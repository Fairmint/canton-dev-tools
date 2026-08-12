/**
 * Prepare Release Script
 *
 * Selects the next version (floor-style) and prepends CHANGELOG.md.
 *
 * Version selection (ocp-canton-sdk / ui-style floor):
 * - If package.json version is ahead of npm latest (or npm returns 404) and is free,
 *   publish that version exactly.
 * - Otherwise patch-increment from the higher of npm latest / package.json, skipping
 *   versions that already exist on npm or as git tags.
 *
 * Rewrites package.json version in the CI workspace only — does not commit it back.
 */

import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFlagValue } from './daml/packages';
import type { PackageJson } from './daml/types';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface PrepareReleaseOptions {
  rootDir: string;
  /**
   * GitHub `owner/repo` used in changelog previous-version links.
   * Defaults to `--changelog-repo`, then package.json repository.url, then the
   * Fairmint package name heuristic.
   */
  changelogRepo?: string;
}

/** Exact `x.y.z` with no leading zeros, exponents, or empty segments. */
const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Release tags created by this workflow: `v` + exact semver. */
const RELEASE_TAG_GLOB = 'v[0-9]*.[0-9]*.[0-9]*';

type NpmLookupResult =
  | { kind: 'found'; latest: string | null; versions: Set<string> }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

/** Check if a git tag exists */
function tagExists(rootDir: string, tag: string): boolean {
  try {
    execFileSync('git', ['rev-parse', `refs/tags/${tag}`], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Encode a scoped package name for the npm registry HTTP API. */
function encodePackageNameForRegistry(packageName: string): string {
  return packageName.replace('/', '%2f');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Read published versions from the public registry HTTP API.
 *
 * Prefer this over `npm view` when a classic auth token in npmrc can 404 public
 * packages the token cannot read (npm reports that as 404, not 403).
 */
export function getNpmMetadataFromRegistry(packageName: string): NpmLookupResult {
  try {
    const encodedName = encodePackageNameForRegistry(packageName);
    const result = execFileSync(
      'curl',
      ['-sS', '-w', '\n%{http_code}', `https://registry.npmjs.org/${encodedName}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const trimmed = result.replace(/\s+$/, '');
    const lastNewline = trimmed.lastIndexOf('\n');
    const body = lastNewline === -1 ? '' : trimmed.slice(0, lastNewline);
    const statusCode = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);

    if (statusCode === '404') {
      return { kind: 'not-found' };
    }
    if (statusCode !== '200') {
      return { kind: 'error', message: `registry.npmjs.org returned HTTP ${statusCode}` };
    }

    const metadata = JSON.parse(body) as {
      'dist-tags'?: { latest?: string };
      versions?: Record<string, unknown>;
    };
    const versions = new Set(Object.keys(metadata.versions ?? {}));
    const latest = metadata['dist-tags']?.latest ?? null;
    return { kind: 'found', latest, versions };
  } catch (error) {
    return { kind: 'error', message: getErrorMessage(error) };
  }
}

function isNpmNotFoundMessage(message: string): boolean {
  return /\b404\b|E404|Not Found|not found/i.test(message);
}

/** Get published versions via `npm view` (fallback when registry HTTP fails transiently). */
function getNpmMetadataFromNpmView(packageName: string): NpmLookupResult {
  try {
    const versionsRaw = execSync(`npm view "${packageName}" versions --json`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const parsed = JSON.parse(versionsRaw) as string | string[];
    const versions = new Set(Array.isArray(parsed) ? parsed : [parsed]);

    let latest: string | null = null;
    try {
      const latestRaw = execSync(`npm view "${packageName}" version`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      latest = latestRaw || null;
    } catch {
      latest = versions.size > 0 ? [...versions].sort().at(-1) ?? null : null;
    }

    return { kind: 'found', latest, versions };
  } catch (error) {
    const message = getErrorMessage(error);
    if (isNpmNotFoundMessage(message)) {
      return { kind: 'not-found' };
    }
    return { kind: 'error', message };
  }
}

/**
 * Establish published-version state, failing closed when unknown.
 *
 * Registry HTTP 404 → treat as unpublished (new package).
 * Registry HTTP success → use that metadata.
 * Registry transient error → only accept a successful `npm view`; never treat
 * ambiguous failures as "no versions published".
 */
export function resolvePublishedNpmState(packageName: string): {
  latest: string | null;
  versions: Set<string>;
} {
  const registry = getNpmMetadataFromRegistry(packageName);
  if (registry.kind === 'found') {
    return { latest: registry.latest, versions: registry.versions };
  }
  if (registry.kind === 'not-found') {
    return { latest: null, versions: new Set() };
  }

  const npmView = getNpmMetadataFromNpmView(packageName);
  if (npmView.kind === 'found') {
    console.log(
      `registry.npmjs.org unavailable (${registry.message}); using npm view metadata instead`
    );
    return { latest: npmView.latest, versions: npmView.versions };
  }

  throw new Error(
    `Unable to determine published versions for ${packageName} (failing closed). ` +
      `registry: ${registry.message}; npm view: ${
        npmView.kind === 'error' ? npmView.message : 'package not found (ambiguous after registry error)'
      }`
  );
}

/** Parse version string into components (exact `x.y.z` only). */
export function parseVersion(version: string): ParsedVersion | null {
  const match = STRICT_SEMVER_PATTERN.exec(version);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Compare two parsed semantic versions. */
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/** Find the next available version by incrementing patch until free on tags and npm */
function findNextAvailableVersion(
  isVersionTaken: (version: string) => boolean,
  major: number,
  minor: number,
  startPatch: number
): string {
  let patch = startPatch;
  let version: string;

  do {
    patch++;
    version = `${major}.${minor}.${patch}`;
  } while (isVersionTaken(version));

  return version;
}

/**
 * Select the version to publish.
 *
 * A manifest version newer than the latest NPM version (including first publish when npm is
 * missing) is an explicit release boundary, so publish it unchanged when it is available.
 * Once that version exists, normal patch increments resume from the highest baseline.
 */
export function selectReleaseVersion(
  manifestVersion: string,
  latestNpmVersion: string | null,
  isVersionTaken: (version: string) => boolean
): string {
  const manifestParsed = parseVersion(manifestVersion);
  if (!manifestParsed) {
    throw new Error('Invalid version format in package.json. Expected format: x.y.z');
  }

  const npmParsed = latestNpmVersion ? parseVersion(latestNpmVersion) : null;
  if (latestNpmVersion && !npmParsed) {
    throw new Error(`Invalid version from npm: ${latestNpmVersion}. Expected format: x.y.z`);
  }

  const manifestAheadOfNpm = !npmParsed || compareVersions(manifestParsed, npmParsed) > 0;

  if (manifestAheadOfNpm && !isVersionTaken(manifestVersion)) {
    return manifestVersion;
  }

  const baseline =
    npmParsed && compareVersions(npmParsed, manifestParsed) > 0 ? npmParsed : manifestParsed;
  return findNextAvailableVersion(isVersionTaken, baseline.major, baseline.minor, baseline.patch);
}

/** Parse `owner/repo` from a package.json repository field or git URL. */
export function parseChangelogRepo(
  repository: PackageJson['repository'] | undefined
): string | undefined {
  if (!repository) return undefined;
  const url = typeof repository === 'string' ? repository : repository.url;
  if (!url) return undefined;

  // Capture owner/repo (dots allowed); strip only a trailing `.git` suffix.
  const match = url.match(/github\.com[/:]([^/]+\/[^/#?\s]+)/i);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1].replace(/\.git$/i, '');
}

export function resolveChangelogRepo(
  packageJson: PackageJson,
  explicit?: string
): string | undefined {
  if (explicit) return explicit;
  return parseChangelogRepo(packageJson.repository);
}

/** Describe the nearest prior `v<semver>` release tag, or null if none. */
function describePreviousReleaseTag(rootDir: string): string | null {
  try {
    const lastTag = execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', RELEASE_TAG_GLOB],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();
    return lastTag || null;
  } catch {
    return null;
  }
}

function readCommitsSince(rootDir: string, lastTag: string | null): string {
  if (lastTag) {
    return execFileSync('git', ['log', '--oneline', '--format=%s', `${lastTag}..HEAD`], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  return execFileSync('git', ['log', '--oneline', '--format=%s', '-n', '20'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Prepare release by selecting version and generating changelog.
 * Safe for local testing (no git tag / push operations).
 */
export function prepareRelease(options: PrepareReleaseOptions): string {
  const rootDir = path.resolve(options.rootDir);
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;

  if (!packageJson.name || !packageJson.version) {
    throw new Error(`package.json at ${packageJsonPath} must include name and version`);
  }

  const packageName = packageJson.name;
  const currentVersion = packageJson.version;
  console.log(`Package: ${packageName}`);
  console.log(`Current version in package.json: ${currentVersion}`);

  console.log('Fetching published versions from NPM...');
  const { versions: npmVersions, latest: latestNpmVersion } = resolvePublishedNpmState(packageName);

  if (latestNpmVersion) {
    console.log(`Latest version on NPM: ${latestNpmVersion}`);
    console.log(`Total published versions: ${npmVersions.size}`);
  } else {
    console.log('No version found on NPM (new package)');
  }

  const isVersionTaken = (version: string): boolean =>
    npmVersions.has(version) || tagExists(rootDir, `v${version}`);
  const newVersion = selectReleaseVersion(currentVersion, latestNpmVersion, isVersionTaken);

  console.log(`New version: ${newVersion}`);

  packageJson.version = newVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  console.log('✅ Updated package.json with new version');

  const lastTag = describePreviousReleaseTag(rootDir);
  if (lastTag) {
    console.log(`Last tag: ${lastTag}`);
  } else {
    console.log('No previous release tag found, using recent commit history');
  }

  let commits: string;
  try {
    commits = readCommitsSince(rootDir, lastTag);
  } catch {
    commits = '';
  }

  if (!commits) {
    console.log('No commits found for changelog, using placeholder');
    commits = 'Initial release';
  }

  const commitLines = commits.split('\n').map((commit: string): string => `- ${commit}`);
  const changelog = commitLines.join('\n');

  console.log('\n📋 Generated changelog:');
  console.log('='.repeat(50));
  console.log(changelog);
  console.log('='.repeat(50));

  const tagMessage = `Release v${newVersion}\n\nChanges:\n${changelog}`;

  console.log('\n🏷️  Tag message preview:');
  console.log('='.repeat(50));
  console.log(tagMessage);
  console.log('='.repeat(50));

  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  const changelogRepo = resolveChangelogRepo(packageJson, options.changelogRepo);
  const previousVersionLink =
    lastTag && changelogRepo
      ? `\n[Previous version: ${lastTag}](https://github.com/${changelogRepo}/releases/tag/${lastTag})`
      : '';

  const changelogContent = `# Changelog for v${newVersion}\n\n${changelog}${previousVersionLink}\n\n`;

  if (fs.existsSync(changelogPath)) {
    const existingChangelog = fs.readFileSync(changelogPath, 'utf8');
    fs.writeFileSync(changelogPath, changelogContent + existingChangelog);
  } else {
    fs.writeFileSync(changelogPath, changelogContent);
  }

  console.log(`\n✅ Saved changelog to CHANGELOG.md`);
  console.log(`\n🎯 Ready for release! CI will publish and tag v${newVersion}.`);
  return newVersion;
}

export function runPrepareReleaseCli(args: string[]): void {
  const rootDir = path.resolve(parseFlagValue(args, '--root') ?? process.cwd());
  const changelogRepo = parseFlagValue(args, '--changelog-repo');
  try {
    prepareRelease({ rootDir, changelogRepo });
  } catch (error) {
    console.error('❌ Error preparing release:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

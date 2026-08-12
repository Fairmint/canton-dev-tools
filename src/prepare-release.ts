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

import { execSync } from 'node:child_process';
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

/** Check if a git tag exists */
function tagExists(rootDir: string, tag: string): boolean {
  try {
    execSync(`git rev-parse "refs/tags/${tag}"`, { cwd: rootDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Encode a scoped package name for the npm registry HTTP API. */
function encodePackageNameForRegistry(packageName: string): string {
  return packageName.replace('/', '%2f');
}

/**
 * Read published versions from the public registry HTTP API.
 *
 * Prefer this over `npm view` when a classic auth token in npmrc can 404 public
 * packages the token cannot read (npm reports that as 404, not 403).
 */
function getNpmMetadataFromRegistry(packageName: string): {
  latest: string | null;
  versions: Set<string>;
} | null {
  try {
    const encodedName = encodePackageNameForRegistry(packageName);
    const result = execSync(`curl -fsS "https://registry.npmjs.org/${encodedName}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const metadata = JSON.parse(result) as {
      'dist-tags'?: { latest?: string };
      versions?: Record<string, unknown>;
    };
    const versions = new Set(Object.keys(metadata.versions ?? {}));
    const latest = metadata['dist-tags']?.latest ?? null;
    return { latest, versions };
  } catch {
    return null;
  }
}

/** Get all published versions from NPM registry */
function getAllNpmVersions(packageName: string): Set<string> {
  try {
    const result = execSync(`npm view "${packageName}" versions --json`, {
      encoding: 'utf8',
    }).trim();
    const versions = JSON.parse(result) as string | string[];
    if (Array.isArray(versions)) {
      return new Set(versions);
    }
    return new Set([versions]);
  } catch {
    return new Set();
  }
}

/** Get the latest version from NPM registry */
function getLatestNpmVersion(packageName: string): string | null {
  try {
    const result = execSync(`npm view "${packageName}" version`, { encoding: 'utf8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Parse version string into components */
function parseVersion(version: string): ParsedVersion | null {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    return null;
  }
  if (!parts.every((part) => Number.isInteger(part) && part >= 0)) {
    return null;
  }
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]! };
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

  const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?/i);
  return match?.[1];
}

export function resolveChangelogRepo(
  packageJson: PackageJson,
  explicit?: string
): string | undefined {
  if (explicit) return explicit;
  return parseChangelogRepo(packageJson.repository);
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
  let npmVersions = getAllNpmVersions(packageName);
  let latestNpmVersion = getLatestNpmVersion(packageName);

  if (!latestNpmVersion && npmVersions.size === 0) {
    const registryMetadata = getNpmMetadataFromRegistry(packageName);
    if (registryMetadata) {
      console.log('npm view returned no versions; using public registry HTTP metadata instead');
      npmVersions = registryMetadata.versions;
      latestNpmVersion = registryMetadata.latest;
    }
  }

  if (latestNpmVersion) {
    console.log(`Latest version on NPM: ${latestNpmVersion}`);
    console.log(`Total published versions: ${npmVersions.size}`);
  } else {
    console.log('No version found on NPM (new package or registry unavailable)');
  }

  const isVersionTaken = (version: string): boolean =>
    npmVersions.has(version) || tagExists(rootDir, `v${version}`);
  const newVersion = selectReleaseVersion(currentVersion, latestNpmVersion, isVersionTaken);

  console.log(`New version: ${newVersion}`);

  packageJson.version = newVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  console.log('✅ Updated package.json with new version');

  let commits: string;
  let lastTag: string | null = null;
  try {
    lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null', {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    console.log(`Last tag: ${lastTag}`);
    commits = execSync(`git log --oneline --format="%s" ${lastTag}..HEAD`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
  } catch {
    console.log('No previous tag found, using recent commit history');
    commits = execSync('git log --oneline --format="%s" -n 20', {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
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

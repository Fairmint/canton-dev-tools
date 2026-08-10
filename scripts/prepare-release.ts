#!/usr/bin/env node

/**
 * Prepare Release Script
 *
 * Prepares a new release by selecting the next version and prepending CHANGELOG.md.
 *
 * Usage: npm run prepare-release
 *
 * Version selection (ocp-canton-sdk / ui-style floor):
 * - If package.json version is ahead of npm latest (or npm returns 404) and is free,
 *   publish that version exactly (first publish = package.json, currently 0.1.0).
 * - Otherwise patch-increment from the higher of npm latest / package.json, skipping
 *   versions that already exist on npm or as git tags.
 *
 * Rewrites package.json version in the CI workspace only — does not commit it back.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface PackageJson {
  name: string;
  version: string;
  [key: string]: unknown;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Check if a git tag exists */
function tagExists(tag: string): boolean {
  try {
    execSync(`git rev-parse "refs/tags/${tag}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
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
    // Package may not exist on NPM yet (404)
    return new Set();
  }
}

/** Get the latest version from NPM registry */
function getLatestNpmVersion(packageName: string): string | null {
  try {
    const result = execSync(`npm view "${packageName}" version`, { encoding: 'utf8' }).trim();
    return result || null;
  } catch {
    // Package may not exist on NPM yet (404)
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
function selectReleaseVersion(
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

/**
 * Prepare release by selecting version and generating changelog.
 * Safe for local testing (no git tag / push operations).
 */
function prepareRelease(): void {
  try {
    const packageJsonPath: string = path.join(process.cwd(), 'package.json');
    const packageJson: PackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const packageName: string = packageJson.name;
    const currentVersion: string = packageJson.version;
    console.log(`Package: ${packageName}`);
    console.log(`Current version in package.json: ${currentVersion}`);

    console.log('Fetching published versions from NPM...');
    const npmVersions = getAllNpmVersions(packageName);
    const latestNpmVersion = getLatestNpmVersion(packageName);

    if (latestNpmVersion) {
      console.log(`Latest version on NPM: ${latestNpmVersion}`);
      console.log(`Total published versions: ${npmVersions.size}`);
    } else {
      console.log('No version found on NPM (new package or registry unavailable)');
    }

    const isVersionTaken = (version: string): boolean =>
      npmVersions.has(version) || tagExists(`v${version}`);
    const newVersion: string = selectReleaseVersion(
      currentVersion,
      latestNpmVersion,
      isVersionTaken
    );

    console.log(`New version: ${newVersion}`);

    packageJson.version = newVersion;
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    console.log('✅ Updated package.json with new version');

    let commits: string;
    let lastTag: string | null = null;
    try {
      lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null', {
        encoding: 'utf8',
      }).trim();
      console.log(`Last tag: ${lastTag}`);
      commits = execSync(`git log --oneline --format="%s" ${lastTag}..HEAD`, {
        encoding: 'utf8',
      }).trim();
    } catch {
      // No previous tag (first publish on main): take recent history, not main..HEAD
      // which is empty when HEAD is already on main.
      console.log('No previous tag found, using recent commit history');
      commits = execSync('git log --oneline --format="%s" -n 20', {
        encoding: 'utf8',
      }).trim();
    }

    if (!commits) {
      console.log('No commits found for changelog, using placeholder');
      commits = 'Initial release';
    }

    const commitLines: string[] = commits
      .split('\n')
      .map((commit: string): string => `- ${commit}`);
    const changelog: string = commitLines.join('\n');

    console.log('\n📋 Generated changelog:');
    console.log('='.repeat(50));
    console.log(changelog);
    console.log('='.repeat(50));

    const tagMessage = `Release v${newVersion}\n\nChanges:\n${changelog}`;

    console.log('\n🏷️  Tag message preview:');
    console.log('='.repeat(50));
    console.log(tagMessage);
    console.log('='.repeat(50));

    const changelogPath: string = path.join(process.cwd(), 'CHANGELOG.md');
    const previousVersionLink: string = lastTag
      ? `\n[Previous version: ${lastTag}](https://github.com/Fairmint/canton-dev-tools/releases/tag/${lastTag})`
      : '';

    const changelogContent = `# Changelog for v${newVersion}\n\n${changelog}${previousVersionLink}\n\n`;

    if (fs.existsSync(changelogPath)) {
      const existingChangelog: string = fs.readFileSync(changelogPath, 'utf8');
      fs.writeFileSync(changelogPath, changelogContent + existingChangelog);
    } else {
      fs.writeFileSync(changelogPath, changelogContent);
    }

    console.log(`\n✅ Saved changelog to CHANGELOG.md`);
    console.log(`\n🎯 Ready for release! CI will publish and tag v${newVersion}.`);
  } catch (error) {
    console.error('❌ Error preparing release:', (error as Error).message);
    process.exit(1);
  }
}

if (require.main === module) {
  prepareRelease();
}

export { prepareRelease, selectReleaseVersion };

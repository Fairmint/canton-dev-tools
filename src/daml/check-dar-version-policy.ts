/**
 * DAR version policy checker (candidate slots, deployment tags, lock immutability).
 *
 * Adapted from canton-assets (handles missing dars.lock at base ref).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import {
  assertGitCommitRef,
  computeSha256,
  darLockEntriesEqual,
  getDarLockKey,
  getDarsDir,
  getFreshDarPath,
  loadDarsLock,
  type DarsLock,
  type DarsLockEntry,
} from './dar-utils';
import {
  assertMainnetNotAhead,
  assertMainnetPromotionNotBehind,
  buildDeploymentTag,
  decideCandidateVersion,
  findDeploymentAnchor,
  getLockEntry,
  last,
  listDeploymentTags,
  parseDeploymentTag,
  parseStrictSemver,
  type DeploymentNetwork,
} from './dar-version-policy';
import { discoverManagedPackages, requirePackage, type PackageConfig } from './packages';
import { resolveContainedPath } from './sync-splice-dars';

export interface CheckDarVersionPolicyOptions {
  rootDir: string;
  all?: boolean;
  base?: string;
  deployment?: DeploymentNetwork;
  packageKey?: string;
}

interface TagRef {
  name: string;
  objectType: string;
}

function gitText(rootDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
}

function listTagRefs(rootDir: string): TagRef[] {
  const output = gitText(rootDir, [
    'for-each-ref',
    '--format=%(refname:strip=2)%09%(objecttype)',
    'refs/tags',
  ]);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const [name, objectType] = line.split('\t');
    return { name: name ?? '', objectType: objectType ?? '' };
  });
}

function deploymentTagNames(rootDir: string): string[] {
  const refs = listTagRefs(rootDir);
  for (const ref of refs) {
    if (parseDeploymentTag(ref.name) && ref.objectType !== 'tag') {
      throw new Error(`Deployment tag must be annotated and immutable: ${ref.name}`);
    }
  }
  return refs
    .filter(({ name, objectType }) => objectType === 'tag' && parseDeploymentTag(name))
    .map(({ name }) => name);
}

function loadLockAtRef(rootDir: string, ref: string): DarsLock {
  assertGitCommitRef(rootDir, ref);

  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:dars/dars.lock`], {
      cwd: rootDir,
      stdio: 'ignore',
    });
  } catch {
    return { version: 1, packages: {} };
  }

  const parsed: unknown = JSON.parse(gitText(rootDir, ['show', `${ref}:dars/dars.lock`]));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('packages' in parsed) ||
    typeof parsed.packages !== 'object' ||
    parsed.packages === null
  ) {
    throw new Error(`Invalid dars.lock at ${ref}`);
  }
  return parsed as DarsLock;
}

function lockEntriesForPackage(lock: DarsLock, packageName: string) {
  const prefix = `${packageName}/`;
  return Object.entries(lock.packages)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, entry]) => ({ key, entry, version: key.slice(prefix.length).split('/')[0] ?? '' }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function verifyEntry(rootDir: string, key: string, entry: DarsLockEntry): void {
  const darPath = resolveContainedPath(getDarsDir(rootDir), key, 'dars.lock key');
  if (!fs.existsSync(darPath)) throw new Error(`Missing DAR recorded in dars.lock: ${key}`);
  const stats = fs.statSync(darPath);
  if (!stats.isFile()) throw new Error(`DAR path is not a file: ${key}`);
  const actualHash = computeSha256(darPath);
  if (actualHash !== entry.sha256 || stats.size !== entry.size) {
    throw new Error(
      `DAR integrity mismatch for ${key}: expected ${entry.sha256}/${entry.size}, got ${actualHash}/${stats.size}`
    );
  }
}

function packageMetadataAtRef(
  rootDir: string,
  ref: string,
  pkg: PackageConfig
): { name?: string; version?: string } {
  try {
    const parsed: unknown = yaml.parse(
      gitText(rootDir, ['show', `${ref}:${pkg.sourceDir}/daml.yaml`])
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const name: unknown = Reflect.get(parsed, 'name');
    const version: unknown = Reflect.get(parsed, 'version');
    if (name !== undefined && typeof name !== 'string') return {};
    if (version !== undefined && typeof version !== 'string') return {};
    return {
      name: typeof name === 'string' ? name : undefined,
      version: typeof version === 'string' ? version : undefined,
    };
  } catch {
    return {};
  }
}

function migrationCandidateVersion(
  rootDir: string,
  ref: string,
  pkg: PackageConfig,
  lock: DarsLock
): string | undefined {
  const metadata = packageMetadataAtRef(rootDir, ref, pkg);
  if (metadata.name !== pkg.name || !metadata.version) return undefined;
  const entry = getLockEntry(lock, getDarLockKey(pkg.name, metadata.version, pkg.darName));
  return entry?.networks.length === 0 ? metadata.version : undefined;
}

function taggedEntry(
  rootDir: string,
  packageConfig: PackageConfig,
  tagName: string,
  version: string
): DarsLockEntry {
  const key = getDarLockKey(packageConfig.name, version, packageConfig.darName);
  const entry = getLockEntry(loadLockAtRef(rootDir, `${tagName}^{commit}`), key);
  if (!entry) throw new Error(`${tagName} does not record its deployed DAR at ${key}`);
  return entry;
}

function freshAndLockedEntry(
  rootDir: string,
  pkg: PackageConfig,
  lock: DarsLock
): { key: string; entry: DarsLockEntry; hash: string } {
  if (!parseStrictSemver(pkg.version)) {
    throw new Error(`Invalid daml.yaml version for ${pkg.name}: ${pkg.version}`);
  }
  const key = getDarLockKey(pkg.name, pkg.version, pkg.darName);
  const entry = getLockEntry(lock, key);
  if (!entry) throw new Error(`Current package is not backed up: ${key}`);
  verifyEntry(rootDir, key, entry);

  const freshPath = getFreshDarPath(rootDir, pkg.buildDir, pkg.version, pkg.darName);
  if (!freshPath) {
    throw new Error(
      `Fresh build is missing: ${pkg.buildDir}/.daml/dist/${pkg.darName}-${pkg.version}.dar`
    );
  }
  const hash = computeSha256(freshPath);
  const { size } = fs.statSync(freshPath);
  if (hash !== entry.sha256 || size !== entry.size) {
    throw new Error(
      `Fresh build does not match committed backup ${key}: expected ${entry.sha256}/${entry.size}, got ${hash}/${size}`
    );
  }
  return { key, entry, hash };
}

function changedPackages(
  rootDir: string,
  base: string,
  currentLock: DarsLock,
  baseLock: DarsLock,
  allPackages: PackageConfig[]
): PackageConfig[] {
  const changedPaths = gitText(rootDir, [
    'diff',
    '--name-only',
    '--diff-filter=ACMRTUXB',
    `${base}...HEAD`,
  ])
    .split('\n')
    .filter(Boolean);
  const lockChanged = changedPaths.includes('dars/dars.lock');
  return allPackages.filter((pkg) => {
    const filesChanged = changedPaths.some(
      (changedPath) =>
        changedPath === `${pkg.sourceDir}/daml.yaml` ||
        changedPath.startsWith(`${pkg.sourceDir}/daml/`) ||
        changedPath.startsWith(`dars/${pkg.name}/`)
    );
    if (filesChanged) return true;
    if (!lockChanged) return false;
    const currentEntries = lockEntriesForPackage(currentLock, pkg.name);
    const baseEntries = lockEntriesForPackage(baseLock, pkg.name);
    return (
      currentEntries.length !== baseEntries.length ||
      currentEntries.some(({ key, entry }, index) => {
        const baseEntry = baseEntries[index];
        return !baseEntry || key !== baseEntry.key || !darLockEntriesEqual(entry, baseEntry.entry);
      })
    );
  });
}

function validateRetainedHistory(
  rootDir: string,
  currentLock: DarsLock,
  baseLock: DarsLock,
  selectedPackages: PackageConfig[],
  latestTaggedEntries: Map<string, DarsLockEntry>
): void {
  const mutableKeys = new Set(
    selectedPackages.map((pkg) => getDarLockKey(pkg.name, pkg.version, pkg.darName))
  );

  for (const [key, baseEntry] of Object.entries(baseLock.packages)) {
    if (mutableKeys.has(key)) continue;
    const currentEntry = getLockEntry(currentLock, key);
    const promotedEntry = latestTaggedEntries.get(key);
    if (
      !currentEntry ||
      (!darLockEntriesEqual(currentEntry, baseEntry) &&
        (!promotedEntry || !darLockEntriesEqual(currentEntry, promotedEntry)))
    ) {
      throw new Error(`Historical DAR lock entry is immutable: ${key}`);
    }
    verifyEntry(rootDir, key, currentEntry);
  }

  for (const key of Object.keys(currentLock.packages)) {
    const retainedTagEntry = latestTaggedEntries.get(key);
    const currentEntry = getLockEntry(currentLock, key);
    if (
      !getLockEntry(baseLock, key) &&
      !mutableKeys.has(key) &&
      (!retainedTagEntry || !currentEntry || !darLockEntriesEqual(currentEntry, retainedTagEntry))
    ) {
      throw new Error(`Only a selected package's current candidate slot may be added: ${key}`);
    }
  }
}

function validatePackage(
  rootDir: string,
  pkg: PackageConfig,
  currentLock: DarsLock,
  baseLock: DarsLock,
  baseRef: string,
  tagNames: string[]
): void {
  assertMainnetNotAhead(pkg.name, tagNames);
  const packageTags = listDeploymentTags(tagNames, pkg.name);
  const currentEntries = lockEntriesForPackage(currentLock, pkg.name);
  const baseMarkers = lockEntriesForPackage(baseLock, pkg.name).filter(
    ({ entry }) => entry.networks.length > 0
  );
  const devnetTags = packageTags.filter(({ network }) => network === 'devnet');
  const latestDevnetTag = last(devnetTags);

  for (const { key, entry, version } of currentEntries) {
    if (!parseStrictSemver(version)) throw new Error(`Invalid version in dars.lock key: ${key}`);
    verifyEntry(rootDir, key, entry);
    if (entry.networks.length > 0) {
      const baseEntry = getLockEntry(baseLock, key);
      if (!baseEntry || !darLockEntriesEqual(entry, baseEntry)) {
        throw new Error(
          `Legacy deployment marker is immutable and may not be added or changed in a branch: ${key}`
        );
      }
    }
  }

  for (const { key, entry } of baseMarkers) {
    const currentEntry = getLockEntry(currentLock, key);
    if (!currentEntry || !darLockEntriesEqual(currentEntry, entry)) {
      throw new Error(`Legacy deployed backup is immutable: ${key}`);
    }
  }

  const tagEntriesByVersion = new Map<string, DarsLockEntry>();
  for (const tag of packageTags) {
    const key = getDarLockKey(pkg.name, tag.version, pkg.darName);
    const currentEntry = getLockEntry(currentLock, key);
    const originalEntry = taggedEntry(rootDir, pkg, tag.name, tag.version);
    const otherNetworkEntry = tagEntriesByVersion.get(tag.version);
    if (otherNetworkEntry && !darLockEntriesEqual(otherNetworkEntry, originalEntry)) {
      throw new Error(`Deployment tags disagree for ${pkg.name} ${tag.version}`);
    }
    tagEntriesByVersion.set(tag.version, originalEntry);
    if (
      tag.name === latestDevnetTag?.name &&
      (!currentEntry || !darLockEntriesEqual(currentEntry, originalEntry))
    ) {
      throw new Error(`Restore latest DevNet backup ${key} exactly from ${tag.name}`);
    }
  }

  const anchor = findDeploymentAnchor(pkg.name, tagNames, baseLock);
  const {
    key: currentKey,
    entry: currentEntry,
    hash: currentHash,
  } = freshAndLockedEntry(rootDir, pkg, currentLock);
  let deployedHash: string | undefined;
  if (anchor?.source === 'devnet-tag') {
    const tagName = buildDeploymentTag('devnet', pkg.name, anchor.version);
    deployedHash = taggedEntry(rootDir, pkg, tagName, anchor.version).sha256;
  } else if (anchor) {
    deployedHash = baseMarkers.find(({ version }) => version === anchor.version)?.entry.sha256;
  }
  const decision = decideCandidateVersion(
    pkg.version,
    anchor,
    currentHash === deployedHash,
    migrationCandidateVersion(rootDir, baseRef, pkg, baseLock)
  );
  if (!decision.valid) throw new Error(decision.message);

  if (currentEntry.sha256 !== currentHash)
    throw new Error(`Internal hash mismatch for ${currentKey}`);
  console.log(
    `✅ ${pkg.name} ${pkg.version} (${decision.kind}; anchor ${anchor?.version ?? 'none'})`
  );
}

function writeDeploymentOutputs(values: Record<string, string>): void {
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`
  );
}

function deploymentPreflight(
  rootDir: string,
  pkg: PackageConfig,
  network: DeploymentNetwork
): void {
  const lock = loadDarsLock(rootDir);
  const baseLock = loadLockAtRef(rootDir, 'origin/main');
  const tagNames = deploymentTagNames(rootDir);
  assertMainnetNotAhead(pkg.name, tagNames);
  const { entry } = freshAndLockedEntry(rootDir, pkg, lock);
  const tagName = buildDeploymentTag(network, pkg.name, pkg.version);
  const tagExists = tagNames.includes(tagName);

  if (network === 'mainnet') {
    assertMainnetPromotionNotBehind(pkg.name, pkg.version, tagNames);
    const devnetTagName = buildDeploymentTag('devnet', pkg.name, pkg.version);
    if (!tagNames.includes(devnetTagName))
      throw new Error(`Mainnet requires successful DevNet tag ${devnetTagName}`);
    const devnetEntry = taggedEntry(rootDir, pkg, devnetTagName, pkg.version);
    if (devnetEntry.sha256 !== entry.sha256) {
      throw new Error(
        `Current locked DAR hash ${entry.sha256} does not match DevNet tag hash ${devnetEntry.sha256}`
      );
    }
  }

  if (tagExists) {
    const existingEntry = taggedEntry(rootDir, pkg, tagName, pkg.version);
    if (existingEntry.sha256 !== entry.sha256) {
      throw new Error(
        `Existing immutable tag ${tagName} records ${existingEntry.sha256}, not ${entry.sha256}`
      );
    }
    writeDeploymentOutputs({
      tag: tagName,
      tag_exists: 'true',
      package_name: pkg.name,
      version: pkg.version,
    });
    console.log(`✅ Deployment preflight: ${tagName} (already recorded)`);
    return;
  }

  if (network === 'mainnet') {
    writeDeploymentOutputs({
      tag: tagName,
      tag_exists: 'false',
      package_name: pkg.name,
      version: pkg.version,
    });
    console.log(`✅ Deployment preflight: ${tagName}`);
    return;
  }

  const anchor = findDeploymentAnchor(pkg.name, tagNames, baseLock);
  let deployedHash: string | undefined;
  if (anchor?.source === 'devnet-tag') {
    deployedHash = taggedEntry(
      rootDir,
      pkg,
      buildDeploymentTag('devnet', pkg.name, anchor.version),
      anchor.version
    ).sha256;
  } else if (anchor) {
    deployedHash = lockEntriesForPackage(baseLock, pkg.name).find(
      ({ version, entry: candidate }) => version === anchor.version && candidate.networks.length > 0
    )?.entry.sha256;
  }
  const decision = decideCandidateVersion(
    pkg.version,
    anchor,
    entry.sha256 === deployedHash,
    migrationCandidateVersion(rootDir, 'origin/main', pkg, baseLock)
  );
  if (!decision.valid) throw new Error(decision.message);

  writeDeploymentOutputs({
    tag: tagName,
    tag_exists: 'false',
    package_name: pkg.name,
    version: pkg.version,
  });
  console.log(`✅ Deployment preflight: ${tagName}`);
}

export function checkDarVersionPolicy(options: CheckDarVersionPolicyOptions): void {
  const rootDir = path.resolve(options.rootDir);
  const allPackages = discoverManagedPackages(rootDir);

  if (options.deployment) {
    if (!options.packageKey) throw new Error('--deployment requires --package');
    deploymentPreflight(
      rootDir,
      requirePackage(allPackages, options.packageKey),
      options.deployment
    );
    return;
  }

  const base = options.base ?? 'origin/main';
  const currentLock = loadDarsLock(rootDir);
  const baseLock = loadLockAtRef(rootDir, base);
  let packages: PackageConfig[];
  if (options.packageKey) {
    packages = [requirePackage(allPackages, options.packageKey)];
  } else if (options.all) {
    packages = allPackages;
  } else {
    packages = changedPackages(rootDir, base, currentLock, baseLock, allPackages);
  }
  for (const pkg of packages) {
    if (!parseStrictSemver(pkg.version)) {
      throw new Error(`Invalid daml.yaml version for ${pkg.name}: ${pkg.version}`);
    }
  }
  const tagNames = deploymentTagNames(rootDir);
  const latestTaggedEntries = new Map<string, DarsLockEntry>();
  for (const pkg of allPackages) {
    const devnetTags = listDeploymentTags(tagNames, pkg.name).filter(
      ({ network }) => network === 'devnet'
    );
    const latestTag = last(devnetTags);
    if (!latestTag) continue;
    const key = getDarLockKey(pkg.name, latestTag.version, pkg.darName);
    latestTaggedEntries.set(key, taggedEntry(rootDir, pkg, latestTag.name, latestTag.version));
  }
  validateRetainedHistory(rootDir, currentLock, baseLock, packages, latestTaggedEntries);
  if (packages.length === 0) {
    console.log(`ℹ️ No changed DAML package lines relative to ${base}`);
    return;
  }

  for (const pkg of packages) validatePackage(rootDir, pkg, currentLock, baseLock, base, tagNames);
}

export function runCheckDarVersionPolicyCli(args: string[] = process.argv.slice(2)): void {
  try {
    const options: CheckDarVersionPolicyOptions = {
      rootDir: process.cwd(),
      all: args.includes('--all'),
      base: 'origin/main',
    };
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--root') options.rootDir = args[++index] ?? options.rootDir;
      if (args[index] === '--base') options.base = args[++index] ?? '';
      if (args[index] === '--deployment') {
        const network = args[++index];
        if (network !== 'devnet' && network !== 'mainnet')
          throw new Error(`Invalid deployment network: ${network}`);
        options.deployment = network;
      }
      if (args[index] === '--package') options.packageKey = args[++index];
    }
    if (!options.base) throw new Error('--base requires a Git ref');
    checkDarVersionPolicy(options);
  } catch (error) {
    console.error(
      `❌ DAR version policy failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

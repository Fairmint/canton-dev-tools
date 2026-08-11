/**
 * Back up the current candidate DAR. Undeployed candidates are mutable; tag- or marker-deployed backups are not.
 *
 * Adapted from canton-assets (handles missing dars.lock at origin/main).
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
  loadDarsLock,
  saveDarsLock,
  type DarsLock,
  type DarsLockEntry,
} from './dar-utils';
import {
  assertMainnetNotAhead,
  decideCandidateVersion,
  findDeploymentAnchor,
  getLockEntry,
  last,
  listDeploymentTags,
  parseDeploymentTag,
  type DeploymentTag,
} from './dar-version-policy';
import {
  discoverManagedPackages,
  findPackage,
  parsePackageArg,
  parseVersionArg,
  type PackageConfig,
} from './packages';

export interface BackupDarOptions {
  rootDir: string;
  packageArg: string;
  version: string;
  baseRef?: string;
}

function getSdkVersion(rootDir: string, sourceDir: string): string {
  const parsed: unknown = yaml.parse(
    fs.readFileSync(path.join(rootDir, sourceDir, 'daml.yaml'), 'utf8')
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unknown';
  const sdkVersion = Reflect.get(parsed, 'sdk-version');
  return typeof sdkVersion === 'string' ? sdkVersion : 'unknown';
}

function deploymentTags(rootDir: string): DeploymentTag[] {
  const output = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname:strip=2)%09%(objecttype)', 'refs/tags'],
    {
      cwd: rootDir,
      encoding: 'utf8',
    }
  ).trim();
  if (!output) return [];
  return output.split('\n').flatMap((line) => {
    const [name, objectType] = line.split('\t');
    if (!name) return [];
    const tag = parseDeploymentTag(name);
    if (!tag) return [];
    if (objectType !== 'tag') throw new Error(`Deployment tag must be annotated: ${name}`);
    return [tag];
  });
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

  const output = execFileSync('git', ['show', `${ref}:dars/dars.lock`], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return JSON.parse(output) as DarsLock;
}

function migrationCandidateVersion(
  rootDir: string,
  pkg: PackageConfig,
  baseLock: DarsLock,
  baseRef: string
): string | undefined {
  let parsed: unknown;
  try {
    parsed = yaml.parse(
      execFileSync('git', ['show', `${baseRef}:${pkg.sourceDir}/daml.yaml`], {
        cwd: rootDir,
        encoding: 'utf8',
      })
    );
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const name: unknown = Reflect.get(parsed, 'name');
  const version: unknown = Reflect.get(parsed, 'version');
  if (name !== pkg.name || typeof version !== 'string' || !version) return undefined;
  const entry = getLockEntry(baseLock, getDarLockKey(pkg.name, version, pkg.darName));
  return entry?.networks.length === 0 ? version : undefined;
}

function safeDarPath(rootDir: string, lockKey: string): string {
  const darsDir = path.resolve(getDarsDir(rootDir));
  const darPath = path.resolve(darsDir, lockKey);
  if (!darPath.startsWith(`${darsDir}${path.sep}`))
    throw new Error(`Unsafe DAR lock key: ${lockKey}`);
  return darPath;
}

export function backupDar(options: BackupDarOptions): void {
  const rootDir = path.resolve(options.rootDir);
  const baseRef = options.baseRef ?? 'origin/main';
  const packages = discoverManagedPackages(rootDir);
  const pkg = findPackage(packages, options.packageArg);
  if (!pkg) {
    throw new Error(`Unknown package: ${options.packageArg}`);
  }
  if (options.version !== pkg.version) {
    throw new Error(`${pkg.name} is version ${pkg.version}, not ${options.version}`);
  }

  const sourcePath = path.join(
    rootDir,
    pkg.buildDir,
    '.daml',
    'dist',
    `${pkg.darName}-${options.version}.dar`
  );
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source DAR not found: ${sourcePath}. Run npm run build first`);
  }

  const lock = loadDarsLock(rootDir);
  const baseLock = loadLockAtRef(rootDir, baseRef);
  const tags = deploymentTags(rootDir);
  const tagNames = tags.map(({ name }) => name);
  const packageTags = listDeploymentTags(tagNames, pkg.name);
  assertMainnetNotAhead(pkg.name, tagNames);
  const anchor = findDeploymentAnchor(pkg.name, tagNames, baseLock);
  const lockKey = `${pkg.name}/${options.version}/${pkg.darName}.dar`;
  const destPath = safeDarPath(rootDir, lockKey);
  const sourceHash = computeSha256(sourcePath);
  const sourceSize = fs.statSync(sourcePath).size;
  const existing = getLockEntry(lock, lockKey);
  const devnetTags = packageTags.filter(({ network }) => network === 'devnet');
  const latestDevnetTag = last(devnetTags);
  let latestTaggedEntry: DarsLockEntry | undefined;
  if (latestDevnetTag) {
    const taggedLock = loadLockAtRef(rootDir, `${latestDevnetTag.name}^{commit}`);
    const taggedKey = `${pkg.name}/${latestDevnetTag.version}/${pkg.darName}.dar`;
    latestTaggedEntry = getLockEntry(taggedLock, taggedKey);
    if (!latestTaggedEntry) throw new Error(`${latestDevnetTag.name} does not record ${taggedKey}`);
    const currentEntry = getLockEntry(lock, taggedKey);
    if (!currentEntry || !darLockEntriesEqual(currentEntry, latestTaggedEntry)) {
      throw new Error(
        `Restore latest DevNet backup ${taggedKey} exactly from ${latestDevnetTag.name} before backing up a new candidate`
      );
    }
  }

  for (const [key, baseEntry] of Object.entries(baseLock.packages)) {
    if (!key.startsWith(`${pkg.name}/`) || baseEntry.networks.length === 0) continue;
    const currentEntry = getLockEntry(lock, key);
    if (!currentEntry || !darLockEntriesEqual(currentEntry, baseEntry)) {
      throw new Error(`Legacy deployed backup is immutable: ${key}`);
    }
  }
  for (const [key, currentEntry] of Object.entries(lock.packages)) {
    if (!key.startsWith(`${pkg.name}/`) || currentEntry.networks.length === 0) continue;
    const baseEntry = getLockEntry(baseLock, key);
    if (!baseEntry || !darLockEntriesEqual(currentEntry, baseEntry)) {
      throw new Error(`Legacy deployment markers may not be added or changed in a branch: ${key}`);
    }
  }

  const baseCurrent = getLockEntry(baseLock, lockKey);
  const isTagged = Boolean(
    existing &&
    latestDevnetTag?.version === options.version &&
    latestTaggedEntry &&
    darLockEntriesEqual(existing, latestTaggedEntry)
  );
  const isMarkerDeployed = Boolean(
    existing && baseCurrent?.networks.length && darLockEntriesEqual(existing, baseCurrent)
  );
  const bytesMatch = Boolean(
    existing &&
    fs.existsSync(destPath) &&
    existing.sha256 === sourceHash &&
    existing.size === sourceSize
  );
  const decision = decideCandidateVersion(
    options.version,
    anchor,
    bytesMatch && (isTagged || isMarkerDeployed),
    migrationCandidateVersion(rootDir, pkg, baseLock, baseRef)
  );
  if (!decision.valid) throw new Error(decision.message);

  if (existing) {
    if (!fs.existsSync(destPath))
      throw new Error(`Lock entry exists but file is missing: ${lockKey}`);
    const currentHash = computeSha256(destPath);
    const currentSize = fs.statSync(destPath).size;
    if (currentHash !== existing.sha256 || currentSize !== existing.size) {
      throw new Error(`Existing backup failed integrity verification: ${lockKey}`);
    }
    if ((isTagged || isMarkerDeployed) && !bytesMatch) {
      throw new Error(`Refusing to replace deployed DAR: ${lockKey}`);
    }
  } else if (decision.kind === 'deployed' || isTagged) {
    throw new Error(
      `Deployed DAR backup is missing and cannot be recreated implicitly: ${lockKey}`
    );
  }

  let replacedBackupPath: string | undefined;
  let stagedPath: string | undefined;
  if (!bytesMatch) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    stagedPath = `${destPath}.tmp-${process.pid}`;
    fs.copyFileSync(sourcePath, stagedPath);
    if (fs.existsSync(destPath)) {
      replacedBackupPath = `${destPath}.previous-${process.pid}`;
      fs.renameSync(destPath, replacedBackupPath);
    }
    fs.renameSync(stagedPath, destPath);
    lock.packages[lockKey] = {
      sha256: sourceHash,
      size: sourceSize,
      sdkVersion: getSdkVersion(rootDir, pkg.sourceDir),
      uploadedAt: new Date().toISOString(),
      networks: [],
    };
  }

  lock.packages = Object.fromEntries(
    Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right))
  );

  try {
    saveDarsLock(rootDir, lock);
  } catch (error) {
    if (replacedBackupPath) {
      fs.rmSync(destPath, { force: true });
      fs.renameSync(replacedBackupPath, destPath);
    } else if (!existing) {
      fs.rmSync(destPath, { force: true });
    }
    throw error;
  } finally {
    if (stagedPath) fs.rmSync(stagedPath, { force: true });
  }
  if (replacedBackupPath) fs.rmSync(replacedBackupPath, { force: true });

  console.log(`${bytesMatch ? '✅ Reused' : '✅ Backed up'}: ${lockKey}`);
}

export function runBackupDarCli(args: string[] = process.argv.slice(2)): void {
  const rootDir = path.resolve(
    (() => {
      const idx = args.findIndex((arg) => arg === '--root');
      if (idx !== -1 && args[idx + 1]) return args[idx + 1]!;
      return process.cwd();
    })()
  );
  const packageArg = parsePackageArg(args);
  const version = parseVersionArg(args);
  const packages = discoverManagedPackages(rootDir);

  if (!packageArg || !version) {
    console.error('❌ Missing required arguments\n');
    console.error('Usage: canton-dev-tools backup-dar --package <name> --version <version>');
    console.error('\nPackages:');
    for (const pkg of packages)
      console.error(`  ${pkg.key.padEnd(24)} → ${pkg.name} v${pkg.version}`);
    process.exit(1);
  }

  try {
    backupDar({ rootDir, packageArg, version });
  } catch (error) {
    console.error(`❌ Backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

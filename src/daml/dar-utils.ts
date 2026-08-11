/** Shared utilities for DAR file management. Used by upload scripts and backup scripts. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DarsLockEntry {
  sha256: string;
  size: number;
  sdkVersion: string;
  uploadedAt: string;
  networks: string[];
}

export interface DarsLock {
  version: number;
  packages: Record<string, DarsLockEntry>;
}

/** Compare lock entries by value without depending on JSON object key order. */
export function darLockEntriesEqual(left: DarsLockEntry, right: DarsLockEntry): boolean {
  const leftNetworks = [...left.networks].sort();
  const rightNetworks = [...right.networks].sort();
  return (
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.sdkVersion === right.sdkVersion &&
    left.uploadedAt === right.uploadedAt &&
    leftNetworks.length === rightNetworks.length &&
    leftNetworks.every((network, index) => network === rightNetworks[index])
  );
}

/** Error thrown when DAR integrity verification fails. */
export class DarIntegrityError extends Error {
  constructor(
    message: string,
    public readonly lockKey: string,
    public readonly expectedHash: string,
    public readonly actualHash: string
  ) {
    super(message);
    this.name = 'DarIntegrityError';
  }
}

/** Get the path to the dars directory. */
export function getDarsDir(rootDir: string): string {
  return path.join(rootDir, 'dars');
}

/** Load the dars.lock file. */
export function loadDarsLock(rootDir: string): DarsLock {
  const lockPath = path.join(getDarsDir(rootDir), 'dars.lock');

  if (!fs.existsSync(lockPath)) {
    return { version: 1, packages: {} };
  }

  const content = fs.readFileSync(lockPath, 'utf-8');

  try {
    const parsed: unknown = JSON.parse(content);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      typeof parsed.version !== 'number' ||
      !('packages' in parsed) ||
      typeof parsed.packages !== 'object' ||
      parsed.packages === null
    ) {
      throw new Error(`Invalid dars.lock format at ${lockPath}`);
    }

    return parsed as DarsLock;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Failed to parse dars.lock at ${lockPath}: ${message}`);
    throw new Error('Corrupted dars.lock file. Please restore from backup or delete to reset.');
  }
}

/** Save the dars.lock file. */
export function saveDarsLock(rootDir: string, lock: DarsLock): void {
  const lockPath = path.join(getDarsDir(rootDir), 'dars.lock');
  const lockDir = path.dirname(lockPath);
  const tempPath = path.join(lockDir, `dars.lock.tmp-${process.pid}-${Date.now()}`);
  const data = `${JSON.stringify(lock, null, 2)}\n`;

  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, lockPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/** Compute SHA256 hash of a file. */
export function computeSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(fileBuffer);
  return hash.digest('hex');
}

/** Get the lock key for a DAR file. Always uses forward slashes for consistency across platforms. */
export function getDarLockKey(packageName: string, version: string, darName: string): string {
  const key = path.join(packageName, version, `${darName}.dar`);
  return key.replace(/\\/g, '/');
}

/** Find all DAR files in a directory recursively. */
export function findDarFiles(darsDir: string): string[] {
  const files: string[] = [];

  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith('.dar')) {
        files.push(fullPath);
      }
    }
  }

  scanDir(darsDir);
  return files;
}

/**
 * Check if a backed-up DAR exists and return its path. Returns null if no backed-up DAR exists or file is missing.
 * Throws DarIntegrityError if the file exists but hash doesn't match.
 */
export function getBackedUpDarPath(
  rootDir: string,
  packageName: string,
  version: string,
  darName: string
): string | null {
  const lockKey = getDarLockKey(packageName, version, darName);
  const lock = loadDarsLock(rootDir);

  if (!(lockKey in lock.packages)) {
    return null;
  }

  const darPath = path.join(getDarsDir(rootDir), lockKey);
  if (!fs.existsSync(darPath)) {
    console.warn(`⚠️ DAR recorded in dars.lock but file missing: ${lockKey}`);
    return null;
  }

  const actualHash = computeSha256(darPath);
  const expectedHash = lock.packages[lockKey]?.sha256;
  if (!expectedHash || actualHash !== expectedHash) {
    throw new DarIntegrityError(
      `Hash mismatch for backed-up DAR: ${lockKey}. ` +
        `Expected ${expectedHash ?? '(missing)'}, got ${actualHash}. ` +
        `The DAR file may have been tampered with.`,
      lockKey,
      expectedHash ?? '',
      actualHash
    );
  }

  return darPath;
}

/**
 * Get the path to a freshly built DAR file (from .daml/dist/).
 *
 * @param sourcePackageDir Repo-relative folder that contains the built DAR under `.daml/dist/`
 *   (typically `generated/build/<packageName>`).
 */
export function getFreshDarPath(
  rootDir: string,
  sourcePackageDir: string,
  version: string,
  darName: string
): string | null {
  const freshPath = path.join(
    rootDir,
    sourcePackageDir,
    '.daml',
    'dist',
    `${darName}-${version}.dar`
  );
  return fs.existsSync(freshPath) ? freshPath : null;
}

/**
 * Require a backed-up DAR file to exist and be verified. This is the strict mode - it will NOT fall back to fresh
 * builds.
 */
export function requireBackedUpDar(
  rootDir: string,
  packageName: string,
  version: string,
  darName: string
): string {
  try {
    const backedUpPath = getBackedUpDarPath(rootDir, packageName, version, darName);
    if (backedUpPath) {
      console.log(`📦 Using backed-up DAR: ${path.relative(rootDir, backedUpPath)}`);
      return backedUpPath;
    }
  } catch (error) {
    if (error instanceof DarIntegrityError) {
      console.error(`❌ ${error.message}`);
      console.error('   This is a security concern. Please investigate before proceeding.');
      process.exit(1);
    }
    throw error;
  }

  console.error(`❌ DAR not backed up: ${packageName} v${version}`);
  console.error('   Backups are required before upload to ensure reproducibility.');
  console.error(
    `   Run first: canton-dev-tools backup-dar --package ${packageName} --version ${version}`
  );
  process.exit(1);
}

/**
 * @deprecated Use requireBackedUpDar instead. Prefer backed-up DAR; fall back to fresh build.
 */
export function getDarPath(
  rootDir: string,
  packageName: string,
  version: string,
  darName: string
): string {
  try {
    const backedUpPath = getBackedUpDarPath(rootDir, packageName, version, darName);
    if (backedUpPath) {
      console.log(`📦 Using backed-up DAR: ${path.relative(rootDir, backedUpPath)}`);
      return backedUpPath;
    }
  } catch (error) {
    if (error instanceof DarIntegrityError) {
      console.error(`❌ ${error.message}`);
      console.error('   This is a security concern. Please investigate before proceeding.');
      process.exit(1);
    }
    throw error;
  }

  const freshPath = path.join(rootDir, packageName, '.daml', 'dist', `${darName}-${version}.dar`);
  console.warn(`⚠️ No backed-up DAR found for ${packageName} v${version}`);
  console.warn('   Using freshly built DAR from .daml/dist/');
  console.warn('   This behavior is deprecated. Please backup first.');

  if (!fs.existsSync(freshPath)) {
    console.error(`❌ DAR file not found: ${freshPath}`);
    console.error('Run "npm run build" first to build the DAR.');
    process.exit(1);
  }

  return freshPath;
}

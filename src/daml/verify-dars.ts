/**
 * Verify DAR integrity: checks that all DAR files in dars/ match hashes in dars.lock.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeSha256,
  findDarFiles,
  getDarsDir,
  loadDarsLock,
  saveDarsLock,
  type DarsLockEntry,
} from './dar-utils';

export interface VerifyDarsOptions {
  rootDir: string;
  update?: boolean;
}

export interface VerificationResult {
  verified: number;
  missing: number;
  mismatch: number;
  sizeMismatch: number;
  untracked: number;
  errors: string[];
}

export function verifyDars(options: VerifyDarsOptions): VerificationResult {
  const rootDir = path.resolve(options.rootDir);
  const update = options.update ?? false;
  const darsDir = getDarsDir(rootDir);
  const lock = loadDarsLock(rootDir);
  const darFiles = findDarFiles(darsDir);
  const checkedPaths = new Set<string>();

  const result: VerificationResult = {
    verified: 0,
    missing: 0,
    mismatch: 0,
    sizeMismatch: 0,
    untracked: 0,
    errors: [],
  };

  for (const [lockKey, entry] of Object.entries(lock.packages)) {
    const darPath = path.join(darsDir, lockKey);
    checkedPaths.add(darPath);

    if (!fs.existsSync(darPath)) {
      console.error(`❌ Missing DAR: ${lockKey}`);
      result.errors.push(`Missing DAR file: ${lockKey} (recorded in dars.lock but file not found)`);
      result.missing++;
      continue;
    }

    const actualHash = computeSha256(darPath);
    const actualStats = fs.statSync(darPath);

    if (actualHash !== entry.sha256) {
      console.error(`❌ Hash mismatch: ${lockKey}`);
      console.error(`   Expected: ${entry.sha256}`);
      console.error(`   Actual:   ${actualHash}`);
      result.errors.push(
        `Hash mismatch for ${lockKey}:\n` +
          `  Expected (dars.lock): ${entry.sha256}\n` +
          `  Actual (file):        ${actualHash}\n` +
          `  This DAR file has been modified without updating dars.lock!`
      );
      result.mismatch++;

      if (update) {
        console.log('   📝 Updating hash in dars.lock');
        entry.sha256 = actualHash;
        entry.size = actualStats.size;
      }
    } else if (actualStats.size !== entry.size) {
      console.warn(`⚠️ Size mismatch (hash matches): ${lockKey}`);
      console.warn(`   Expected: ${entry.size} bytes`);
      console.warn(`   Actual:   ${actualStats.size} bytes`);

      if (update) {
        console.log('   📝 Updating size in dars.lock');
        entry.size = actualStats.size;
      }
      result.sizeMismatch++;
      result.verified++;
    } else {
      console.log(`✅ ${lockKey}`);
      result.verified++;
    }
  }

  for (const darPath of darFiles) {
    if (!checkedPaths.has(darPath)) {
      const relativePath = path.relative(darsDir, darPath).replace(/\\/g, '/');
      console.error(`❌ Untracked DAR: ${relativePath}`);
      result.errors.push(
        `Untracked DAR file: ${relativePath}\n` +
          `  This file exists in dars/ but is not recorded in dars.lock.\n` +
          `  Use 'canton-dev-tools backup-dar' to properly add new DAR files.`
      );
      result.untracked++;

      if (update) {
        console.log('   📝 Adding to dars.lock');
        const hash = computeSha256(darPath);
        const stats = fs.statSync(darPath);
        lock.packages[relativePath] = {
          sha256: hash,
          size: stats.size,
          sdkVersion: 'unknown',
          uploadedAt: new Date().toISOString(),
          networks: [],
        };
      }
    }
  }

  if (update && (result.mismatch > 0 || result.sizeMismatch > 0 || result.untracked > 0)) {
    const sortedPackages: Record<string, DarsLockEntry> = {};
    Object.keys(lock.packages)
      .sort()
      .forEach((key) => {
        const entry = lock.packages[key];
        if (entry) sortedPackages[key] = entry;
      });
    lock.packages = sortedPackages;

    saveDarsLock(rootDir, lock);
    console.log('\n📝 dars.lock has been updated');
  }

  return result;
}

export function runVerifyDarsCli(options: VerifyDarsOptions): void {
  console.log('🔍 Verifying DAR file integrity...\n');

  const result = verifyDars(options);
  const hasErrors = result.errors.length > 0;
  const packageCount = result.verified + result.missing + result.mismatch;

  console.log('\n--- Summary ---');
  console.log(`Verified: ${result.verified}`);
  if (result.missing > 0) console.log(`Missing:  ${result.missing}`);
  if (result.mismatch > 0) console.log(`Mismatch: ${result.mismatch}`);
  if (result.sizeMismatch > 0) console.log(`Size fixed: ${result.sizeMismatch}`);
  if (result.untracked > 0) console.log(`Untracked: ${result.untracked}`);

  if (packageCount === 0 && !hasErrors) {
    console.log('\nℹ️ No DAR files backed up yet. This is OK for a fresh setup.');
    return;
  }

  if (hasErrors && !options.update) {
    console.error(`\n${'─'.repeat(60)}`);
    console.error(`\n❌ Verification failed with ${result.errors.length} error(s)\n`);
    console.error('To fix these issues:');
    console.error(
      '  1. If changes were intentional, run: canton-dev-tools backup-dar --package <name> --version <version>'
    );
    console.error('  2. If changes were accidental, restore the original DAR files');
    console.error('  3. Never modify backed-up DAR files directly');
    console.error('  4. Run with --update to fix dars.lock (use with caution)\n');
    process.exit(1);
  }

  if (!hasErrors) {
    console.log('\n✅ All DAR files verified successfully!');
  }
}

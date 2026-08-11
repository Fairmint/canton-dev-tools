/**
 * CI backwards compatibility checker using `dpm upgrade-check`.
 *
 * Compares the current build against committed backups. Package discovery uses
 * `multi-package.yaml` (Test packages excluded by default).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeSha256, getDarLockKey, getDarsDir, loadDarsLock } from './dar-utils';
import { discoverManagedPackages, type PackageConfig } from './packages';

export interface CheckUpgradeCompatibilityOptions {
  rootDir: string;
  /** Exact daml.yaml package names that skip lineage upgrade-check. */
  skipLineageUpgradeCheck?: ReadonlySet<string>;
}

/**
 * Empty by default: any backwards-incompatible change must be expressed as a major version bump.
 */
const DEFAULT_SKIP_LINEAGE_UPGRADE_CHECK = new Set<string>([]);

function parsePackageName(name: string): { baseName: string; majorVersion: number | null } {
  const match = /^(.+)-v(\d+)$/.exec(name);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { baseName: match[1], majorVersion: parseInt(match[2], 10) };
  }
  return { baseName: name, majorVersion: null };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

interface BackupRecord {
  packageName: string;
  version: string;
  darPath: string;
  lockKey: string;
}

function getBackedUpPackages(rootDir: string): Map<string, BackupRecord[]> {
  const lock = loadDarsLock(rootDir);
  const darsDir = getDarsDir(rootDir);
  const byPackageName = new Map<string, BackupRecord[]>();

  for (const [lockKey] of Object.entries(lock.packages)) {
    const parts = lockKey.split('/');
    if (parts.length !== 3) continue;

    const [packageName, version] = parts;
    if (!packageName || !version) continue;
    const darPath = path.join(darsDir, lockKey);
    if (!fs.existsSync(darPath)) continue;

    if (!byPackageName.has(packageName)) {
      byPackageName.set(packageName, []);
    }
    byPackageName.get(packageName)!.push({ packageName, version, darPath, lockKey });
  }

  return byPackageName;
}

function sortBackupsDesc(backups: BackupRecord[]): BackupRecord[] {
  return [...backups].sort((a, b) => compareSemver(b.version, a.version));
}

function getMostRecentOlderBackup(
  backups: BackupRecord[],
  currentVersion: string
): BackupRecord | null {
  const older = backups.filter((b) => compareSemver(currentVersion, b.version) > 0);
  if (older.length === 0) return null;
  return sortBackupsDesc(older)[0] ?? null;
}

function verifyBackupAgainstLock(rootDir: string, backup: BackupRecord): void {
  const lock = loadDarsLock(rootDir);
  const entry = lock.packages[backup.lockKey];
  if (!entry) {
    throw new Error(`No dars.lock entry for baseline backup ${backup.lockKey}`);
  }
  if (!fs.existsSync(backup.darPath)) {
    throw new Error(`Baseline backup missing on disk: ${backup.lockKey}`);
  }
  const actualHash = computeSha256(backup.darPath);
  const actualSize = fs.statSync(backup.darPath).size;
  if (actualHash !== entry.sha256 || actualSize !== entry.size) {
    throw new Error(
      `Baseline backup failed integrity check for ${backup.lockKey}: ` +
        `expected ${entry.sha256}/${entry.size}, got ${actualHash}/${actualSize}`
    );
  }
}

function getCurrentDar(
  rootDir: string,
  pkg: PackageConfig
): { darPath: string; version: string } | null {
  const darPath = path.join(
    rootDir,
    pkg.buildDir,
    '.daml',
    'dist',
    `${pkg.darName}-${pkg.version}.dar`
  );
  if (!fs.existsSync(darPath)) return null;
  return { darPath, version: pkg.version };
}

function reportUpgradeFailure(packageName: string, baseName: string, output: string): void {
  console.error(`❌ ${packageName}: NOT backwards compatible!\n`);
  console.error('   Upgrade check output (full log):');
  const lines = output.split('\n');
  const indent = (s: string): void => {
    console.error(`   ${s}`);
  };
  const maxLines = 100;
  if (lines.length <= maxLines) {
    for (const line of lines) indent(line);
  } else {
    indent(`(${lines.length} lines; showing first ${maxLines / 2} and last ${maxLines / 2})`);
    for (const line of lines.slice(0, maxLines / 2)) indent(line);
    indent('...');
    for (const line of lines.slice(-(maxLines / 2))) indent(line);
  }
  console.error('');
  console.error(
    `   If this was a non-breaking change, bump the patch in daml.yaml (e.g. upgrade-package --package ${baseName} --type minor).`
  );
  console.error('   To introduce breaking changes, bump the major version:');
  console.error(`   upgrade-package --package ${baseName} --type major\n`);
}

function isMissingDpmError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const execError = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (execError.code === 'ENOENT' || execError.errno === 'ENOENT') return true;
  const message = typeof execError.message === 'string' ? execError.message : '';
  return /\bENOENT\b/.test(message) && /\bdpm\b/i.test(message);
}

function runUpgradeCheck(oldDar: string, newDar: string): { success: boolean; output: string } {
  try {
    const output = execFileSync('dpm', ['upgrade-check', '--both', oldDar, newDar], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${process.env['HOME']}/.dpm/bin:${process.env['PATH']}` },
    });
    return { success: true, output };
  } catch (error: unknown) {
    if (isMissingDpmError(error)) {
      throw new Error(
        'dpm not found on PATH (also checked ~/.dpm/bin). Install the Daml SDK / dpm before running upgrade-check.'
      );
    }
    const execError = error as { stdout?: string; stderr?: string };
    return {
      success: false,
      output: (execError.stdout ?? '') + (execError.stderr ?? ''),
    };
  }
}

export function checkUpgradeCompatibility(options: CheckUpgradeCompatibilityOptions): void {
  const rootDir = path.resolve(options.rootDir);
  const skipLineage = options.skipLineageUpgradeCheck ?? DEFAULT_SKIP_LINEAGE_UPGRADE_CHECK;

  console.log('🔍 Checking DAML package upgrade compatibility...\n');

  const backedUpByPackageName = getBackedUpPackages(rootDir);
  const currentPackages = discoverManagedPackages(rootDir);

  let hasFailures = false;
  let checkedCount = 0;
  let skippedCount = 0;

  for (const pkg of currentPackages) {
    const currentDar = getCurrentDar(rootDir, pkg);
    if (!currentDar) {
      console.log(`⏭️  Skipping ${pkg.name} (no built DAR found at ${pkg.buildDir}/.daml/dist)`);
      skippedCount++;
      continue;
    }

    const currentPackageName = pkg.name;
    const { baseName } = parsePackageName(currentPackageName);

    const lock = loadDarsLock(rootDir);
    const darsDir = getDarsDir(rootDir);
    const currentLockKey = getDarLockKey(
      currentPackageName,
      currentDar.version,
      currentPackageName
    );
    const committedBackupPath = path.join(darsDir, currentLockKey);
    if (!(currentLockKey in lock.packages)) {
      console.error(`❌ ${currentPackageName}: No dars.lock entry for the current release.\n`);
      console.error(`   Expected key: ${currentLockKey}`);
      console.error('   Build the package, then run:');
      console.error(
        `   canton-dev-tools backup-dar --package ${pkg.key} --version ${currentDar.version}`
      );
      console.error('   then commit dars/ and dars.lock.\n');
      hasFailures = true;
      checkedCount++;
      continue;
    }

    const lockEntry = lock.packages[currentLockKey];
    if (!lockEntry) {
      hasFailures = true;
      checkedCount++;
      continue;
    }

    if (!fs.existsSync(committedBackupPath)) {
      console.error(
        `❌ ${currentPackageName}: dars.lock lists ${currentLockKey} but the file is missing on disk.\n`
      );
      console.error(`   Expected file: ${committedBackupPath}`);
      console.error('   Restore from git or re-run backup-dar and commit.\n');
      hasFailures = true;
      checkedCount++;
      continue;
    }

    const builtHash = computeSha256(currentDar.darPath);
    if (builtHash !== lockEntry.sha256) {
      console.error(
        `❌ ${currentPackageName}: Built DAR does not match the committed backup in dars/.\n`
      );
      console.error(`   Lock key: ${currentLockKey}`);
      console.error(`   Expected (dars.lock): ${lockEntry.sha256}`);
      console.error(`   Actual (build):       ${builtHash}`);
      console.error('');
      console.error('   The tree under dars/ must be the exact DAR for this daml.yaml version.');
      console.error('   After `npm run build`, run backup-dar for this package and commit.\n');
      hasFailures = true;
      checkedCount++;
      continue;
    }

    console.log(
      `✅ ${currentPackageName} v${currentDar.version}: Built DAR matches committed backup (${currentLockKey})`
    );

    const backupsForPackage = backedUpByPackageName.get(currentPackageName) ?? [];
    const upgradeBaseline = getMostRecentOlderBackup(backupsForPackage, currentDar.version);

    if (upgradeBaseline) {
      if (skipLineage.has(currentPackageName)) {
        console.log(
          `⏭️  ${currentPackageName}: Skipping lineage upgrade-check v${upgradeBaseline.version} → v${currentDar.version} (configured skip).\n`
        );
      } else {
        try {
          verifyBackupAgainstLock(rootDir, upgradeBaseline);
        } catch (error) {
          console.error(`❌ ${error instanceof Error ? error.message : String(error)}\n`);
          hasFailures = true;
          checkedCount++;
          continue;
        }
        console.log(
          `🔄 Running upgrade-check: v${upgradeBaseline.version} (backup) → v${currentDar.version} (current build)...`
        );
        const result = runUpgradeCheck(upgradeBaseline.darPath, currentDar.darPath);
        if (!result.success) {
          reportUpgradeFailure(currentPackageName, baseName, result.output);
          hasFailures = true;
          checkedCount++;
          continue;
        }
        console.log(
          `✅ ${currentPackageName}: upgrade-check OK (v${upgradeBaseline.version} → v${currentDar.version})\n`
        );
      }
    } else {
      console.log(
        `✅ ${currentPackageName}: No older backed-up version to upgrade-check (first release in dars/)\n`
      );
    }

    checkedCount++;
  }

  console.log('---');
  console.log(`📊 Summary: ${checkedCount} checked, ${skippedCount} skipped`);

  if (hasFailures) {
    throw new Error(
      'Upgrade compatibility check failed! Fix the issues above or bump the major version for breaking changes.'
    );
  }

  console.log('\n✅ All packages are backwards compatible.');
}

export function runCheckUpgradeCompatibilityCli(args: string[] = process.argv.slice(2)): void {
  try {
    let rootDir = process.cwd();
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--root' && args[index + 1]) {
        rootDir = args[++index]!;
      }
    }
    checkUpgradeCompatibility({ rootDir });
  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Sync pinned Splice DARs (and optionally Canton admin protos) into a consumer repo.
 *
 * Requires a JSON config (default `splice-dars.json` in the repo root) so each consumer
 * owns SPLICE_REF + REQUIRED_DARS. Env overrides: SPLICE_REPO, SPLICE_REF, CANTON_SPLICE_DARS_CONFIG.
 */

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RequiredDar {
  file: string;
  sha256: string;
}

export interface SyncSpliceDarsConfig {
  spliceRepo?: string;
  spliceRef: string;
  requiredDars: RequiredDar[];
  /** Relative to repo root. Default: libs/splice/daml/dars */
  darsRelativeDir?: string;
  /** Relative to repo root. Default: libs/splice/canton/community/admin-api/src/main/protobuf */
  adminProtoRelativeDir?: string;
  /** Upstream path inside the Splice clone. */
  adminProtoSourceDir?: string;
  /** Relative marker file under adminProtoRelativeDir that must exist after sync. */
  adminProtoPackageService?: string;
  syncAdminProtos?: boolean;
}

export interface SyncSpliceDarsOptions {
  rootDir: string;
  configPath?: string;
  force?: boolean;
  config?: SyncSpliceDarsConfig;
}

interface SyncState {
  spliceRef: string;
  dars: Record<string, string>;
  adminProtos?: boolean;
}

const DEFAULT_ADMIN_PROTO_SOURCE_DIR = 'canton/community/admin-api/src/main/protobuf';
const DEFAULT_ADMIN_PROTO_PACKAGE_SERVICE =
  'com/digitalasset/canton/admin/participant/v30/package_service.proto';
const DEFAULT_DARS_RELATIVE_DIR = 'libs/splice/daml/dars';
const DEFAULT_ADMIN_PROTO_RELATIVE_DIR = 'libs/splice/canton/community/admin-api/src/main/protobuf';
const SYNC_STATE_FILENAME = '.canton-splice-sync-state.json';

function resolveConfigPath(rootDir: string, configPath?: string): string {
  if (configPath) return path.resolve(configPath);
  if (process.env['CANTON_SPLICE_DARS_CONFIG']) {
    return path.resolve(process.env['CANTON_SPLICE_DARS_CONFIG']);
  }
  return path.join(rootDir, 'splice-dars.json');
}

export function loadSyncSpliceDarsConfig(configPath: string): SyncSpliceDarsConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Splice DAR config not found: ${configPath}\n` +
        'Create splice-dars.json (or pass --config) with spliceRef + requiredDars.\n' +
        'See README for the expected shape.'
    );
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid splice DAR config (expected object): ${configPath}`);
  }
  const spliceRef = Reflect.get(parsed, 'spliceRef');
  const requiredDars = Reflect.get(parsed, 'requiredDars');
  if (typeof spliceRef !== 'string' || !spliceRef) {
    throw new Error(`splice-dars config missing spliceRef: ${configPath}`);
  }
  if (!Array.isArray(requiredDars) || requiredDars.length === 0) {
    throw new Error(`splice-dars config missing requiredDars: ${configPath}`);
  }
  for (const dar of requiredDars) {
    if (
      typeof dar !== 'object' ||
      dar === null ||
      typeof Reflect.get(dar, 'file') !== 'string' ||
      typeof Reflect.get(dar, 'sha256') !== 'string'
    ) {
      throw new Error(`Invalid requiredDars entry in ${configPath}`);
    }
    assertSafeRelativePath(String(Reflect.get(dar, 'file')), 'requiredDars.file');
  }
  for (const [key, label] of [
    ['darsRelativeDir', 'darsRelativeDir'],
    ['adminProtoRelativeDir', 'adminProtoRelativeDir'],
    ['adminProtoSourceDir', 'adminProtoSourceDir'],
    ['adminProtoPackageService', 'adminProtoPackageService'],
  ] as const) {
    const value = Reflect.get(parsed, key);
    if (value !== undefined) {
      if (typeof value !== 'string') {
        throw new Error(`Invalid ${label} in ${configPath}`);
      }
      assertSafeRelativePath(value, label);
    }
  }
  return parsed as SyncSpliceDarsConfig;
}

function runGit(args: string[], cwd?: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'inherit',
  });
}

function computeSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function verifyFile(filePath: string, expectedSha256: string): boolean {
  return fs.existsSync(filePath) && computeSha256(filePath) === expectedSha256;
}

/** Reject absolute paths and `..` / empty / `.` segments that escape an expected root. */
export function assertSafeRelativePath(relativePath: string, label: string): void {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe ${label}: ${relativePath}`);
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.')) {
    throw new Error(`Unsafe ${label}: ${relativePath}`);
  }
}

export function resolveContainedPath(root: string, relativePath: string, label: string): string {
  assertSafeRelativePath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe ${label} escapes root: ${relativePath}`);
  }
  return resolved;
}

/** Resolve a config-relative directory that must stay strictly inside `root`. */
function resolveSyncRelativeDir(
  root: string,
  relativeDir: string | undefined,
  fallback: string,
  label: string
): string {
  const relative = relativeDir || fallback;
  const resolved = resolveContainedPath(root, relative, label);
  if (resolved === path.resolve(root)) {
    throw new Error(`Unsafe ${label}: ${relative}`);
  }
  return resolved;
}

function effectiveSpliceRef(config: SyncSpliceDarsConfig): string {
  return process.env['SPLICE_REF'] ?? config.spliceRef;
}

function syncStatePath(darsDir: string): string {
  return path.join(darsDir, SYNC_STATE_FILENAME);
}

function readSyncState(darsDir: string): SyncState | null {
  const stateFile = syncStatePath(darsDir);
  if (!fs.existsSync(stateFile)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const spliceRef = Reflect.get(parsed, 'spliceRef');
    const dars = Reflect.get(parsed, 'dars');
    if (typeof spliceRef !== 'string' || typeof dars !== 'object' || dars === null) return null;
    return parsed as SyncState;
  } catch {
    return null;
  }
}

function writeSyncState(darsDir: string, config: SyncSpliceDarsConfig): void {
  const state: SyncState = {
    spliceRef: effectiveSpliceRef(config),
    dars: Object.fromEntries(config.requiredDars.map((dar) => [dar.file, dar.sha256])),
    adminProtos: config.syncAdminProtos !== false,
  };
  fs.writeFileSync(syncStatePath(darsDir), `${JSON.stringify(state, null, 2)}\n`);
}

function syncStateMatches(darsDir: string, config: SyncSpliceDarsConfig): boolean {
  const state = readSyncState(darsDir);
  if (!state) return false;
  if (state.spliceRef !== effectiveSpliceRef(config)) return false;
  if (Boolean(state.adminProtos) !== (config.syncAdminProtos !== false)) return false;
  for (const dar of config.requiredDars) {
    if (state.dars[dar.file] !== dar.sha256) return false;
  }
  for (const file of Object.keys(state.dars)) {
    if (!config.requiredDars.some((dar) => dar.file === file)) return false;
  }
  return true;
}

function checkExistingFiles(
  rootDir: string,
  config: SyncSpliceDarsConfig,
  force: boolean
): boolean {
  const darsDir = resolveSyncRelativeDir(
    rootDir,
    config.darsRelativeDir,
    DEFAULT_DARS_RELATIVE_DIR,
    'darsRelativeDir'
  );
  const adminProtoDir = resolveSyncRelativeDir(
    rootDir,
    config.adminProtoRelativeDir,
    DEFAULT_ADMIN_PROTO_RELATIVE_DIR,
    'adminProtoRelativeDir'
  );
  const packageService = config.adminProtoPackageService || DEFAULT_ADMIN_PROTO_PACKAGE_SERVICE;
  const syncAdminProtos = config.syncAdminProtos !== false;

  let needsSync = false;
  const errors: string[] = [];

  for (const dar of config.requiredDars) {
    const targetPath = resolveContainedPath(darsDir, dar.file, 'requiredDars.file');

    if (!fs.existsSync(targetPath)) {
      needsSync = true;
      continue;
    }

    const actualSha256 = computeSha256(targetPath);
    if (actualSha256 !== dar.sha256) {
      needsSync = true;
      if (!force) {
        errors.push(
          `${path.relative(rootDir, targetPath)} expected ${dar.sha256}, got ${actualSha256}`
        );
      }
    }
  }

  if (errors.length > 0) {
    const details = errors.map((error) => `  - ${error}`).join('\n');
    throw new Error(
      `Splice DAR hash mismatch. Refusing to overwrite existing files without --force.\n${details}`
    );
  }

  if (syncAdminProtos) {
    const packageServicePath = resolveContainedPath(
      adminProtoDir,
      packageService,
      'adminProtoPackageService'
    );
    if (!fs.existsSync(packageServicePath)) {
      needsSync = true;
    }
  }

  if (!syncStateMatches(darsDir, config)) {
    needsSync = true;
  }

  return needsSync;
}

function syncSpliceDarsFiles(rootDir: string, config: SyncSpliceDarsConfig): void {
  const spliceRepo =
    process.env['SPLICE_REPO'] ??
    config.spliceRepo ??
    'https://github.com/canton-network/splice.git';
  const spliceRef = effectiveSpliceRef(config);
  const darsDir = resolveSyncRelativeDir(
    rootDir,
    config.darsRelativeDir,
    DEFAULT_DARS_RELATIVE_DIR,
    'darsRelativeDir'
  );
  const adminProtoDir = resolveSyncRelativeDir(
    rootDir,
    config.adminProtoRelativeDir,
    DEFAULT_ADMIN_PROTO_RELATIVE_DIR,
    'adminProtoRelativeDir'
  );
  const adminProtoSourceRelative =
    config.adminProtoSourceDir || DEFAULT_ADMIN_PROTO_SOURCE_DIR;
  const packageService = config.adminProtoPackageService || DEFAULT_ADMIN_PROTO_PACKAGE_SERVICE;
  const syncAdminProtos = config.syncAdminProtos !== false;

  // Validate source/package paths before any clone or filesystem mutation.
  assertSafeRelativePath(adminProtoSourceRelative, 'adminProtoSourceDir');
  assertSafeRelativePath(packageService, 'adminProtoPackageService');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-dev-tools-splice-dars-'));
  const cloneDir = path.join(tempDir, 'splice');

  try {
    console.log(`Fetching Splice DARs from ${spliceRepo} at ${spliceRef}`);
    runGit(['clone', '--filter=blob:none', '--sparse', '--no-checkout', spliceRepo, cloneDir]);
    runGit(['checkout', spliceRef], cloneDir);
    const sparsePaths = syncAdminProtos
      ? ['daml/dars', adminProtoSourceRelative]
      : ['daml/dars'];
    runGit(['sparse-checkout', 'set', ...sparsePaths], cloneDir);

    fs.mkdirSync(darsDir, { recursive: true });

    for (const dar of config.requiredDars) {
      const sourcePath = resolveContainedPath(
        path.join(cloneDir, 'daml/dars'),
        dar.file,
        'requiredDars.file'
      );
      const targetPath = resolveContainedPath(darsDir, dar.file, 'requiredDars.file');

      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Missing upstream Splice DAR: daml/dars/${dar.file}`);
      }

      const sourceSha256 = computeSha256(sourcePath);
      if (sourceSha256 !== dar.sha256) {
        throw new Error(
          `Hash mismatch for upstream ${dar.file}: expected ${dar.sha256}, got ${sourceSha256}`
        );
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
      if (!verifyFile(targetPath, dar.sha256)) {
        throw new Error(`Hash mismatch after copying ${dar.file}`);
      }
    }

    if (syncAdminProtos) {
      const sourceAdminProtoDir = resolveContainedPath(
        cloneDir,
        adminProtoSourceRelative,
        'adminProtoSourceDir'
      );
      const sourcePackageServiceProto = resolveContainedPath(
        sourceAdminProtoDir,
        packageService,
        'adminProtoPackageService'
      );
      if (!fs.existsSync(sourcePackageServiceProto)) {
        throw new Error(
          `Missing upstream Canton admin proto: ${adminProtoSourceRelative}/${packageService}`
        );
      }
      // Replace destination so stale upstream deletions do not linger.
      // adminProtoDir was containment-checked above before any delete.
      fs.rmSync(adminProtoDir, { recursive: true, force: true });
      fs.mkdirSync(adminProtoDir, { recursive: true });
      fs.cpSync(sourceAdminProtoDir, adminProtoDir, { recursive: true });
    }

    writeSyncState(darsDir, config);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(
    `Synced ${config.requiredDars.length} Splice DARs into ${path.relative(rootDir, darsDir)}` +
      (syncAdminProtos
        ? ` and Canton admin protos into ${path.relative(rootDir, adminProtoDir)}.`
        : '.')
  );
}

export function syncSpliceDars(options: SyncSpliceDarsOptions): void {
  const rootDir = path.resolve(options.rootDir);
  const force = options.force ?? false;
  const config =
    options.config ?? loadSyncSpliceDarsConfig(resolveConfigPath(rootDir, options.configPath));

  for (const dar of config.requiredDars) {
    assertSafeRelativePath(dar.file, 'requiredDars.file');
  }

  if (!force && !checkExistingFiles(rootDir, config, force)) {
    console.log('Splice DARs already present and verified.');
    return;
  }

  syncSpliceDarsFiles(rootDir, config);
}

export function runSyncSpliceDarsCli(args: string[] = process.argv.slice(2)): void {
  try {
    let rootDir = process.cwd();
    let configPath: string | undefined;
    const force = args.includes('--force');
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--root' && args[index + 1]) rootDir = args[++index]!;
      if (args[index] === '--config' && args[index + 1]) configPath = args[++index]!;
    }
    syncSpliceDars({ rootDir, configPath, force });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

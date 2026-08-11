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

const DEFAULT_ADMIN_PROTO_SOURCE_DIR = 'canton/community/admin-api/src/main/protobuf';
const DEFAULT_ADMIN_PROTO_PACKAGE_SERVICE =
  'com/digitalasset/canton/admin/participant/v30/package_service.proto';
const DEFAULT_DARS_RELATIVE_DIR = 'libs/splice/daml/dars';
const DEFAULT_ADMIN_PROTO_RELATIVE_DIR = 'libs/splice/canton/community/admin-api/src/main/protobuf';

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

function checkExistingFiles(
  rootDir: string,
  config: SyncSpliceDarsConfig,
  force: boolean
): boolean {
  const darsDir = path.join(rootDir, config.darsRelativeDir ?? DEFAULT_DARS_RELATIVE_DIR);
  const adminProtoDir = path.join(
    rootDir,
    config.adminProtoRelativeDir ?? DEFAULT_ADMIN_PROTO_RELATIVE_DIR
  );
  const packageService = config.adminProtoPackageService ?? DEFAULT_ADMIN_PROTO_PACKAGE_SERVICE;
  const syncAdminProtos = config.syncAdminProtos !== false;

  let needsSync = false;
  const errors: string[] = [];

  for (const dar of config.requiredDars) {
    const targetPath = path.join(darsDir, dar.file);

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
    console.error(
      'Splice DAR hash mismatch. Refusing to overwrite existing files without --force.'
    );
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  if (syncAdminProtos && !fs.existsSync(path.join(adminProtoDir, packageService))) {
    needsSync = true;
  }

  return needsSync;
}

function syncSpliceDarsFiles(rootDir: string, config: SyncSpliceDarsConfig): void {
  const spliceRepo =
    process.env['SPLICE_REPO'] ??
    config.spliceRepo ??
    'https://github.com/canton-network/splice.git';
  const spliceRef = process.env['SPLICE_REF'] ?? config.spliceRef;
  const darsDir = path.join(rootDir, config.darsRelativeDir ?? DEFAULT_DARS_RELATIVE_DIR);
  const adminProtoDir = path.join(
    rootDir,
    config.adminProtoRelativeDir ?? DEFAULT_ADMIN_PROTO_RELATIVE_DIR
  );
  const adminProtoSourceDir = config.adminProtoSourceDir ?? DEFAULT_ADMIN_PROTO_SOURCE_DIR;
  const packageService = config.adminProtoPackageService ?? DEFAULT_ADMIN_PROTO_PACKAGE_SERVICE;
  const syncAdminProtos = config.syncAdminProtos !== false;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-dev-tools-splice-dars-'));
  const cloneDir = path.join(tempDir, 'splice');

  try {
    console.log(`Fetching Splice DARs from ${spliceRepo} at ${spliceRef}`);
    runGit(['clone', '--filter=blob:none', '--sparse', '--no-checkout', spliceRepo, cloneDir]);
    runGit(['checkout', spliceRef], cloneDir);
    const sparsePaths = syncAdminProtos ? ['daml/dars', adminProtoSourceDir] : ['daml/dars'];
    runGit(['sparse-checkout', 'set', ...sparsePaths], cloneDir);

    fs.mkdirSync(darsDir, { recursive: true });

    for (const dar of config.requiredDars) {
      const sourcePath = path.join(cloneDir, 'daml/dars', dar.file);
      const targetPath = path.join(darsDir, dar.file);

      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Missing upstream Splice DAR: daml/dars/${dar.file}`);
      }

      const sourceSha256 = computeSha256(sourcePath);
      if (sourceSha256 !== dar.sha256) {
        throw new Error(
          `Hash mismatch for upstream ${dar.file}: expected ${dar.sha256}, got ${sourceSha256}`
        );
      }

      fs.copyFileSync(sourcePath, targetPath);
      if (!verifyFile(targetPath, dar.sha256)) {
        throw new Error(`Hash mismatch after copying ${dar.file}`);
      }
    }

    if (syncAdminProtos) {
      const sourceAdminProtoDir = path.join(cloneDir, adminProtoSourceDir);
      const sourcePackageServiceProto = path.join(sourceAdminProtoDir, packageService);
      if (!fs.existsSync(sourcePackageServiceProto)) {
        throw new Error(
          `Missing upstream Canton admin proto: ${adminProtoSourceDir}/${packageService}`
        );
      }
      fs.cpSync(sourceAdminProtoDir, adminProtoDir, { recursive: true });
    }
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

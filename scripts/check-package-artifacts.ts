#!/usr/bin/env tsx

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface NpmPackFile {
  path: string;
  size: number;
  mode: number;
}

interface NpmPackResult {
  id: string;
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  filename: string;
  files: NpmPackFile[];
}

const DEFAULT_MAX_UNPACKED_BYTES = 5 * 1024 * 1024;
const configuredMaxUnpackedBytes = process.env['MAX_PACKAGE_UNPACKED_BYTES'];
const maxUnpackedBytes = parseMaxUnpackedBytes(configuredMaxUnpackedBytes);

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function parseMaxUnpackedBytes(rawValue: string | undefined): number {
  const parsedValue = rawValue === undefined ? DEFAULT_MAX_UNPACKED_BYTES : Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(
      `MAX_PACKAGE_UNPACKED_BYTES must be a positive integer in bytes, got ${JSON.stringify(rawValue)}`
    );
  }

  return parsedValue;
}

function forbiddenPackagePathReason(packagePath: string): string | null {
  if (packagePath.endsWith('.dar')) return 'DAML DAR files are not runtime package artifacts';
  if (packagePath === 'fixtures' || packagePath.startsWith('fixtures/')) {
    return 'internal fixtures (including DAR lifecycle sources) must not be published';
  }
  if (packagePath === 'internal' || packagePath.startsWith('internal/')) {
    return 'internal CI-only assets must not be published';
  }
  if (packagePath === 'libs' || packagePath.startsWith('libs/')) {
    return 'submodules under libs/ must not be published';
  }
  if (packagePath === 'node_modules' || packagePath.startsWith('node_modules/')) {
    return 'node_modules must not be published';
  }
  if (packagePath === 'core' || packagePath.startsWith('core.')) {
    return 'crash dumps must not be published';
  }
  return null;
}

function parsePackResults(stdout: string): NpmPackResult[] {
  try {
    return JSON.parse(stdout) as NpmPackResult[];
  } catch (error) {
    throw new Error(
      `npm pack did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function spawnFailureDetails(command: string, result: SpawnSyncReturns<string>): string {
  const details = [`status ${result.status ?? 'unknown'}`];

  if (result.signal) {
    details.push(`signal ${result.signal}`);
  }
  if (result.error) {
    details.push(`error ${result.error.message}`);
  }

  return `${command} failed (${details.join(', ')})`;
}

function throwIfSpawnFailed(command: string, result: SpawnSyncReturns<string>): void {
  if (result.status === 0 && !result.signal && !result.error) {
    return;
  }

  if (result.stderr) {
    console.error(result.stderr);
  }
  if (result.stdout) {
    console.error(result.stdout);
  }

  throw new Error(spawnFailureDetails(command, result));
}

function readPackageConfigPins(): {
  quickstartRef: string;
  spliceVersion: string;
  scribeVersion: string;
  protocolVersion: string;
} {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    config?: {
      localnet_quickstart_ref?: string;
      localnet_splice_version?: string;
      localnet_scribe_version?: string;
      localnet_protocol_version?: string;
    };
  };

  const quickstartRef = pkg.config?.localnet_quickstart_ref;
  const spliceVersion = pkg.config?.localnet_splice_version;
  const scribeVersion = pkg.config?.localnet_scribe_version;
  const protocolVersion = pkg.config?.localnet_protocol_version;
  if (!quickstartRef || !spliceVersion || !scribeVersion || !protocolVersion) {
    throw new Error(
      'package.json config must define localnet_quickstart_ref, localnet_splice_version, localnet_scribe_version, and localnet_protocol_version'
    );
  }

  return { quickstartRef, spliceVersion, scribeVersion, protocolVersion };
}

function verifyPackagedLocalnetPins(): void {
  const localnetBin = readFileSync(join(process.cwd(), 'bin', 'canton-dev-tools'), 'utf8');
  const { quickstartRef, spliceVersion, scribeVersion, protocolVersion } = readPackageConfigPins();

  const expectedDefaults: Array<[string, string]> = [
    ['DEFAULT_QUICKSTART_REF', quickstartRef],
    ['DEFAULT_SPLICE_VERSION', spliceVersion],
    ['DEFAULT_SCRIBE_VERSION', scribeVersion],
    ['DEFAULT_PROTOCOL_VERSION', protocolVersion],
  ];

  for (const [name, value] of expectedDefaults) {
    if (!localnetBin.includes(`${name}="${value}"`)) {
      throw new Error(
        `bin/canton-dev-tools must hardcode ${name}="${value}" for npx pin ownership`
      );
    }
  }
}

function verifyPackagedLocalnetBinary(): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-package-'));

  try {
    const packageRoot = join(tempDir, 'node_modules', '@fairmint', 'canton-dev-tools');
    const binDir = join(tempDir, 'node_modules', '.bin');
    const localnetBin = join(packageRoot, 'bin', 'canton-dev-tools');
    const localnetSymlink = join(binDir, 'canton-dev-tools');

    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    cpSync(join(process.cwd(), 'bin'), join(packageRoot, 'bin'), { recursive: true });
    cpSync(join(process.cwd(), 'scripts'), join(packageRoot, 'scripts'), { recursive: true });
    chmodSync(localnetBin, 0o755);
    symlinkSync('../@fairmint/canton-dev-tools/bin/canton-dev-tools', localnetSymlink);

    const logs = spawnSync(localnetSymlink, ['diagnostics'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CANTON_LOCALNET_CACHE_DIR: join(tempDir, 'cache'),
        HOME: join(tempDir, 'home'),
      },
    });
    throwIfSpawnFailed('packaged canton-dev-tools diagnostics', logs);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

verifyPackagedLocalnetPins();

const prepack = spawnSync('npm', ['run', 'prepack'], {
  encoding: 'utf8',
});
throwIfSpawnFailed('npm run prepack', prepack);

const packArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];
const pack = spawnSync('npm', packArgs, {
  encoding: 'utf8',
});
throwIfSpawnFailed(`npm ${packArgs.join(' ')}`, pack);

const [result] = parsePackResults(pack.stdout);
if (!result) {
  throw new Error('npm pack returned no package metadata');
}

const errors: string[] = [];

if (result.unpackedSize > maxUnpackedBytes) {
  errors.push(
    `package unpacked size ${formatBytes(result.unpackedSize)} exceeds limit ${formatBytes(maxUnpackedBytes)}`
  );
}

const packagePaths = new Set(result.files.map((file) => file.path));
for (const requiredPath of [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/testing/index.js',
  'dist/testing/index.d.ts',
  'dist/daml/index.js',
  'dist/daml/index.d.ts',
  'dist/cli.js',
  'bin/canton-dev-tools',
  'scripts/localnet-cloud.sh',
  'scripts/install-dpm-sdks.sh',
]) {
  if (!packagePaths.has(requiredPath)) {
    errors.push(`package is missing required runtime entry ${requiredPath}`);
  }
}

for (const file of result.files) {
  const reason = forbiddenPackagePathReason(file.path);
  if (reason) {
    errors.push(`${file.path}: ${reason}`);
  }
}

if (errors.length > 0) {
  console.error(`\n${result.name}@${result.version} package artifact check failed:\n`);
  for (const error of errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exit(1);
}

verifyPackagedLocalnetBinary();

console.log(
  `✓ ${result.name}@${result.version} package artifact is ${formatBytes(result.unpackedSize)} unpacked across ${result.files.length} files`
);

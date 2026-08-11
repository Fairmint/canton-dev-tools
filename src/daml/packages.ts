/**
 * Discover DAML packages from `multi-package.yaml` + each package's `daml.yaml`.
 *
 * Repo-local `packages.ts` / PACKAGE_DEFS shims are not required for the shared CLI.
 * Generated-package npm metadata (publish suffixes, index flags) stays consumer-local.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { isContractNetwork, type ContractNetwork } from './types';

export interface PackageConfig {
  /** Stable CLI key derived from the source directory basename (lowercase). */
  key: string;
  /** DAML package name from daml.yaml (e.g. `WrappedAssets-v01`). */
  name: string;
  /** DAR file name without extension (same as name). */
  darName: string;
  /** Current version from daml.yaml. */
  version: string;
  /** Source directory relative to repo root. */
  sourceDir: string;
  /** Generated build directory relative to repo root. */
  buildDir: string;
}

export interface DiscoverPackagesOptions {
  /**
   * When false (default for policy/backup/compat tools), skip packages whose name or
   * source directory basename is `Test` (case-insensitive).
   */
  includeTest?: boolean;
  /** Relative build root used for `buildDir` (default `generated/build`). */
  buildRoot?: string;
}

interface DamlPackageMetadata {
  name?: string;
  version?: string;
}

function readYamlFile<T>(filePath: string): T {
  return yaml.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function isTestPackage(pkg: Pick<PackageConfig, 'name' | 'sourceDir'>): boolean {
  const sourceBase = path.basename(pkg.sourceDir);
  return pkg.name.toLowerCase() === 'test' || sourceBase.toLowerCase() === 'test';
}

function packageKeyFromSourceDir(sourceDir: string): string {
  return path.basename(sourceDir).toLowerCase();
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Discover packages declared in `multi-package.yaml` at `rootDir`. */
export function discoverPackages(
  rootDir: string,
  options: DiscoverPackagesOptions = {}
): PackageConfig[] {
  const buildRoot = options.buildRoot ?? 'generated/build';
  const includeTest = options.includeTest ?? true;
  const manifestPath = path.join(rootDir, 'multi-package.yaml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`multi-package.yaml not found at ${manifestPath}`);
  }

  const manifest = readYamlFile<{ packages?: string[] }>(manifestPath);
  const sourcePackages = manifest.packages ?? [];
  const packages: PackageConfig[] = [];

  for (const sourceDir of sourcePackages) {
    const damlYamlPath = path.join(rootDir, sourceDir, 'daml.yaml');
    if (!fs.existsSync(damlYamlPath)) {
      throw new Error(`daml.yaml not found: ${damlYamlPath}`);
    }
    const metadata = readYamlFile<DamlPackageMetadata>(damlYamlPath);
    if (!metadata.name || !metadata.version) {
      throw new Error(`${damlYamlPath} is missing required name/version fields`);
    }

    const pkg: PackageConfig = {
      key: packageKeyFromSourceDir(sourceDir),
      name: metadata.name,
      darName: metadata.name,
      version: metadata.version,
      sourceDir,
      buildDir: path.join(buildRoot, metadata.name),
    };

    if (!includeTest && isTestPackage(pkg)) {
      continue;
    }
    packages.push(pkg);
  }

  return packages;
}

/** Managed (non-Test) packages — used by backup / version-policy / upgrade-compat. */
export function discoverManagedPackages(
  rootDir: string,
  options: Omit<DiscoverPackagesOptions, 'includeTest'> = {}
): PackageConfig[] {
  return discoverPackages(rootDir, { ...options, includeTest: false });
}

export function findPackage(
  packages: readonly PackageConfig[],
  keyOrName: string
): PackageConfig | undefined {
  const query = keyOrName.trim();
  if (!query) return undefined;

  const lower = query.toLowerCase();
  const exact = packages.find(
    (pkg) =>
      pkg.key === lower ||
      pkg.name.toLowerCase() === lower ||
      pkg.sourceDir.toLowerCase() === lower ||
      path.basename(pkg.sourceDir).toLowerCase() === lower
  );
  if (exact) return exact;

  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) return undefined;

  const fuzzy = packages.filter((pkg) => {
    const candidates = [pkg.key, pkg.name, pkg.sourceDir, path.basename(pkg.sourceDir)].map(
      normalizeToken
    );
    return candidates.some(
      (candidate) =>
        candidate === normalizedQuery ||
        candidate.startsWith(normalizedQuery) ||
        normalizedQuery.startsWith(candidate)
    );
  });

  if (fuzzy.length === 1) {
    return fuzzy[0];
  }
  if (fuzzy.length > 1) {
    const labels = fuzzy.map((pkg) => `${pkg.key} (${pkg.name})`).join(', ');
    throw new Error(`Ambiguous package "${query}"; matches: ${labels}`);
  }
  return undefined;
}

export function requirePackage(
  packages: readonly PackageConfig[],
  keyOrName: string
): PackageConfig {
  const pkg = findPackage(packages, keyOrName);
  if (!pkg) {
    throw new Error(
      `Unknown package: ${keyOrName}. Known: ${packages.map((candidate) => candidate.key).join(', ')}`
    );
  }
  return pkg;
}

export function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (idx === -1) return undefined;
  const arg = args[idx];
  if (arg === undefined) return undefined;
  if (arg.startsWith(`${flag}=`)) {
    return arg.slice(flag.length + 1);
  }
  return args[idx + 1];
}

export function parseNetworkArg(
  args: string[] = process.argv.slice(2)
): ContractNetwork | undefined {
  const value = parseFlagValue(args, '--network') ?? parseFlagValue(args, '-n');
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return isContractNetwork(lower) ? lower : undefined;
}

export function parsePackageArg(args: string[] = process.argv.slice(2)): string | undefined {
  return parseFlagValue(args, '--package') ?? parseFlagValue(args, '-p');
}

export function parseVersionArg(args: string[] = process.argv.slice(2)): string | undefined {
  return parseFlagValue(args, '--version') ?? parseFlagValue(args, '-v');
}

export function parseRootArg(args: string[] = process.argv.slice(2)): string {
  const root = parseFlagValue(args, '--root') ?? process.cwd();
  return path.resolve(root);
}

export function printPackageUsage(
  scriptName: string,
  packages: readonly PackageConfig[],
  errorMessage?: string
): void {
  if (errorMessage) {
    console.error(`❌ ${errorMessage}`);
    console.error('');
  }
  console.error(`Usage: canton-dev-tools ${scriptName} --package <package> [--version <version>]`);
  console.error('');
  console.error('Packages:');
  for (const pkg of packages) {
    console.error(`  ${pkg.key.padEnd(24)} → ${pkg.name} v${pkg.version}`);
  }
}

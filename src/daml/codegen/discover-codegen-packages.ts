import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { discoverManagedPackages, type PackageConfig } from '../packages';
import { resolveContainedPath } from '../sync-splice-dars';

export interface CodegenPackageConfig extends PackageConfig {
  /** Absolute path to generated/build/<name> (where `dpm codegen-js` runs). */
  absoluteBuildDir: string;
  /** Absolute path to generated/js/<name>-<version>. */
  absoluteGeneratedJsDir: string;
  /** Absolute path to generated/js/<name>-<version>/lib. */
  absoluteGeneratedLibDir: string;
}

interface DamlYamlCodegen {
  codegen?: {
    js?: {
      'output-directory'?: string;
      'npm-scope'?: string;
    };
  };
}

export interface DiscoverCodegenPackagesOptions {
  rootDir: string;
  /** Relative generated JS root (default `generated/js`). */
  generatedJsRoot?: string;
}

/** Discover managed packages that declare `codegen.js` in daml.yaml. */
export function discoverCodegenPackages(
  options: DiscoverCodegenPackagesOptions
): CodegenPackageConfig[] {
  const rootDir = path.resolve(options.rootDir);
  const generatedJsRoot = options.generatedJsRoot ?? 'generated/js';
  const packages = discoverManagedPackages(rootDir);
  const result: CodegenPackageConfig[] = [];

  for (const pkg of packages) {
    // Prefer prepared build copy (output-directory already rewritten); fall back to source.
    const buildDamlYaml = path.join(rootDir, pkg.buildDir, 'daml.yaml');
    const sourceDamlYaml = path.join(rootDir, pkg.sourceDir, 'daml.yaml');
    const damlYamlPath = fs.existsSync(buildDamlYaml) ? buildDamlYaml : sourceDamlYaml;
    if (!fs.existsSync(damlYamlPath)) {
      continue;
    }

    const damlYaml = yaml.parse(fs.readFileSync(damlYamlPath, 'utf8')) as DamlYamlCodegen;
    if (!damlYaml.codegen?.js) {
      continue;
    }

    const generatedJsDir = path.join(rootDir, generatedJsRoot, `${pkg.name}-${pkg.version}`);
    resolveContainedPath(
      rootDir,
      path.relative(rootDir, generatedJsDir),
      'generated js package dir'
    );

    result.push({
      ...pkg,
      absoluteBuildDir: path.join(rootDir, pkg.buildDir),
      absoluteGeneratedJsDir: generatedJsDir,
      absoluteGeneratedLibDir: path.join(generatedJsDir, 'lib'),
    });
  }

  return result;
}

/**
 * Resolve published npm name for a codegen package.
 *
 * - `publishNameSuffix: null` → root package name
 * - `publishNameSuffix: 'reports'` → `${root}-reports`
 * - omitted → root package name when only one codegen package; otherwise `${root}-${key}`
 */
export function buildPublishedPackageName(
  rootPackageName: string,
  suffix: string | null | undefined,
  fallbackKey?: string
): string {
  if (suffix === null || suffix === undefined) {
    if (suffix === null) return rootPackageName;
    return fallbackKey ? `${rootPackageName}-${fallbackKey}` : rootPackageName;
  }
  return `${rootPackageName}-${suffix}`;
}

export interface CodegenPublishSuffixMap {
  /** Map daml package name or key → suffix (`null` = root package name). */
  [packageNameOrKey: string]: string | null;
}

/** Read optional publish suffix map from package.json `cantonDevTools.codegenPublishSuffixes`. */
export function readCodegenPublishSuffixes(rootDir: string): CodegenPublishSuffixMap {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return {};
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    cantonDevTools?: { codegenPublishSuffixes?: CodegenPublishSuffixMap };
  };
  return packageJson.cantonDevTools?.codegenPublishSuffixes ?? {};
}

export function resolvePublishedPackageName(options: {
  rootPackageName: string;
  pkg: PackageConfig;
  suffixes: CodegenPublishSuffixMap;
  codegenPackageCount: number;
}): string {
  const { rootPackageName, pkg, suffixes, codegenPackageCount } = options;
  if (Object.prototype.hasOwnProperty.call(suffixes, pkg.name)) {
    return buildPublishedPackageName(rootPackageName, suffixes[pkg.name]);
  }
  if (Object.prototype.hasOwnProperty.call(suffixes, pkg.key)) {
    return buildPublishedPackageName(rootPackageName, suffixes[pkg.key]);
  }
  // Single codegen package (canton-assets / ocp): publish as the root package name.
  if (codegenPackageCount === 1) {
    return rootPackageName;
  }
  return buildPublishedPackageName(rootPackageName, undefined, pkg.key);
}

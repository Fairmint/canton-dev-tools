/**
 * Prepare a generated multi-package build tree from source packages.
 *
 * Copies each package from `multi-package.yaml` into `generated/build/<name>/`,
 * rewrites sibling package references, and writes a build-time multi-package.yaml.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { assertSafeRelativePath, resolveContainedPath } from './sync-splice-dars';

export interface PrepareBuildOptions {
  rootDir: string;
}

interface DamlYaml {
  name?: string;
  dependencies?: string[];
  'data-dependencies'?: string[];
  codegen?: { js?: { 'output-directory'?: string } };
}

/** Fixed relative build destination; kept in sync with packages.ts buildDir. */
const BUILD_ROOT_RELATIVE = 'generated/build';

function readYamlFile<T>(file: string): T {
  return yaml.parse(fs.readFileSync(file, 'utf8')) as T;
}

function copyDir(source: string, target: string): void {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      return !relative.split(path.sep).some((part) => part === '.daml' || part === 'lib');
    },
  });
}

function rewriteDependency(
  dependency: string,
  currentSourceDir: string,
  rootDir: string,
  packageNames: Map<string, string>
): string {
  // Keep non-relative entries (package ids, absolute paths) unchanged.
  if (!dependency.startsWith('.')) return dependency;

  const currentSourcePath = path.resolve(rootDir, currentSourceDir);
  const resolved = path.resolve(currentSourcePath, dependency);
  const normalizedResolved = resolved.replace(/\\/g, '/');

  // Prefer longer source dirs so OpenCapTable wins over OpenCap prefixes.
  const sourceDirs = [...packageNames.keys()].sort((left, right) => right.length - left.length);
  for (const sourceDir of sourceDirs) {
    const packageName = packageNames.get(sourceDir);
    if (!packageName) continue;
    const packagePath = path.resolve(rootDir, sourceDir);
    if (resolved === packagePath || resolved.startsWith(`${packagePath}${path.sep}`)) {
      const rest = path.relative(packagePath, resolved).split(path.sep).join('/');
      return rest ? `../${packageName}/${rest}` : `../${packageName}`;
    }
  }

  const libsPath = path.resolve(rootDir, 'libs');
  if (resolved === libsPath || resolved.startsWith(`${libsPath}${path.sep}`)) {
    const rest = path.relative(libsPath, resolved).split(path.sep).join('/');
    // generated/build/<pkg> -> repo root libs/
    return rest ? `../../../libs/${rest}` : '../../../libs';
  }

  // Leave unresolved relative paths alone (caller may still fail later at build time).
  void normalizedResolved;
  return dependency;
}

/** Require `candidate` to resolve strictly inside `rootDir` (not the root itself). */
export function assertPathInsideRoot(rootDir: string, candidate: string, label: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must resolve inside the repo root (got ${candidate})`);
  }
  return resolved;
}

export function prepareBuild(options: PrepareBuildOptions): string[] {
  const rootDir = path.resolve(options.rootDir);
  const sourceManifest = path.join(rootDir, 'multi-package.yaml');
  const buildRoot = assertPathInsideRoot(
    rootDir,
    path.join(rootDir, BUILD_ROOT_RELATIVE),
    'build root'
  );

  const manifest = readYamlFile<{ packages?: string[] }>(sourceManifest);
  const sourcePackages = manifest.packages ?? [];
  const packageNames = new Map<string, string>();

  for (const sourceDir of sourcePackages) {
    assertSafeRelativePath(sourceDir, 'multi-package.yaml packages entry');
    const sourcePath = resolveContainedPath(rootDir, sourceDir, 'multi-package.yaml packages entry');
    const damlYamlPath = path.join(sourcePath, 'daml.yaml');
    const damlYaml = readYamlFile<DamlYaml>(damlYamlPath);
    if (!damlYaml.name) {
      throw new Error(`${damlYamlPath} is missing required name field`);
    }
    assertSafeRelativePath(damlYaml.name, 'daml.yaml name');
    packageNames.set(sourceDir, damlYaml.name);
  }

  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(buildRoot, { recursive: true });

  const generatedPackages: string[] = [];
  for (const sourceDir of sourcePackages) {
    const packageName = packageNames.get(sourceDir);
    if (!packageName) throw new Error(`Missing package name for ${sourceDir}`);

    const sourcePath = resolveContainedPath(rootDir, sourceDir, 'multi-package.yaml packages entry');
    const targetPath = resolveContainedPath(buildRoot, packageName, 'daml.yaml name');
    assertPathInsideRoot(rootDir, targetPath, 'prepare-build target');
    copyDir(sourcePath, targetPath);

    const targetDamlYamlPath = path.join(targetPath, 'daml.yaml');
    const damlYaml = readYamlFile<DamlYaml>(targetDamlYamlPath);

    for (const key of ['dependencies', 'data-dependencies'] as const) {
      const deps = damlYaml[key];
      if (Array.isArray(deps)) {
        damlYaml[key] = deps.map((dependency) =>
          rewriteDependency(dependency, sourceDir, rootDir, packageNames)
        );
      }
    }

    if (damlYaml.codegen?.js?.['output-directory']) {
      damlYaml.codegen.js['output-directory'] = '../../js';
    }

    fs.writeFileSync(targetDamlYamlPath, yaml.stringify(damlYaml));
    generatedPackages.push(packageName);
  }

  fs.writeFileSync(
    path.join(buildRoot, 'multi-package.yaml'),
    yaml.stringify({ packages: generatedPackages })
  );
  console.log(
    `Prepared ${generatedPackages.length} DAML packages in ${path.relative(rootDir, buildRoot)}`
  );
  return generatedPackages;
}

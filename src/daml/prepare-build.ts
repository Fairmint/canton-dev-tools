/**
 * Prepare a generated multi-package build tree from source packages.
 *
 * Copies each package from `multi-package.yaml` into `generated/build/<name>/`,
 * rewrites sibling package references, and writes a build-time multi-package.yaml.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

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

function rewritePackageReferences(value: string, packageNames: Map<string, string>): string {
  let rewritten = value;
  for (const [sourceDir, packageName] of packageNames) {
    rewritten = rewritten.split(`../${sourceDir}/`).join(`../${packageName}/`);
  }
  rewritten = rewritten.split('../libs/').join('../../../libs/');
  return rewritten;
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
    const damlYamlPath = path.join(rootDir, sourceDir, 'daml.yaml');
    const damlYaml = readYamlFile<DamlYaml>(damlYamlPath);
    if (!damlYaml.name) {
      throw new Error(`${damlYamlPath} is missing required name field`);
    }
    packageNames.set(sourceDir, damlYaml.name);
  }

  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(buildRoot, { recursive: true });

  const generatedPackages: string[] = [];
  for (const sourceDir of sourcePackages) {
    const packageName = packageNames.get(sourceDir);
    if (!packageName) throw new Error(`Missing package name for ${sourceDir}`);

    const sourcePath = path.join(rootDir, sourceDir);
    const targetPath = path.join(buildRoot, packageName);
    copyDir(sourcePath, targetPath);

    const targetDamlYamlPath = path.join(targetPath, 'daml.yaml');
    const damlYaml = readYamlFile<DamlYaml>(targetDamlYamlPath);

    for (const key of ['dependencies', 'data-dependencies'] as const) {
      const deps = damlYaml[key];
      if (Array.isArray(deps)) {
        damlYaml[key] = deps.map((dependency) =>
          rewritePackageReferences(dependency, packageNames)
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

/**
 * Generic DAML → JS codegen orchestration (Phase 1).
 *
 * Runs `dpm codegen-js` for packages with codegen.js, then:
 * update-generated-package → create-package-index → fix-splice-refs
 * on generated JS trees.
 *
 * Phase 2 (config-driven, separate CLI):
 * - bundle-dependencies
 * - create-root-index
 * - fix-splice-refs --target <merged-lib>
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFlagValue } from '../packages';
import type { PackageJson } from '../types';
import { createPackageIndexes } from './create-package-index';
import {
  discoverCodegenPackages,
  readCodegenPublishSuffixes,
  resolvePublishedPackageName,
  type CodegenPackageConfig,
} from './discover-codegen-packages';
import { fixSpliceRefs } from './fix-splice-refs';
import { updateGeneratedPackagesFromRoot } from './update-generated-package';

export interface CodegenJsOptions {
  rootDir: string;
  /** Skip `dpm codegen-js` (only run post-processing). */
  skipDpm?: boolean;
}

function dpmEnv(): NodeJS.ProcessEnv {
  const homeBin = process.env['HOME'] ? path.join(process.env['HOME'], '.dpm', 'bin') : undefined;
  const pathParts = [homeBin, process.env['PATH']].filter(Boolean);
  return { ...process.env, PATH: pathParts.join(path.delimiter) };
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    env: dpmEnv(),
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${command} ${args.join(' ')} terminated with signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

export interface CodegenJsResult {
  packages: CodegenPackageConfig[];
  updatedDirs: string[];
}

/** Run generic codegen-js steps for a multi-package DAML repo. */
export function runCodegenJs(options: CodegenJsOptions): CodegenJsResult {
  const rootDir = path.resolve(options.rootDir);
  const packages = discoverCodegenPackages({ rootDir });

  if (packages.length === 0) {
    throw new Error(
      `No packages with codegen.js found under ${rootDir}. ` +
        'Ensure prepare-build has run and daml.yaml declares codegen.js.'
    );
  }

  if (!options.skipDpm) {
    for (const pkg of packages) {
      if (!fs.existsSync(path.join(pkg.absoluteBuildDir, 'daml.yaml'))) {
        throw new Error(
          `Missing prepared build for ${pkg.name} at ${pkg.absoluteBuildDir}. Run prepare-build first.`
        );
      }
      console.log(`Running dpm codegen-js for ${pkg.name}...`);
      run('dpm', ['codegen-js'], pkg.absoluteBuildDir);
    }
  }

  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
  ) as PackageJson;
  if (!rootPackage.name) {
    throw new Error(`Root package.json missing name at ${rootDir}`);
  }

  const suffixes = readCodegenPublishSuffixes(rootDir);
  const updateTargets = packages
    .filter((pkg) => fs.existsSync(path.join(pkg.absoluteGeneratedJsDir, 'package.json')))
    .map((pkg) => ({
      dir: pkg.absoluteGeneratedJsDir,
      publishedPackageName: resolvePublishedPackageName({
        rootPackageName: rootPackage.name!,
        pkg,
        suffixes,
        codegenPackageCount: packages.length,
      }),
    }));

  const updatedDirs = updateGeneratedPackagesFromRoot({
    rootDir,
    packages: updateTargets,
    writeIndex: false,
  });

  createPackageIndexes({ packageDirs: updateTargets.map((target) => target.dir) });

  for (const pkg of packages) {
    if (!fs.existsSync(pkg.absoluteGeneratedLibDir)) {
      console.log(`Skipping fix-splice-refs for ${pkg.name} (no lib yet)`);
      continue;
    }
    // Generated trees are pre-bundle: namespace fix only (__bundled__ rewrite is a no-op).
    fixSpliceRefs({
      targetDir: pkg.absoluteGeneratedLibDir,
      rewriteFairmintScopedImports: true,
    });
  }

  console.log(
    `codegen-js complete for ${packages.map((pkg) => pkg.name).join(', ')}. ` +
      'Next: canton-dev-tools bundle-dependencies → create-root-index → ' +
      'fix-splice-refs --target <merged-lib> → build:ts.'
  );

  return { packages, updatedDirs };
}

export function runCodegenJsCli(args: string[]): void {
  const rootDir = path.resolve(parseFlagValue(args, '--root') ?? process.cwd());
  runCodegenJs({
    rootDir,
    skipDpm: args.includes('--skip-dpm'),
  });
}

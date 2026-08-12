import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackageJson } from '../types';
import { writeGeneratedPackageIndex } from './generated-package-index';

export interface GeneratedPackageUpdateTarget {
  /** Absolute path to the generated package directory (contains package.json). */
  dir: string;
  /** Published npm package name to write into the generated package.json. */
  publishedPackageName: string;
}

export interface UpdateGeneratedPackagesOptions {
  /** Root package name (used only for logging / validation). */
  rootPackageName: string;
  /** Version to stamp onto every generated package.json. */
  rootPackageVersion: string;
  /** Optional peerDependencies copied onto each generated package. */
  peerDependencies?: Record<string, string>;
  /** Packages to update. */
  packages: readonly GeneratedPackageUpdateTarget[];
  /** When true (default), also write index.js / index.d.ts. */
  writeIndex?: boolean;
}

/** Update generated package.json name/version/peers and optionally write package indexes. */
export function updateGeneratedPackages(options: UpdateGeneratedPackagesOptions): string[] {
  const updated: string[] = [];
  const writeIndex = options.writeIndex ?? true;

  for (const { dir, publishedPackageName } of options.packages) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    const generatedPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;

    generatedPackage.version = options.rootPackageVersion;
    generatedPackage.name = publishedPackageName;
    delete generatedPackage.private;

    generatedPackage.publishConfig ??= { access: 'public' };

    if (generatedPackage['peer-dependencies']) {
      generatedPackage.peerDependencies = {
        ...(generatedPackage.peerDependencies ?? {}),
        ...generatedPackage['peer-dependencies'],
      };
      delete generatedPackage['peer-dependencies'];
    }

    if (options.peerDependencies) {
      generatedPackage.peerDependencies = { ...options.peerDependencies };
    }

    fs.writeFileSync(packageJsonPath, `${JSON.stringify(generatedPackage, null, 4)}\n`);

    if (writeIndex) {
      writeGeneratedPackageIndex(dir);
    }

    updated.push(dir);
    console.log(
      `Updated generated package.json for ${options.rootPackageName}: ` +
        `name=${generatedPackage.name}, version=${generatedPackage.version}`
    );
    if (writeIndex) {
      console.log(`Created package index files (index.js and index.d.ts) in ${dir}`);
    }
  }

  return updated;
}

export interface UpdateGeneratedPackagesFromRootOptions {
  rootDir: string;
  packages: readonly GeneratedPackageUpdateTarget[];
  writeIndex?: boolean;
}

/** Convenience: read root package.json then update generated packages. */
export function updateGeneratedPackagesFromRoot(
  options: UpdateGeneratedPackagesFromRootOptions
): string[] {
  const rootPackagePath = path.join(options.rootDir, 'package.json');
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8')) as PackageJson;
  if (!rootPackage.name) {
    throw new Error(`Root package.json missing package name: ${rootPackagePath}`);
  }
  if (!rootPackage.version) {
    throw new Error(`Root package.json missing version: ${rootPackagePath}`);
  }

  return updateGeneratedPackages({
    rootPackageName: rootPackage.name,
    rootPackageVersion: rootPackage.version,
    peerDependencies: rootPackage.peerDependencies,
    packages: options.packages,
    writeIndex: options.writeIndex,
  });
}

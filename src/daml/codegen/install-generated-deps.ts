import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getErrorMessage, type PackageJson } from '../types';

export interface InstallGeneratedDepsOptions {
  /** Absolute path to `generated/js` (or equivalent). */
  generatedJsDir: string;
  /** npm argv after `npm` (default: `install --no-package-lock --silent`). */
  npmInstallArgs?: string[];
}

/** Install dependencies for each generated package under `generatedJsDir` that declares any. */
export function installGeneratedDeps(options: InstallGeneratedDepsOptions): void {
  const generatedJsDir = path.resolve(options.generatedJsDir);
  if (!fs.existsSync(generatedJsDir)) {
    throw new Error(`Generated JS directory not found: ${generatedJsDir}`);
  }

  const npmInstallArgs = options.npmInstallArgs ?? ['install', '--no-package-lock', '--silent'];

  const packages = fs
    .readdirSync(generatedJsDir)
    .filter((dir) => fs.existsSync(path.join(generatedJsDir, dir, 'package.json')))
    .map((dir) => path.join(generatedJsDir, dir));

  console.log(
    'Found packages:',
    packages.map((packageDir) => path.basename(packageDir))
  );

  for (const packageDir of packages) {
    const packageJsonPath = path.join(packageDir, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;

    const deps = packageJson.dependencies ? Object.keys(packageJson.dependencies) : [];
    if (deps.length > 0) {
      console.log(`Installing dependencies for ${path.basename(packageDir)}...`);
      try {
        execFileSync('npm', npmInstallArgs, {
          cwd: packageDir,
          stdio: 'inherit',
        });
        console.log(
          `✓ Dependencies installed for ${path.basename(packageDir)} (${deps.length} deps)`
        );
      } catch (error) {
        throw new Error(
          `Failed to install dependencies for ${path.basename(packageDir)}: ${getErrorMessage(error)}`
        );
      }
    } else {
      console.log(`Skipping ${path.basename(packageDir)} (no dependencies)`);
    }
  }

  console.log('All dependencies installed successfully!');
}

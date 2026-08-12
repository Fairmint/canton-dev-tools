import * as fs from 'node:fs';
import { writeGeneratedPackageIndex } from './generated-package-index';

export interface CreatePackageIndexOptions {
  /** Absolute paths to generated package directories that should receive index.js / index.d.ts. */
  packageDirs: readonly string[];
}

/** Write standalone package index files for each existing generated package directory. */
export function createPackageIndexes(options: CreatePackageIndexOptions): string[] {
  const created: string[] = [];
  for (const generatedDir of options.packageDirs) {
    if (!fs.existsSync(generatedDir)) continue;
    writeGeneratedPackageIndex(generatedDir);
    created.push(generatedDir);
    console.log(`Created package index files (index.js and index.d.ts) in ${generatedDir}`);
  }
  return created;
}

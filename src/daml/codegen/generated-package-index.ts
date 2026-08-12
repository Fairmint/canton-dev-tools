import * as fs from 'node:fs';
import * as path from 'node:path';

export const GENERATED_PACKAGE_INDEX_JS = `"use strict";

// Re-export everything from the lib directory
const lib = require('./lib/index.js');

// Export all properties from lib
Object.keys(lib).forEach(key => {
    exports[key] = lib[key];
});

// Also export the lib object itself for backward compatibility
exports.lib = lib;
`;

export const GENERATED_PACKAGE_INDEX_DTS = `// Re-export everything from the lib directory
export * from './lib/index';

// Also export the lib object itself for backward compatibility
import * as lib from './lib/index';
export { lib };
`;

export function writeGeneratedPackageIndex(generatedDir: string): void {
  fs.writeFileSync(path.join(generatedDir, 'index.js'), GENERATED_PACKAGE_INDEX_JS);
  fs.writeFileSync(path.join(generatedDir, 'index.d.ts'), GENERATED_PACKAGE_INDEX_DTS);
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getErrorMessage } from '../types';
import { collectGeneratedOutputFiles } from './generated-output-helpers';

/** Default unresolved-import patterns (assets / daml.js + @fairmint npm-scope). */
export const DEFAULT_UNRESOLVED_IMPORT_PATTERNS: readonly RegExp[] = [
  /require\(['"]@?daml\.js\/[^'"]+['"]\)/g,
  /from ['"]@?daml\.js\/[^'"]+['"]/g,
  /require\(['"]@fairmint\/(?:splice-|ghc-stdlib-|daml-stdlib-|daml-prim-)[^'"]+['"]\)/g,
  /from ['"]@fairmint\/(?:splice-|ghc-stdlib-|daml-stdlib-|daml-prim-)[^'"]+['"]/g,
];

/** daml.js-only patterns (repos that do not use npm-scope: fairmint). */
export const DAML_JS_UNRESOLVED_IMPORT_PATTERNS: readonly RegExp[] = [
  /require\(['"]@?daml\.js\/[^'"]+['"]\)/g,
  /from ['"]@?daml\.js\/[^'"]+['"]/g,
];

export interface UnresolvedImportIssue {
  file: string;
  matches: string[];
}

export interface VerifyPackageImportsOptions {
  /** Directory to scan (typically repo `lib/`). */
  libDir: string;
  /** Override forbidden unresolved import patterns. */
  unresolvedPatterns?: readonly RegExp[];
  /** When false, do not throw / exit — just return issues. Default true for CLI. */
  throwOnIssues?: boolean;
}

export function findUnresolvedPackageImports(
  options: VerifyPackageImportsOptions
): UnresolvedImportIssue[] {
  const libDir = path.resolve(options.libDir);
  const patterns = options.unresolvedPatterns ?? DEFAULT_UNRESOLVED_IMPORT_PATTERNS;
  const issues: UnresolvedImportIssue[] = [];

  for (const filePath of collectGeneratedOutputFiles(libDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const matches: string[] = [];

    for (const pattern of patterns) {
      // Clone so lastIndex does not leak across files for global regexes.
      const cloned = new RegExp(pattern.source, pattern.flags);
      const found = content.match(cloned);
      if (found) {
        matches.push(...found);
      }
    }

    if (matches.length > 0) {
      issues.push({
        file: path.relative(libDir, filePath),
        matches: [...new Set(matches)],
      });
    }
  }

  return issues;
}

/** Verify published lib has no unresolved daml.js / @fairmint codegen imports. */
export function verifyPackageImports(options: VerifyPackageImportsOptions): UnresolvedImportIssue[] {
  const libDir = path.resolve(options.libDir);
  console.log(`🔍 Checking for unresolved daml.js/ imports in ${libDir}...\n`);

  if (!fs.existsSync(libDir)) {
    throw new Error(`lib directory not found: ${libDir}. Run codegen first.`);
  }

  try {
    const issues = findUnresolvedPackageImports(options);

    if (issues.length > 0) {
      console.error('❌ Found unresolved daml.js/ or @fairmint codegen imports:\n');
      for (const issue of issues) {
        console.error(`  ${issue.file}:`);
        for (const match of issue.matches) {
          console.error(`    - ${match}`);
        }
        console.error('');
      }
      console.error(
        'These imports should have been replaced with relative paths by bundle-dependencies.'
      );
      if (options.throwOnIssues !== false) {
        throw new Error('Unresolved codegen imports remain in published lib');
      }
      return issues;
    }

    console.log('✅ No unresolved daml.js/ imports found. Package is ready for publish.');
    return issues;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unresolved codegen')) {
      throw error;
    }
    throw new Error(`Error checking imports: ${getErrorMessage(error)}`);
  }
}

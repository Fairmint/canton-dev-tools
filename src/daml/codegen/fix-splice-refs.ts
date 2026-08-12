import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyGeneratedImportRewrites,
  collectGeneratedOutputFiles,
  type GeneratedImportRewriteRule,
} from './generated-output-helpers';

export interface FixSpliceRefsOptions {
  /** Directory to walk (typically `lib/` or a generated package `lib/`). */
  targetDir: string;
  /**
   * When true (default), rewrite `@fairmint/*` and `daml.js/*` imports to relative
   * `__bundled__/<name>` paths when that directory exists under `targetDir`.
   * No-op when `__bundled__` is absent (pre-bundle generated trees).
   */
  rewriteFairmintScopedImports?: boolean;
}

function fixNestedNamespaceReferences(filePath: string, targetDir: string): boolean {
  let content = fs.readFileSync(filePath, 'utf8');

  const packageRegex = /var (pkg[a-f0-9]{64}) = require\('([^']+)'\);/g;
  const packages: Map<string, string> = new Map();

  let match: RegExpExecArray | null;
  while ((match = packageRegex.exec(content)) !== null) {
    const pkgVar = match[1];
    const modulePath = match[2];
    if (!pkgVar || !modulePath) continue;
    packages.set(pkgVar, modulePath);
  }

  let modified = false;
  for (const [pkgVar] of packages.entries()) {
    const usageRegex = new RegExp(
      `${pkgVar}\\.((?:[A-Z][A-Za-z0-9]*\\.)+)([A-Z][A-Za-z0-9_]*)`,
      'g'
    );

    const replacements = new Map<string, string>();
    let usageMatch: RegExpExecArray | null;
    while ((usageMatch = usageRegex.exec(content)) !== null) {
      const fullMatch = usageMatch[0];
      const namespacePath = usageMatch[1] ?? '';
      const typeName = usageMatch[2];
      if (!typeName) continue;

      if (namespacePath.includes('Splice.') || /^[A-Z][A-Za-z0-9]*V\d+\./.test(namespacePath)) {
        replacements.set(fullMatch, `${pkgVar}.${typeName}`);
      }
    }

    for (const [from, to] of replacements.entries()) {
      const beforeReplace = content;
      content = content.replace(new RegExp(from.replace(/\./g, '\\.'), 'g'), to);

      if (content !== beforeReplace) {
        modified = true;
        console.log(`  Fixed ${from} -> ${to} in ${path.relative(targetDir, filePath)}`);
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content);
  }
  return modified;
}

function stripTrailingSemver(packageName: string): string {
  return packageName.replace(/-\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]*)?$/, '');
}

function resolveBundledTarget(libRoot: string, importSpecifier: string): string | null {
  const match = importSpecifier.match(/^(?:@fairmint\/|@?daml\.js\/)(.+)$/);
  if (!match?.[1]) return null;

  const pkgName = match[1];
  const candidates = [pkgName, stripTrailingSemver(pkgName)];
  for (const candidate of candidates) {
    const dir = path.join(libRoot, '__bundled__', candidate);
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

function buildFairmintScopedRewriteRules(libRoot: string): GeneratedImportRewriteRule[] {
  const bundledRoot = path.join(libRoot, '__bundled__');
  if (!fs.existsSync(bundledRoot)) {
    return [];
  }

  const rules: GeneratedImportRewriteRule[] = [];
  const seen = new Set<string>();

  for (const filePath of collectGeneratedOutputFiles(libRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const importMatches = source.matchAll(
      /(?:require\(|from )['"](@fairmint\/[^'"]+|@?daml\.js\/[^'"]+)['"]/g
    );
    for (const importMatch of importMatches) {
      const specifier = importMatch[1];
      if (!specifier || seen.has(specifier)) continue;
      seen.add(specifier);

      const target = resolveBundledTarget(libRoot, specifier);
      if (!target) continue;

      rules.push({
        importPaths: [specifier],
        resolveTarget: () => target,
        logLabel: 'bundled dependency',
      });
    }
  }

  return rules;
}

/**
 * Fix Splice / module-namespace references in generated JS bindings.
 *
 * Works for packages required via relative paths or `@fairmint/*` (npm-scope).
 * Optionally rewrites remaining `@fairmint/*` / `daml.js/*` imports onto `__bundled__`
 * siblings when present (assets merged-lib behavior).
 */
export function fixSpliceRefs(options: FixSpliceRefsOptions): number {
  const targetDir = path.resolve(options.targetDir);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`fix-splice-refs target not found: ${targetDir}`);
  }

  console.log(`🔧 Fixing Splice API namespace references in ${targetDir}...`);

  let fixedCount = 0;
  for (const filePath of collectGeneratedOutputFiles(targetDir)) {
    if (fixNestedNamespaceReferences(filePath, targetDir)) {
      fixedCount++;
    }
  }

  const rewriteFairmint = options.rewriteFairmintScopedImports ?? true;
  if (rewriteFairmint) {
    const rules = buildFairmintScopedRewriteRules(targetDir);
    if (rules.length > 0) {
      const rewritten = applyGeneratedImportRewrites(targetDir, rules);
      fixedCount += rewritten;
      console.log(`  Rewrote ${rewritten} files with @fairmint/daml.js → __bundled__ paths`);
    }
  }

  console.log(`✅ Fixed ${fixedCount} files`);
  return fixedCount;
}

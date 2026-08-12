/**
 * Config-driven merged root `lib/` builder for published DAML→JS packages.
 *
 * Product-specific exports / template constants come from `daml-js-bundle.json`
 * (`rootIndex`); this engine never hardcodes package product names.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFlagValue } from '../packages';
import {
  assertSafeRelativePath,
  normalizeRelativePath,
  resolveContainedPath,
} from '../sync-splice-dars';
import { getErrorMessage } from '../types';
import { applyBundlePresets } from './bundle-dependencies';
import {
  copyDirectory,
  createDirectoryIfNotExists,
  ensureBundledDANamespaceIndexes,
  ensureBundledSpliceNamespaceIndexes,
  removeDirectoryIfExists,
} from './bundle-fs';
import { BUNDLE_PRESETS, type BundlePresetId } from './bundle-presets';
import {
  resolveDamlJsBundleConfig,
  type ResolvedDamlJsBundleConfig,
  type RootIndexConfig,
  type RootIndexTemplateEntry,
} from './daml-js-bundle-config';
import { discoverCodegenPackages, type CodegenPackageConfig } from './discover-codegen-packages';
import { applyGeneratedImportRewrites } from './generated-output-helpers';

export interface CreateRootIndexOptions {
  rootDir: string;
  configPath?: string;
}

function resolveSourcePackage(
  packages: CodegenPackageConfig[],
  selector: RootIndexConfig['sourcePackage']
): CodegenPackageConfig {
  const matches = packages.filter((pkg) => {
    if (selector.name && pkg.name === selector.name) return true;
    if (selector.key && pkg.key === selector.key) return true;
    if (selector.namePrefix && pkg.name.startsWith(selector.namePrefix)) return true;
    return false;
  });

  if (matches.length === 0) {
    throw new Error(
      `No codegen package matched rootIndex.sourcePackage ` +
        `(${JSON.stringify(selector)}). Run prepare-build / codegen-js first.`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple codegen packages matched rootIndex.sourcePackage ` +
        `(${JSON.stringify(selector)}): ${matches.map((pkg) => pkg.name).join(', ')}`
    );
  }
  return matches[0]!;
}

function jsVarName(modulePath: string, binding: string): string {
  const cleaned = modulePath
    .replace(/^\.\//, '')
    .replace(/\/module$/, '')
    .replace(/[^A-Za-z0-9]+/g, '_');
  return `${cleaned}_${binding}`.replace(/^_+/, '');
}

function renderTemplateConstantsJs(
  constants: Record<string, Record<string, RootIndexTemplateEntry>>
): { requires: string[]; exports: string[] } {
  const requires: string[] = [];
  const exports: string[] = [];
  const seenVars = new Set<string>();

  for (const [constName, entries] of Object.entries(constants)) {
    const fields: string[] = [];
    for (const [entryName, entry] of Object.entries(entries)) {
      const varName = jsVarName(entry.from, entry.binding);
      if (!seenVars.has(varName)) {
        seenVars.add(varName);
        requires.push(`var ${varName} = require('${entry.from}');`);
      }
      const field = entry.field ?? 'templateId';
      fields.push(`    ${entryName}: ${varName}.${entry.binding}.${field},`);
    }
    exports.push(
      `exports.${constName} = Object.freeze({\n${fields.join('\n')}\n});`
    );
  }

  return { requires, exports };
}

function renderTemplateConstantsDts(
  constants: Record<string, Record<string, RootIndexTemplateEntry>>
): { imports: string[]; declarations: string[] } {
  const imports: string[] = [];
  const declarations: string[] = [];
  const seenVars = new Set<string>();

  for (const [constName, entries] of Object.entries(constants)) {
    const fields: string[] = [];
    for (const [entryName, entry] of Object.entries(entries)) {
      const varName = jsVarName(entry.from, entry.binding);
      if (!seenVars.has(varName)) {
        seenVars.add(varName);
        imports.push(`import * as ${varName} from '${entry.from}';`);
      }
      const field = entry.field ?? 'templateId';
      fields.push(
        `  readonly ${entryName}: typeof ${varName}.${entry.binding}.${field};`
      );
    }
    declarations.push(
      `export declare const ${constName}: {\n${fields.join('\n')}\n};`
    );
  }

  return { imports, declarations };
}

function writeRootIndexFiles(
  destLib: string,
  namespaces: string[],
  templateConstants?: RootIndexConfig['templateConstants']
): void {
  const constants = templateConstants ?? {};
  const jsConstants = renderTemplateConstantsJs(constants);
  const dtsConstants = renderTemplateConstantsDts(constants);

  const namespaceRequires = namespaces
    .map(
      (ns) =>
        `var ${ns} = require('./${ns}');\nexports.${ns} = ${ns};`
    )
    .join('\n');

  const indexJs = `"use strict";
/* eslint-disable-next-line no-unused-vars */
function __export(m) {
/* eslint-disable-next-line no-prototype-builtins */
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
${namespaceRequires}
${jsConstants.requires.join('\n')}
${jsConstants.exports.join('\n')}
`;

  const namespaceImports = namespaces
    .map((ns) => `import * as ${ns} from './${ns}';`)
    .join('\n');
  const namespaceExport = `export { ${namespaces.join(', ')} };`;

  const indexDts = `${namespaceImports}
${dtsConstants.imports.join('\n')}
${namespaceExport}
${dtsConstants.declarations.join('\n')}
`;

  fs.writeFileSync(path.join(destLib, 'index.js'), indexJs);
  fs.writeFileSync(path.join(destLib, 'index.d.ts'), indexDts);
}

/**
 * Patch daml.js / @fairmint / @daml.js imports onto `__bundled__` wrappers
 * using the same rewrite rules as bundle-dependencies.
 *
 * `destLib` must be a directory named `lib`: preset rewrite rules resolve
 * targets under `<packageRoot>/lib/…`, so the package root is `dirname(destLib)`.
 */
export function patchBundledDependencyImports(
  destLib: string,
  options: {
    generatedJsDir: string;
    pins: ResolvedDamlJsBundleConfig['pins'];
    presets: BundlePresetId[];
  }
): number {
  if (path.basename(destLib) !== 'lib') {
    throw new Error(
      `patchBundledDependencyImports expects a directory named "lib" (got ${destLib}). ` +
        'Bundle rewrite rules resolve targets under <packageRoot>/lib/.'
    );
  }
  const packageRoot = path.dirname(destLib);
  const rules = options.presets.flatMap((id) =>
    BUNDLE_PRESETS[id].rewriteRules(packageRoot, options.pins)
  );
  if (rules.length === 0) {
    return 0;
  }
  return applyGeneratedImportRewrites(destLib, rules);
}

export function createRootIndex(options: CreateRootIndexOptions): {
  config: ResolvedDamlJsBundleConfig;
  sourcePackage: CodegenPackageConfig;
  outputDir: string;
} {
  const config = resolveDamlJsBundleConfig({
    rootDir: options.rootDir,
    configPath: options.configPath,
  });

  if (!config.rootIndex) {
    throw new Error(
      `daml-js bundle config at ${config.configPath ?? config.rootDir} is missing rootIndex`
    );
  }

  const rootIndex = config.rootIndex;
  const packages = discoverCodegenPackages({
    rootDir: config.rootDir,
    generatedJsRoot: config.generatedJsDir,
  });
  const sourcePackage = resolveSourcePackage(packages, rootIndex.sourcePackage);
  const pkgLib = sourcePackage.absoluteGeneratedLibDir;
  if (!fs.existsSync(pkgLib)) {
    throw new Error(
      `Source package lib not found at ${pkgLib}. Run codegen-js + bundle-dependencies first.`
    );
  }

  const outputRel = normalizeRelativePath(rootIndex.outputDir ?? 'lib');
  assertSafeRelativePath(outputRel, 'rootIndex.outputDir');
  if (path.basename(outputRel) !== 'lib') {
    throw new Error(
      `rootIndex.outputDir must resolve to a directory named "lib" (got ${JSON.stringify(outputRel)}). ` +
        'Bundle presets and import rewrites assume a <packageRoot>/lib layout.'
    );
  }
  const destLib = resolveContainedPath(config.rootDir, outputRel, 'rootIndex.outputDir');
  const packageRoot = path.dirname(destLib);

  console.log(`🧩 Building combined ${outputRel}/ from ${sourcePackage.name} codegen...`);
  removeDirectoryIfExists(destLib);
  createDirectoryIfNotExists(destLib);

  for (const [index, entry] of rootIndex.copy.entries()) {
    assertSafeRelativePath(entry, `rootIndex.copy[${index}]`);
    const normalizedEntry = normalizeRelativePath(entry);
    copyDirectory(
      resolveContainedPath(pkgLib, normalizedEntry, `rootIndex.copy[${index}]`),
      resolveContainedPath(destLib, normalizedEntry, `rootIndex.copy[${index}]`)
    );
  }

  writeRootIndexFiles(destLib, rootIndex.namespaces, rootIndex.templateConstants);

  const postPresets = rootIndex.postBundlePresets ?? [];
  // Only presets that actually materialized are safe to rewrite onto __bundled__.
  const appliedPostPresets =
    postPresets.length > 0
      ? applyBundlePresets({
          targetDir: packageRoot,
          generatedJsDir: config.absoluteGeneratedJsDir,
          pins: config.pins,
          presets: postPresets,
        })
      : [];

  const shouldPatch = rootIndex.patchBundledImports ?? true;
  if (shouldPatch) {
    // config.presets are expected from an earlier bundle-dependencies + copy step;
    // only rewrite when their bundled artifacts are present. postBundlePresets only
    // rewrite when applyBundlePresets reported success (same gate as bundleDependenciesForTarget).
    const candidatePresets = [...new Set([...config.presets, ...appliedPostPresets])];
    const presetsToPatch = candidatePresets.filter((id) =>
      BUNDLE_PRESETS[id].detectionTargets(packageRoot).some((target) => fs.existsSync(target))
    );
    patchBundledDependencyImports(destLib, {
      generatedJsDir: config.absoluteGeneratedJsDir,
      pins: config.pins,
      presets: presetsToPatch,
    });
  }

  ensureBundledDANamespaceIndexes(packageRoot);
  ensureBundledSpliceNamespaceIndexes(packageRoot);

  console.log(`✅ Combined ${outputRel}/ created`);
  return { config, sourcePackage, outputDir: destLib };
}

export function runCreateRootIndexCli(args: string[]): void {
  try {
    const rootDir = path.resolve(parseFlagValue(args, '--root') ?? process.cwd());
    const configPath = parseFlagValue(args, '--config');
    createRootIndex({
      rootDir,
      ...(configPath ? { configPath } : {}),
    });
  } catch (error) {
    console.error(`❌ Error during create-root-index: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

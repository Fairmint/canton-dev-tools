/**
 * Config-driven dependency bundling for generated DAML→JS packages.
 *
 * Ports the canton-assets bundling engine without hardcoding product package names.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFlagValue } from '../packages';
import { getErrorMessage, type PackageJson } from '../types';
import {
  ensureBundledDANamespaceIndexes,
  ensureBundledSpliceNamespaceIndexes,
  normalizeImportTarget,
  removeDirectoryIfExists,
} from './bundle-fs';
import {
  getBundledArtifactDirs,
  resolvePresetIds,
  type BundlePresetId,
  type BundlePins,
} from './bundle-presets';
import {
  resolveDamlJsBundleConfig,
  type ResolvedDamlJsBundleConfig,
} from './daml-js-bundle-config';
import { discoverCodegenPackages } from './discover-codegen-packages';
import {
  applyGeneratedImportRewrites,
  collectGeneratedOutputFiles,
  type GeneratedImportRewriteRule,
} from './generated-output-helpers';

export interface BundleDependenciesOptions {
  rootDir: string;
  configPath?: string;
  /** Override packages to process (absolute generated package dirs). */
  packageDirs?: string[];
  /** Force-apply these presets (skip detection). Used by create-root-index post-steps. */
  forcePresets?: BundlePresetId[];
  /** Target package roots (default: discovered codegen packages). */
  targetDirs?: string[];
}

function packageHasDependencyReference(
  targetDir: string,
  rawImports: string[],
  bundledTargets: string[]
): boolean {
  const normalizedTargets = bundledTargets.map((bundledTarget) =>
    normalizeImportTarget(bundledTarget)
  );
  const moduleSpecifierPatterns = [/require\(['"]([^'"]+)['"]\)/g, /from ['"]([^'"]+)['"]/g];

  for (const filePath of collectGeneratedOutputFiles(path.join(targetDir, 'lib'), {
    ignoredDirs: getBundledArtifactDirs(targetDir),
  })) {
    const fileContents = fs.readFileSync(filePath, 'utf8');

    if (rawImports.some((rawImport) => fileContents.includes(rawImport))) {
      return true;
    }

    for (const pattern of moduleSpecifierPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(fileContents);

      while (match) {
        const specifier = match[1];
        if (specifier?.startsWith('.')) {
          const resolvedImport = normalizeImportTarget(
            path.resolve(path.dirname(filePath), specifier)
          );
          if (normalizedTargets.some((bundledTarget) => bundledTarget === resolvedImport)) {
            return true;
          }
        }
        match = pattern.exec(fileContents);
      }
    }
  }

  return false;
}

function clearBundledArtifacts(targetDir: string): void {
  for (const bundledDir of getBundledArtifactDirs(targetDir)) {
    removeDirectoryIfExists(bundledDir);
  }
}

function normalizeMainIndexJs(content: string, hasSpliceDir: boolean): string {
  let normalizedContent = content
    .replace(/var DA = require\('\.\/DA'\);\nexports\.DA = DA;\n?/g, '')
    .replace(/var Splice = require\('\.\/Splice'\);\nexports\.Splice = Splice;\n?/g, '')
    .trimEnd();

  normalizedContent = `${normalizedContent}\nvar DA = require('./DA');\nexports.DA = DA;\n`;

  if (hasSpliceDir) {
    normalizedContent = `${normalizedContent}var Splice = require('./Splice');\nexports.Splice = Splice;\n`;
  }

  return normalizedContent;
}

function normalizeMainIndexDts(content: string, hasSpliceDir: boolean): string {
  const importsToAdd = ["import * as DA from './DA';"];
  if (hasSpliceDir) {
    importsToAdd.push("import * as Splice from './Splice';");
  }

  let normalizedContent = content
    .replace(/^import \* as DA from '\.\/DA';\n?/gm, '')
    .replace(/^import \* as Splice from '\.\/Splice';\n?/gm, '');

  const exportMatch = normalizedContent.match(/export \{([^}]*)\} ;/);
  const exportNames = exportMatch
    ? exportMatch[1]!
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .filter((name) => name !== 'DA' && name !== 'Splice')
    : [];

  exportNames.push('DA');
  if (hasSpliceDir) {
    exportNames.push('Splice');
  }

  const exportLine = `export { ${[...new Set(exportNames)].join(', ')} } ;`;
  normalizedContent = exportMatch
    ? normalizedContent.replace(/export \{[^}]*\} ;/, exportLine)
    : `${normalizedContent.trimEnd()}\n${exportLine}\n`;

  const lines = normalizedContent.split('\n');
  const firstNonImportIndex = lines.findIndex(
    (line) => line.trim() !== '' && !line.startsWith('import ')
  );
  const insertIndex = firstNonImportIndex === -1 ? lines.length : firstNonImportIndex;
  lines.splice(insertIndex, 0, ...importsToAdd);

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function updateMainIndex(targetDir: string): void {
  console.log('📝 Updating main index files...');
  const hasSpliceDir =
    fs.existsSync(path.join(targetDir, 'lib/Splice/index.js')) &&
    fs.existsSync(path.join(targetDir, 'lib/Splice/index.d.ts'));

  const mainIndexPath = path.join(targetDir, 'lib/index.js');
  if (fs.existsSync(mainIndexPath)) {
    const mainIndex = fs.readFileSync(mainIndexPath, 'utf8');
    const normalizedMainIndex = normalizeMainIndexJs(mainIndex, hasSpliceDir);
    if (normalizedMainIndex !== mainIndex) {
      fs.writeFileSync(mainIndexPath, normalizedMainIndex);
      console.log('✅ Updated main index.js');
    }
  }

  const mainIndexDtsPath = path.join(targetDir, 'lib/index.d.ts');
  if (fs.existsSync(mainIndexDtsPath)) {
    const mainIndexDts = fs.readFileSync(mainIndexDtsPath, 'utf8');
    const normalizedMainIndexDts = normalizeMainIndexDts(mainIndexDts, hasSpliceDir);
    if (normalizedMainIndexDts !== mainIndexDts) {
      fs.writeFileSync(mainIndexDtsPath, normalizedMainIndexDts);
      console.log('✅ Updated main index.d.ts');
    }
  }
}

function removeLocalDependencies(
  targetDir: string,
  deps: string[]
): void {
  console.log('🗑️  Removing local dependencies from package.json...');
  const packageJsonPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.log('ℹ️  No package.json found');
    return;
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
  let removedCount = 0;
  for (const dep of deps) {
    if (packageJson.dependencies?.[dep]) {
      delete packageJson.dependencies[dep];
      removedCount++;
      console.log(`✅ Removed local dependency: ${dep}`);
    }
  }
  if (removedCount > 0) {
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4));
    console.log(`✅ Removed ${removedCount} local dependencies from package.json`);
  } else {
    console.log('ℹ️  No local dependencies found in package.json');
  }
}

/**
 * Bundle selected presets into a single generated package directory
 * (`…/generated/js/<pkg>-<ver>/` with a `lib/` child).
 */
export function bundleDependenciesForTarget(options: {
  targetDir: string;
  generatedJsDir: string;
  pins: BundlePins;
  presets: BundlePresetId[];
  /** When set, skip detection and always apply these presets. */
  forcePresets?: BundlePresetId[];
  /** Clear stale bundled artifacts before detecting (default true). */
  clearFirst?: boolean;
  /** Update lib/index to export DA/Splice (default true). */
  updateIndex?: boolean;
  /** Strip bundled deps from package.json (default true). */
  cleanPackageJson?: boolean;
}): BundlePresetId[] {
  const targetDir = path.resolve(options.targetDir);
  const clearFirst = options.clearFirst ?? true;
  const updateIndex = options.updateIndex ?? true;
  const cleanPackageJson = options.cleanPackageJson ?? true;

  if (clearFirst) {
    clearBundledArtifacts(targetDir);
  }

  const presetDefs = resolvePresetIds(options.presets);
  const forceSet = new Set(options.forcePresets ?? []);

  // Detect amulet first so featured-app-v2 can use willBundleAmulet.
  const amuletPreset = presetDefs.find((preset) => preset.id === 'amulet');
  const amuletDetected = amuletPreset
    ? packageHasDependencyReference(
        targetDir,
        amuletPreset.importSpecs(options.pins),
        // Amulet detection historically used lib/ as the relative target marker.
        amuletPreset.detectionTargets(targetDir)
      )
    : false;
  const willBundleAmulet = forceSet.has('amulet') || amuletDetected;

  const applied: BundlePresetId[] = [];
  const rewriteRules: GeneratedImportRewriteRule[] = [];
  const packageJsonDeps: string[] = [];

  for (const preset of presetDefs) {
    const detected = packageHasDependencyReference(
      targetDir,
      preset.importSpecs(options.pins),
      preset.detectionTargets(targetDir)
    );
    const shouldApply = forceSet.has(preset.id)
      ? true
      : preset.shouldApply
        ? preset.shouldApply(
            {
              targetDir,
              generatedJsDir: options.generatedJsDir,
              pins: options.pins,
              willBundleAmulet,
            },
            detected
          )
        : detected;

    if (!shouldApply) {
      continue;
    }

    const materialized = preset.apply({
      targetDir,
      generatedJsDir: options.generatedJsDir,
      pins: options.pins,
      willBundleAmulet,
    });
    // Skip rewrite + dep removal when apply could not materialize sources —
    // otherwise imports would point at missing __bundled__ paths.
    if (!materialized) {
      console.log(
        `⚠️  Skipping rewrite/cleanup for preset ${preset.id}: generated dependency tree missing`
      );
      continue;
    }
    applied.push(preset.id);
    // Derive cleanup keys from rewrite rules so partial presets (e.g. splice-token-v1)
    // only strip deps for packages that actually materialized.
    const rules = preset.rewriteRules(targetDir, options.pins);
    rewriteRules.push(...rules);
    packageJsonDeps.push(...rules.flatMap((rule) => rule.importPaths));
  }

  ensureBundledDANamespaceIndexes(targetDir);
  ensureBundledSpliceNamespaceIndexes(targetDir);

  if (updateIndex) {
    updateMainIndex(targetDir);
  }

  console.log('🔄 Replacing dependency references in generated files...');
  const replacedCount = applyGeneratedImportRewrites(path.join(targetDir, 'lib'), rewriteRules);
  console.log(`✅ Replaced dependency references in ${replacedCount} files`);

  if (cleanPackageJson) {
    removeLocalDependencies(targetDir, [...new Set(packageJsonDeps)]);
  }

  return applied;
}

export function bundleDependencies(
  options: BundleDependenciesOptions
): { config: ResolvedDamlJsBundleConfig; processed: string[]; applied: Record<string, BundlePresetId[]> } {
  const config = resolveDamlJsBundleConfig({
    rootDir: options.rootDir,
    configPath: options.configPath,
    allowMissing: true,
  });

  const targetDirs =
    options.targetDirs ??
    options.packageDirs ??
    discoverCodegenPackages({
      rootDir: config.rootDir,
      generatedJsRoot: config.generatedJsDir,
    }).map((pkg) => pkg.absoluteGeneratedJsDir);

  console.log('🚀 Starting dependency bundling...');
  const applied: Record<string, BundlePresetId[]> = {};
  const processed: string[] = [];

  for (const targetDir of targetDirs) {
    if (!fs.existsSync(targetDir)) {
      console.log(`ℹ️  Skipping missing package dir: ${targetDir}`);
      continue;
    }
    console.log(`📦 Processing package: ${targetDir}`);
    processed.push(targetDir);
    applied[targetDir] = bundleDependenciesForTarget({
      targetDir,
      generatedJsDir: config.absoluteGeneratedJsDir,
      pins: config.pins,
      presets: config.presets,
      forcePresets: options.forcePresets,
    });
  }

  console.log('✅ Dependency bundling completed successfully!');
  return { config, processed, applied };
}

/** Force-apply presets into an existing package/repo root (used by create-root-index). */
export function applyBundlePresets(options: {
  targetDir: string;
  generatedJsDir: string;
  pins: BundlePins;
  presets: BundlePresetId[];
}): BundlePresetId[] {
  return bundleDependenciesForTarget({
    targetDir: options.targetDir,
    generatedJsDir: options.generatedJsDir,
    pins: options.pins,
    presets: options.presets,
    forcePresets: options.presets,
    clearFirst: false,
    updateIndex: false,
    cleanPackageJson: false,
  });
}

export function runBundleDependenciesCli(args: string[]): void {
  try {
    const rootDir = path.resolve(parseFlagValue(args, '--root') ?? process.cwd());
    const configPath = parseFlagValue(args, '--config');
    bundleDependencies({
      rootDir,
      ...(configPath ? { configPath } : {}),
    });
  } catch (error) {
    console.error(`❌ Error during dependency bundling: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

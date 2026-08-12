/**
 * Consumer config for Phase 2 DAML→JS bundling / root-index merge.
 *
 * Resolution order:
 * 1. `--config` / `options.configPath`
 * 2. `package.json` → `cantonDevTools.damlJsBundle` (path string or inline object)
 * 3. repo-root `daml-js-bundle.json`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertSafeRelativePath,
  normalizeRelativePath,
  resolveContainedPath,
} from '../sync-splice-dars';
import type { PackageJson } from '../types';
import { BUNDLE_PRESET_IDS, type BundlePresetId } from './bundle-presets';

export const DAML_JS_BUNDLE_CONFIG_FILENAME = 'daml-js-bundle.json';

export interface DamlJsBundlePins {
  /** splice-amulet version (default `0.1.19`). */
  amulet?: string;
  /** splice-token-standard-utils version (default `2.0.0`). */
  tokenStandardUtils?: string;
}

export interface RootIndexTemplateEntry {
  /** Relative module path from output lib (e.g. `./WrappedAssets/Holding/module`). */
  from: string;
  /** Exported binding on that module (e.g. `WrappedAsset`). */
  binding: string;
  /** Property to expose (default `templateId`). */
  field?: string;
}

export interface RootIndexSourcePackage {
  /** Exact daml.yaml package name. */
  name?: string;
  /** Match packages whose name starts with this prefix. */
  namePrefix?: string;
  /** Discover key (source dir basename, lowercase). */
  key?: string;
}

export interface RootIndexConfig {
  /**
   * Output directory relative to repo root (default `lib`).
   * Must be a safe relative path whose basename is `lib` — bundle presets and
   * import rewrites assume a `<packageRoot>/lib` layout.
   */
  outputDir?: string;
  /** Which codegen package supplies the primary tree. */
  sourcePackage: RootIndexSourcePackage;
  /** Top-level dirs to copy from the source package `lib/` into `outputDir`. */
  copy: string[];
  /** Namespace exports written into `outputDir/index.{js,d.ts}` (order preserved). */
  namespaces: string[];
  /**
   * Optional frozen template-id constant maps written into the root index.
   * Keys are export names (e.g. `WRAPPED_ASSETS_TEMPLATES`).
   */
  templateConstants?: Record<string, Record<string, RootIndexTemplateEntry>>;
  /**
   * Presets to force-apply after the merge (target = repo root).
   * Useful when the merged tree needs token/DA modules not present on the source package alone.
   */
  postBundlePresets?: BundlePresetId[];
  /** Rewrite remaining daml.js/@fairmint imports onto `__bundled__` (default true). */
  patchBundledImports?: boolean;
}

export interface DamlJsBundleConfigFile {
  /** Relative generated JS root (default `generated/js`). */
  generatedJsDir?: string;
  /**
   * Presets to consider when bundling each codegen package.
   * `da-internal-template` is always applied even if omitted.
   * Default: all built-in stdlib/Splice presets.
   */
  presets?: BundlePresetId[];
  /** Version pins for floating Splice packages. */
  pins?: DamlJsBundlePins;
  /** Merged published `lib/` configuration (create-root-index). */
  rootIndex?: RootIndexConfig;
}

export interface ResolvedDamlJsBundleConfig {
  rootDir: string;
  configPath: string | null;
  generatedJsDir: string;
  absoluteGeneratedJsDir: string;
  presets: BundlePresetId[];
  pins: Required<DamlJsBundlePins>;
  rootIndex: RootIndexConfig | null;
}

const DEFAULT_PINS: Required<DamlJsBundlePins> = {
  amulet: '0.1.19',
  tokenStandardUtils: '2.0.0',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPresetId(value: unknown, label: string): BundlePresetId {
  if (typeof value !== 'string' || !(BUNDLE_PRESET_IDS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(value)}. Expected one of: ${BUNDLE_PRESET_IDS.join(', ')}`
    );
  }
  return value as BundlePresetId;
}

function parsePins(raw: unknown, label: string): DamlJsBundlePins {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new Error(`Invalid ${label} (expected object)`);
  }
  const pins: DamlJsBundlePins = {};
  if (raw['amulet'] !== undefined) {
    if (typeof raw['amulet'] !== 'string' || raw['amulet'].length === 0) {
      throw new Error(`Invalid ${label}.amulet (expected non-empty string)`);
    }
    pins.amulet = raw['amulet'];
  }
  if (raw['tokenStandardUtils'] !== undefined) {
    if (typeof raw['tokenStandardUtils'] !== 'string' || raw['tokenStandardUtils'].length === 0) {
      throw new Error(`Invalid ${label}.tokenStandardUtils (expected non-empty string)`);
    }
    pins.tokenStandardUtils = raw['tokenStandardUtils'];
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'amulet' && key !== 'tokenStandardUtils') {
      throw new Error(`Unknown ${label} key: ${key}`);
    }
  }
  return pins;
}

function parseTemplateConstants(raw: unknown, label: string): RootIndexConfig['templateConstants'] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid ${label} (expected object)`);
  }
  const result: NonNullable<RootIndexConfig['templateConstants']> = {};
  for (const [constName, entriesRaw] of Object.entries(raw)) {
    if (!isRecord(entriesRaw)) {
      throw new Error(`Invalid ${label}.${constName} (expected object)`);
    }
    const entries: Record<string, RootIndexTemplateEntry> = {};
    for (const [entryName, entryRaw] of Object.entries(entriesRaw)) {
      if (!isRecord(entryRaw)) {
        throw new Error(`Invalid ${label}.${constName}.${entryName} (expected object)`);
      }
      const from = entryRaw['from'];
      const binding = entryRaw['binding'];
      const field = entryRaw['field'];
      if (typeof from !== 'string' || from.length === 0) {
        throw new Error(`Invalid ${label}.${constName}.${entryName}.from`);
      }
      if (typeof binding !== 'string' || binding.length === 0) {
        throw new Error(`Invalid ${label}.${constName}.${entryName}.binding`);
      }
      if (field !== undefined && (typeof field !== 'string' || field.length === 0)) {
        throw new Error(`Invalid ${label}.${constName}.${entryName}.field`);
      }
      entries[entryName] = {
        from,
        binding,
        ...(typeof field === 'string' ? { field } : {}),
      };
    }
    result[constName] = entries;
  }
  return result;
}

function parseRootIndex(raw: unknown, label: string): RootIndexConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid ${label} (expected object)`);
  }
  const sourcePackageRaw = raw['sourcePackage'];
  if (!isRecord(sourcePackageRaw)) {
    throw new Error(`Invalid ${label}.sourcePackage (expected object)`);
  }
  const sourcePackage: RootIndexSourcePackage = {};
  for (const key of ['name', 'namePrefix', 'key'] as const) {
    const value = sourcePackageRaw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Invalid ${label}.sourcePackage.${key}`);
    }
    sourcePackage[key] = value;
  }
  if (!sourcePackage.name && !sourcePackage.namePrefix && !sourcePackage.key) {
    throw new Error(`${label}.sourcePackage requires at least one of name, namePrefix, or key`);
  }

  const copyRaw = raw['copy'];
  if (
    !Array.isArray(copyRaw) ||
    copyRaw.length === 0 ||
    !copyRaw.every((v) => typeof v === 'string')
  ) {
    throw new Error(`Invalid ${label}.copy (expected non-empty string[])`);
  }
  const copy = (copyRaw as string[]).map((entry, index) => {
    assertSafeRelativePath(entry, `${label}.copy[${index}]`);
    return normalizeRelativePath(entry);
  });

  const namespacesRaw = raw['namespaces'];
  if (
    !Array.isArray(namespacesRaw) ||
    namespacesRaw.length === 0 ||
    !namespacesRaw.every((v) => typeof v === 'string')
  ) {
    throw new Error(`Invalid ${label}.namespaces (expected non-empty string[])`);
  }

  const outputDirRaw = raw['outputDir'];
  let outputDir: string | undefined;
  if (outputDirRaw !== undefined) {
    if (typeof outputDirRaw !== 'string' || outputDirRaw.length === 0) {
      throw new Error(`Invalid ${label}.outputDir`);
    }
    assertSafeRelativePath(outputDirRaw, `${label}.outputDir`);
    outputDir = normalizeRelativePath(outputDirRaw);
    // Bundle presets / import rewrites resolve targets under `<packageRoot>/lib/`.
    if (path.basename(outputDir) !== 'lib') {
      throw new Error(
        `${label}.outputDir must resolve to a directory named "lib" ` +
          `(got ${JSON.stringify(outputDirRaw)}). Custom non-lib output dirs are not supported.`
      );
    }
  }

  const postBundlePresetsRaw = raw['postBundlePresets'];
  let postBundlePresets: BundlePresetId[] | undefined;
  if (postBundlePresetsRaw !== undefined) {
    if (!Array.isArray(postBundlePresetsRaw)) {
      throw new Error(`Invalid ${label}.postBundlePresets (expected array)`);
    }
    postBundlePresets = postBundlePresetsRaw.map((id, index) =>
      assertPresetId(id, `${label}.postBundlePresets[${index}]`)
    );
  }

  const patchBundledImports = raw['patchBundledImports'];
  if (patchBundledImports !== undefined && typeof patchBundledImports !== 'boolean') {
    throw new Error(`Invalid ${label}.patchBundledImports (expected boolean)`);
  }

  return {
    ...(typeof outputDir === 'string' ? { outputDir } : {}),
    sourcePackage,
    copy,
    namespaces: namespacesRaw as string[],
    templateConstants: parseTemplateConstants(
      raw['templateConstants'],
      `${label}.templateConstants`
    ),
    ...(postBundlePresets ? { postBundlePresets } : {}),
    ...(typeof patchBundledImports === 'boolean' ? { patchBundledImports } : {}),
  };
}

export function parseDamlJsBundleConfig(raw: unknown, label: string): DamlJsBundleConfigFile {
  if (!isRecord(raw)) {
    throw new Error(`Invalid ${label} (expected object)`);
  }

  const generatedJsDir = raw['generatedJsDir'];
  if (
    generatedJsDir !== undefined &&
    (typeof generatedJsDir !== 'string' || generatedJsDir.length === 0)
  ) {
    throw new Error(`Invalid ${label}.generatedJsDir`);
  }

  let presets: BundlePresetId[] | undefined;
  if (raw['presets'] !== undefined) {
    if (!Array.isArray(raw['presets'])) {
      throw new Error(`Invalid ${label}.presets (expected array)`);
    }
    presets = raw['presets'].map((id, index) => assertPresetId(id, `${label}.presets[${index}]`));
  }

  const rootIndex =
    raw['rootIndex'] === undefined
      ? undefined
      : parseRootIndex(raw['rootIndex'], `${label}.rootIndex`);

  return {
    ...(typeof generatedJsDir === 'string' ? { generatedJsDir } : {}),
    ...(presets ? { presets } : {}),
    pins: parsePins(raw['pins'], `${label}.pins`),
    ...(rootIndex ? { rootIndex } : {}),
  };
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

/**
 * Resolve which config file (or inline package.json object) to load.
 * Returns null when nothing is configured (callers may use defaults).
 */
export function resolveDamlJsBundleConfigSource(
  rootDir: string,
  configPath?: string
): { kind: 'file'; path: string } | { kind: 'inline'; value: unknown; path: string } | null {
  if (configPath) {
    return { kind: 'file', path: path.resolve(configPath) };
  }

  const packageJsonPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = readJsonFile(packageJsonPath) as PackageJson & {
      cantonDevTools?: { damlJsBundle?: unknown };
    };
    const pointer = packageJson.cantonDevTools?.damlJsBundle;
    if (typeof pointer === 'string' && pointer.length > 0) {
      assertSafeRelativePath(pointer, 'package.json cantonDevTools.damlJsBundle');
      const resolved = resolveContainedPath(
        rootDir,
        normalizeRelativePath(pointer),
        'package.json cantonDevTools.damlJsBundle'
      );
      return { kind: 'file', path: resolved };
    }
    if (isRecord(pointer)) {
      return { kind: 'inline', value: pointer, path: packageJsonPath };
    }
  }

  const defaultPath = path.join(rootDir, DAML_JS_BUNDLE_CONFIG_FILENAME);
  if (fs.existsSync(defaultPath)) {
    return { kind: 'file', path: defaultPath };
  }

  return null;
}

export function resolveDamlJsBundleConfig(options: {
  rootDir: string;
  configPath?: string;
  /** When true, missing config uses built-in defaults instead of throwing. */
  allowMissing?: boolean;
}): ResolvedDamlJsBundleConfig {
  const rootDir = path.resolve(options.rootDir);
  const source = resolveDamlJsBundleConfigSource(rootDir, options.configPath);

  let parsed: DamlJsBundleConfigFile = {};
  let configPath: string | null = null;

  if (source === null) {
    if (!options.allowMissing) {
      throw new Error(
        `No daml-js bundle config found under ${rootDir}. ` +
          `Add ${DAML_JS_BUNDLE_CONFIG_FILENAME}, set package.json cantonDevTools.damlJsBundle, or pass --config.`
      );
    }
  } else if (source.kind === 'file') {
    if (!fs.existsSync(source.path)) {
      throw new Error(`daml-js bundle config not found: ${source.path}`);
    }
    configPath = source.path;
    parsed = parseDamlJsBundleConfig(readJsonFile(source.path), source.path);
  } else {
    configPath = source.path;
    parsed = parseDamlJsBundleConfig(source.value, `${source.path} cantonDevTools.damlJsBundle`);
  }

  const generatedJsDir = parsed.generatedJsDir ?? 'generated/js';
  assertSafeRelativePath(generatedJsDir, 'generatedJsDir');
  const absoluteGeneratedJsDir = resolveContainedPath(rootDir, generatedJsDir, 'generatedJsDir');

  const presets = parsed.presets ?? [...BUNDLE_PRESET_IDS];
  // Always include da-internal-template first.
  const orderedPresets: BundlePresetId[] = [];
  if (!presets.includes('da-internal-template')) {
    orderedPresets.push('da-internal-template');
  }
  for (const id of presets) {
    if (!orderedPresets.includes(id)) {
      orderedPresets.push(id);
    }
  }

  return {
    rootDir,
    configPath,
    generatedJsDir,
    absoluteGeneratedJsDir,
    presets: orderedPresets,
    pins: {
      amulet: parsed.pins?.amulet ?? DEFAULT_PINS.amulet,
      tokenStandardUtils: parsed.pins?.tokenStandardUtils ?? DEFAULT_PINS.tokenStandardUtils,
    },
    rootIndex: parsed.rootIndex ?? null,
  };
}

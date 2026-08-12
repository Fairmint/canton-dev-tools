/**
 * Built-in stdlib / Splice dependency presets for DAML→JS bundling.
 *
 * Product packages (WrappedAssets, OCP, NFT, …) are never named here — consumers
 * select presets via `daml-js-bundle.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GeneratedImportRewriteRule } from './generated-output-helpers';
import { writeGeneratedOutputPair } from './generated-output-helpers';
import {
  copyDirectory,
  createDirectoryIfNotExists,
  createNamespaceIndexDts,
} from './bundle-fs';

export const BUNDLE_PRESET_IDS = [
  'da-internal-template',
  'featured-app-v1',
  'featured-app-v2',
  'amulet',
  'da-time-types',
  'da-types',
  'da-set-types',
  'splice-token-v1',
  'splice-token-standard-utils',
] as const;

export type BundlePresetId = (typeof BUNDLE_PRESET_IDS)[number];

export interface BundlePins {
  amulet: string;
  tokenStandardUtils: string;
}

export interface BundleApplyContext {
  targetDir: string;
  generatedJsDir: string;
  pins: BundlePins;
  /** Whether amulet will be / was requested for this package (affects featured-app-v2). */
  willBundleAmulet: boolean;
}

function importVariants(packageNameWithVersion: string): string[] {
  return [
    `daml.js/${packageNameWithVersion}`,
    `@daml.js/${packageNameWithVersion}`,
    `@fairmint/${packageNameWithVersion}`,
  ];
}

function packageDir(generatedJsDir: string, nameWithVersion: string): string {
  return path.join(generatedJsDir, nameWithVersion);
}

function ensureWrapper(
  targetDir: string,
  wrapperName: string,
  js: string,
  dts: string
): void {
  const wrapperDir = path.join(targetDir, 'lib', '__bundled__', wrapperName);
  writeGeneratedOutputPair(wrapperDir, 'index', { js, dts });
}

function writeModuleIndexPair(dirPath: string): void {
  writeGeneratedOutputPair(dirPath, 'index', {
    js: `"use strict";
/* eslint-disable-next-line no-unused-vars */
function __export(m) {
/* eslint-disable-next-line no-prototype-builtins */
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
__export(require('./module'));
`,
    dts: `export * from './module';
`,
  });
}

function writeNamespaceChildPair(dirPath: string, childName: string): void {
  writeGeneratedOutputPair(dirPath, 'index', {
    js: `"use strict";
/* eslint-disable-next-line no-unused-vars */
function __export(m) {
/* eslint-disable-next-line no-prototype-builtins */
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
var ${childName} = require('./${childName}');
exports.${childName} = ${childName};
`,
    dts: createNamespaceIndexDts([childName]),
  });
}

function copyModuleTreeOrWarn(
  sourceDir: string,
  destDir: string,
  label: string
): boolean {
  if (!fs.existsSync(sourceDir)) {
    console.log(`⚠️  ${label} not found at ${sourceDir}`);
    return false;
  }
  copyDirectory(sourceDir, destDir);
  return true;
}

export interface BundlePresetDefinition {
  id: BundlePresetId;
  /** Import strings used for detection + package.json cleanup. */
  importSpecs: (pins: BundlePins) => string[];
  /** Absolute paths under targetDir that count as "already bundled" for detection. */
  detectionTargets: (targetDir: string) => string[];
  /** Artifact dirs cleared before detection (subset of getBundledArtifactDirs). */
  clearDirs?: (targetDir: string) => string[];
  /**
   * Whether this preset should apply. Default: detect via importSpecs/detectionTargets.
   * Special cases (featured-app-v2, always-on da-internal-template) override.
   */
  shouldApply?: (ctx: BundleApplyContext, detected: boolean) => boolean;
  apply: (ctx: BundleApplyContext) => void;
  rewriteRules: (targetDir: string, pins: BundlePins) => GeneratedImportRewriteRule[];
}

function amuletPackageName(pins: BundlePins): string {
  return `splice-amulet-${pins.amulet}`;
}

function tokenStandardUtilsPackageName(pins: BundlePins): string {
  return `splice-token-standard-utils-${pins.tokenStandardUtils}`;
}

function amuletModuleReferencesFeaturedAppV2(content: string): boolean {
  return (
    content.includes('daml.js/splice-api-featured-app-v2-1.0.0') ||
    content.includes('@daml.js/splice-api-featured-app-v2-1.0.0') ||
    content.includes('@fairmint/splice-api-featured-app-v2-1.0.0')
  );
}

function packageNeedsFeaturedAppV2(ctx: BundleApplyContext): boolean {
  const embeddedAmulet = path.join(ctx.targetDir, 'lib/Splice/Amulet/module.js');
  if (fs.existsSync(embeddedAmulet)) {
    return amuletModuleReferencesFeaturedAppV2(fs.readFileSync(embeddedAmulet, 'utf8'));
  }
  if (ctx.willBundleAmulet) {
    const templateAmulet = path.join(
      packageDir(ctx.generatedJsDir, amuletPackageName(ctx.pins)),
      'lib/Splice/Amulet/module.js'
    );
    return (
      fs.existsSync(templateAmulet) &&
      amuletModuleReferencesFeaturedAppV2(fs.readFileSync(templateAmulet, 'utf8'))
    );
  }
  return false;
}

const TOKEN_V1_PACKAGES: Array<{
  dirName: string;
  relModule: string;
  wrapperKey: string;
  wrapperName: string;
}> = [
  {
    dirName: 'splice-api-token-burn-mint-v1-1.0.0',
    relModule: 'lib/Splice/Api/Token/BurnMintV1',
    wrapperKey: 'BurnMintV1',
    wrapperName: 'splice-api-token-burn-mint-v1',
  },
  {
    dirName: 'splice-api-token-metadata-v1-1.0.0',
    relModule: 'lib/Splice/Api/Token/MetadataV1',
    wrapperKey: 'MetadataV1',
    wrapperName: 'splice-api-token-metadata-v1',
  },
  {
    dirName: 'splice-api-token-holding-v1-1.0.0',
    relModule: 'lib/Splice/Api/Token/HoldingV1',
    wrapperKey: 'HoldingV1',
    wrapperName: 'splice-api-token-holding-v1',
  },
  {
    dirName: 'splice-api-token-allocation-instruction-v1-1.0.0',
    relModule: 'lib/Splice/Api/Token/AllocationInstructionV1',
    wrapperKey: 'AllocationInstructionV1',
    wrapperName: 'splice-api-token-allocation-instruction-v1',
  },
  {
    dirName: 'splice-api-token-transfer-instruction-v1-1.0.0',
    relModule: 'lib/Splice/Api/Token/TransferInstructionV1',
    wrapperKey: 'TransferInstructionV1',
    wrapperName: 'splice-api-token-transfer-instruction-v1',
  },
  {
    dirName: 'splice-api-token-allocation-v1-1.0.0',
    relModule: 'lib/Splice/Api/Token/AllocationV1',
    wrapperKey: 'AllocationV1',
    wrapperName: 'splice-api-token-allocation-v1',
  },
];

export const BUNDLE_PRESETS: Record<BundlePresetId, BundlePresetDefinition> = {
  'da-internal-template': {
    id: 'da-internal-template',
    importSpecs: () => importVariants('ghc-stdlib-DA-Internal-Template-1.0.0'),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'DA', 'Internal', 'Template'),
      path.join(targetDir, 'lib', '__bundled__', 'ghc-stdlib-DA-Internal-Template'),
    ],
    shouldApply: () => true,
    apply: (ctx) => {
      console.log('📦 Bundling DA.Internal.Template dependency...');
      const templateDir = path.join(ctx.targetDir, 'lib/DA/Internal/Template');
      createDirectoryIfNotExists(templateDir);
      const depRoot = packageDir(ctx.generatedJsDir, 'ghc-stdlib-DA-Internal-Template-1.0.0');
      const moduleSrc = path.join(depRoot, 'lib/DA/Internal/Template/module.js');
      const moduleDtsSrc = path.join(depRoot, 'lib/DA/Internal/Template/module.d.ts');

      if (fs.existsSync(moduleSrc)) {
        fs.copyFileSync(moduleSrc, path.join(templateDir, 'module.js'));
      } else {
        console.log('⚠️  module.js not found in dependency, creating minimal version');
        fs.writeFileSync(
          path.join(templateDir, 'module.js'),
          `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var jtv = require('@mojotech/json-type-validation');
var damlTypes = require('@daml/types');
exports.Archive = {
  decoder: damlTypes.lazyMemo(function () { return jtv.object({}); }),
  encode: function (__typed__) { return {}; },
};
`
        );
      }

      if (fs.existsSync(moduleDtsSrc)) {
        fs.copyFileSync(moduleDtsSrc, path.join(templateDir, 'module.d.ts'));
      } else {
        console.log('⚠️  module.d.ts not found in dependency, creating minimal version');
        fs.writeFileSync(
          path.join(templateDir, 'module.d.ts'),
          `import * as damlTypes from '@daml/types';
export declare type Archive = {};
export declare const Archive: damlTypes.Serializable<Archive>;
`
        );
      }

      writeModuleIndexPair(templateDir);
      writeNamespaceChildPair(path.join(ctx.targetDir, 'lib/DA/Internal'), 'Template');
      writeNamespaceChildPair(path.join(ctx.targetDir, 'lib/DA'), 'Internal');

      ensureWrapper(
        ctx.targetDir,
        'ghc-stdlib-DA-Internal-Template',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var Template = require('../../DA/Internal/Template');
exports.DA = { Internal: { Template: Template } };
`,
        `import * as Template from '../../DA/Internal/Template';
export declare const DA: { Internal: { Template: typeof Template } };
`
      );
      console.log('✅ Created bundled DA.Internal.Template structure');
    },
    rewriteRules: (targetDir) => [
      {
        importPaths: importVariants('ghc-stdlib-DA-Internal-Template-1.0.0'),
        resolveTarget: () =>
          path.join(targetDir, 'lib/__bundled__/ghc-stdlib-DA-Internal-Template'),
        logLabel: 'DA',
      },
    ],
  },

  'featured-app-v1': {
    id: 'featured-app-v1',
    importSpecs: () => importVariants('splice-api-featured-app-v1-1.0.0'),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'Splice', 'Api', 'FeaturedAppRightV1'),
      path.join(targetDir, 'lib', '__bundled__', 'splice-api-featured-app-v1'),
    ],
    apply: (ctx) => {
      console.log('📦 Bundling splice-api-featured-app-v1 dependency...');
      const spliceDir = path.join(ctx.targetDir, 'lib/Splice/Api/FeaturedAppRightV1');
      createDirectoryIfNotExists(spliceDir);
      const depRoot = packageDir(ctx.generatedJsDir, 'splice-api-featured-app-v1-1.0.0');
      const moduleSrc = path.join(depRoot, 'lib/Splice/Api/FeaturedAppRightV1/module.js');
      const moduleDtsSrc = path.join(depRoot, 'lib/Splice/Api/FeaturedAppRightV1/module.d.ts');

      if (fs.existsSync(moduleSrc)) {
        fs.copyFileSync(moduleSrc, path.join(spliceDir, 'module.js'));
      } else {
        console.log('⚠️  Splice module.js not found in dependency, creating minimal version');
        fs.writeFileSync(
          path.join(spliceDir, 'module.js'),
          `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var damlTypes = require('@daml/types');
var jtv = require('@mojotech/json-type-validation');
exports.FeaturedAppRight = {
  decoder: damlTypes.lazyMemo(function () { return jtv.object({}); }),
  encode: function (__typed__) { return {}; },
};
`
        );
      }

      if (fs.existsSync(moduleDtsSrc)) {
        fs.copyFileSync(moduleDtsSrc, path.join(spliceDir, 'module.d.ts'));
      } else {
        fs.writeFileSync(
          path.join(spliceDir, 'module.d.ts'),
          `import * as damlTypes from '@daml/types';
export declare type FeaturedAppRight = {};
export declare const FeaturedAppRight: damlTypes.Serializable<FeaturedAppRight>;
`
        );
      }

      writeModuleIndexPair(spliceDir);
      writeNamespaceChildPair(path.join(ctx.targetDir, 'lib/Splice/Api'), 'FeaturedAppRightV1');
      writeNamespaceChildPair(path.join(ctx.targetDir, 'lib/Splice'), 'Api');

      ensureWrapper(
        ctx.targetDir,
        'splice-api-featured-app-v1',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var FeaturedAppRightV1 = require('../../Splice/Api/FeaturedAppRightV1');
exports.Splice = { Api: { FeaturedAppRightV1: FeaturedAppRightV1 } };
`,
        `import * as FeaturedAppRightV1 from '../../Splice/Api/FeaturedAppRightV1';
export declare const Splice: { Api: { FeaturedAppRightV1: typeof FeaturedAppRightV1 } };
`
      );
      console.log('✅ Created bundled splice-api-featured-app-v1 structure');
    },
    rewriteRules: (targetDir) => [
      {
        importPaths: importVariants('splice-api-featured-app-v1-1.0.0'),
        resolveTarget: () => path.join(targetDir, 'lib/__bundled__/splice-api-featured-app-v1'),
        logLabel: 'Splice',
      },
    ],
  },

  'featured-app-v2': {
    id: 'featured-app-v2',
    importSpecs: () => importVariants('splice-api-featured-app-v2-1.0.0'),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'Splice', 'Api', 'FeaturedAppRightV2'),
      path.join(targetDir, 'lib', '__bundled__', 'splice-api-featured-app-v2'),
    ],
    shouldApply: (ctx) => packageNeedsFeaturedAppV2(ctx),
    apply: (ctx) => {
      console.log('📦 Bundling splice-api-featured-app-v2 dependency...');
      const sourceDir = path.join(
        packageDir(ctx.generatedJsDir, 'splice-api-featured-app-v2-1.0.0'),
        'lib/Splice/Api/FeaturedAppRightV2'
      );
      if (!fs.existsSync(sourceDir)) {
        console.log('⚠️  splice-api-featured-app-v2 FeaturedAppRightV2 directory not found');
        return;
      }
      createDirectoryIfNotExists(path.join(ctx.targetDir, 'lib/Splice/Api'));
      copyDirectory(sourceDir, path.join(ctx.targetDir, 'lib/Splice/Api/FeaturedAppRightV2'));
      ensureWrapper(
        ctx.targetDir,
        'splice-api-featured-app-v2',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var FeaturedAppRightV2 = require('../../Splice/Api/FeaturedAppRightV2');
exports.Splice = { Api: { FeaturedAppRightV2: FeaturedAppRightV2 } };
`,
        `import * as FeaturedAppRightV2 from '../../Splice/Api/FeaturedAppRightV2';
export declare const Splice: { Api: { FeaturedAppRightV2: typeof FeaturedAppRightV2 } };
`
      );
      console.log('✅ Copied splice-api-featured-app-v2 FeaturedAppRightV2 modules');
    },
    rewriteRules: (targetDir) => [
      {
        importPaths: importVariants('splice-api-featured-app-v2-1.0.0'),
        resolveTarget: () => path.join(targetDir, 'lib/__bundled__/splice-api-featured-app-v2'),
        logLabel: 'Splice v2',
      },
    ],
  },

  amulet: {
    id: 'amulet',
    importSpecs: (pins) => importVariants(amuletPackageName(pins)),
    detectionTargets: (targetDir) => [path.join(targetDir, 'lib')],
    apply: (ctx) => {
      console.log('📦 Bundling splice-amulet dependency...');
      const spliceSourceDir = path.join(
        packageDir(ctx.generatedJsDir, amuletPackageName(ctx.pins)),
        'lib/Splice'
      );
      if (
        !copyModuleTreeOrWarn(
          spliceSourceDir,
          path.join(ctx.targetDir, 'lib/Splice'),
          'splice-amulet Splice directory'
        )
      ) {
        return;
      }
      console.log('✅ Copied splice-amulet Splice modules');
    },
    rewriteRules: (targetDir, pins) => [
      {
        importPaths: importVariants(amuletPackageName(pins)),
        resolveTarget: () => path.join(targetDir, 'lib'),
        logLabel: 'splice-amulet',
      },
    ],
  },

  'da-time-types': {
    id: 'da-time-types',
    importSpecs: () => importVariants('daml-stdlib-DA-Time-Types-1.0.0'),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'DA', 'Time', 'Types'),
      path.join(targetDir, 'lib', '__bundled__', 'daml-stdlib-DA-Time-Types'),
    ],
    apply: (ctx) => {
      console.log('📦 Bundling DA Time Types dependency...');
      const sourceDir = path.join(
        packageDir(ctx.generatedJsDir, 'daml-stdlib-DA-Time-Types-1.0.0'),
        'lib/DA/Time'
      );
      if (!copyModuleTreeOrWarn(sourceDir, path.join(ctx.targetDir, 'lib/DA/Time'), 'DA Time Types')) {
        return;
      }
      ensureWrapper(
        ctx.targetDir,
        'daml-stdlib-DA-Time-Types',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var Types = require('../../DA/Time/Types');
exports.DA = { Time: { Types: Types } };
`,
        `import * as Types from '../../DA/Time/Types';
export declare const DA: { Time: { Types: typeof Types } };
`
      );
      console.log('✅ Copied DA Time Types modules');
    },
    rewriteRules: (targetDir) => [
      {
        importPaths: importVariants('daml-stdlib-DA-Time-Types-1.0.0'),
        resolveTarget: () => path.join(targetDir, 'lib/__bundled__/daml-stdlib-DA-Time-Types'),
        logLabel: 'DA Time Types',
      },
    ],
  },

  'da-types': {
    id: 'da-types',
    importSpecs: () => importVariants('daml-prim-DA-Types-1.0.0'),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'DA', 'Types'),
      path.join(targetDir, 'lib', '__bundled__', 'daml-prim-DA-Types'),
    ],
    apply: (ctx) => {
      console.log('📦 Bundling DA Types dependency...');
      const sourceDir = path.join(
        packageDir(ctx.generatedJsDir, 'daml-prim-DA-Types-1.0.0'),
        'lib/DA/Types'
      );
      if (!copyModuleTreeOrWarn(sourceDir, path.join(ctx.targetDir, 'lib/DA/Types'), 'DA Types')) {
        return;
      }
      ensureWrapper(
        ctx.targetDir,
        'daml-prim-DA-Types',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var Types = require('../../DA/Types');
exports.DA = { Types: Types };
`,
        `import * as Types from '../../DA/Types';
export declare const DA: { Types: typeof Types };
`
      );
      console.log('✅ Copied DA Types modules');
    },
    rewriteRules: (targetDir) => [
      {
        importPaths: importVariants('daml-prim-DA-Types-1.0.0'),
        resolveTarget: () => path.join(targetDir, 'lib/__bundled__/daml-prim-DA-Types'),
        logLabel: 'DA Types',
      },
    ],
  },

  'da-set-types': {
    id: 'da-set-types',
    importSpecs: () => importVariants('daml-stdlib-DA-Set-Types-1.0.0'),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'DA', 'Set', 'Types'),
      path.join(targetDir, 'lib', '__bundled__', 'daml-stdlib-DA-Set-Types'),
    ],
    apply: (ctx) => {
      console.log('📦 Bundling DA Set Types dependency...');
      const sourceDir = path.join(
        packageDir(ctx.generatedJsDir, 'daml-stdlib-DA-Set-Types-1.0.0'),
        'lib/DA/Set'
      );
      if (!copyModuleTreeOrWarn(sourceDir, path.join(ctx.targetDir, 'lib/DA/Set'), 'DA Set Types')) {
        return;
      }
      ensureWrapper(
        ctx.targetDir,
        'daml-stdlib-DA-Set-Types',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var Types = require('../../DA/Set/Types');
exports.DA = { Set: { Types: Types } };
`,
        `import * as Types from '../../DA/Set/Types';
export declare const DA: { Set: { Types: typeof Types } };
`
      );
      console.log('✅ Copied DA Set Types modules');
    },
    rewriteRules: (targetDir) => [
      {
        importPaths: importVariants('daml-stdlib-DA-Set-Types-1.0.0'),
        resolveTarget: () => path.join(targetDir, 'lib/__bundled__/daml-stdlib-DA-Set-Types'),
        logLabel: 'DA Set Types',
      },
    ],
  },

  'splice-token-v1': {
    id: 'splice-token-v1',
    importSpecs: () =>
      TOKEN_V1_PACKAGES.flatMap((pkg) => importVariants(pkg.dirName)),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'Splice', 'Api', 'Token', 'BurnMintV1'),
      path.join(targetDir, 'lib', 'Splice', 'Api', 'Token', 'MetadataV1'),
      path.join(targetDir, 'lib', 'Splice', 'Api', 'Token', 'HoldingV1'),
      path.join(targetDir, 'lib', 'Splice', 'Api', 'Token', 'AllocationInstructionV1'),
      path.join(targetDir, 'lib', 'Splice', 'Api', 'Token', 'TransferInstructionV1'),
      path.join(targetDir, 'lib', 'Splice', 'Api', 'Token', 'AllocationV1'),
      ...TOKEN_V1_PACKAGES.map((pkg) =>
        path.join(targetDir, 'lib', '__bundled__', pkg.wrapperName)
      ),
    ],
    apply: (ctx) => {
      console.log('📦 Bundling Splice API Token dependencies...');
      for (const pkg of TOKEN_V1_PACKAGES) {
        const sourceDir = path.join(packageDir(ctx.generatedJsDir, pkg.dirName), pkg.relModule);
        const destDir = path.join(ctx.targetDir, pkg.relModule);
        if (fs.existsSync(sourceDir)) {
          copyDirectory(sourceDir, destDir);
          console.log(`✅ Copied ${pkg.wrapperName}`);
        }
      }

      for (const pkg of TOKEN_V1_PACKAGES) {
        const relPath = `../../Splice/Api/Token/${pkg.wrapperKey}`;
        ensureWrapper(
          ctx.targetDir,
          pkg.wrapperName,
          `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var mod = require('${relPath}');
Object.assign(exports, mod);
exports.Splice = { Api: { Token: { ${pkg.wrapperKey}: mod } } };
`,
          `export * from '${relPath}';
import * as mod from '${relPath}';
export declare const Splice: { Api: { Token: { ${pkg.wrapperKey}: typeof mod } } };
`
        );
      }
    },
    rewriteRules: (targetDir) =>
      TOKEN_V1_PACKAGES.map((pkg) => ({
        importPaths: importVariants(pkg.dirName),
        resolveTarget: () => path.join(targetDir, 'lib/__bundled__', pkg.wrapperName),
      })),
  },

  'splice-token-standard-utils': {
    id: 'splice-token-standard-utils',
    importSpecs: (pins) => importVariants(tokenStandardUtilsPackageName(pins)),
    detectionTargets: (targetDir) => [
      path.join(targetDir, 'lib', 'Splice', 'TokenStandard'),
      path.join(targetDir, 'lib', '__bundled__', 'splice-token-standard-utils'),
    ],
    apply: (ctx) => {
      console.log('📦 Bundling splice-token-standard-utils dependency...');
      const depRoot = packageDir(ctx.generatedJsDir, tokenStandardUtilsPackageName(ctx.pins));
      const sourceDir = path.join(depRoot, 'lib/Splice/TokenStandard');
      if (fs.existsSync(sourceDir)) {
        copyDirectory(sourceDir, path.join(ctx.targetDir, 'lib/Splice/TokenStandard'));
      } else {
        const alt = path.join(depRoot, 'lib/Splice');
        if (!copyModuleTreeOrWarn(alt, path.join(ctx.targetDir, 'lib/Splice'), 'splice-token-standard-utils')) {
          return;
        }
      }
      ensureWrapper(
        ctx.targetDir,
        'splice-token-standard-utils',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var TokenStandard = require('../../Splice/TokenStandard');
exports.Splice = { TokenStandard: TokenStandard };
`,
        `import * as TokenStandard from '../../Splice/TokenStandard';
export declare const Splice: { TokenStandard: typeof TokenStandard };
`
      );
      console.log('✅ Copied splice-token-standard-utils modules');
    },
    rewriteRules: (targetDir, pins) => [
      {
        importPaths: importVariants(tokenStandardUtilsPackageName(pins)),
        resolveTarget: () => path.join(targetDir, 'lib/__bundled__/splice-token-standard-utils'),
      },
    ],
  },
};

/** Stable apply order matching the historical assets pipeline. */
export const BUNDLE_PRESET_APPLY_ORDER: BundlePresetId[] = [
  'da-internal-template',
  'featured-app-v1',
  'amulet',
  'featured-app-v2',
  'da-time-types',
  'da-types',
  'splice-token-v1',
  'splice-token-standard-utils',
  'da-set-types',
];

export function getBundledArtifactDirs(targetDir: string): string[] {
  return [
    path.join(targetDir, 'lib', 'Splice'),
    path.join(targetDir, 'lib', '__bundled__'),
    path.join(targetDir, 'lib', 'DA', 'Time'),
    path.join(targetDir, 'lib', 'DA', 'Types'),
    path.join(targetDir, 'lib', 'DA', 'Set'),
  ];
}

export function resolvePresetIds(selected: BundlePresetId[]): BundlePresetDefinition[] {
  const selectedSet = new Set(selected);
  return BUNDLE_PRESET_APPLY_ORDER.filter((id) => selectedSet.has(id)).map(
    (id) => BUNDLE_PRESETS[id]
  );
}

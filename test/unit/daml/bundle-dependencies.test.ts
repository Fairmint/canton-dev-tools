import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleDependenciesForTarget,
  createRootIndex,
  parseDamlJsBundleConfig,
  resolveDamlJsBundleConfig,
  BUNDLE_PRESET_IDS,
} from '../../../src/daml/codegen';

function writePair(dir: string, base: string, js: string, dts = 'export {};\n'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${base}.js`), js);
  writeFileSync(join(dir, `${base}.d.ts`), dts);
}

function scaffoldRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'daml-js-bundle-'));
  writeFileSync(
    join(root, 'multi-package.yaml'),
    `packages:\n- DemoPkg\n`
  );
  mkdirSync(join(root, 'DemoPkg'), { recursive: true });
  writeFileSync(
    join(root, 'DemoPkg', 'daml.yaml'),
    `name: DemoPkg
version: 0.0.1
source: daml
dependencies:
- daml-prim
- daml-stdlib
codegen:
  js:
    output-directory: ../generated/js/DemoPkg-0.0.1
`
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@fairmint/demo-daml-js', version: '0.0.1' }, null, 2)
  );
  return root;
}

function scaffoldGeneratedPackage(root: string): string {
  const pkgDir = join(root, 'generated', 'js', 'DemoPkg-0.0.1');
  const libDir = join(pkgDir, 'lib');
  writePair(
    join(libDir, 'Demo'),
    'module',
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var template = require('daml.js/ghc-stdlib-DA-Internal-Template-1.0.0');
var time = require('daml.js/daml-stdlib-DA-Time-Types-1.0.0');
exports.Demo = { template: template, time: time };
`
  );
  writePair(
    libDir,
    'index',
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var Demo = require('./Demo');
exports.Demo = Demo;
`,
    `import * as Demo from './Demo';
export { Demo } ;
`
  );
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: '@fairmint/demo-daml-js',
        version: '0.0.1',
        dependencies: {
          'daml.js/ghc-stdlib-DA-Internal-Template-1.0.0': 'file:../ghc-stdlib-DA-Internal-Template-1.0.0',
          'daml.js/daml-stdlib-DA-Time-Types-1.0.0': 'file:../daml-stdlib-DA-Time-Types-1.0.0',
        },
      },
      null,
      4
    )
  );
  return pkgDir;
}

function scaffoldDependencyTemplates(root: string): void {
  const jsRoot = join(root, 'generated', 'js');

  writePair(
    join(jsRoot, 'ghc-stdlib-DA-Internal-Template-1.0.0', 'lib', 'DA', 'Internal', 'Template'),
    'module',
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Archive = { encode: function () { return {}; } };
`,
    `export declare const Archive: { encode: () => object };\n`
  );

  writePair(
    join(jsRoot, 'daml-stdlib-DA-Time-Types-1.0.0', 'lib', 'DA', 'Time', 'Types'),
    'module',
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RelTime = {};
`,
    `export declare const RelTime: object;\n`
  );
  writePair(
    join(jsRoot, 'daml-stdlib-DA-Time-Types-1.0.0', 'lib', 'DA', 'Time', 'Types'),
    'index',
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function __export(m) { for (var p in m) exports[p] = m[p]; }
__export(require('./module'));
`,
    `export * from './module';\n`
  );
}

describe('daml-js-bundle config', (): void => {
  it('parses presets, pins, and rootIndex', (): void => {
    const parsed = parseDamlJsBundleConfig(
      {
        presets: ['da-internal-template', 'amulet', 'da-time-types'],
        pins: { amulet: '0.1.19' },
        rootIndex: {
          sourcePackage: { namePrefix: 'Demo' },
          copy: ['Demo', 'DA'],
          namespaces: ['Demo', 'DA'],
          templateConstants: {
            DEMO_TEMPLATES: {
              demo: {
                from: './Demo/module',
                binding: 'Demo',
              },
            },
          },
          postBundlePresets: ['da-time-types'],
        },
      },
      'test'
    );
    expect(parsed.presets).toEqual(['da-internal-template', 'amulet', 'da-time-types']);
    expect(parsed.pins?.amulet).toBe('0.1.19');
    expect(parsed.rootIndex?.namespaces).toEqual(['Demo', 'DA']);
  });

  it('rejects unknown preset ids', (): void => {
    expect(() =>
      parseDamlJsBundleConfig({ presets: ['wrapped-assets'] }, 'test')
    ).toThrow(/Invalid test.presets\[0\]/);
  });

  it('rejects unsafe rootIndex.outputDir and copy paths', (): void => {
    expect(() =>
      parseDamlJsBundleConfig(
        {
          rootIndex: {
            outputDir: '../outside',
            sourcePackage: { namePrefix: 'Demo' },
            copy: ['Demo'],
            namespaces: ['Demo'],
          },
        },
        'test'
      )
    ).toThrow(/Unsafe test\.rootIndex\.outputDir/);

    expect(() =>
      parseDamlJsBundleConfig(
        {
          rootIndex: {
            outputDir: 'dist',
            sourcePackage: { namePrefix: 'Demo' },
            copy: ['Demo'],
            namespaces: ['Demo'],
          },
        },
        'test'
      )
    ).toThrow(/must resolve to a directory named "lib"/);

    expect(() =>
      parseDamlJsBundleConfig(
        {
          rootIndex: {
            sourcePackage: { namePrefix: 'Demo' },
            copy: ['../escape'],
            namespaces: ['Demo'],
          },
        },
        'test'
      )
    ).toThrow(/Unsafe test\.rootIndex\.copy\[0\]/);
  });

  it('accepts nested outputDir when basename is lib', (): void => {
    const parsed = parseDamlJsBundleConfig(
      {
        rootIndex: {
          outputDir: 'packages/demo/lib',
          sourcePackage: { namePrefix: 'Demo' },
          copy: ['Demo'],
          namespaces: ['Demo'],
        },
      },
      'test'
    );
    expect(parsed.rootIndex?.outputDir).toBe('packages/demo/lib');
  });

  it('resolves daml-js-bundle.json with defaults', (): void => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-config-'));
    try {
      writeFileSync(
        join(root, 'daml-js-bundle.json'),
        JSON.stringify({
          presets: ['da-internal-template', 'da-time-types'],
          pins: { amulet: '0.1.20' },
        })
      );
      const resolved = resolveDamlJsBundleConfig({ rootDir: root });
      expect(resolved.pins.amulet).toBe('0.1.20');
      expect(resolved.pins.tokenStandardUtils).toBe('2.0.0');
      expect(resolved.presets[0]).toBe('da-internal-template');
      expect(resolved.presets).toContain('da-time-types');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults to all built-in presets when allowMissing', (): void => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-missing-'));
    try {
      const resolved = resolveDamlJsBundleConfig({ rootDir: root, allowMissing: true });
      expect(resolved.presets).toEqual([...BUNDLE_PRESET_IDS]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bundleDependenciesForTarget', (): void => {
  it('bundles detected stdlib deps and rewrites imports', (): void => {
    const root = scaffoldRepo();
    try {
      scaffoldDependencyTemplates(root);
      const pkgDir = scaffoldGeneratedPackage(root);

      const applied = bundleDependenciesForTarget({
        targetDir: pkgDir,
        generatedJsDir: join(root, 'generated', 'js'),
        pins: { amulet: '0.1.19', tokenStandardUtils: '2.0.0' },
        presets: ['da-internal-template', 'da-time-types'],
      });

      expect(applied).toEqual(['da-internal-template', 'da-time-types']);
      expect(existsSync(join(pkgDir, 'lib/DA/Internal/Template/module.js'))).toBe(true);
      expect(existsSync(join(pkgDir, 'lib/__bundled__/ghc-stdlib-DA-Internal-Template/index.js'))).toBe(
        true
      );
      expect(existsSync(join(pkgDir, 'lib/DA/Time/Types/module.js'))).toBe(true);

      const demoJs = readFileSync(join(pkgDir, 'lib/Demo/module.js'), 'utf8');
      expect(demoJs).toContain('__bundled__/ghc-stdlib-DA-Internal-Template');
      expect(demoJs).toContain('__bundled__/daml-stdlib-DA-Time-Types');
      expect(demoJs).not.toContain('daml.js/ghc-stdlib-DA-Internal-Template-1.0.0');

      const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      expect(pkgJson.dependencies?.['daml.js/ghc-stdlib-DA-Internal-Template-1.0.0']).toBeUndefined();
      expect(pkgJson.dependencies?.['daml.js/daml-stdlib-DA-Time-Types-1.0.0']).toBeUndefined();

      const mainIndex = readFileSync(join(pkgDir, 'lib/index.js'), 'utf8');
      expect(mainIndex).toContain("require('./DA')");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not enable featured-app-v2 without amulet', (): void => {
    const root = scaffoldRepo();
    try {
      scaffoldDependencyTemplates(root);
      const pkgDir = scaffoldGeneratedPackage(root);
      // Place an amulet template that references v2 — must NOT trigger without willBundleAmulet.
      writePair(
        join(root, 'generated/js/splice-amulet-0.1.19/lib/Splice/Amulet'),
        'module',
        `"use strict";
require('daml.js/splice-api-featured-app-v2-1.0.0');
`
      );

      const applied = bundleDependenciesForTarget({
        targetDir: pkgDir,
        generatedJsDir: join(root, 'generated', 'js'),
        pins: { amulet: '0.1.19', tokenStandardUtils: '2.0.0' },
        presets: ['da-internal-template', 'featured-app-v2', 'amulet'],
      });

      expect(applied).toEqual(['da-internal-template']);
      expect(applied).not.toContain('featured-app-v2');
      expect(applied).not.toContain('amulet');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not rewrite or strip deps when preset source is missing', (): void => {
    const root = scaffoldRepo();
    try {
      // Intentionally omit daml-stdlib-DA-Time-Types generated tree.
      scaffoldDependencyTemplates(root);
      rmSync(join(root, 'generated', 'js', 'daml-stdlib-DA-Time-Types-1.0.0'), {
        recursive: true,
        force: true,
      });
      const pkgDir = scaffoldGeneratedPackage(root);

      const applied = bundleDependenciesForTarget({
        targetDir: pkgDir,
        generatedJsDir: join(root, 'generated', 'js'),
        pins: { amulet: '0.1.19', tokenStandardUtils: '2.0.0' },
        presets: ['da-internal-template', 'da-time-types'],
        forcePresets: ['da-time-types'],
      });

      expect(applied).toEqual(['da-internal-template']);
      expect(applied).not.toContain('da-time-types');
      expect(existsSync(join(pkgDir, 'lib/__bundled__/daml-stdlib-DA-Time-Types'))).toBe(false);

      const demoJs = readFileSync(join(pkgDir, 'lib/Demo/module.js'), 'utf8');
      expect(demoJs).toContain("require('daml.js/daml-stdlib-DA-Time-Types-1.0.0')");
      expect(demoJs).not.toContain('__bundled__/daml-stdlib-DA-Time-Types');
      // Successful preset still rewrites.
      expect(demoJs).toContain('__bundled__/ghc-stdlib-DA-Internal-Template');

      const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      expect(pkgJson.dependencies?.['daml.js/daml-stdlib-DA-Time-Types-1.0.0']).toBe(
        'file:../daml-stdlib-DA-Time-Types-1.0.0'
      );
      expect(pkgJson.dependencies?.['daml.js/ghc-stdlib-DA-Internal-Template-1.0.0']).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createRootIndex', (): void => {
  it('merges configured namespaces and template constants', (): void => {
    const root = scaffoldRepo();
    try {
      scaffoldDependencyTemplates(root);
      const pkgDir = scaffoldGeneratedPackage(root);
      bundleDependenciesForTarget({
        targetDir: pkgDir,
        generatedJsDir: join(root, 'generated', 'js'),
        pins: { amulet: '0.1.19', tokenStandardUtils: '2.0.0' },
        presets: ['da-internal-template', 'da-time-types'],
      });

      // Add a Demo binding with templateId for constant generation.
      writePair(
        join(pkgDir, 'lib', 'Demo'),
        'module',
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Demo = { templateId: 'Demo:Demo:Demo' };
`,
        `export declare const Demo: { templateId: string };\n`
      );

      writeFileSync(
        join(root, 'daml-js-bundle.json'),
        JSON.stringify(
          {
            presets: ['da-internal-template', 'da-time-types'],
            rootIndex: {
              sourcePackage: { namePrefix: 'Demo' },
              copy: ['Demo', 'DA', '__bundled__'],
              namespaces: ['Demo', 'DA'],
              templateConstants: {
                DEMO_TEMPLATES: {
                  demo: { from: './Demo/module', binding: 'Demo' },
                },
              },
              postBundlePresets: ['da-time-types'],
            },
          },
          null,
          2
        )
      );

      const result = createRootIndex({ rootDir: root });
      expect(result.outputDir).toBe(join(root, 'lib'));
      expect(existsSync(join(root, 'lib/Demo/module.js'))).toBe(true);
      expect(existsSync(join(root, 'lib/DA/Internal/Template/module.js'))).toBe(true);

      const indexJs = readFileSync(join(root, 'lib/index.js'), 'utf8');
      expect(indexJs).toContain("require('./Demo')");
      expect(indexJs).toContain('DEMO_TEMPLATES');
      expect(indexJs).toContain('Demo.templateId');

      const indexDts = readFileSync(join(root, 'lib/index.d.ts'), 'utf8');
      expect(indexDts).toContain('export { Demo, DA }');
      expect(indexDts).toContain('DEMO_TEMPLATES');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

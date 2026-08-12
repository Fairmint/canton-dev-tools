import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collapseManifestLines,
  createPackageIndexes,
  GENERATED_PACKAGE_INDEX_DTS,
  GENERATED_PACKAGE_INDEX_JS,
  hasGeneratedOutputPair,
  writeGeneratedOutputPair,
  rewriteGeneratedOutputFiles,
  applyGeneratedImportRewrites,
  findUnresolvedPackageImports,
  DEFAULT_UNRESOLVED_IMPORT_PATTERNS,
  buildPublishedPackageName,
  resolvePublishedPackageName,
  fixSpliceRefs,
  updateGeneratedPackages,
} from '../../../src/daml/codegen';
import { parseChangelogRepo, selectReleaseVersion } from '../../../src/prepare-release';

describe('collapseManifestLines', (): void => {
  it('drops map files and collapses js/d.ts pairs', (): void => {
    expect(
      collapseManifestLines([
        'lib/index.js',
        'lib/index.d.ts',
        'lib/index.js.map',
        'lib/index.d.ts.map',
        'README.md',
      ])
    ).toEqual(['README.md', 'lib/index']);
  });

  it('throws when no files remain', (): void => {
    expect(() => collapseManifestLines([])).toThrow(/No files found/);
  });
});

describe('generated package index helpers', (): void => {
  it('writes index.js and index.d.ts', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-index-'));
    try {
      createPackageIndexes({ packageDirs: [dir] });
      expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe(GENERATED_PACKAGE_INDEX_JS);
      expect(readFileSync(join(dir, 'index.d.ts'), 'utf8')).toBe(GENERATED_PACKAGE_INDEX_DTS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generated output helpers', (): void => {
  it('writes and detects output pairs, then rewrites imports', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-out-'));
    try {
      writeGeneratedOutputPair(dir, 'mod', {
        js: "const x = require('daml.js/foo');\n",
        dts: "export * from 'daml.js/foo';\n",
      });
      expect(hasGeneratedOutputPair(dir, 'mod')).toBe(true);

      const rewritten = rewriteGeneratedOutputFiles(dir, (source, ctx) =>
        source.replace(/daml\.js\/foo/g, ctx.isDts ? './rel' : './rel')
      );
      expect(rewritten).toBe(2);
      expect(readFileSync(join(dir, 'mod.js'), 'utf8')).toContain("./rel");

      writeGeneratedOutputPair(dir, 'other', {
        js: "require('@fairmint/splice-api-token-metadata-v1-1.0.0');\n",
        dts: "from '@fairmint/splice-api-token-metadata-v1-1.0.0';\n",
      });
      const target = join(dir, '__bundled__', 'splice-api-token-metadata-v1');
      mkdirSync(target, { recursive: true });
      applyGeneratedImportRewrites(dir, [
        {
          importPaths: ['@fairmint/splice-api-token-metadata-v1-1.0.0'],
          resolveTarget: () => target,
        },
      ]);
      expect(readFileSync(join(dir, 'other.js'), 'utf8')).toContain('__bundled__');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('updateGeneratedPackages', (): void => {
  it('stamps name/version and normalizes peer-dependencies', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-update-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: '@fairmint/old',
          version: '9.9.9',
          private: true,
          'peer-dependencies': { '@daml/types': '3.5.2' },
        })
      );
      updateGeneratedPackages({
        rootPackageName: '@fairmint/wrapped-assets-daml-js',
        rootPackageVersion: '0.0.1',
        peerDependencies: { '@daml/types': '3.5.2', '@daml/ledger': '2.10.4' },
        packages: [{ dir, publishedPackageName: '@fairmint/wrapped-assets-daml-js' }],
      });
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        private?: boolean;
        peerDependencies?: Record<string, string>;
        'peer-dependencies'?: unknown;
      };
      expect(pkg.name).toBe('@fairmint/wrapped-assets-daml-js');
      expect(pkg.version).toBe('0.0.1');
      expect(pkg.private).toBeUndefined();
      expect(pkg['peer-dependencies']).toBeUndefined();
      expect(pkg.peerDependencies).toEqual({
        '@daml/types': '3.5.2',
        '@daml/ledger': '2.10.4',
      });
      expect(existsSync(join(dir, 'index.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('publish name helpers', (): void => {
  it('builds suffix names and resolves single-package root name', (): void => {
    expect(buildPublishedPackageName('@fairmint/daml-js', null)).toBe('@fairmint/daml-js');
    expect(buildPublishedPackageName('@fairmint/daml-js', 'reports')).toBe(
      '@fairmint/daml-js-reports'
    );
    expect(
      resolvePublishedPackageName({
        rootPackageName: '@fairmint/wrapped-assets-daml-js',
        pkg: {
          key: 'wrappedassets-v01',
          name: 'WrappedAssets-v01',
          darName: 'WrappedAssets-v01',
          version: '0.0.1',
          sourceDir: 'WrappedAssets-v01',
          buildDir: 'generated/build/WrappedAssets-v01',
        },
        suffixes: {},
        codegenPackageCount: 1,
      })
    ).toBe('@fairmint/wrapped-assets-daml-js');
  });
});

describe('fixSpliceRefs', (): void => {
  it('collapses nested Splice namespaces and rewrites @fairmint imports to __bundled__', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-splice-'));
    try {
      const bundled = join(dir, '__bundled__', 'splice-api-token-metadata-v1');
      mkdirSync(bundled, { recursive: true });
      writeFileSync(
        join(dir, 'Holding.js'),
        [
          "var pkgabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 = require('@fairmint/splice-api-token-metadata-v1-1.0.0');",
          'exports.x = pkgabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789.Splice.Api.Token.MetadataV1.Metadata;',
          '',
        ].join('\n')
      );
      writeFileSync(join(dir, 'Holding.d.ts'), 'export {};\n');

      fixSpliceRefs({ targetDir: dir });

      const js = readFileSync(join(dir, 'Holding.js'), 'utf8');
      expect(js).toContain(
        'pkgabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789.Metadata'
      );
      expect(js).not.toContain('Splice.Api.Token.MetadataV1.Metadata');
      expect(js).toContain('__bundled__/splice-api-token-metadata-v1');
      expect(js).not.toContain('@fairmint/splice-api-token-metadata-v1-1.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyPackageImports', (): void => {
  it('flags unresolved daml.js and @fairmint codegen imports by default', (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-imports-'));
    try {
      writeFileSync(
        join(dir, 'bad.js'),
        "require('@fairmint/splice-api-token-holding-v1-1.0.0');\nrequire('daml.js/ghc-stdlib-DA-Internal-Template-1.0.0');\n"
      );
      const issues = findUnresolvedPackageImports({
        libDir: dir,
        unresolvedPatterns: DEFAULT_UNRESOLVED_IMPORT_PATTERNS,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.matches.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('selectReleaseVersion / changelog repo', (): void => {
  const withTakenVersions = (...versions: string[]) => {
    const taken = new Set(versions);
    return (version: string): boolean => taken.has(version);
  };

  it('keeps floor version on first publish', (): void => {
    expect(selectReleaseVersion('0.0.1', '0.0.0', withTakenVersions('0.0.0'))).toBe('0.0.1');
  });

  it('parses changelog repo from package.json repository url', (): void => {
    expect(
      parseChangelogRepo({ type: 'git', url: 'git+https://github.com/Fairmint/canton-assets.git' })
    ).toBe('Fairmint/canton-assets');
  });
});

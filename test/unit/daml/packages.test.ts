import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPathInsideRoot,
  discoverManagedPackages,
  discoverPackages,
  findPackage,
  prepareBuild,
} from '../../../src/daml';

describe('daml package discovery + prepare-build', (): void => {
  let rootDir = '';

  beforeEach((): void => {
    rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-daml-'));
    mkdirSync(join(rootDir, 'WrappedAssets-v01', 'daml'), { recursive: true });
    mkdirSync(join(rootDir, 'Test', 'daml'), { recursive: true });
    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - WrappedAssets-v01\n  - Test\n`
    );
    writeFileSync(
      join(rootDir, 'WrappedAssets-v01', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: WrappedAssets-v01\nsource: daml\nversion: 0.0.1\ndependencies: []\n`
    );
    writeFileSync(
      join(rootDir, 'Test', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: Test\nsource: daml\nversion: 0.0.1\ndependencies:\n  - ../WrappedAssets-v01/.daml/dist/WrappedAssets-v01-0.0.1.dar\n`
    );
    writeFileSync(join(rootDir, 'WrappedAssets-v01', 'daml', 'Main.daml'), 'module Main where\n');
    writeFileSync(join(rootDir, 'Test', 'daml', 'Main.daml'), 'module Main where\n');
  });

  afterEach((): void => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('discovers packages from multi-package.yaml and excludes Test by default for managed set', (): void => {
    const all = discoverPackages(rootDir);
    expect(all.map((pkg) => pkg.name)).toEqual(['WrappedAssets-v01', 'Test']);

    const managed = discoverManagedPackages(rootDir);
    expect(managed.map((pkg) => pkg.name)).toEqual(['WrappedAssets-v01']);
    expect(managed[0]?.buildDir).toBe('generated/build/WrappedAssets-v01');
    expect(managed[0]?.key).toBe('wrappedassets-v01');
  });

  it('fuzzy-matches package aliases like wrappedAssets', (): void => {
    const managed = discoverManagedPackages(rootDir);
    expect(findPackage(managed, 'wrappedAssets')?.name).toBe('WrappedAssets-v01');
    expect(findPackage(managed, 'WrappedAssets-v01')?.key).toBe('wrappedassets-v01');
  });

  it('rejects ambiguous exact key matches from nested source dirs', (): void => {
    mkdirSync(join(rootDir, 'group-a', 'token', 'daml'), { recursive: true });
    mkdirSync(join(rootDir, 'group-b', 'token', 'daml'), { recursive: true });
    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - group-a/token\n  - group-b/token\n`
    );
    writeFileSync(
      join(rootDir, 'group-a', 'token', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: TokenA-v01\nsource: daml\nversion: 0.0.1\ndependencies: []\n`
    );
    writeFileSync(
      join(rootDir, 'group-b', 'token', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: TokenB-v01\nsource: daml\nversion: 0.0.1\ndependencies: []\n`
    );
    writeFileSync(join(rootDir, 'group-a', 'token', 'daml', 'Main.daml'), 'module Main where\n');
    writeFileSync(join(rootDir, 'group-b', 'token', 'daml', 'Main.daml'), 'module Main where\n');

    const managed = discoverManagedPackages(rootDir);
    expect(() => findPackage(managed, 'token')).toThrow(/Ambiguous package/);
  });

  it('prepare-build copies packages into generated/build and writes multi-package.yaml', (): void => {
    const generated = prepareBuild({ rootDir });
    expect(generated).toEqual(['WrappedAssets-v01', 'Test']);
    expect(
      existsSync(join(rootDir, 'generated', 'build', 'WrappedAssets-v01', 'daml', 'Main.daml'))
    ).toBe(true);
    expect(existsSync(join(rootDir, 'generated', 'build', 'Test', 'daml', 'Main.daml'))).toBe(true);

    const buildManifest = readFileSync(
      join(rootDir, 'generated', 'build', 'multi-package.yaml'),
      'utf8'
    );
    expect(buildManifest).toContain('WrappedAssets-v01');
    expect(buildManifest).toContain('Test');

    const testDamlYaml = readFileSync(
      join(rootDir, 'generated', 'build', 'Test', 'daml.yaml'),
      'utf8'
    );
    expect(testDamlYaml).toContain('WrappedAssets-v01');
  });

  it('rewrites nested and prefix-sensitive dependency paths into generated sibling packages', (): void => {
    mkdirSync(join(rootDir, 'group-a', 'token', 'daml'), { recursive: true });
    mkdirSync(join(rootDir, 'group-b', 'token', 'daml'), { recursive: true });
    mkdirSync(join(rootDir, 'OpenCap', 'daml'), { recursive: true });
    mkdirSync(join(rootDir, 'OpenCapTable', 'daml'), { recursive: true });
    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - group-a/token\n  - group-b/token\n  - OpenCap\n  - OpenCapTable\n`
    );
    writeFileSync(
      join(rootDir, 'group-a', 'token', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: TokenA-v01\nsource: daml\nversion: 0.0.1\ndata-dependencies:\n  - ../../group-b/token/.daml/dist/TokenB-v01-0.0.1.dar\n  - ../../libs/splice/foo.dar\n`
    );
    writeFileSync(
      join(rootDir, 'group-b', 'token', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: TokenB-v01\nsource: daml\nversion: 0.0.1\ndependencies: []\n`
    );
    writeFileSync(
      join(rootDir, 'OpenCap', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: OpenCap-v01\nsource: daml\nversion: 0.0.1\ndependencies: []\n`
    );
    writeFileSync(
      join(rootDir, 'OpenCapTable', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: OpenCapTable-v01\nsource: daml\nversion: 0.0.1\ndata-dependencies:\n  - ../OpenCapTable/.daml/dist/OpenCapTable-v01-0.0.1.dar\n`
    );
    for (const rel of [
      'group-a/token/daml/Main.daml',
      'group-b/token/daml/Main.daml',
      'OpenCap/daml/Main.daml',
      'OpenCapTable/daml/Main.daml',
    ]) {
      writeFileSync(join(rootDir, rel), 'module Main where\n');
    }

    prepareBuild({ rootDir });
    const tokenA = readFileSync(
      join(rootDir, 'generated', 'build', 'TokenA-v01', 'daml.yaml'),
      'utf8'
    );
    expect(tokenA).toContain('../TokenB-v01/.daml/dist/TokenB-v01-0.0.1.dar');
    expect(tokenA).toContain('../../../libs/splice/foo.dar');
    expect(tokenA).not.toContain('../../group-b/token');

    const openCapTable = readFileSync(
      join(rootDir, 'generated', 'build', 'OpenCapTable-v01', 'daml.yaml'),
      'utf8'
    );
    expect(openCapTable).toContain('../OpenCapTable-v01/.daml/dist/OpenCapTable-v01-0.0.1.dar');
    expect(openCapTable).not.toContain('../OpenCap/.daml');
  });

  it('rejects build paths that escape the repo root', (): void => {
    expect(() => assertPathInsideRoot(rootDir, rootDir, 'build root')).toThrow(/inside the repo/);
    expect(() => assertPathInsideRoot(rootDir, join(rootDir, '..'), 'build root')).toThrow(
      /inside the repo/
    );
    expect(() => assertPathInsideRoot(rootDir, '/tmp/outside', 'build root')).toThrow(
      /inside the repo/
    );
    expect(assertPathInsideRoot(rootDir, join(rootDir, 'generated/build'), 'build root')).toBe(
      join(rootDir, 'generated/build')
    );
  });

  it('rejects multi-package source dirs and daml.yaml names that escape the build tree', (): void => {
    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - ../../../.github\n`
    );
    expect(() => prepareBuild({ rootDir })).toThrow(/Unsafe/);

    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - WrappedAssets-v01\n`
    );
    writeFileSync(
      join(rootDir, 'WrappedAssets-v01', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: ../../../.github\nsource: daml\nversion: 0.0.1\ndependencies: []\n`
    );
    expect(() => prepareBuild({ rootDir })).toThrow(/Unsafe/);
  });

  it('rejects escaping source dirs and daml.yaml names during package discovery', (): void => {
    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - ../outside\n`
    );
    expect(() => discoverPackages(rootDir)).toThrow(/Unsafe/);

    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - WrappedAssets-v01\n`
    );
    writeFileSync(
      join(rootDir, 'WrappedAssets-v01', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: ../escape\nsource: daml\nversion: 0.0.1\ndependencies: []\n`
    );
    expect(() => discoverPackages(rootDir)).toThrow(/Unsafe/);
  });
});

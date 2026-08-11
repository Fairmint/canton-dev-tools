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
});

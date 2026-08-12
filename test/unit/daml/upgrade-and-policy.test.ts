import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkDarVersionPolicy,
  checkUpgradeCompatibility,
  normalizeExtraPolicyWatchPaths,
  parseExtraPolicyPathsArg,
  pathMatchesWatchPrefix,
  resolveDarVersionPolicyWatchPaths,
  saveDarsLock,
  selectChangedPackages,
  loadDarsLock,
  discoverManagedPackages,
} from '../../../src/daml';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function writePackage(rootDir: string, sourceDir: string, name: string, version: string): void {
  mkdirSync(join(rootDir, sourceDir, 'daml'), { recursive: true });
  writeFileSync(
    join(rootDir, sourceDir, 'daml.yaml'),
    `sdk-version: 3.5.2\nname: ${name}\nsource: daml\nversion: ${version}\ndependencies: []\n`
  );
  writeFileSync(join(rootDir, sourceDir, 'daml', 'Main.daml'), 'module Main where\n');
}

function git(rootDir: string, args: string[]): void {
  execFileSync('git', args, { cwd: rootDir, stdio: 'ignore' });
}

describe('checkUpgradeCompatibility', (): void => {
  let rootDir = '';

  beforeEach((): void => {
    rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-upgrade-'));
    writePackage(rootDir, 'WrappedAssets-v01', 'WrappedAssets-v01', '0.0.2');
    writeFileSync(join(rootDir, 'multi-package.yaml'), `packages:\n  - WrappedAssets-v01\n`);
  });

  afterEach((): void => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('fails when every managed package is skipped for missing built DARs', (): void => {
    const logged: string[] = [];
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(() => checkUpgradeCompatibility({ rootDir })).toThrow(
        /Upgrade compatibility check failed/
      );
      expect(logged.join('\n')).toMatch(/no built DAR found/);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('fails when only some managed packages are missing built DARs', (): void => {
    writePackage(rootDir, 'Other-v01', 'Other-v01', '0.0.1');
    writeFileSync(
      join(rootDir, 'multi-package.yaml'),
      `packages:\n  - WrappedAssets-v01\n  - Other-v01\n`
    );
    const built = Buffer.from('other-dar');
    const distDir = join(rootDir, 'generated', 'build', 'Other-v01', '.daml', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'Other-v01-0.0.1.dar'), built);
    mkdirSync(join(rootDir, 'dars', 'Other-v01', '0.0.1'), { recursive: true });
    writeFileSync(join(rootDir, 'dars', 'Other-v01', '0.0.1', 'Other-v01.dar'), built);
    saveDarsLock(rootDir, {
      version: 1,
      packages: {
        'Other-v01/0.0.1/Other-v01.dar': {
          sha256: sha256(built),
          size: built.length,
          sdkVersion: '3.5.2',
          uploadedAt: '2026-01-01T00:00:00.000Z',
          networks: [],
        },
      },
    });

    const logged: string[] = [];
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(() => checkUpgradeCompatibility({ rootDir })).toThrow(
        /Upgrade compatibility check failed/
      );
      expect(logged.join('\n')).toMatch(/WrappedAssets-v01: no built DAR found/);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('rejects non-semver versions in dars.lock when selecting upgrade baselines', (): void => {
    const currentBytes = Buffer.from('current-dar');
    const distDir = join(rootDir, 'generated', 'build', 'WrappedAssets-v01', '.daml', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'WrappedAssets-v01-0.0.2.dar'), currentBytes);
    mkdirSync(join(rootDir, 'dars', 'WrappedAssets-v01', '0.0.2'), { recursive: true });
    writeFileSync(
      join(rootDir, 'dars', 'WrappedAssets-v01', '0.0.2', 'WrappedAssets-v01.dar'),
      currentBytes
    );
    saveDarsLock(rootDir, {
      version: 1,
      packages: {
        'WrappedAssets-v01/not-a-version/WrappedAssets-v01.dar': {
          sha256: sha256('x'),
          size: 1,
          sdkVersion: '3.5.2',
          uploadedAt: '2026-01-01T00:00:00.000Z',
          networks: [],
        },
        'WrappedAssets-v01/0.0.2/WrappedAssets-v01.dar': {
          sha256: sha256(currentBytes),
          size: currentBytes.length,
          sdkVersion: '3.5.2',
          uploadedAt: '2026-02-01T00:00:00.000Z',
          networks: [],
        },
      },
    });

    expect(() => checkUpgradeCompatibility({ rootDir })).toThrow(/Invalid semver in dars.lock key/);
  });

  it('fails when an older lock baseline is missing on disk instead of treating as first release', (): void => {
    const currentBytes = Buffer.from('current-dar');
    const distDir = join(rootDir, 'generated', 'build', 'WrappedAssets-v01', '.daml', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'WrappedAssets-v01-0.0.2.dar'), currentBytes);

    mkdirSync(join(rootDir, 'dars', 'WrappedAssets-v01', '0.0.2'), { recursive: true });
    writeFileSync(
      join(rootDir, 'dars', 'WrappedAssets-v01', '0.0.2', 'WrappedAssets-v01.dar'),
      currentBytes
    );
    // 0.0.1 is in the lock but intentionally absent from dars/
    saveDarsLock(rootDir, {
      version: 1,
      packages: {
        'WrappedAssets-v01/0.0.1/WrappedAssets-v01.dar': {
          sha256: sha256('older-dar'),
          size: 9,
          sdkVersion: '3.5.2',
          uploadedAt: '2026-01-01T00:00:00.000Z',
          networks: [],
        },
        'WrappedAssets-v01/0.0.2/WrappedAssets-v01.dar': {
          sha256: sha256(currentBytes),
          size: currentBytes.length,
          sdkVersion: '3.5.2',
          uploadedAt: '2026-02-01T00:00:00.000Z',
          networks: [],
        },
      },
    });

    const logged: string[] = [];
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(() => checkUpgradeCompatibility({ rootDir })).toThrow(
        /Upgrade compatibility check failed/
      );
      expect(logged.join('\n')).toMatch(
        /Baseline backup missing on disk: WrappedAssets-v01\/0\.0\.1\/WrappedAssets-v01\.dar/
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('fails when the committed current backup exists but does not match dars.lock', (): void => {
    const buildBytes = Buffer.from('build-dar');
    const corruptBackup = Buffer.from('corrupt-backup-bytes');
    const distDir = join(rootDir, 'generated', 'build', 'WrappedAssets-v01', '.daml', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'WrappedAssets-v01-0.0.2.dar'), buildBytes);
    mkdirSync(join(rootDir, 'dars', 'WrappedAssets-v01', '0.0.2'), { recursive: true });
    writeFileSync(
      join(rootDir, 'dars', 'WrappedAssets-v01', '0.0.2', 'WrappedAssets-v01.dar'),
      corruptBackup
    );
    saveDarsLock(rootDir, {
      version: 1,
      packages: {
        'WrappedAssets-v01/0.0.2/WrappedAssets-v01.dar': {
          sha256: sha256(buildBytes),
          size: buildBytes.length,
          sdkVersion: '3.5.2',
          uploadedAt: '2026-02-01T00:00:00.000Z',
          networks: [],
        },
      },
    });

    const logged: string[] = [];
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(() => checkUpgradeCompatibility({ rootDir })).toThrow(
        /Upgrade compatibility check failed/
      );
      expect(logged.join('\n')).toMatch(/Baseline backup failed integrity check/);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('checkDarVersionPolicy --package', (): void => {
  let rootDir = '';

  beforeEach((): void => {
    rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-policy-'));
    writePackage(rootDir, 'WrappedAssets-v01', 'WrappedAssets-v01', '0.0.1');
    writeFileSync(join(rootDir, 'multi-package.yaml'), `packages:\n  - WrappedAssets-v01\n`);
    mkdirSync(join(rootDir, 'dars'), { recursive: true });
    saveDarsLock(rootDir, { version: 1, packages: {} });

    git(rootDir, ['init']);
    git(rootDir, ['config', 'user.email', 'test@example.com']);
    git(rootDir, ['config', 'user.name', 'Test']);
    git(rootDir, ['add', '.']);
    git(rootDir, ['commit', '-m', 'init']);
  });

  afterEach((): void => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('honors --package outside deployment mode instead of silently using changed detection', (): void => {
    // No file changes vs HEAD → without --package this early-returns.
    expect(() => checkDarVersionPolicy({ rootDir, base: 'HEAD' })).not.toThrow();

    // With --package, the named package is selected and validated.
    expect(() =>
      checkDarVersionPolicy({ rootDir, base: 'HEAD', packageKey: 'WrappedAssets-v01' })
    ).toThrow(/Current package is not backed up/);
  });

  it('rejects unknown --package values', (): void => {
    expect(() =>
      checkDarVersionPolicy({ rootDir, base: 'HEAD', packageKey: 'does-not-exist' })
    ).toThrow(/Unknown package/);
  });

  it('rejects daml.yaml versions that are not strict semver before building lock paths', (): void => {
    writeFileSync(
      join(rootDir, 'WrappedAssets-v01', 'daml.yaml'),
      `sdk-version: 3.5.2\nname: WrappedAssets-v01\nsource: daml\nversion: ../escape\ndependencies: []\n`
    );
    expect(() =>
      checkDarVersionPolicy({ rootDir, base: 'HEAD', packageKey: 'WrappedAssets-v01' })
    ).toThrow(/invalid version/);
  });
});

describe('dar version policy extra watch paths', (): void => {
  let rootDir = '';

  beforeEach((): void => {
    rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-policy-watch-'));
    writePackage(rootDir, 'WrappedAssets-v01', 'WrappedAssets-v01', '0.0.1');
    writeFileSync(join(rootDir, 'multi-package.yaml'), `packages:\n  - WrappedAssets-v01\n`);
    mkdirSync(join(rootDir, 'dars'), { recursive: true });
    saveDarsLock(rootDir, { version: 1, packages: {} });
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0' }, null, 2)
    );

    git(rootDir, ['init']);
    git(rootDir, ['config', 'user.email', 'test@example.com']);
    git(rootDir, ['config', 'user.name', 'Test']);
    git(rootDir, ['add', '.']);
    git(rootDir, ['commit', '-m', 'init']);
    git(rootDir, ['branch', '-M', 'main']);
  });

  afterEach((): void => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function baseSha(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  }

  function commitPath(relativePath: string, contents: string): void {
    const fullPath = join(rootDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
    git(rootDir, ['add', relativePath]);
    git(rootDir, ['commit', '-m', `add ${relativePath}`]);
  }

  it('normalizes prefixes, matches nested files, and rejects escapes', (): void => {
    expect(normalizeExtraPolicyWatchPaths(['scripts/codegen/', './libs/splice'])).toEqual([
      'scripts/codegen',
      'libs/splice',
    ]);
    expect(pathMatchesWatchPrefix('scripts/codegen/generate.ts', 'scripts/codegen')).toBe(true);
    expect(pathMatchesWatchPrefix('scripts/codegen', 'scripts/codegen')).toBe(true);
    expect(pathMatchesWatchPrefix('scripts/codegen-other/x.ts', 'scripts/codegen')).toBe(false);
    expect(() => normalizeExtraPolicyWatchPaths(['../escape'])).toThrow(/Unsafe/);
    expect(() => normalizeExtraPolicyWatchPaths(['/abs/path'])).toThrow(/Unsafe/);
  });

  it('loads watch paths with CLI → package.json → canton-daml-tooling.json precedence', (): void => {
    writeFileSync(
      join(rootDir, 'canton-daml-tooling.json'),
      JSON.stringify({ darVersionPolicyWatchPaths: ['from-tooling'] })
    );
    expect(resolveDarVersionPolicyWatchPaths(rootDir)).toEqual(['from-tooling']);

    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        cantonDevTools: { darVersionPolicyWatchPaths: ['from-package-json', 'libs/splice/'] },
      })
    );
    expect(resolveDarVersionPolicyWatchPaths(rootDir)).toEqual([
      'from-package-json',
      'libs/splice',
    ]);
    expect(resolveDarVersionPolicyWatchPaths(rootDir, ['scripts/codegen'])).toEqual([
      'scripts/codegen',
    ]);
    expect(resolveDarVersionPolicyWatchPaths(rootDir, [])).toEqual([]);
  });

  it('parses --extra-policy-paths as CSV and/or repeatable flags', (): void => {
    expect(parseExtraPolicyPathsArg(['--all'])).toBeUndefined();
    expect(
      parseExtraPolicyPathsArg(['--extra-policy-paths', 'scripts/codegen,libs/splice'])
    ).toEqual(['scripts/codegen', 'libs/splice']);
    expect(
      parseExtraPolicyPathsArg([
        '--extra-policy-paths',
        'scripts/codegen',
        '--extra-policy-paths',
        'libs/splice',
      ])
    ).toEqual(['scripts/codegen', 'libs/splice']);
    expect(parseExtraPolicyPathsArg(['--extra-policy-paths=a,b'])).toEqual(['a', 'b']);
  });

  it('selects packages for codegen-only diffs when scripts/codegen is watched', (): void => {
    const base = baseSha();
    commitPath('scripts/codegen/generate-captable.ts', 'export {};\n');

    const packages = discoverManagedPackages(rootDir);
    const lock = loadDarsLock(rootDir);
    expect(
      selectChangedPackages(rootDir, base, lock, lock, packages, []).map((pkg) => pkg.name)
    ).toEqual([]);
    expect(
      selectChangedPackages(rootDir, base, lock, lock, packages, ['scripts/codegen']).map(
        (pkg) => pkg.name
      )
    ).toEqual(['WrappedAssets-v01']);

    expect(() => checkDarVersionPolicy({ rootDir, base })).not.toThrow();
    expect(() =>
      checkDarVersionPolicy({ rootDir, base, extraPolicyPaths: ['scripts/codegen'] })
    ).toThrow(/Current package is not backed up/);
  });

  it('selects packages for libs-only diffs when libs/splice is watched', (): void => {
    const base = baseSha();
    commitPath('libs/splice/daml/dars/splice-amulet-0.1.16.dar', 'dar-bytes');

    const packages = discoverManagedPackages(rootDir);
    const lock = loadDarsLock(rootDir);
    expect(
      selectChangedPackages(rootDir, base, lock, lock, packages, []).map((pkg) => pkg.name)
    ).toEqual([]);
    expect(
      selectChangedPackages(rootDir, base, lock, lock, packages, ['libs/splice']).map(
        (pkg) => pkg.name
      )
    ).toEqual(['WrappedAssets-v01']);

    writeFileSync(
      join(rootDir, 'canton-daml-tooling.json'),
      JSON.stringify({ darVersionPolicyWatchPaths: ['libs/splice/'] })
    );
    expect(() => checkDarVersionPolicy({ rootDir, base })).toThrow(
      /Current package is not backed up/
    );
  });

  it('rejects escaping watch paths from package.json config', (): void => {
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        cantonDevTools: { darVersionPolicyWatchPaths: ['../../etc/passwd'] },
      })
    );
    expect(() => resolveDarVersionPolicyWatchPaths(rootDir)).toThrow(/Unsafe/);
  });
});

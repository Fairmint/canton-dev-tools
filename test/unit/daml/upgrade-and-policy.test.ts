import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDarVersionPolicy,
  checkUpgradeCompatibility,
  saveDarsLock,
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
    expect(() => checkUpgradeCompatibility({ rootDir })).toThrow(/no built DARs to validate/i);
  });

  it('fails when an older lock baseline is missing on disk instead of treating as first release', (): void => {
    const currentBytes = Buffer.from('current-dar');
    const distDir = join(
      rootDir,
      'generated',
      'build',
      'WrappedAssets-v01',
      '.daml',
      'dist'
    );
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
});

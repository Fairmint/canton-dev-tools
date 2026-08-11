import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertGitCommitRef,
  assertSafeRelativePath,
  loadSyncSpliceDarsConfig,
  resolveContainedPath,
  saveDarsLock,
  syncSpliceDars,
  verifyDars,
  type DarsLock,
} from '../../../src/daml';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('verify-dars semantics', (): void => {
  let rootDir = '';

  beforeEach((): void => {
    rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-verify-'));
    mkdirSync(join(rootDir, 'dars', 'Pkg', '0.0.1'), { recursive: true });
  });

  afterEach((): void => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function writeLock(packages: DarsLock['packages']): void {
    saveDarsLock(rootDir, { version: 1, packages });
  }

  it('treats size mismatch as an error without --update', (): void => {
    const content = Buffer.from('dar-bytes');
    const darPath = join(rootDir, 'dars', 'Pkg', '0.0.1', 'Pkg.dar');
    writeFileSync(darPath, content);
    writeLock({
      'Pkg/0.0.1/Pkg.dar': {
        sha256: sha256(content),
        size: content.length + 10,
        sdkVersion: '3.5.2',
        uploadedAt: '2026-01-01T00:00:00.000Z',
        networks: [],
      },
    });

    const result = verifyDars({ rootDir });
    expect(result.sizeMismatch).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.errors.some((error) => error.includes('Size mismatch'))).toBe(true);
  });

  it('keeps missing tracked DARs fatal even with --update', (): void => {
    writeLock({
      'Pkg/0.0.1/Pkg.dar': {
        sha256: 'abc',
        size: 1,
        sdkVersion: '3.5.2',
        uploadedAt: '2026-01-01T00:00:00.000Z',
        networks: [],
      },
    });

    const result = verifyDars({ rootDir, update: true });
    expect(result.missing).toBe(1);
    expect(result.errors.some((error) => error.includes('Missing DAR'))).toBe(true);
  });

  it('updates size mismatches with --update without recording an error', (): void => {
    const content = Buffer.from('dar-bytes');
    const darPath = join(rootDir, 'dars', 'Pkg', '0.0.1', 'Pkg.dar');
    writeFileSync(darPath, content);
    writeLock({
      'Pkg/0.0.1/Pkg.dar': {
        sha256: sha256(content),
        size: content.length + 10,
        sdkVersion: '3.5.2',
        uploadedAt: '2026-01-01T00:00:00.000Z',
        networks: [],
      },
    });

    const result = verifyDars({ rootDir, update: true });
    expect(result.sizeMismatch).toBe(1);
    expect(result.errors).toEqual([]);
    const lock = JSON.parse(readFileSync(join(rootDir, 'dars', 'dars.lock'), 'utf8')) as DarsLock;
    expect(lock.packages['Pkg/0.0.1/Pkg.dar']?.size).toBe(content.length);
  });
});

describe('path containment helpers', (): void => {
  it('rejects traversing and absolute relative paths', (): void => {
    expect(() => assertSafeRelativePath('../escape.dar', 'requiredDars.file')).toThrow(/Unsafe/);
    expect(() => assertSafeRelativePath('/abs.dar', 'requiredDars.file')).toThrow(/Unsafe/);
    expect(() => assertSafeRelativePath('nested/../escape.dar', 'requiredDars.file')).toThrow(
      /Unsafe/
    );
    expect(() => assertSafeRelativePath('.', 'darsRelativeDir')).toThrow(/Unsafe/);
    expect(() => assertSafeRelativePath('..', 'adminProtoRelativeDir')).toThrow(/Unsafe/);
    expect(() => assertSafeRelativePath('ok/file.dar', 'requiredDars.file')).not.toThrow();
  });

  it('resolves only paths contained under the expected root', (): void => {
    const root = mkdtempSync(join(tmpdir(), 'canton-dev-tools-contain-'));
    try {
      expect(resolveContainedPath(root, 'a/b.dar', 'file')).toBe(join(root, 'a/b.dar'));
      expect(() => resolveContainedPath(root, '../b.dar', 'file')).toThrow(/Unsafe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sync-splice-dars path safety', (): void => {
  it('rejects unsafe directory fields in config JSON', (): void => {
    const rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-sync-cfg-'));
    try {
      const configPath = join(rootDir, 'splice-dars.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          spliceRef: 'v1',
          requiredDars: [{ file: 'a.dar', sha256: 'abc' }],
          adminProtoRelativeDir: '..',
        })
      );
      expect(() => loadSyncSpliceDarsConfig(configPath)).toThrow(/Unsafe adminProtoRelativeDir/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('refuses sync when adminProtoRelativeDir would wipe the repo root', (): void => {
    const rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-sync-rm-'));
    try {
      const marker = join(rootDir, 'keep-me.txt');
      writeFileSync(marker, 'safe\n');
      expect(() =>
        syncSpliceDars({
          rootDir,
          force: true,
          config: {
            spliceRef: 'v1',
            requiredDars: [{ file: 'a.dar', sha256: 'abc' }],
            adminProtoRelativeDir: '.',
          },
        })
      ).toThrow(/Unsafe adminProtoRelativeDir/);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('saveDarsLock', (): void => {
  it('creates the dars directory when missing', (): void => {
    const rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-lock-'));
    try {
      expect(existsSync(join(rootDir, 'dars'))).toBe(false);
      saveDarsLock(rootDir, { version: 1, packages: {} });
      expect(existsSync(join(rootDir, 'dars', 'dars.lock'))).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('assertGitCommitRef', (): void => {
  it('rejects invalid base refs', (): void => {
    const rootDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-gitref-'));
    try {
      execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: rootDir,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: rootDir, stdio: 'ignore' });
      writeFileSync(join(rootDir, 'README'), 'x\n');
      execFileSync('git', ['add', 'README'], { cwd: rootDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: rootDir, stdio: 'ignore' });

      expect(() => assertGitCommitRef(rootDir, 'definitely-not-a-real-ref-xyz')).toThrow(
        /Git ref not found/
      );
      expect(() => assertGitCommitRef(rootDir, 'HEAD')).not.toThrow();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

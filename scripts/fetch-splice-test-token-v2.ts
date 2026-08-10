#!/usr/bin/env node

/**
 * Sparse-fetch Splice `splice-test-token-v2-1.0.0.dar` into fixtures/ (gitignored).
 *
 * Ref defaults to package.json config.localnet_splice_version (0.6.11).
 * Pattern mirrors Fairmint/daml scripts/sync-splice-dars.ts.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  computeSha256,
  SPLICE_TEST_TOKEN_V2_DAR_FILENAME,
  SPLICE_TEST_TOKEN_V2_PACKAGE_ID,
  SPLICE_TEST_TOKEN_V2_SHA256,
  SPLICE_TEST_TOKEN_V2_UPSTREAM_PATH,
  spliceTestTokenV2DarPath,
} from '../src/testing/cip56/fixture';

const ROOT_DIR = process.cwd();
const SPLICE_REPO = process.env['SPLICE_REPO'] ?? 'https://github.com/canton-network/splice.git';

function readSpliceRef(): string {
  if (process.env['SPLICE_REF']) {
    return process.env['SPLICE_REF'];
  }

  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    config?: { localnet_splice_version?: string };
  };
  const version = pkg.config?.localnet_splice_version;
  if (!version) {
    throw new Error('package.json config.localnet_splice_version is required');
  }
  return version;
}

function parseArgs(): { force: boolean } {
  return { force: process.argv.includes('--force') };
}

function runGit(args: string[], cwd?: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'inherit',
  });
}

function main(): void {
  const { force } = parseArgs();
  const spliceRef = readSpliceRef();
  const targetPath = spliceTestTokenV2DarPath(ROOT_DIR);

  if (!force && existsSync(targetPath)) {
    const actual = computeSha256(targetPath);
    if (actual === SPLICE_TEST_TOKEN_V2_SHA256) {
      console.log(
        `Splice TestTokenV2 DAR already present and verified at ${relative(ROOT_DIR, targetPath)}`
      );
      console.log(`  package id: ${SPLICE_TEST_TOKEN_V2_PACKAGE_ID}`);
      return;
    }
    throw new Error(
      `Hash mismatch for existing ${relative(ROOT_DIR, targetPath)}: expected ${SPLICE_TEST_TOKEN_V2_SHA256}, got ${actual}. Re-run with --force.`
    );
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'canton-dev-tools-splice-token-v2-'));
  const cloneDir = join(tempDir, 'splice');

  try {
    console.log(
      `Fetching ${SPLICE_TEST_TOKEN_V2_UPSTREAM_PATH} from ${SPLICE_REPO} at ${spliceRef}`
    );
    runGit(['clone', '--filter=blob:none', '--sparse', '--no-checkout', SPLICE_REPO, cloneDir]);
    runGit(['checkout', spliceRef], cloneDir);
    runGit(['sparse-checkout', 'set', 'daml/dars'], cloneDir);

    const sourcePath = join(cloneDir, SPLICE_TEST_TOKEN_V2_UPSTREAM_PATH);
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing upstream Splice DAR: ${SPLICE_TEST_TOKEN_V2_UPSTREAM_PATH}`);
    }

    const sourceSha = computeSha256(sourcePath);
    if (sourceSha !== SPLICE_TEST_TOKEN_V2_SHA256) {
      throw new Error(
        `Hash mismatch for upstream ${SPLICE_TEST_TOKEN_V2_DAR_FILENAME}: expected ${SPLICE_TEST_TOKEN_V2_SHA256}, got ${sourceSha}`
      );
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);

    const copiedSha = computeSha256(targetPath);
    if (copiedSha !== SPLICE_TEST_TOKEN_V2_SHA256) {
      throw new Error(`Hash mismatch after copying ${SPLICE_TEST_TOKEN_V2_DAR_FILENAME}`);
    }

    console.log(`Wrote ${relative(ROOT_DIR, targetPath)}`);
    console.log(`  sha256: ${copiedSha}`);
    console.log(`  package id (assert after upload): ${SPLICE_TEST_TOKEN_V2_PACKAGE_ID}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

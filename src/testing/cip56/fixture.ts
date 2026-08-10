import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Upstream DAR filename under `daml/dars/` in canton-network/splice. */
export const SPLICE_TEST_TOKEN_V2_DAR_FILENAME = 'splice-test-token-v2-1.0.0.dar';

/** Upstream path inside the Splice repository. */
export const SPLICE_TEST_TOKEN_V2_UPSTREAM_PATH = `daml/dars/${SPLICE_TEST_TOKEN_V2_DAR_FILENAME}`;

/**
 * SHA-256 of `splice-test-token-v2-1.0.0.dar` at Splice `0.6.14`
 * (unchanged from `0.6.11`; `fd93f86ac42ce3a08985dcd0baae530b4f235f60` era).
 */
export const SPLICE_TEST_TOKEN_V2_SHA256 =
  '43fcf2fcf4e84861501a0c00e8550e2863e1aad553b1fb772ee8aa7bca7fd245';

/**
 * Main package id embedded in the DAR (assert against Ledger package status after upload).
 */
export const SPLICE_TEST_TOKEN_V2_PACKAGE_ID =
  'a38a96b6f46c14c599b2763bc4fc68911a9cada90f89c599a1401e8e3df685e1';

/** Relative fixture directory inside this package (DAR is gitignored). */
export const SPLICE_TEST_TOKEN_V2_FIXTURE_DIR = join('fixtures', 'splice-test-token-v2');

export function spliceTestTokenV2DarPath(packageRoot: string): string {
  return join(packageRoot, SPLICE_TEST_TOKEN_V2_FIXTURE_DIR, SPLICE_TEST_TOKEN_V2_DAR_FILENAME);
}

export function computeSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Returns true when the fixture DAR exists and matches {@link SPLICE_TEST_TOKEN_V2_SHA256}. */
export function isSpliceTestTokenV2DarPresent(packageRoot: string): boolean {
  const darPath = spliceTestTokenV2DarPath(packageRoot);
  return existsSync(darPath) && computeSha256(darPath) === SPLICE_TEST_TOKEN_V2_SHA256;
}

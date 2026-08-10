#!/usr/bin/env node

/**
 * CIP-56 / CIP-112 LocalNet transfer smoke entrypoint.
 *
 * Ensures the Splice TestTokenV2 fixture DAR is present, then runs the
 * integration skeleton against LocalNet Ledger JSON API (localhost:3975).
 * Fails closed when Docker / LocalNet is not reachable so CI surfaces a clear error.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT_DIR = process.cwd();
const LEDGER_URL = process.env['FAIRMINT_TEST_LEDGER_API_URL'] ?? 'http://localhost:3975';

async function ledgerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${LEDGER_URL.replace(/\/$/, '')}/v2/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    // Match LocalNet readiness: oauth2 Ledger returns 401 without a token.
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  console.log('Fetching Splice TestTokenV2 fixture DAR (if needed)...');
  run('npx', ['tsx', 'scripts/fetch-splice-test-token-v2.ts']);

  if (!(await ledgerReachable())) {
    console.error(
      `LocalNet Ledger JSON API is not reachable at ${LEDGER_URL}/v2/version.\n` +
        'Start LocalNet first (`npm run localnet:start`) or run this step only inside localnet-smoke.yml.'
    );
    process.exit(1);
  }

  console.log('Running CIP-56 / CIP-112 transfer smoke against LocalNet...');
  run('npx', [
    'jest',
    '--runInBand',
    '--testTimeout=300000',
    '--testMatch',
    '**/test/integration/localnet/cip56-transfer.test.ts',
    join('test', 'integration', 'localnet', 'cip56-transfer.test.ts'),
  ]);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

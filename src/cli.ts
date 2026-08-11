#!/usr/bin/env node
/**
 * CLI entry for DAML package tooling subcommands.
 *
 * Invoked by `bin/canton-dev-tools` for non-LocalNet commands.
 */

import * as path from 'node:path';
import { runBackupDarCli } from './daml/backup-dar';
import { runCheckDarVersionPolicyCli } from './daml/check-dar-version-policy';
import { runCheckUpgradeCompatibilityCli } from './daml/check-upgrade-compatibility';
import { parseFlagValue } from './daml/packages';
import { prepareBuild } from './daml/prepare-build';
import { runSyncSpliceDarsCli } from './daml/sync-splice-dars';
import { runVerifyDarsCli } from './daml/verify-dars';

function usage(): void {
  console.log(`Usage: canton-dev-tools <command> [options]

DAML package commands (run from a multi-package repo root):
  prepare-build              Copy packages into generated/build for dpm
  verify-dars [--update]     Verify dars/ against dars.lock
  backup-dar                 Backup a built DAR into dars/
  check-dar-version-policy   Enforce DAR version / deployment tag policy
  check-upgrade-compat       Run dpm upgrade-check against backups
  sync-splice-dars           Fetch pinned Splice DARs from splice-dars.json
  install-dpm-sdks           Install Daml SDKs from daml.yaml (shell helper)

Common options:
  --root <dir>               Repo root (default: cwd)

LocalNet commands are handled by the canton-dev-tools shell binary.
`);
}

function resolveRoot(args: string[]): string {
  return path.resolve(parseFlagValue(args, '--root') ?? process.cwd());
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case 'prepare-build': {
      const rootDir = resolveRoot(args);
      const buildRoot = parseFlagValue(args, '--build-root') ?? 'generated/build';
      prepareBuild({ rootDir, buildRoot });
      break;
    }
    case 'verify-dars': {
      runVerifyDarsCli({ rootDir: resolveRoot(args), update: args.includes('--update') });
      break;
    }
    case 'backup-dar': {
      runBackupDarCli(args);
      break;
    }
    case 'check-dar-version-policy': {
      runCheckDarVersionPolicyCli(args);
      break;
    }
    case 'check-upgrade-compat':
    case 'check-upgrade-compatibility': {
      runCheckUpgradeCompatibilityCli(args);
      break;
    }
    case 'sync-splice-dars': {
      runSyncSpliceDarsCli(args);
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

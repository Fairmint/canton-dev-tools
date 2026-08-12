/**
 * CLI entry for DAML package tooling subcommands.
 *
 * Invoked by `bin/canton-dev-tools` for non-LocalNet commands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runBackupDarCli } from './daml/backup-dar';
import { runCheckDarVersionPolicyCli } from './daml/check-dar-version-policy';
import { runCheckUpgradeCompatibilityCli } from './daml/check-upgrade-compatibility';
import { runBundleDependenciesCli } from './daml/codegen/bundle-dependencies';
import { runCodegenJsCli } from './daml/codegen/codegen-js';
import { collapseManifestFromStdin } from './daml/codegen/collapse-manifest';
import { runCreateRootIndexCli } from './daml/codegen/create-root-index';
import { fixSpliceRefs } from './daml/codegen/fix-splice-refs';
import { parseFlagValue } from './daml/packages';
import { prepareBuild } from './daml/prepare-build';
import { runSyncSpliceDarsCli } from './daml/sync-splice-dars';
import { runVerifyDarsCli } from './daml/verify-dars';
import { runPrepareReleaseCli } from './prepare-release';

function usage(): void {
  console.log(`Usage: canton-dev-tools <command> [options]

DAML package commands (run from a multi-package repo root):
  prepare-build              Copy packages into generated/build for dpm
  verify-dars [--update]     Verify dars/ against dars.lock
  backup-dar                 Backup a built DAR into dars/
  check-dar-version-policy   Enforce DAR version / deployment tag policy
  check-upgrade-compat       Run dpm upgrade-check against backups
  sync-splice-dars           Fetch pinned Splice DARs (packaged default or splice-dars.json)
  install-dpm-sdks           Install Daml SDKs from daml.yaml (shell helper)
  codegen-js                 Run dpm codegen-js + generic post-steps
  bundle-dependencies        Bundle stdlib/Splice deps into generated packages
  create-root-index          Build merged published lib/ from daml-js-bundle.json
  fix-splice-refs            Fix Splice namespace refs (optional --target)
  prepare-release            Floor-style version bump + CHANGELOG.md
  collapse-manifest          Collapse npm pack paths from stdin

Common options:
  --root <dir>               Repo root (default: cwd)
  --config <path>            daml-js-bundle.json (bundle-dependencies / create-root-index)

codegen-js options:
  --skip-dpm                 Only run post-processing (update/index/fix-splice-refs)

fix-splice-refs options:
  --target <dir>             Directory to walk (default: <root>/lib)
  --no-rewrite-fairmint      Skip @fairmint/daml.js → __bundled__ rewrites

prepare-release options:
  --changelog-repo <owner/repo>  GitHub repo for previous-version changelog links
                                 (default: package.json repository field)

check-dar-version-policy options:
  --all                      Check every managed package
  --package <name>           Check one package
  --base <ref>               Diff base (default: origin/main)
  --extra-policy-paths <csv> Extra watch prefixes (repeatable / CSV); overrides config
  --deployment <net>         DevNet/MainNet preflight (requires --package)

LocalNet commands are handled by the canton-dev-tools shell binary.
`);
}

function resolveRoot(args: string[]): string {
  return path.resolve(parseFlagValue(args, '--root') ?? process.cwd());
}

function runFixSpliceRefsCli(args: string[]): void {
  const rootDir = resolveRoot(args);
  const target = parseFlagValue(args, '--target');
  const targetDir = path.resolve(target ?? path.join(rootDir, 'lib'));
  fixSpliceRefs({
    targetDir,
    rewriteFairmintScopedImports: !args.includes('--no-rewrite-fairmint'),
  });
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case 'prepare-build': {
      prepareBuild({ rootDir: resolveRoot(args) });
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
    case 'codegen-js': {
      runCodegenJsCli(args);
      break;
    }
    case 'bundle-dependencies': {
      runBundleDependenciesCli(args);
      break;
    }
    case 'create-root-index': {
      runCreateRootIndexCli(args);
      break;
    }
    case 'fix-splice-refs': {
      runFixSpliceRefsCli(args);
      break;
    }
    case 'prepare-release': {
      runPrepareReleaseCli(args);
      break;
    }
    case 'collapse-manifest': {
      const input = fs.readFileSync(0, 'utf8');
      console.log(collapseManifestFromStdin(input));
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

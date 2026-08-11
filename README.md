# @fairmint/canton-dev-tools

Shared Canton LocalNet CLI, DAML package tooling, and integration-test helpers for Fairmint packages.

This package owns the versioned LocalNet lifecycle (start, readiness, diagnostics, teardown), reusable TypeScript helpers used by Canton integration tests, and shared DAML multi-package scripts (prepare-build, DAR policy, Splice DAR sync). Introduced by [ENG-1635](https://linear.app/fairmint/issue/ENG-1635/establish-canton-dev-tools-and-migrate-shared-canton-test).

## Docs

- [Canton LocalNet testing](https://github.com/Fairmint/dev-docs/blob/main/docs/development/testing/canton-localnet.md)
- [COMPATIBILITY.md](./COMPATIBILITY.md) — pinned LocalNet / Splice / scribe / protocol versions and auth defaults

## Install

```bash
npm install -D @fairmint/canton-dev-tools
```

Peer dependency: `@fairmint/canton-node-sdk` (for TypeScript helpers).

## LocalNet CLI

```bash
npx canton-dev-tools start
npx canton-dev-tools readiness
npx canton-dev-tools diagnostics
npx canton-dev-tools teardown
```

The binary hardcodes the four LocalNet pins from [COMPATIBILITY.md](./COMPATIBILITY.md). Auth defaults to **oauth2** (Keycloak). Consumer CI that uses HS256 JWTs should set `CANTON_LOCALNET_AUTH_MODE=shared-secret`.

## DAML package CLI

Run from a DAML multi-package repo root (`multi-package.yaml` + per-package `daml.yaml`). Packages are discovered automatically — no repo-local `packages.ts` required for these commands. Keep consumer-specific PACKAGE_DEFS / generated npm metadata in the consumer when needed.

```bash
npx canton-dev-tools install-dpm-sdks
npx canton-dev-tools prepare-build
npx canton-dev-tools verify-dars
npx canton-dev-tools backup-dar --package WrappedAssets-v01 --version 0.0.1
npx canton-dev-tools check-dar-version-policy --all
npx canton-dev-tools check-upgrade-compat
npx canton-dev-tools sync-splice-dars
```

`backup-dar` / version-policy / upgrade-compat skip `Test` packages by default. Pass `--package` with the daml.yaml name, source dir, or a fuzzy alias (e.g. `wrappedAssets`).

### `sync-splice-dars` config

By default, sync uses the packaged pin at `config/default-splice-dars.json` (Splice **0.7.0**
token-standard + amulet DARs). Optional overrides, in order:

1. `--config <path>`
2. `CANTON_SPLICE_DARS_CONFIG`
3. repo-root `splice-dars.json` (per-repo pin when it must differ from the shared default)

```json
{
  "spliceRef": "<git-sha-or-tag>",
  "requiredDars": [{ "file": "splice-amulet-0.1.16.dar", "sha256": "..." }],
  "syncAdminProtos": true
}
```

`SPLICE_REF` / `SPLICE_REPO` override the config values.

### Library import

```ts
import { prepareBuild, discoverManagedPackages } from '@fairmint/canton-dev-tools/daml';
```

## TypeScript helpers

```ts
import {
  buildLocalnetClientConfig,
  getLocalnetParticipantAdminLedgerClient,
  findCreatedContractId,
  buildTransferFactoryTransferCommand,
  SPLICE_TEST_TOKEN_V2_SHA256,
} from '@fairmint/canton-dev-tools/testing';
```

CIP-56 / CIP-112 helpers target the Splice `splice-test-token-v2` reference DAR.

## Publishing

Every push/merge to `main` runs [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which auto-publishes `@fairmint/canton-dev-tools` to npm via **OIDC Trusted Publishing**.

- **`package.json` version is a floor.** Intentional minor/major bumps: set a version higher than npm's latest before merging; CI publishes that exact version.
- **Routine patches auto-increment** from the higher of npm latest / existing tags.

## Development

```bash
npm install
npm run build
npm test
npm run pack:check
```

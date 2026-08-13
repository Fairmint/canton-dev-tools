# @fairmint/canton-dev-tools

Shared Canton LocalNet CLI, DAML package tooling, and integration-test helpers for Canton LocalNet consumers.

This package owns the versioned LocalNet lifecycle (start, readiness, diagnostics, teardown), reusable TypeScript helpers used by Canton integration tests, and shared DAML multi-package scripts (prepare-build, DAR policy, Splice DAR sync). Introduced to own the shared LocalNet lifecycle.

## Docs

Canonical documentation lives in this repository:

- [LocalNet](#localnet) — CLI, prerequisites, consumer setup, and ready endpoints
- [COMPATIBILITY.md](./COMPATIBILITY.md) — pinned Quickstart / Splice / scribe / protocol versions and auth defaults
- [DAML package CLI](#daml-package-cli) — multi-package build, DAR policy, and Splice DAR sync
- [TypeScript helpers](#typescript-helpers) — `@fairmint/canton-dev-tools/testing`

Implementation: [`bin/canton-dev-tools`](./bin/canton-dev-tools) and [`scripts/localnet-cloud.sh`](./scripts/localnet-cloud.sh). CI smoke: [`.github/workflows/localnet-smoke.yml`](./.github/workflows/localnet-smoke.yml).

## Install

```bash
npm install -D @fairmint/canton-dev-tools
```

Peer dependency: `@fairmint/canton-node-sdk` (for TypeScript helpers).

## LocalNet

This package owns the shared Canton LocalNet lifecycle. The CLI wraps [Canton Network Quickstart](https://docs.canton.network/appdev/quickstart) with pinned versions from [COMPATIBILITY.md](./COMPATIBILITY.md).

### Prerequisites

- Docker and Compose v2
- First start pulls images and bootstraps Splice (~10–15 minutes on a cold cache)
- Host aliases `scan.localhost`, `sv.localhost`, and `wallet.localhost` (the CLI adds them with passwordless `sudo` when available; otherwise add manually)

In npm consumer packages the CLI fetches [cn-quickstart](https://github.com/digital-asset/cn-quickstart) at the pinned ref into `~/.cache/fairmint/canton-localnet` (override with `CANTON_LOCALNET_CACHE_DIR` / `CANTON_LOCALNET_QUICKSTART_DIR`). In a git checkout with `libs/cn-quickstart`, submodule init is used instead.

### CLI

```bash
npx canton-dev-tools start
npx canton-dev-tools readiness
npx canton-dev-tools diagnostics
npx canton-dev-tools teardown
```

Auth defaults to **oauth2** (Keycloak). Consumer CI that signs HS256 JWTs should set `CANTON_LOCALNET_AUTH_MODE=shared-secret` (see [COMPATIBILITY.md](./COMPATIBILITY.md)).

### Scripts in this repo

```bash
npm run localnet:start
npm run localnet:readiness
npm run localnet:diagnostics
npm run localnet:teardown
npm run localnet:cip56-transfer   # Splice TestTokenV2 CIP-56 / CIP-112 smoke
```

### Wire up a consumer package

Expose `localnet:*` scripts that delegate to the binary. Shared-secret auth is typical for CI:

```json
{
  "scripts": {
    "localnet": "CANTON_LOCALNET_AUTH_MODE=shared-secret canton-dev-tools",
    "localnet:start": "npm run -s localnet -- start",
    "localnet:readiness": "npm run -s localnet -- readiness",
    "localnet:teardown": "npm run -s localnet -- teardown"
  }
}
```

Prefer Dev Tools pin defaults; only set `CANTON_LOCALNET_*` overrides for intentional experiments.

### Ready endpoints

After `start` / `readiness`:

| Service         | URL                                                   |
| --------------- | ----------------------------------------------------- |
| Ledger JSON API | `http://localhost:3975/v2/version`                    |
| Scan            | `http://scan.localhost:4000/api/scan/v0/dso-party-id` |
| Validator       | `http://localhost:3903/` (200/401)                    |

See `npx canton-dev-tools diagnostics` and [`.github/workflows/localnet-smoke.yml`](./.github/workflows/localnet-smoke.yml) for the CI smoke path.

## DAML package CLI

Run from a DAML multi-package repo root (`multi-package.yaml` + per-package `daml.yaml`). Packages are discovered automatically — no repo-local `packages.ts` required for these commands. Keep consumer-specific PACKAGE_DEFS / generated npm metadata in the consumer when needed.

```bash
npx canton-dev-tools install-dpm-sdks
npx canton-dev-tools prepare-build
npx canton-dev-tools verify-dars
npx canton-dev-tools backup-dar --package WrappedAssets-v01 --version 0.0.1
npx canton-dev-tools check-dar-version-policy --all
npx canton-dev-tools check-dar-version-policy --extra-policy-paths scripts/codegen,libs/splice
npx canton-dev-tools check-upgrade-compat
npx canton-dev-tools sync-splice-dars
npx canton-dev-tools codegen-js
npx canton-dev-tools bundle-dependencies
npx canton-dev-tools create-root-index
npx canton-dev-tools fix-splice-refs --target lib
npx canton-dev-tools prepare-release --changelog-repo Fairmint/canton-assets
```

`backup-dar` / version-policy / upgrade-compat skip `Test` packages by default. Pass `--package` with the daml.yaml name, source dir, or a fuzzy alias (e.g. `wrappedAssets`).

### `codegen-js` (Phase 1)

Generic DAML → JS bindings steps for packages that declare `codegen.js` in `daml.yaml`:

1. `dpm codegen-js` in each `generated/build/<pkg>` (expects `prepare-build` already done)
2. Stamp generated `package.json` name/version from the repo root
3. Write per-package `index.js` / `index.d.ts`
4. Fix Splice namespace refs on generated `lib/` trees (optional `@fairmint/*` → `__bundled__` rewrite when present)

### Phase 2: `bundle-dependencies` + `create-root-index`

Config-driven stdlib/Splice bundling and merged published `lib/` creation. Driven by
`daml-js-bundle.json` (or `--config` / `package.json` → `cantonDevTools.damlJsBundle`).
**No product package names are hardcoded** in canton-dev-tools — consumers select presets and
describe their root index in JSON.

```bash
npx canton-dev-tools bundle-dependencies [--root <dir>] [--config <path>]
npx canton-dev-tools create-root-index [--root <dir>] [--config <path>]
npx canton-dev-tools fix-splice-refs --target lib
```

Built-in presets (stdlib / Splice only):

| Preset id                     | Bundles                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `da-internal-template`        | `ghc-stdlib-DA-Internal-Template` (always applied)                     |
| `featured-app-v1`             | `splice-api-featured-app-v1`                                           |
| `featured-app-v2`             | `splice-api-featured-app-v2` (only when amulet needs it)               |
| `amulet`                      | `splice-amulet-<pin>`                                                  |
| `da-time-types`               | `daml-stdlib-DA-Time-Types`                                            |
| `da-types`                    | `daml-prim-DA-Types`                                                   |
| `da-set-types`                | `daml-stdlib-DA-Set-Types`                                             |
| `splice-token-v1`             | token burn/mint, metadata, holding, allocation\*, transfer-instruction |
| `splice-token-standard-utils` | `splice-token-standard-utils-<pin>`                                    |

Pins (optional): `pins.amulet` (default `0.1.19`), `pins.tokenStandardUtils` (default `2.0.0`).

Example `daml-js-bundle.json` (assets-like shape; product names belong in the **consumer** config):

```json
{
  "generatedJsDir": "generated/js",
  "presets": [
    "da-internal-template",
    "featured-app-v1",
    "featured-app-v2",
    "amulet",
    "da-time-types",
    "da-types",
    "da-set-types",
    "splice-token-v1",
    "splice-token-standard-utils"
  ],
  "pins": {
    "amulet": "0.1.19",
    "tokenStandardUtils": "2.0.0"
  },
  "rootIndex": {
    "outputDir": "lib",
    "sourcePackage": { "namePrefix": "WrappedAssets" },
    "copy": ["DA", "Splice", "__bundled__", "WrappedAssets"],
    "namespaces": ["WrappedAssets", "DA", "Splice"],
    "templateConstants": {
      "WRAPPED_ASSETS_TEMPLATES": {
        "burnMintFactory": {
          "from": "./WrappedAssets/BurnMint/module",
          "binding": "WrappedAssetsBurnMintFactory"
        },
        "burnOffer": {
          "from": "./WrappedAssets/BurnOffer/module",
          "binding": "BurnOffer"
        },
        "wrappedAsset": {
          "from": "./WrappedAssets/Holding/module",
          "binding": "WrappedAsset"
        },
        "frozenWrappedAsset": {
          "from": "./WrappedAssets/Holding/module",
          "binding": "FrozenWrappedAsset"
        }
      }
    },
    "postBundlePresets": [
      "da-time-types",
      "da-types",
      "splice-token-v1",
      "splice-token-standard-utils",
      "da-set-types"
    ]
  }
}
```

Or point at the file from `package.json`:

```json
{
  "cantonDevTools": {
    "damlJsBundle": "./daml-js-bundle.json"
  }
}
```

Library imports:

```ts
import {
  runCodegenJs,
  bundleDependencies,
  createRootIndex,
  fixSpliceRefs,
  resolveDamlJsBundleConfig,
  BUNDLE_PRESET_IDS,
} from '@fairmint/canton-dev-tools/daml';
```

Example consumer scripts:

```json
{
  "scripts": {
    "prepare-build": "canton-dev-tools prepare-build",
    "codegen": "npm run build && canton-dev-tools codegen-js && canton-dev-tools bundle-dependencies && canton-dev-tools create-root-index && canton-dev-tools fix-splice-refs --target lib",
    "prepare-release": "canton-dev-tools prepare-release"
  }
}
```

NFT / CapTable merge hooks stay consumer-local (out of scope for Phase 2).

Optional publish suffixes in root `package.json` (multi-package repos):

```json
{
  "cantonDevTools": {
    "codegenPublishSuffixes": {
      "OpenCapTableReports-v01": "reports",
      "WrappedAssets-v01": null
    }
  }
}
```

`null` publishes as the root package name. A single codegen package defaults to the root name.

Library imports (Phase 1 helpers):

```ts
import {
  runCodegenJs,
  createPackageIndexes,
  updateGeneratedPackagesFromRoot,
  fixSpliceRefs,
  collapseManifestLines,
  verifyPackageImports,
  applyGeneratedImportRewrites,
} from '@fairmint/canton-dev-tools/daml';
```

### `check-dar-version-policy` extra watch paths

By default, auto-selection only treats package `daml.yaml` / `daml/` sources and `dars/<package>/`
backups (plus lock-entry diffs) as package input changes. Repos such as OCP also need shared
inputs (`scripts/codegen/`, `libs/splice/`) to select packages. Configure extra relative prefixes
with this precedence (first wins):

1. CLI `--extra-policy-paths <csv>` (repeatable; overrides config entirely, including `[]`)
2. `package.json` → `cantonDevTools.darVersionPolicyWatchPaths`
3. repo-root `canton-daml-tooling.json` → `darVersionPolicyWatchPaths`
4. `[]` (no extra watches)

```json
{
  "cantonDevTools": {
    "darVersionPolicyWatchPaths": ["scripts/codegen", "libs/splice"]
  }
}
```

```json
{
  "darVersionPolicyWatchPaths": ["scripts/codegen/", "libs/splice/"]
}
```

Paths must be relative and contained (no `..` / absolute escapes). A change under any configured
prefix selects **all** managed packages for the policy check.

### `sync-splice-dars` config

By default, sync uses the packaged pin at `config/default-splice-dars.json` (MainNet Splice
**0.6.14** / commit `398919a5b13479877fd61587003ba7a4ba00091b`, token-standard + amulet DARs).
Optional overrides, in order:

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
import {
  prepareBuild,
  discoverManagedPackages,
  runCodegenJs,
} from '@fairmint/canton-dev-tools/daml';
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

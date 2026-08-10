# SDK package-boundary audit (ENG-1635)

Central evidence for the production-boundary audit of Fairmint Canton SDKs.
Performed against workspace checkouts on 2026-08-10; pack inspections used
`npm pack --dry-run --json --ignore-scripts` after a publish-shaped build where
noted.

Related work:

- `@fairmint/canton-dev-tools` establish PR:
  https://github.com/Fairmint/canton-dev-tools/pull/1
- `@fairmint/canton-node-sdk` soft-migration PR:
  https://github.com/Fairmint/canton-node-sdk/pull/398
- `@fairmint/canton-fairmint-sdk` pack guard PR:
  https://github.com/Fairmint/canton-fairmint-sdk/pull/196
- `@fairmint/canton-fairmint-sdk` soft-migration PR:
  https://github.com/Fairmint/canton-fairmint-sdk/pull/197
- `@open-captable-protocol/canton` pack guard PR:
  https://github.com/Fairmint/ocp-canton-sdk/pull/451

## Summary

| Package                          | Publishes?                 | Pack guard                                            | Ships LocalNet CLI?                                                           | Ships `.dar` / `libs/**` / fixtures? | Verdict                                                                   |
| -------------------------------- | -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `@fairmint/canton-node-sdk`      | public npm                 | `check:package-artifacts` (CI)                        | **Yes** (`bin/canton-localnet`, `scripts/localnet-cloud.sh`) — soft migration | No                                   | Acceptable temporary exception; harden `files` to `build/src/**`          |
| `@fairmint/canton-fairmint-sdk`  | restricted npm             | **added** (`check:package-artifacts`)                 | No (npm scripts only; CLI via node-sdk / Dev Tools)                           | No                                   | Clean runtime `dist/**`; add repeatable pack guard                        |
| `@open-captable-protocol/canton` | public npm                 | **added** (`check:package-artifacts`)                 | No (npm scripts only)                                                         | No (`libs/**` not in `files`)        | Clean runtime `dist/**` (+ intentional `dist/ocf-schema`); add pack guard |
| `@fairmint/canton-privy-sdk`     | restricted npm             | `pack:check` + `smoke:package` + entry-boundary check | No                                                                            | No                                   | Clean; no LocalNet surface                                                |
| `@fairmint/canton-dev-tools`     | intended public (ENG-1635) | `check:package-artifacts`                             | **Yes** (canonical owner)                                                     | No (fixtures stay repo-local)        | Intended LocalNet home                                                    |

## Per-package findings

### `@fairmint/canton-node-sdk`

- `package.json#files` (after hardening): `bin/canton-localnet`, `scripts/localnet-cloud.sh`, `build/src/**`
- `package.json#bin`: `canton-localnet` → `bin/canton-localnet`
- Dependencies: runtime clients only; `@fairmint/canton-dev-tools` is optionalDependency / optional peer (git SHA during soft migration)
- LocalNet / test scripts: `localnet:*`, `test:integration` / `test:localnet` — CI / repo only
- Pack dry-run after `prepack` (`clean` + `build:core`): **1369 files / ~5.68 MB** — runtime under `build/src/**` plus the soft-migration LocalNet scripts
- **Leak risk closed this session:** previous `files: ["build/**"]` could ship compiled `build/test|scripts|examples` if `prepack` were skipped; narrowed to `build/src/**` and forbidden those prefixes in the artifact check
- **Known soft-migration:** LocalNet CLI remains publishable until hard cutover to Dev Tools (`docs/package-boundary.md`)

### `@fairmint/canton-fairmint-sdk`

- `files`: `["dist"]` — after `tsc`, **494 files / ~0.91 MB**; no `bin`
- LocalNet: `package.json#config` pins + `localnet*` scripts (soft-migrated to invoke
  `canton-dev-tools` via optionalDependency; not packaged)
- No `.dar`, `libs/**`, Docker compose, or fixture trees in the tarball
- Gap closed: added `scripts/check-package-artifacts.cjs` + CI step (PR #196)
- Soft migration: optional Dev Tools dependency + script switch (PR #197)

### `@open-captable-protocol/canton`

- `files`: `["dist"]` — after full build (including OCF schema copy), **1106 files / ~2.20 MB**
- Publishes compiled SDK plus intentional `dist/ocf-schema` JSON (runtime validation assets, not DAML DARs)
- LocalNet: scripts + `config.localnet_quickstart_ref` only; CLI not packaged
- `libs/Open-Cap-Format-OCF`, `libs/cn-quickstart`, `libs/splice` exist in the repo for CI / schemas / LocalNet but are outside `files`
- Gap closed: added `scripts/check-package-artifacts.cjs` + CI step

### `@fairmint/canton-privy-sdk`

- `files`: `["dist", "LICENSE"]` — after build, **9 paths / ~0.07 MB**
- No LocalNet scripts, DARs, or Docker deps
- Existing guards (`pack:check`, `smoke:package`, `check:boundaries`) are sufficient for ENG-1635 scope

### `@fairmint/canton-dev-tools`

- Canonical LocalNet publish surface: `bin/canton-dev-tools`, `scripts/localnet-cloud.sh`, `dist/**`
- Fixture DARs under `fixtures/**` are explicitly forbidden by `check:package-artifacts`
- Not a production application SDK; consumers should install it as a **devDependency**

## Follow-ups

1. **Hard cutover (ENG-1635):** remove `bin/canton-localnet` / `scripts/localnet-cloud.sh` from `@fairmint/canton-node-sdk` publish once consumers use Dev Tools.
2. Soft-migrate remaining SDK `localnet*` npm scripts to call `canton-dev-tools` / drop duplicate pin `config` blocks where safe.
3. Keep pack guards in CI for every publishable Canton SDK.

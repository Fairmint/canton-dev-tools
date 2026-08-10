# @fairmint/canton-dev-tools

Shared Canton LocalNet CLI and integration-test helpers for Fairmint packages.

This package owns the versioned LocalNet lifecycle (start, readiness, diagnostics, teardown) and reusable TypeScript helpers used by Canton integration tests. It is introduced by [ENG-1635](https://linear.app/fairmint/issue/ENG-1635/establish-canton-dev-tools-and-migrate-shared-canton-test).

## Docs

- [Canton LocalNet testing](https://github.com/Fairmint/dev-docs/blob/main/docs/development/testing/canton-localnet.md)
- [COMPATIBILITY.md](./COMPATIBILITY.md) — pinned LocalNet / Splice / scribe / protocol versions and auth defaults
- [SDK package-boundary audit](./docs/sdk-package-boundary-audit.md) — ENG-1635 production vs CI-only surfaces across Canton SDKs

## Install

```bash
npm install -D @fairmint/canton-dev-tools
```

Peer dependency: `@fairmint/canton-node-sdk` (for TypeScript helpers).

## CLI

Product commands:

```bash
npx canton-dev-tools start
npx canton-dev-tools readiness
npx canton-dev-tools diagnostics
npx canton-dev-tools teardown
```

The binary hardcodes the four LocalNet pins from [COMPATIBILITY.md](./COMPATIBILITY.md), so `npx` /
direct invocations apply the same defaults as `npm run localnet*`.

Auth defaults to **oauth2** (Keycloak). Consumer CI that uses HS256 JWTs (for example
`@fairmint/canton-fairmint-sdk`) should set `CANTON_LOCALNET_AUTH_MODE=shared-secret`.

Legacy aliases (same binary as `canton-localnet`): `setup`, `stop`, `logs`, `status`, `smoke`, `test`, `verify`.

Environment variables keep the `CANTON_LOCALNET_*` prefix for consumer compatibility.

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

CIP-56 / CIP-112 helpers target the Splice `splice-test-token-v2` reference DAR (not Fairmint EquityTokens).

## Development

```bash
npm install
npm run build
npm test
npm run pack:check
npm run fixture:splice-test-token-v2:fetch
```

Internal fixtures (CI/scripts only; never published):

- `fixtures/dar-lifecycle/` — minimal DAR lifecycle sources
- `fixtures/splice-test-token-v2/` — Splice TestTokenV2 DAR (gitignored binary; fetch via npm script)

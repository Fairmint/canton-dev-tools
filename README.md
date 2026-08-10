# @fairmint/canton-dev-tools

Shared Canton LocalNet CLI and integration-test helpers for Fairmint packages.

This package owns the versioned LocalNet lifecycle (start, readiness, diagnostics, teardown) and reusable TypeScript helpers used by Canton integration tests. It is introduced by [ENG-1635](https://linear.app/fairmint/issue/ENG-1635/establish-canton-dev-tools-and-migrate-shared-canton-test).

## Docs

- [Canton LocalNet testing](https://github.com/Fairmint/dev-docs/blob/main/docs/development/testing/canton-localnet.md)
- [COMPATIBILITY.md](./COMPATIBILITY.md) — pinned LocalNet / Splice / scribe / protocol versions

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

Legacy aliases (same binary as `canton-localnet`): `setup`, `stop`, `logs`, `status`, `smoke`, `test`, `verify`.

Environment variables keep the `CANTON_LOCALNET_*` prefix for consumer compatibility.

## TypeScript helpers

```ts
import {
  buildLocalnetClientConfig,
  getLocalnetParticipantAdminLedgerClient,
  findCreatedContractId,
} from '@fairmint/canton-dev-tools/testing';
```

## Development

```bash
npm install
npm run build
npm test
npm run pack:check
```

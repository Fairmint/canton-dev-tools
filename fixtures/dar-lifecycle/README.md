# DAR lifecycle fixture (CI / scripts only)

This directory is an **internal** DAML fixture used to validate Fairmint DAR lifecycle tooling
(build → upload → vet → breaking-upgrade detection). It is **never published** with
`@fairmint/canton-dev-tools`.

## Rules

- Not listed in `package.json#files`
- `scripts/check-package-artifacts.ts` / `npm run pack:check` must fail if any `fixtures/**` or `*.dar` path appears in the pack file list
- Do not import this fixture from published TypeScript exports

## Layout

```
fixtures/dar-lifecycle/
  daml.yaml                 # minimal package metadata
  daml/DarLifecycle/Marker.daml
  README.md                 # this file
```

## Building

Requires `dpm` (Daml Package Manager) on `PATH`. Unit CI does **not** install dpm; the npm
stubs skip cleanly when it is missing:

```bash
npm run fixture:dar-lifecycle:build
```

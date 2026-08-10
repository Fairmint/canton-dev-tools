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

## TODOs (ENG-1635 follow-ups)

- [ ] CI job that installs dpm and builds this DAR
- [ ] Upload the DAR to LocalNet Ledger JSON API
- [ ] Vet / package status checks against running LocalNet
- [ ] Breaking-upgrade scenario (intentionally incompatible package bump)
- [ ] Wire into CIP-56 / CIP-112 transfer smoke using Splice reference fixtures (not a Fairmint token)

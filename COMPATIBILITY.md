# LocalNet Compatibility Pins

`@fairmint/canton-dev-tools` is the **central owner** of Fairmint's shared Canton LocalNet pin set.

Consumers should prefer this package's CLI defaults in `bin/canton-dev-tools` (kept in sync with
`package.json#config` by `pack:check`) instead of maintaining divergent pins in individual SDKs.
`npm run localnet*` delegates to the binary, which applies the four pins and oauth2 auth as
defaults while preserving caller environment overrides.

| Pin                     | Config key                  | Current value                              |
| ----------------------- | --------------------------- | ------------------------------------------ |
| cn-quickstart git ref   | `localnet_quickstart_ref`   | `2f4edfc17621a7dfb6d44357050c22f4b3914c89` |
| Splice image tag        | `localnet_splice_version`   | `0.6.14`                                   |
| Scribe image tag        | `localnet_scribe_version`   | `0.6.14`                                   |
| Canton protocol version | `localnet_protocol_version` | `35`                                       |

## Why both quickstart ref and Splice version?

They are **not redundant** — each owns a different layer:

| Pin                                                   | Owns                                                                            | Why it is separate                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `localnet_quickstart_ref`                             | CN Quickstart **compose / scripts / Daml runtime wiring** (git tree)            | Locks how LocalNet is brought up (ports, modules, Keycloak, `.env` defaults).                                                                                |
| `localnet_splice_version` / `localnet_scribe_version` | **Container image tags** written into Quickstart `.env` via `CANTON_LOCALNET_*` | Lets us run MainNet-aligned Splice/Scribe images on an older, known-good Quickstart tree without waiting for a Quickstart bump that already embeds that tag. |

Quickstart's checked-in `.env` may still say `SPLICE_VERSION=0.6.11` at the pinned ref; our CLI **overrides** that with `localnet_splice_version`. Same pattern as `@fairmint/canton-assets` LocalNet docs (same Quickstart ref + MainNet Splice `0.6.14`).

Do not derive one from the other in this package: consumers may need to advance images before compose, or pin compose while validating a new image.

## Auth mode

| Mode            | When to use                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `oauth2`        | **Package default** for `npm run localnet*` and bare CLI / `npx` invocations |
| `shared-secret` | **Consumer CI** that signs HS256 JWTs (e.g. `@fairmint/canton-fairmint-sdk`) |

Override with `CANTON_LOCALNET_AUTH_MODE=shared-secret` in consumer packages. Do not change the
package default to shared-secret without coordinating Keycloak / OAuth2 LocalNet smoke coverage.

## Override env vars

These remain supported for one-off local experiments:

- `CANTON_LOCALNET_QUICKSTART_REF`
- `CANTON_LOCALNET_SPLICE_VERSION`
- `CANTON_LOCALNET_SCRIBE_VERSION`
- `CANTON_LOCALNET_PROTOCOL_VERSION`
- `CANTON_LOCALNET_QUICKSTART_DIR`
- `CANTON_LOCALNET_CACHE_DIR`
- `CANTON_LOCALNET_AUTH_MODE`
- `CANTON_LOCALNET_INFRA_ONLY`

Changing the default pins is a breaking compatibility change for shared LocalNet CI and should be reviewed as part of ENG-1635 follow-ups.

SDK package-boundary ownership (what ships in publish tarballs vs CI-only fixtures) is tracked via consumer PRs under [ENG-1635](https://linear.app/fairmint/issue/ENG-1635/establish-canton-dev-tools-and-migrate-shared-canton-test).

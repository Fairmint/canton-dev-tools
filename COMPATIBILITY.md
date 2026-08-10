# LocalNet Compatibility Pins

`@fairmint/canton-dev-tools` is the **central owner** of Fairmint's shared Canton LocalNet pin set.

Consumers should prefer this package's CLI defaults in `bin/canton-dev-tools` (kept in sync with
`package.json#config` by `pack:check`) instead of maintaining divergent pins in individual SDKs.
`npm run localnet*` delegates to the binary, which applies the four pins and oauth2 auth as
defaults while preserving caller environment overrides.

| Pin                     | Config key                  | Current value                              |
| ----------------------- | --------------------------- | ------------------------------------------ |
| cn-quickstart git ref   | `localnet_quickstart_ref`   | `2f4edfc17621a7dfb6d44357050c22f4b3914c89` |
| Splice image tag        | `localnet_splice_version`   | `0.6.11`                                   |
| Scribe image tag        | `localnet_scribe_version`   | `0.6.11`                                   |
| Canton protocol version | `localnet_protocol_version` | `35`                                       |

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

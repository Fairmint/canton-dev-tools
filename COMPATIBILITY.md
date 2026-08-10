# LocalNet Compatibility Pins

`@fairmint/canton-dev-tools` is the **central owner** of Fairmint's shared Canton LocalNet pin set.

Consumers should prefer this package's `package.json#config` values (and matching CLI defaults) instead of maintaining divergent pins in individual SDKs.

| Pin                     | Config key                  | Current value                              |
| ----------------------- | --------------------------- | ------------------------------------------ |
| cn-quickstart git ref   | `localnet_quickstart_ref`   | `2f4edfc17621a7dfb6d44357050c22f4b3914c89` |
| Splice image tag        | `localnet_splice_version`   | `0.6.11`                                   |
| Scribe image tag        | `localnet_scribe_version`   | `0.6.11`                                   |
| Canton protocol version | `localnet_protocol_version` | `35`                                       |

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

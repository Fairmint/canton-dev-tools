# Splice `splice-test-token-v2` fixture (CIP-56 / CIP-112)

Internal reference DAR from
[`canton-network/splice`](https://github.com/canton-network/splice) used for LocalNet CIP-56
holdings and CIP-112 transfer-instruction smoke tests.

**Do not invent a Fairmint token for this path.** Prefer this Splice TestTokenV2 DAR
(CIP-112 capable). Do not use Fairmint EquityTokens.

## Provenance

| Field         | Value                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| Upstream repo | `https://github.com/canton-network/splice`                                  |
| Ref           | `package.json#config.localnet_splice_version` (currently `0.6.14`)          |
| Upstream path | `daml/dars/splice-test-token-v2-1.0.0.dar`                                  |
| Local path    | `fixtures/splice-test-token-v2/splice-test-token-v2-1.0.0.dar` (gitignored) |
| SHA-256       | `43fcf2fcf4e84861501a0c00e8550e2863e1aad553b1fb772ee8aa7bca7fd245`          |
| Package id    | `a38a96b6f46c14c599b2763bc4fc68911a9cada90f89c599a1401e8e3df685e1`          |

## Rules

- Not listed in `package.json#files`
- `npm run pack:check` / `scripts/check-package-artifacts.ts` must fail if any `fixtures/**` or `*.dar` path appears in the pack file list
- Do not import the DAR binary from published TypeScript exports (helpers may export hash / package-id constants only)

## Fetch

```bash
npm run fixture:splice-test-token-v2:fetch
```

Sparse-clones the pinned Splice ref, copies the DAR, and asserts the SHA-256 above.

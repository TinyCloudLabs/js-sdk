---
"@tinycloud/cli": patch
"@tinycloud/share-sdk": patch
---

`tc share publish --to email:...` (and other addressed targets) from a sign-in that cannot decrypt with the account's key, such as one made with `builtin:share-publishing`, now stops before any upload, registry write or network call. It exits 5 with `PERMISSION_DENIED`, "this sign-in can't create email-addressed shares: it has no permission to decrypt with the account's key. Nothing was shared.", and a hint to share from share.tinycloud.xyz as the account owner or use `--to anyone`. Previously the file was uploaded first and the command failed later with a generic error. Local-key owners are unchanged.

`tc share list` now prints a fourth tab-separated column, `status`: `revoked`, `expired` or `active`. Scripts that split rows on tabs will see the extra column. `--json` output is unchanged.

`inspectShare` and `receiveShare` now report an inline share link whose origin is not the trusted viewer origin as `origin-mismatch` (CLI: `ORIGIN_MISMATCH`, exit 5), matching short links. Before, it was `invalid-link` (exit 2). Malformed links are still `invalid-link`.

Details: TC-1753, TC-1754, TC-1737

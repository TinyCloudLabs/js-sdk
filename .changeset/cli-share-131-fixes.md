---
"@tinycloud/cli": patch
---

`tc share publish --to email:...` (and other addressed targets) from a sign-in that cannot decrypt with the account's key, such as one made with `builtin:share-publishing`, now stops before any upload, registry write or network call. It exits 5 with `PERMISSION_DENIED`, "this sign-in can't create email-addressed shares: it has no permission to decrypt with the account's key. Nothing was shared.", and a hint to share from share.tinycloud.xyz as the account owner or use `--to anyone`. Previously the file was uploaded first and the command failed later with a generic error. Local-key owners are unchanged.

`tc share list` now prints a fourth tab-separated column, `status`: `revoked`, `expired` or `active`. Scripts that split rows on tabs will see the extra column. `--json` output is unchanged.

`tc share receive` and `tc share inspect` now report a share link whose origin is not the trusted Share origin (`--viewer-origin`) as `ORIGIN_MISMATCH` (exit 5) before any request, matching short links. Before, an inline link at another origin was `INVALID_LINK` (exit 2). A link that is not a URL is still `INVALID_LINK`. The SDKs are unchanged.

Details: TC-1753, TC-1754, TC-1737

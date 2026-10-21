---
"@tinycloud/cli": patch
"@tinycloud/share-envelope": patch
---

`tc share publish` prints addressed shares as a short link, `https://share.tinycloud.xyz/s/<id>#v=3&k=<key>&c=<cid>`, instead of a link of about 17,000 characters. Share's short-link service stores only the sealed envelope bytes. The read key and the CID of those bytes stay in the link's fragment: the service never receives the key, and `share receive`/`share inspect` refuse bytes that do not hash to the link's CID.

- `--long-link` prints the long self-contained link instead.
- If the short-link service is unavailable, publishing still succeeds. The CLI prints the long link and warns that it is long, and `--json` adds `shortLinkError`.
- `share show <id> --reveal-link` prints the same short link.
- `share revoke` deletes the stored envelope after the node confirms the revocation. A failed delete only warns; the envelope expires with the share.
- Sender history and the `--notify` invitation still carry the long link. Bearer links are unchanged.

`@tinycloud/share-envelope` adds `parseShortShareUrl`, `splitInlineToShort` and `rebuildInlineFromShort`, tested against the vectors Share's own codec uses. Details: TC-1737

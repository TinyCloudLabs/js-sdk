---
"@tinycloud/cli": patch
---

`tc delegation revoke <cid>` tries authority scoped to that CID, falls back to a locally stored signed grant artifact only when the raw-CID encoder is unavailable, and keeps temporary authority out of profile storage. Noninteractive authority acquisition requires `--yes`; node-side 403 rejections are reported as typed CLI errors.

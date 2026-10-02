---
"@tinycloud/cli": patch
---

Share publishing stores a filename with spaces or other URI-unsafe characters under a readable URI-safe name that keeps its extension (`Edge test (A).md` is stored as `Edge-test-A.md`), so the upload no longer fails with `PERMISSION_DENIED` and anyone-with-link pages still render; addressed shares keep the original display filename. `tc kv put` rejects keys with spaces before authentication because the SDK passes them unescaped in the Node resource URI. Permission errors now advise checking the existing scope before requesting consent again. Publish and KV put quota errors report used and limit sizes; other publish upload failures use a safe `UPLOAD_FAILED` error.

---
"@tinycloud/cli": patch
---

Share publishing stores filenames in URL-safe, reversible KV path segments while preserving the original display filename. `tc kv put` rejects keys with spaces before authentication because the SDK passes them unescaped in the Node resource URI. Permission errors now advise checking the existing scope before requesting consent again. Publish and KV put quota errors report used and limit sizes; other publish upload failures use a safe `UPLOAD_FAILED` error.

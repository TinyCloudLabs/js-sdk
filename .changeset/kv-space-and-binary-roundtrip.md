---
"@tinycloud/sdk-services": patch
"@tinycloud/cli": patch
---

Fix `tc kv put`/`kv delete --space` and binary KV round-trips.

- `tc kv put` and `tc kv delete` now accept `--space <name|uri>`, routing through
  the space-scoped KV (`kvForSpace`) like `get`/`list`/`head` already did. KV
  writes to a non-primary space (e.g. an `applications` space) are now possible
  from the CLI.
- Binary KV values now round-trip byte-identically. `KVService.put` sends
  Blob/ArrayBuffer/typed-array/Buffer values as raw bytes
  (`application/octet-stream`, honoring an explicit `contentType`) instead of
  JSON-stringifying them into `{"type":"Buffer","data":[...]}`. A new
  `KVGetOptions.binary` returns the raw response bytes as a `Uint8Array`, and the
  CLI's `kv get -o <file>` / `--raw` use it so images and other binaries are
  written out unchanged.

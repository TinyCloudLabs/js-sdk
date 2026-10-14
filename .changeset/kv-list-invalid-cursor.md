---
"@tinycloud/cli": patch
---

`tc kv list --cursor` with a cursor the node rejects now fails with `KV_LIST_CURSOR_INVALID` (exit 2) and a hint to start again without `--cursor`, instead of `NETWORK_ERROR` with a misleading "switch to a reachable profile" hint.

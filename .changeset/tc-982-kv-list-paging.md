---
"@tinycloud/cli": patch
---

`tc kv list` can now page through a prefix and say whether a listing is complete (TC-982). The new options:
- `--limit N` (1–1000) sets the page size;
- `--cursor C` continues from a previous page;
- `--all` follows cursors until the listing is complete, and stops with `KV_LIST_CURSOR_STALLED` if the node repeats a cursor.

`--json` output now includes `truncated` and `nextCursor`; both are `null` when the node doesn't report them. Human output says when more keys follow. The `Size` and `Updated` columns were always empty for a list and still are.

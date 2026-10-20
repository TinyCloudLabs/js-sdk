---
"@tinycloud/courier": minor
---

`courier intake` queue record (contract v1) gains `peerId`, the peer handle, which equals the queue directory name. Records stay written atomically (same-directory temp file, fsync, then hard link or rename) without overwriting, so a reader never sees a partial `<msgId>.json`.

---
"@tinycloud/web-sdk": minor
---

Expose `sqlForSpace(spaceId)` and `kvForSpace(spaceId)` on `TinyCloudWeb`.

These thin passthroughs forward to the underlying `TinyCloudNode.sqlForSpace`/`kvForSpace` (already used by the CLI), mirroring the existing `get sql()`/`get kv()` accessors. They let a browser/web-SDK app read or write a non-primary space — e.g. the pure-client viewer reading the artifact `feed` SQL and appending `interaction` rows under the owner's `applications` space.

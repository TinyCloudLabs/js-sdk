---
"@tinycloud/sdk-services": minor
"@tinycloud/cli": minor
---

KV head reports the stored value's size and its last-modified time. It reports them only under the same rule as `list` entries below; other callers get neither field. `head()` reads the size from the node's `x-tinycloud-content-length` header and no longer reports the empty body's `content-length` (0) as the value's size; against a node that doesn't send the header, `contentLength` is absent instead of 0. `lastModified` carries the node's `Last-Modified` header.

`list({ entries: true })` also returns `entries`: each key with its stored `size` and `updatedAt` (RFC 3339), when the node reports them. The node reports them only to the space owner, or to a caller whose session holds an unexpired `kv/get` covering that key. For other keys, and for values written before the node recorded sizes, both fields are absent, never `0` or `null`. If the node can't be reached or times out and a local replica is set, the list falls back to the replica's keys, with the key only in each entry. A node that doesn't support entries returns the key only as well.

`tinycloud kv list` fills its Size and Updated columns from these entries and shows a dash where a field is absent; JSON output is unchanged. `tinycloud kv head` reports the stored size instead of 0.

Details: TC-2492

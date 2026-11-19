---
"@tinycloud/sdk-services": minor
"@tinycloud/cli": minor
---

KV head reports the stored value's size and its last-modified time. `head()` reads the size from the node's `x-tinycloud-content-length` header and no longer reports the empty body's `content-length` (0) as the value's size; against a node that doesn't send the header, `contentLength` is absent instead of 0. `lastModified` carries the node's `Last-Modified` header.

`list({ entries: true })` also returns `entries`, each key with its stored `size` and `updatedAt` (RFC 3339) where the node reports them. The node reports them only to the space owner, or to a caller whose session holds an unexpired `kv/get` covering that key. For any other key, and for values written before the node recorded sizes, both fields are absent, never `0` or `null`. The request goes to the network. When the network is unreachable or times out and a local replica is set, the list falls back to the replica's keys, and their entries carry the key only. A node that doesn't support entries lists bare keys, and their entries also carry the key only.

`tc kv list` fills its Size and Updated table columns from these entries and shows "—" where a field is absent; JSON output is unchanged. `tc kv head` reports the stored size instead of 0.

Details: TC-2492

---
"@tinycloud/sdk-services": patch
---

`KVService.batchGet` and `batchHead` no longer fail (or misattribute results) when the requested keys are not already in key order. The node returns batch results sorted by path (it flattens invocation abilities from a `BTreeMap`), but the SDK matched them to the request by position, so an unsorted request errored with `NETWORK_ERROR` "KV batch read response did not match the requested keys". Results are now matched by the path each response item carries and returned in the caller's requested order; a response that carries no keys is aligned assuming the node's byte-sorted path order. A response that is missing a requested path, carries an unrequested one, or mixes keyed and keyless items still fails closed with `NETWORK_ERROR`.

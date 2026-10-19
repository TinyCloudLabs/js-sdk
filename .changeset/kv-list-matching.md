---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
---

Add `kv.listMatching(prefix, options?)`, a client-side helper for "keys whose name starts with a partial segment". Since node 1.19.0 (TC-731) the node matches list prefixes on whole path segments only (`qa/b` matches `qa/b` and `qa/b/...`, not `qa/b00`), so a grant on `docs` cannot enumerate `docsecret/...`. The helper splits the prefix at its last `/`, lists that folder with the normal `list` across every page, and filters the keys locally; it never lists more than the folder, so delegated sessions see only what their grant allows. It reads the whole folder, so use it for type-ahead and small folders, not large ones. `IKVService` gains a required `listMatching` method (custom `IKVService` implementations must add it) and `KVListMatchingOptions` is exported from both packages.

---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
"@tinycloud/node-sdk": minor
---

Add `listMatching(kv, prefix, options?)`, a standalone client-side helper for "keys whose name starts with a partial segment". Since node 1.19.0 (TC-731) the node matches list prefixes on whole path segments only (`qa/b` matches `qa/b` and `qa/b/...`, not `qa/b00`), so a grant on `docs` cannot enumerate `docsecret/...`. The helper splits the prefix at its last `/`, lists that folder with the normal `list` across every page, and filters the keys locally; it never lists more than the folder, so delegated sessions see only what their grant allows. It accepts a KV service or a `withPrefix` view. It reads the whole folder, so use it for type-ahead and small folders, not large ones. It is a free function, not a method on `IKVService`, so nothing in the interface changes and bundles that don't import it don't include it. Exported from sdk-services, sdk-core, web-sdk and node-sdk, together with the `KVListSource` and `KVListMatchingOptions` types.

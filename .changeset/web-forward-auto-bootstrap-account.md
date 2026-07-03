---
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

fix(web-sdk): forward autoBootstrapAccount to node-sdk config

The web `Config` interface neither declared nor forwarded `autoBootstrapAccount`
into the assembled `nodeConfig`, so setting it in a web app (e.g.
`autoBootstrapAccount: false` to suppress the multi-signature bootstrap loop)
was silently inert — the node-sdk default (`true`) always won. Declare the
option on `Config` and forward it, restoring the web↔node contract.

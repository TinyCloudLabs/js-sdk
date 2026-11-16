---
"@tinycloud/mcp": patch
---

The hosted server serves its restricted personal-record surface at three more addresses, one each for the Claude, Grok and Muse directory listings: `/claude/mcp`, `/grok/mcp` and `/muse/mcp`. Each registers the same five tools as `/chatgpt/mcp` (`tinycloud_connect` and the four `tinycloud_apps_*` tools) and is its own OAuth resource, with its own protected-resource metadata, 401 challenge, approval route and tenant state. A token or approval link issued for one address is refused at every other.

`/mcp` and `/chatgpt/mcp` are unchanged: their tool lists, schemas, descriptions, annotations, instructions and discovery documents are byte-identical to the previous release.

A new address serves requests only after the matching OpenKey release issues tokens for its audience and accepts its approval callback, and the server's token-status client is registered for the new resources. This changeset performs no deployment.

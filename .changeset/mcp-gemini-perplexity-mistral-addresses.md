---
"@tinycloud/mcp": patch
"@tinycloud/operations": patch
---

The hosted server serves four more restricted personal-record addresses, one each for the Gemini, Perplexity, Mistral and Microsoft 365 Copilot listings. Each is its own OAuth resource with its own protected-resource metadata, 401 challenge, approval route and tenant state, like the existing ones.

`/perplexity/mcp`, `/mistral/mcp` and `/copilot/mcp` register the same five tools as `/chatgpt/mcp`. `/mistral/mcp` and `/perplexity/mcp` also name `offline_access` beside `tinycloud:mcp` in the 401 challenge and in `scopes_supported`, as a hint: OpenKey issues a refresh token only when a client asks for that scope, and these clients ask for the scopes they are shown. The scope a token must carry is still `tinycloud:mcp` alone.

`/gemini/mcp` registers eleven typed tools of its own, because Google's Connected Apps policy does not allow instructions in a tool result, model-written SQL or one tool that batches different actions, and Google does not read structured content: `tinycloud_connect`, `tinycloud_list_apps`, `tinycloud_get_app`, `tinycloud_list_records`, `tinycloud_set_timezone`, `tinycloud_create_app`, `tinycloud_create_kind`, `tinycloud_create_record`, `tinycloud_update_record`, `tinycloud_move_record` and `tinycloud_delete_record`. They build record keys, ids and catalog entries themselves and call the existing personal-record operations; results are one JSON text part and never include the rules text. Tools that write are marked destructive. Health Log, Recipes and the searchable copy are not offered there. The tools and server instructions are fixed literals pinned by a snapshot, because Google locks them when a version is published.

`@tinycloud/operations/tc-apps` additionally exports the personal-record key-layout helpers these tools use. No operation, schema or rule text changes.

`/mcp`, `/chatgpt/mcp`, `/claude/mcp`, `/grok/mcp` and `/muse/mcp` are unchanged: their tool lists, schemas, descriptions, annotations, instructions and discovery documents are byte-identical to the previous commit.

A new address serves requests only after the matching OpenKey release issues tokens for its audience and accepts its approval callback, and the server's token-status client is registered for the new resources. This changeset performs no deployment.

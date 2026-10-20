---
"@tinycloud/cli": minor
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
"@tinycloud/node-sdk": patch
---

Agents can pick up the apps a user installed, from their `applications` space.

- `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 with the `--cap` to ask for. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted).
- `tinycloud auth request --preset apps-agent [--app <app_id>]` requests KV get, list, put and SQL read, write on the `applications` space for 7 days: no delete, no schema changes, no other space. `--app` limits it to that app's `<app_id>/` prefix, which is the recommended ask. The scope is printed in plain words before approval (`auth grant` prints it too). The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
- The `tc-cli` skill has a "Pick up a user's apps" section.
- Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it.

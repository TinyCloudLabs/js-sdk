---
"@tinycloud/cli": minor
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
"@tinycloud/node-sdk": patch
---

Agents can pick up the apps a user installed, from their `applications` space.

- `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint names the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
- `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. `--preset apps-agent --write --app <app_id>` is a separate opt-in that adds KV put and SQL write for the named apps; it is refused without `--app`. Because of how TinyCloud permissions work today, SQL write also lets the agent create, change or drop those apps' tables, and the scope text says so; a node-side fix is the real cure. Neither variant carries KV delete, SQL admin or schema, another service or space. The scope is printed in plain words before approval, and `auth grant` prints a scope built from the request as it will be signed: the preset wording only when the permissions, the owner's own `applications` space and the 7-day lifetime all match, otherwise a description of each permission and the requested lifetime. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
- The `tc-cli` skill has a "Pick up a user's apps" section.
- Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused.

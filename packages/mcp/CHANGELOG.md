# @tinycloud/mcp

## 0.8.3-beta.12

### Patch Changes

- Updated dependencies [5d9d314]
  - @tinycloud/node-sdk@3.8.0-beta.11
  - @tinycloud/operations@0.7.7-beta.11

## 0.8.3-beta.11

### Patch Changes

- Updated dependencies [20a872e]
  - @tinycloud/node-sdk@3.8.0-beta.10
  - @tinycloud/operations@0.7.7-beta.10

## 0.8.3-beta.10

### Patch Changes

- Updated dependencies [92e4bd0]
  - @tinycloud/node-sdk@3.8.0-beta.9
  - @tinycloud/operations@0.7.7-beta.9

## 0.8.3-beta.9

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.7
- @tinycloud/operations@0.7.7-beta.8

## 0.8.3-beta.8

### Patch Changes

- 255772f: The hosted MCP server checks each access token's status with OpenKey's resource-server token introspection endpoint before serving a call. Only a 200 answer with `active: true` is active, and only when its `sub` and `client_id` equal the verified token's and its `aud` is a non-empty subset of the token's audiences that includes the server's resource URL; an active answer is reused for 30 seconds. An inactive token is answered with 401 `invalid_token`, and that answer is kept for the token. When OpenKey cannot be reached or answers otherwise, a call is served only when OpenKey itself answered that same token active to this server, and only until the token expires; every other call is answered with 500 `server_error`. A 401 from the endpoint is logged once and refused. The server needs `TC_MCP_INTROSPECTION_URL`, `TC_MCP_INTROSPECTION_CLIENT_ID` and `TC_MCP_INTROSPECTION_CLIENT_SECRET` (and optionally `TC_MCP_INTROSPECTION_AUTH_METHOD=basic|post`) and does not start without them. The README lists where an owner manages the hosted MCP's delegation.

  Details: TC-1627

## 0.8.3-beta.7

### Patch Changes

- Updated dependencies [479205d]
  - @tinycloud/node-sdk@3.8.0-beta.6
  - @tinycloud/operations@0.7.7-beta.7

## 0.8.3-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.5
- @tinycloud/operations@0.7.7-beta.6

## 0.8.3-beta.5

### Patch Changes

- Updated dependencies [c541786]
  - @tinycloud/node-sdk@3.8.0-beta.4
  - @tinycloud/operations@0.7.7-beta.5

## 0.8.3-beta.4

### Patch Changes

- 1fc87b6: Fix personal-app MCP guidance and generated write schemas for server-owned `by` metadata. Write examples omit `by`, and edit/move instructions tell clients to remove it from read-back values before submitting them. Advertised put/move schemas now reject top-level `by` before invocation, matching the existing runtime restriction. CLI records, nested data fields and stored/read-back attribution remain unchanged.
- Updated dependencies [1fc87b6]
  - @tinycloud/operations@0.7.7-beta.4

## 0.8.3-beta.3

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.3
- @tinycloud/operations@0.7.7-beta.3

## 0.8.3-beta.2

### Patch Changes

- Updated dependencies [4a19c47]
  - @tinycloud/node-sdk@3.8.0-beta.2
  - @tinycloud/operations@0.7.7-beta.2

## 0.8.3-beta.1

### Patch Changes

- Updated dependencies [2789240]
  - @tinycloud/node-sdk@3.8.0-beta.1
  - @tinycloud/operations@0.7.7-beta.1

## 0.8.3-beta.0

### Patch Changes

- Updated dependencies [15080ed]
  - @tinycloud/node-sdk@3.8.0-beta.0
  - @tinycloud/operations@0.7.7-beta.0

## 0.8.2

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [279c8e9]
- Updated dependencies [71fa087]
- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0
  - @tinycloud/operations@0.7.6

## 0.8.2-beta.4

### Patch Changes

- Updated dependencies [c142537]
  - @tinycloud/node-sdk@3.7.0-beta.4
  - @tinycloud/operations@0.7.6-beta.4

## 0.8.2-beta.3

### Patch Changes

- Updated dependencies [279c8e9]
  - @tinycloud/node-sdk@3.7.0-beta.3
  - @tinycloud/operations@0.7.6-beta.3

## 0.8.2-beta.2

### Patch Changes

- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0-beta.2
  - @tinycloud/operations@0.7.6-beta.2

## 0.8.2-beta.1

### Patch Changes

- Updated dependencies [71fa087]
  - @tinycloud/node-sdk@3.7.0-beta.1
  - @tinycloud/operations@0.7.6-beta.1

## 0.8.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.6.2-beta.0
- @tinycloud/operations@0.7.6-beta.0

## 0.8.1

### Patch Changes

- Updated dependencies [271155a]
- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1
  - @tinycloud/operations@0.7.5

## 0.8.1-beta.1

### Patch Changes

- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1-beta.1
  - @tinycloud/operations@0.7.5-beta.1

## 0.8.1-beta.0

### Patch Changes

- Updated dependencies [271155a]
  - @tinycloud/node-sdk@3.6.1-beta.0
  - @tinycloud/operations@0.7.5-beta.0

## 0.8.0

### Minor Changes

- e18946e: Add the separate `/chatgpt/mcp` public personal-record endpoint with exactly connect, context, read, write and query tools. Public OAuth audiences, tenant state, approvals and recovery suggestions are isolated from the existing broad `/mcp` service; excluded tools cannot be invoked by name. Preserve local/private integrations and return an inert browser recovery page for invalid approval links.

  Correct context/query mutation annotations and operation effects, ask for an IANA timezone rather than location, and preserve the hosted 100,000-character context and derived-query output limit without truncating canonical write outcomes. Add reproducible MCP-only plugin packaging and explicit reviewer/publication gates.

  Advertise equivalent JSON Schema 2020-12 tool inputs and results on stdio and both hosted surfaces so the official v2 client works with its default validator. Preserve the shared Draft-07 operations catalog for non-MCP consumers; reject unsupported dialect-specific forms rather than silently changing their validation.

  Deploy the matching OpenKey API audience and exact web callback registrations before candidate acceptance. The package is not a published plugin: actual ChatGPT web/mobile tests, independent reviewer access, approved policies, recording and portal review remain required. Default-branch integration and deployment require explicit owner approval.

### Patch Changes

- 00e1d5a: `tinycloud_connect` reports `connected: true` only after the node confirms the account session. When the node cannot confirm it (timeout, unreachable, or an unexpected response), the tool reports `connected: false` with no approval URL instead of a connected state.

  Details: TC-1627

- Updated dependencies [e18946e]
- Updated dependencies [e600a1a]
- Updated dependencies [0c09d7b]
- Updated dependencies [82cbd43]
- Updated dependencies [1f831e3]
- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
- Updated dependencies [e32bc41]
- Updated dependencies [c0acb86]
  - @tinycloud/operations@0.7.4
  - @tinycloud/node-sdk@3.6.0

## 0.8.0-beta.9

### Patch Changes

- Updated dependencies [1f831e3]
  - @tinycloud/node-sdk@3.6.0-beta.8
  - @tinycloud/operations@0.7.4-beta.8

## 0.8.0-beta.8

### Patch Changes

- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
  - @tinycloud/node-sdk@3.6.0-beta.7
  - @tinycloud/operations@0.7.4-beta.7

## 0.8.0-beta.7

### Patch Changes

- 00e1d5a: `tinycloud_connect` reports `connected: true` only after the node confirms the account session. When the node cannot confirm it (timeout, unreachable, or an unexpected response), the tool reports `connected: false` with no approval URL instead of a connected state.

  Details: TC-1627

## 0.8.0-beta.6

### Patch Changes

- Updated dependencies [e600a1a]
  - @tinycloud/node-sdk@3.6.0-beta.6
  - @tinycloud/operations@0.7.4-beta.6

## 0.8.0-beta.5

### Patch Changes

- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0-beta.5
  - @tinycloud/operations@0.7.4-beta.5

## 0.8.0-beta.4

### Patch Changes

- Updated dependencies [e32bc41]
  - @tinycloud/node-sdk@3.6.0-beta.4
  - @tinycloud/operations@0.7.4-beta.4

## 0.8.0-beta.3

### Patch Changes

- Updated dependencies [82cbd43]
  - @tinycloud/operations@0.7.4-beta.3
  - @tinycloud/node-sdk@3.6.0-beta.3

## 0.8.0-beta.2

### Minor Changes

- e18946e: Add the separate `/chatgpt/mcp` public personal-record endpoint with exactly connect, context, read, write and query tools. Public OAuth audiences, tenant state, approvals and recovery suggestions are isolated from the existing broad `/mcp` service; excluded tools cannot be invoked by name. Preserve local/private integrations and return an inert browser recovery page for invalid approval links.

  Correct context/query mutation annotations and operation effects, ask for an IANA timezone rather than location, and preserve the hosted 100,000-character context and derived-query output limit without truncating canonical write outcomes. Add reproducible MCP-only plugin packaging and explicit reviewer/publication gates.

  Advertise equivalent JSON Schema 2020-12 tool inputs and results on stdio and both hosted surfaces so the official v2 client works with its default validator. Preserve the shared Draft-07 operations catalog for non-MCP consumers; reject unsupported dialect-specific forms rather than silently changing their validation.

  Deploy the matching OpenKey API audience and exact web callback registrations before candidate acceptance. The package is not a published plugin: actual ChatGPT web/mobile tests, independent reviewer access, approved policies, recording and portal review remain required. Default-branch integration and deployment require explicit owner approval.

### Patch Changes

- Updated dependencies [e18946e]
  - @tinycloud/operations@0.7.4-beta.2

## 0.7.4-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.6.0-beta.2
- @tinycloud/operations@0.7.4-beta.1

## 0.7.4-beta.0

### Patch Changes

- Updated dependencies [0c09d7b]
  - @tinycloud/node-sdk@3.6.0-beta.0
  - @tinycloud/operations@0.7.4-beta.0

## 0.7.3

### Patch Changes

- Updated dependencies [d60f81d]
- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0
  - @tinycloud/operations@0.7.3

## 0.7.3-beta.1

### Patch Changes

- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0-beta.1
  - @tinycloud/operations@0.7.3-beta.1

## 0.7.3-beta.0

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/node-sdk@3.5.0-beta.0
  - @tinycloud/operations@0.7.3-beta.0

## 0.7.2

### Patch Changes

- @tinycloud/node-sdk@3.4.0
- @tinycloud/operations@0.7.2

## 0.7.2-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.1
- @tinycloud/operations@0.7.2-beta.1

## 0.7.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.0
- @tinycloud/operations@0.7.2-beta.0

## 0.7.1

### Patch Changes

- @tinycloud/node-sdk@3.3.1
- @tinycloud/operations@0.7.1

## 0.7.1-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.1-beta.0
- @tinycloud/operations@0.7.1-beta.0

## 0.7.0

### Minor Changes

- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. `--preset apps-agent --write --app <app_id>` is a separate opt-in for the named apps: KV put only in each app's `knowledge/` and `prefs/` folders (the folders the sample apps' manifests write to) plus SQL write, which adds, changes and deletes rows. Creating, changing and dropping tables also needs `tinycloud.sql/schema`, which the preset grants only on an app's catalog database (`xyz.tinycloud.sample.healthlog` gets `healthlog`, at the exact path `<app_id>/healthlog`). Everything else under `<app_id>/` stays read-only, so the app's code and its stored `<app_id>/app/manifest.json` and `<app_id>/app/install.json` cannot be changed through it (the root-level `<app_id>/manifest.json` and `<app_id>/install.json` are refused too) (TC-1620); it is refused without `--app`. Neither variant carries KV delete, SQL admin, schema on any other database, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

### Patch Changes

- 4dd842f: Update jose to 6.2.4.
- 6ad58de: Consolidated dependency update: bump `@modelcontextprotocol/{node,server,client}` to 2.0.0-beta.5, `zod-to-json-schema` to ^3.25.2, `@openkey/sdk` to 0.9.0 in the example apps, and refresh the tokio entry in Cargo.lock.
- 6793a14: A new sign-in after an account approval is withdrawn at the TinyCloud node offers fresh owner approval. Node refusals that identify a withdrawn per-request permission renew only the affected approval; other node errors leave stored approvals available.
- Updated dependencies [2aa917e]
- Updated dependencies [b6d0b9f]
- Updated dependencies [d2ad845]
- Updated dependencies [6ad58de]
- Updated dependencies [29440be]
- Updated dependencies [a553392]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [41e5fca]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [f2cb165]
- Updated dependencies [87a137e]
- Updated dependencies [ef9653b]
- Updated dependencies [370a8e4]
- Updated dependencies [ef49c14]
- Updated dependencies [cce8b26]
- Updated dependencies [5373fa2]
- Updated dependencies [0c4c6b2]
- Updated dependencies [baca422]
- Updated dependencies [e99a127]
- Updated dependencies [f97d73d]
- Updated dependencies [18b6c9f]
- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0
  - @tinycloud/operations@0.7.0
  - @tinycloud/node-sdk-wasm@1.7.8

## 0.7.0-beta.39

### Patch Changes

- Updated dependencies [ef49c14]
  - @tinycloud/operations@0.7.0-beta.38
  - @tinycloud/node-sdk@3.3.0-beta.39

## 0.7.0-beta.38

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.38
- @tinycloud/operations@0.7.0-beta.37

## 0.7.0-beta.37

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.37
- @tinycloud/operations@0.7.0-beta.36

## 0.7.0-beta.36

### Patch Changes

- 6793a14: A new sign-in after an account approval is withdrawn at the TinyCloud node offers fresh owner approval. Node refusals that identify a withdrawn per-request permission renew only the affected approval; other node errors leave stored approvals available.
- Updated dependencies [5373fa2]
  - @tinycloud/operations@0.7.0-beta.35

## 0.7.0-beta.35

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.36
- @tinycloud/operations@0.7.0-beta.34

## 0.7.0-beta.34

### Patch Changes

- Updated dependencies [f2cb165]
  - @tinycloud/operations@0.7.0-beta.33

## 0.7.0-beta.33

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.35
- @tinycloud/operations@0.7.0-beta.32

## 0.7.0-beta.32

### Minor Changes

- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. Don't request `--write` during the tiny-apps beta. It currently also allows changes to the app's own code and manifest; the narrowed write ships in TC-1620. (The flag adds KV put and SQL write for the named apps and is refused without `--app`.) Because of how TinyCloud permissions work today, SQL write also lets the agent create, change or drop those apps' tables, and the scope text says so; TC-1581 (node-side: `sql/write` must not permit DDL) is the real cure. Neither variant carries KV delete, SQL admin or schema, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

### Patch Changes

- Updated dependencies [a553392]
  - @tinycloud/operations@0.7.0-beta.31
  - @tinycloud/node-sdk@3.3.0-beta.34

## 0.6.1-beta.31

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.33
- @tinycloud/operations@0.6.1-beta.30

## 0.6.1-beta.30

### Patch Changes

- 6ad58de: Consolidated dependency update: bump `@modelcontextprotocol/{node,server,client}` to 2.0.0-beta.5, `zod-to-json-schema` to ^3.25.2, `@openkey/sdk` to 0.9.0 in the example apps, and refresh the tokio entry in Cargo.lock.
- Updated dependencies [6ad58de]
  - @tinycloud/operations@0.6.1-beta.29
  - @tinycloud/node-sdk-wasm@1.7.8-beta.0
  - @tinycloud/node-sdk@3.3.0-beta.31

## 0.6.1-beta.29

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.30
- @tinycloud/operations@0.6.1-beta.28

## 0.6.1-beta.28

### Patch Changes

- Updated dependencies [e99a127]
  - @tinycloud/node-sdk@3.3.0-beta.29
  - @tinycloud/operations@0.6.1-beta.27

## 0.6.1-beta.27

### Patch Changes

- 4dd842f: Update jose to 6.2.4.

## 0.6.1-beta.26

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.28
- @tinycloud/operations@0.6.1-beta.26

## 0.6.1-beta.25

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.27
- @tinycloud/operations@0.6.1-beta.25

## 0.6.1-beta.24

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.26
- @tinycloud/operations@0.6.1-beta.24

## 0.6.1-beta.23

### Patch Changes

- Updated dependencies [87a137e]
  - @tinycloud/node-sdk@3.3.0-beta.25
  - @tinycloud/operations@0.6.1-beta.23

## 0.6.1-beta.22

### Patch Changes

- Updated dependencies [b6d0b9f]
  - @tinycloud/node-sdk@3.3.0-beta.24
  - @tinycloud/operations@0.6.1-beta.22

## 0.6.1-beta.21

### Patch Changes

- Updated dependencies [d2ad845]
  - @tinycloud/node-sdk@3.3.0-beta.23
  - @tinycloud/operations@0.6.1-beta.21

## 0.6.1-beta.20

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.22
- @tinycloud/operations@0.6.1-beta.20

## 0.6.1-beta.19

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.21
- @tinycloud/operations@0.6.1-beta.19

## 0.6.1-beta.18

### Patch Changes

- Updated dependencies [cce8b26]
  - @tinycloud/node-sdk@3.3.0-beta.20
  - @tinycloud/operations@0.6.1-beta.18

## 0.6.1-beta.17

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.18
- @tinycloud/operations@0.6.1-beta.17

## 0.6.1-beta.16

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.17
- @tinycloud/operations@0.6.1-beta.16

## 0.6.1-beta.15

### Patch Changes

- Updated dependencies [18b6c9f]
  - @tinycloud/node-sdk@3.3.0-beta.16
  - @tinycloud/operations@0.6.1-beta.15

## 0.6.1-beta.14

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.15
- @tinycloud/operations@0.6.1-beta.14

## 0.6.1-beta.13

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.14
- @tinycloud/operations@0.6.1-beta.13

## 0.6.1-beta.12

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.13
- @tinycloud/operations@0.6.1-beta.12

## 0.6.1-beta.11

### Patch Changes

- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0-beta.11
  - @tinycloud/operations@0.6.1-beta.11

## 0.6.1-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.10
- @tinycloud/operations@0.6.1-beta.10

## 0.6.1-beta.9

### Patch Changes

- Updated dependencies [ef9653b]
  - @tinycloud/node-sdk@3.3.0-beta.9
  - @tinycloud/operations@0.6.1-beta.9

## 0.6.1-beta.8

### Patch Changes

- Updated dependencies [f97d73d]
  - @tinycloud/node-sdk@3.3.0-beta.8
  - @tinycloud/operations@0.6.1-beta.8

## 0.6.1-beta.7

### Patch Changes

- Updated dependencies [29440be]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [0c4c6b2]
  - @tinycloud/node-sdk@3.3.0-beta.7
  - @tinycloud/operations@0.6.1-beta.7

## 0.6.1-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.6
- @tinycloud/operations@0.6.1-beta.6

## 0.6.1-beta.5

### Patch Changes

- Updated dependencies [baca422]
  - @tinycloud/operations@0.6.1-beta.5
  - @tinycloud/node-sdk@3.2.6-beta.5

## 0.6.1-beta.4

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.4
- @tinycloud/operations@0.6.1-beta.4

## 0.6.1-beta.3

### Patch Changes

- Updated dependencies [41e5fca]
  - @tinycloud/node-sdk@3.2.6-beta.3
  - @tinycloud/operations@0.6.1-beta.3

## 0.6.1-beta.2

### Patch Changes

- Updated dependencies [370a8e4]
  - @tinycloud/node-sdk@3.2.6-beta.2
  - @tinycloud/operations@0.6.1-beta.2

## 0.6.1-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.1
- @tinycloud/operations@0.6.1-beta.1

## 0.6.1-beta.0

### Patch Changes

- Updated dependencies [2aa917e]
  - @tinycloud/node-sdk@3.2.6-beta.0
  - @tinycloud/operations@0.6.1-beta.0

## 0.6.0

### Minor Changes

- 527c91b: Add hosted personal-record queries through the optional fast, searchable copy. Check stale markers and KV/copy counts, rebuild kinds in byte-bounded sequential chunks, and resume remaining kinds with COPY_PARTIAL. Sync completed record writes and move steps without hiding their outcomes; mark kinds stale when upkeep cannot finish. A quarantined database returns nonretryable copy_unavailable for node-team repair. Ship the full pinned tc-apps rules and final hosted-tool documentation.
- cfc9d1b: Add hosted personal-record context, batch reads and ordered conditional writes using the tc-apps catalog and CLI-compatible JSON bytes. Preserve ETags and partial move outcomes, enforce the default-space prefix, and generate guidance from a pinned published skill. Hosted results are readable in text-only MCP clients; secrets remain structured-only and large writes retain every outcome. Request 30-day grants with 15-minute approval links, recover expired sessions through OpenKey, and log only tool, outcome, duration and replayed-grant count.

### Patch Changes

- Updated dependencies [527c91b]
- Updated dependencies [cfc9d1b]
  - @tinycloud/operations@0.6.0
  - @tinycloud/node-sdk@3.2.5

## 0.6.0-beta.2

### Minor Changes

- 527c91b: Add hosted personal-record queries through the optional fast, searchable copy. Check stale markers and KV/copy counts, rebuild kinds in byte-bounded sequential chunks, and resume remaining kinds with COPY_PARTIAL. Sync completed record writes and move steps without hiding their outcomes; mark kinds stale when upkeep cannot finish. A quarantined database returns nonretryable copy_unavailable for node-team repair. Ship the full pinned tc-apps rules and final hosted-tool documentation.

### Patch Changes

- Updated dependencies [527c91b]
  - @tinycloud/operations@0.6.0-beta.2

## 0.6.0-beta.1

### Minor Changes

- cfc9d1b: Add hosted personal-record context, batch reads and ordered conditional writes using the tc-apps catalog and CLI-compatible JSON bytes. Preserve ETags and partial move outcomes, enforce the default-space prefix, and generate guidance from a pinned published skill. Hosted results are readable in text-only MCP clients; secrets remain structured-only and large writes retain every outcome. Request 30-day grants with 15-minute approval links, recover expired sessions through OpenKey, and log only tool, outcome, duration and replayed-grant count.

### Patch Changes

- Updated dependencies [cfc9d1b]
  - @tinycloud/operations@0.6.0-beta.1

## 0.5.5-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.5-beta.0
- @tinycloud/operations@0.5.5-beta.0

## 0.5.4

### Patch Changes

- b6038b1: Diagnostics only: the hosted MCP's `/connect/callback` now says which stage refused an approval. Nothing about what is accepted, refused or stored changes. A refusal is still `400`, and its body adds `error` (the stage: `restore_approval`, `siwe_runtime_delegation`, `auth_import`, `activation` or `unknown`) and `code` (for example `DELEGATION_REJECTED`, `AUTH_EXPIRED`, `CALLBACK_INCOMPLETE`, `SESSION_MISMATCH`, `UNKNOWN`), with an optional `reason` (a `RuntimeDelegationRejectedError` reason such as `activation_rejected` or `proof_invalid`; any other value is reported as `unknown`). The human-readable text moves to `message`.

  The server also writes one stderr line per refusal: `[tinycloud-mcp-http] connect callback rejected: stage=… code=…[ reason=…] detail=…`. `detail` names the check that failed before the approval is read: `state_missing`, `state_invalid`, `state_expired`, `state_not_pending`, `tenant_missing` or `body_invalid`, and `none` otherwise. It appears only in the log; every such refusal gets the same `{ error: "unknown", code: "UNKNOWN" }` body, so a caller cannot probe whether a state is valid. `tenant_missing` includes a validly signed state whose whole tenant directory is gone, such as after a state-volume reset. `state_not_pending` is not proof of replay: retrying an expired link also produces it, because the first attempt deletes the expired pending approval.

  Neither the body nor the line includes callback input, delegations, tokens, session DIDs or node responses. The `403` `approval_owner_mismatch` response is unchanged.

  `tinycloud.auth.import` now puts the activation rejection reason in `DELEGATION_REJECTED` error details as `details.reason`, for example `activation_rejected` when the node's `/delegate` refuses the delegation. Only `RuntimeDelegationRejectedError` reasons cross the result boundary.

- 78c48a1: Hosted MCP tenants created before `TC_HOST` moved to `https://tee.node.tinycloud.xyz` no longer refuse every authority approval with `400 stage=auth_import code=DELEGATION_HOST_MISMATCH`. Those tenants kept `https://node.tinycloud.xyz` as the host in their stored profile. The runtime already used `TC_HOST`, but `tinycloud.auth.import` compares the stored host with it. The hosted MCP now moves a tenant whose stored host is that retired default to the configured node host the next time it loads the tenant (on `tinycloud_connect` or when it creates an approval link). It writes the profile atomically and logs one line: `[tinycloud-mcp-http] tenant node host migrated: from=https://node.tinycloud.xyz to=<TC_HOST origin>`. A tenant stored with any other host is left alone and still gets `DELEGATION_HOST_MISMATCH`.
- 016b878: Release the retired-node-host tenant migration in a new beta (the earlier 0.5.4-beta.1 build predates it).
- Updated dependencies [b6038b1]
- Updated dependencies [079afb6]
  - @tinycloud/operations@0.5.4
  - @tinycloud/node-sdk@3.2.4

## 0.5.4-beta.3

### Patch Changes

- Updated dependencies [079afb6]
  - @tinycloud/operations@0.5.4-beta.2

## 0.5.4-beta.2

### Patch Changes

- 016b878: Release the retired-node-host tenant migration in a new beta (the earlier 0.5.4-beta.1 build predates it).

## 0.5.4-beta.1

### Patch Changes

- b6038b1: Diagnostics only: the hosted MCP's `/connect/callback` now says which stage refused an approval. Nothing about what is accepted, refused or stored changes. A refusal is still `400`, and its body adds `error` (the stage: `restore_approval`, `siwe_runtime_delegation`, `auth_import`, `activation` or `unknown`) and `code` (for example `DELEGATION_REJECTED`, `AUTH_EXPIRED`, `CALLBACK_INCOMPLETE`, `SESSION_MISMATCH`, `UNKNOWN`), with an optional `reason` (a `RuntimeDelegationRejectedError` reason such as `activation_rejected` or `proof_invalid`; any other value is reported as `unknown`). The human-readable text moves to `message`.

  The server also writes one stderr line per refusal: `[tinycloud-mcp-http] connect callback rejected: stage=… code=…[ reason=…] detail=…`. `detail` names the check that failed before the approval is read: `state_missing`, `state_invalid`, `state_expired`, `state_not_pending`, `tenant_missing` or `body_invalid`, and `none` otherwise. It appears only in the log; every such refusal gets the same `{ error: "unknown", code: "UNKNOWN" }` body, so a caller cannot probe whether a state is valid. `tenant_missing` includes a validly signed state whose whole tenant directory is gone, such as after a state-volume reset. `state_not_pending` is not proof of replay: retrying an expired link also produces it, because the first attempt deletes the expired pending approval.

  Neither the body nor the line includes callback input, delegations, tokens, session DIDs or node responses. The `403` `approval_owner_mismatch` response is unchanged.

  `tinycloud.auth.import` now puts the activation rejection reason in `DELEGATION_REJECTED` error details as `details.reason`, for example `activation_rejected` when the node's `/delegate` refuses the delegation. Only `RuntimeDelegationRejectedError` reasons cross the result boundary.

- 78c48a1: Hosted MCP tenants created before `TC_HOST` moved to `https://tee.node.tinycloud.xyz` no longer refuse every authority approval with `400 stage=auth_import code=DELEGATION_HOST_MISMATCH`. Those tenants kept `https://node.tinycloud.xyz` as the host in their stored profile. The runtime already used `TC_HOST`, but `tinycloud.auth.import` compares the stored host with it. The hosted MCP now moves a tenant whose stored host is that retired default to the configured node host the next time it loads the tenant (on `tinycloud_connect` or when it creates an approval link). It writes the profile atomically and logs one line: `[tinycloud-mcp-http] tenant node host migrated: from=https://node.tinycloud.xyz to=<TC_HOST origin>`. A tenant stored with any other host is left alone and still gets `DELEGATION_HOST_MISMATCH`.
- Updated dependencies [b6038b1]
  - @tinycloud/operations@0.5.4-beta.1

## 0.5.4-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.4-beta.0
- @tinycloud/operations@0.5.4-beta.0

## 0.5.3

### Patch Changes

- Updated dependencies [c13720c]
- Updated dependencies [021330d]
  - @tinycloud/node-sdk@3.2.3
  - @tinycloud/operations@0.5.3

## 0.5.3-beta.1

### Patch Changes

- Updated dependencies [c13720c]
  - @tinycloud/node-sdk@3.2.3-beta.0
  - @tinycloud/operations@0.5.3-beta.1

## 0.5.3-beta.0

### Patch Changes

- Updated dependencies [021330d]
  - @tinycloud/operations@0.5.3-beta.0

## 0.5.2

### Patch Changes

- Updated dependencies [0e8ee33]
  - @tinycloud/operations@0.5.2
  - @tinycloud/node-sdk@3.2.2

## 0.5.2-beta.1

### Patch Changes

- Updated dependencies [0e8ee33]
  - @tinycloud/operations@0.5.2-beta.1

## 0.5.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.2-beta.0
- @tinycloud/operations@0.5.2-beta.0

## 0.5.1

### Patch Changes

- Updated dependencies [10359c5]
- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1
  - @tinycloud/operations@0.5.1

## 0.5.1-beta.1

### Patch Changes

- Updated dependencies [10359c5]
  - @tinycloud/node-sdk@3.2.1-beta.1
  - @tinycloud/operations@0.5.1-beta.1

## 0.5.1-beta.0

### Patch Changes

- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1-beta.0
  - @tinycloud/operations@0.5.1-beta.0

## 0.5.0

### Minor Changes

- 4f851e6: Add `tinycloud_secrets_status` (`tinycloud.secrets.status@1`) for local/stdio MCP only; the hosted server does not register it. It is read-only (`readOnlyHint`, `idempotentHint`, `openWorldHint`) and never signs in: it uses the profile's stored session and reports each named secret as `ready`, `pending`, or `consent_required` without saving a permission request.

  Missing-secret `setup` is now the canonical Secret Manager `/request` link (`{url, names, scope?, owner, action: "add_secret"}`) instead of the old setup link. A `complete_migration` recovery in `error.details.recovery` now carries `tool: "tinycloud_auth_capabilities"`, taken from the binding table.

  Tool bindings gain an optional `surfaces` field (`"local"` / `"hosted"`, default both), and `McpStartupSelection` gains a required `surface`; `registerTinyCloudTools` skips bindings not on that surface. Generated `mcp-facts.json` lists each tool's surfaces.

  **Breaks:** direct callers of `registerTinyCloudTools` must pass `surface`; clients that parsed the old setup link shape; the local server now lists 17 tools.

### Patch Changes

- 33efc8c: The hosted MCP connect flow now completes. `tinycloud_connect` accepts a correctly signed OpenKey bootstrap: its account access is checked with the SDK subset check, which considers every signed action together instead of requiring one grant to carry them all. An approved operation delegation is imported as a full `tinycloud.auth.delegation` v1 artifact, and OpenKey's signed-login (CACAO) delegation is verified from its SIWE and accepted, so the retried tool call uses it.

  Hosted mode no longer exposes `tinycloud_auth_import`: delegations reach a hosted tenant only through the OpenKey approval callback, which binds them to the requesting account and the stored request. Approval callbacks must carry the SIWE, signature, address and chain ID. Access tokens are refused unless every owner DID claim is exactly `did:pkh:eip155:<chain>:0x<40 hex>`; owner DIDs are canonicalised before they are compared or shown.

- 9836159: A restarted `tinycloud-mcp-http` container (PID 1, same host boot, state volume kept) recovers the profile turn and `.lock` its crashed predecessor held (`.lock` once 30 s old) instead of waiting forever; a live MCP sharing the volume from another container is still waited for. After a host or VM reboot, a volume moved to another machine, a predecessor from an older release, or a container whose seccomp profile fails UNIX-socket connects, the wait remains: with no MCP or `tc` process using the profile, remove `$TC_MCP_STATE_DIR/tenants/<tenant>/.tinycloud/profile-locks/agent` and `$TC_MCP_STATE_DIR/tenants/<tenant>/.tinycloud/profiles/agent/.lock`.
- ad4a11f: Unify stored-grant replay across CLI, operations, and MCP. Refused replay candidates use fixed-code warnings; only a cross-user compact import with a verified signed audience, matching stored transport audience, and correct CID remains separate and silent.

  Breaking behavior for `@tinycloud/cli`:
  - Grants without a `siweProof` (including CLI <=1.1.0-beta.13 and 1.0.x escalations and non-compact imports without proof) are refused with `proof_missing`. Owners can approve again using `tc auth request --grant [--device]`; delegates can request, receive, and import a new signed grant or reimport the original artifact with its proof. Remove stale rows using `tc auth grants remove <old-cid>`; an owner may add `--revoke`.
  - Unbound compact grants no longer install before migration binds them (including a busy migration lock, `--private-key` on a local profile, or a session without `verificationMethod`); they report `unbound`. Run an ordinary command, sign in again, or reimport the artifact to recover.
  - Compact grants with invalid signatures or CIDs are refused locally with `proof_invalid` or `cid_mismatch`; damaged transport audiences are refused rather than silently classified as cross-user. A single `Bearer` prefix is stripped before activation so verified grants authorize reads; a double prefix is refused.
  - `tc auth import` refuses every proofless non-compact delegation (`INVALID_AUTH_IMPORT`, exit 2), including cross-user artifacts; none is stored or recorded in grant history. A compact or signed-login delegation failing verification returns `DELEGATION_REJECTED` (exit 1). A tampered transport audience cannot turn a session grant into a silent cross-user import. Valid session-targeted imports bind to `unbound-import:<cid>`.
  - Commands that replay may now emit a `{warnings}` stderr line or include `error.warnings`; `TC_DEBUG_REPLAY` is removed. `--private-key` on an OpenKey profile no longer replays stored grants.
  - Owner OpenKey `tc delegation revoke` no longer requests raw `urn:cid` authority (unsupported by deployed OpenKey). It uses a CID-bound owner-space fallback, or fails immediately with `RAW_RECAP_RESOURCE_UNSUPPORTED` instead of timing out.

  `@tinycloud/sdk-core` now exposes the verified signed `payload.aud` from `parseSignedCompactUcanAttenuation` and rejects compact tokens without an audience. The audience is read during the existing signature verification, so replay does not decode an unsigned payload separately.

  Breaking behavior for `@tinycloud/operations`:
  - `replayLimit(entry)` no longer takes `migrated` or returns `"signed"`; `replayStoredDelegation` options no longer take `migrated`; `activateUnboundCompactImport` becomes `activateUnboundImport` and accepts signed-login records. New APIs: `replayProfileDelegations`, `inspectStoredDelegation`, `storedDelegationForAnotherKey`, `verifiedCompactAudience`, `storedDelegationSource`, and `withoutBearer`.
  - Unbound compact grants are refused before migration; `createInvocationRuntime` replays only for a restored persisted session. `liveAdditionalDelegationCount` in `tinycloud.status.get` and `tinycloud.auth.status` counts only bound, unexpired grants. Invalid compact proofs report `proof_invalid`. `generated/operations.json` changes accordingly.

  `@tinycloud/mcp` receives the shared replay and status behavior through its `@tinycloud/operations` dependency; no MCP-generated schema changes in this release.

- Updated dependencies [33efc8c]
- Updated dependencies [33efc8c]
- Updated dependencies [26f86bd]
- Updated dependencies [9836159]
- Updated dependencies [ad4a11f]
- Updated dependencies [6a7fa64]
- Updated dependencies [4756923]
- Updated dependencies [4f851e6]
- Updated dependencies [4f851e6]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [47eb547]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0
  - @tinycloud/operations@0.5.0

## 0.5.0-beta.10

### Patch Changes

- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0-beta.9
  - @tinycloud/operations@0.5.0-beta.10

## 0.5.0-beta.9

### Patch Changes

- Updated dependencies [4756923]
  - @tinycloud/node-sdk@3.2.0-beta.8
  - @tinycloud/operations@0.5.0-beta.9

## 0.5.0-beta.8

### Patch Changes

- Updated dependencies [26f86bd]
  - @tinycloud/node-sdk@3.2.0-beta.7
  - @tinycloud/operations@0.5.0-beta.8

## 0.5.0-beta.7

### Patch Changes

- 33efc8c: The hosted MCP connect flow now completes. `tinycloud_connect` accepts a correctly signed OpenKey bootstrap: its account access is checked with the SDK subset check, which considers every signed action together instead of requiring one grant to carry them all. An approved operation delegation is imported as a full `tinycloud.auth.delegation` v1 artifact, and OpenKey's signed-login (CACAO) delegation is verified from its SIWE and accepted, so the retried tool call uses it.

  Hosted mode no longer exposes `tinycloud_auth_import`: delegations reach a hosted tenant only through the OpenKey approval callback, which binds them to the requesting account and the stored request. Approval callbacks must carry the SIWE, signature, address and chain ID. Access tokens are refused unless every owner DID claim is exactly `did:pkh:eip155:<chain>:0x<40 hex>`; owner DIDs are canonicalised before they are compared or shown.

- Updated dependencies [33efc8c]
- Updated dependencies [33efc8c]
  - @tinycloud/node-sdk@3.2.0-beta.6
  - @tinycloud/operations@0.5.0-beta.7

## 0.5.0-beta.6

### Patch Changes

- 9836159: A restarted `tinycloud-mcp-http` container (PID 1, same host boot, state volume kept) recovers the profile turn and `.lock` its crashed predecessor held (`.lock` once 30 s old) instead of waiting forever; a live MCP sharing the volume from another container is still waited for. After a host or VM reboot, a volume moved to another machine, a predecessor from an older release, or a container whose seccomp profile fails UNIX-socket connects, the wait remains: with no MCP or `tc` process using the profile, remove `$TC_MCP_STATE_DIR/tenants/<tenant>/.tinycloud/profile-locks/agent` and `$TC_MCP_STATE_DIR/tenants/<tenant>/.tinycloud/profiles/agent/.lock`.
- Updated dependencies [9836159]
  - @tinycloud/operations@0.5.0-beta.6

## 0.5.0-beta.5

### Patch Changes

- Updated dependencies [47eb547]
  - @tinycloud/node-sdk@3.2.0-beta.5
  - @tinycloud/operations@0.5.0-beta.5

## 0.5.0-beta.4

### Patch Changes

- @tinycloud/node-sdk@3.2.0-beta.4
- @tinycloud/operations@0.5.0-beta.4

## 0.5.0-beta.3

### Patch Changes

- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
  - @tinycloud/node-sdk@3.2.0-beta.3
  - @tinycloud/operations@0.5.0-beta.3

## 0.5.0-beta.2

### Minor Changes

- 4f851e6: Add `tinycloud_secrets_status` (`tinycloud.secrets.status@1`) for local/stdio MCP only; the hosted server does not register it. It is read-only (`readOnlyHint`, `idempotentHint`, `openWorldHint`) and never signs in: it uses the profile's stored session and reports each named secret as `ready`, `pending`, or `consent_required` without saving a permission request.

  Missing-secret `setup` is now the canonical Secret Manager `/request` link (`{url, names, scope?, owner, action: "add_secret"}`) instead of the old setup link. A `complete_migration` recovery in `error.details.recovery` now carries `tool: "tinycloud_auth_capabilities"`, taken from the binding table.

  Tool bindings gain an optional `surfaces` field (`"local"` / `"hosted"`, default both), and `McpStartupSelection` gains a required `surface`; `registerTinyCloudTools` skips bindings not on that surface. Generated `mcp-facts.json` lists each tool's surfaces.

  **Breaks:** direct callers of `registerTinyCloudTools` must pass `surface`; clients that parsed the old setup link shape; the local server now lists 17 tools.

### Patch Changes

- Updated dependencies [4f851e6]
- Updated dependencies [4f851e6]
  - @tinycloud/operations@0.5.0-beta.2
  - @tinycloud/node-sdk@3.2.0-beta.2

## 0.4.1-beta.1

### Patch Changes

- Updated dependencies [6a7fa64]
  - @tinycloud/node-sdk@3.2.0-beta.1
  - @tinycloud/operations@0.5.0-beta.1

## 0.4.1-beta.0

### Patch Changes

- ad4a11f: Unify stored-grant replay across CLI, operations, and MCP. Refused replay candidates use fixed-code warnings; only a cross-user compact import with a verified signed audience, matching stored transport audience, and correct CID remains separate and silent.

  Breaking behavior for `@tinycloud/cli`:
  - Grants without a `siweProof` (including CLI <=1.1.0-beta.13 and 1.0.x escalations and non-compact imports without proof) are refused with `proof_missing`. Owners can approve again using `tc auth request --grant [--device]`; delegates can request, receive, and import a new signed grant or reimport the original artifact with its proof. Remove stale rows using `tc auth grants remove <old-cid>`; an owner may add `--revoke`.
  - Unbound compact grants no longer install before migration binds them (including a busy migration lock, `--private-key` on a local profile, or a session without `verificationMethod`); they report `unbound`. Run an ordinary command, sign in again, or reimport the artifact to recover.
  - Compact grants with invalid signatures or CIDs are refused locally with `proof_invalid` or `cid_mismatch`; damaged transport audiences are refused rather than silently classified as cross-user. A single `Bearer` prefix is stripped before activation so verified grants authorize reads; a double prefix is refused.
  - `tc auth import` refuses every proofless non-compact delegation (`INVALID_AUTH_IMPORT`, exit 2), including cross-user artifacts; none is stored or recorded in grant history. A compact or signed-login delegation failing verification returns `DELEGATION_REJECTED` (exit 1). A tampered transport audience cannot turn a session grant into a silent cross-user import. Valid session-targeted imports bind to `unbound-import:<cid>`.
  - Commands that replay may now emit a `{warnings}` stderr line or include `error.warnings`; `TC_DEBUG_REPLAY` is removed. `--private-key` on an OpenKey profile no longer replays stored grants.
  - Owner OpenKey `tc delegation revoke` no longer requests raw `urn:cid` authority (unsupported by deployed OpenKey). It uses a CID-bound owner-space fallback, or fails immediately with `RAW_RECAP_RESOURCE_UNSUPPORTED` instead of timing out.

  `@tinycloud/sdk-core` now exposes the verified signed `payload.aud` from `parseSignedCompactUcanAttenuation` and rejects compact tokens without an audience. The audience is read during the existing signature verification, so replay does not decode an unsigned payload separately.

  Breaking behavior for `@tinycloud/operations`:
  - `replayLimit(entry)` no longer takes `migrated` or returns `"signed"`; `replayStoredDelegation` options no longer take `migrated`; `activateUnboundCompactImport` becomes `activateUnboundImport` and accepts signed-login records. New APIs: `replayProfileDelegations`, `inspectStoredDelegation`, `storedDelegationForAnotherKey`, `verifiedCompactAudience`, `storedDelegationSource`, and `withoutBearer`.
  - Unbound compact grants are refused before migration; `createInvocationRuntime` replays only for a restored persisted session. `liveAdditionalDelegationCount` in `tinycloud.status.get` and `tinycloud.auth.status` counts only bound, unexpired grants. Invalid compact proofs report `proof_invalid`. `generated/operations.json` changes accordingly.

  `@tinycloud/mcp` receives the shared replay and status behavior through its `@tinycloud/operations` dependency; no MCP-generated schema changes in this release.

- Updated dependencies [ad4a11f]
  - @tinycloud/operations@0.5.0-beta.0
  - @tinycloud/node-sdk@3.2.0-beta.0

## 0.4.0

### Minor Changes

- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

- 045c2d3: Classify KV and SQL HTTP authorization refusals in operation and MCP structured results. A plain 401 is nonretryable `AUTH_REQUIRED`; 403 or a 401 naming a validated missing capability is nonretryable `PERMISSION_DENIED`, so an agent does not retry signing in when a capability grant is needed. Keep 5xx node failures retryable except uncertain SQL writes, and never expose node response text or transport metadata in canonical results.

### Patch Changes

- b7fd979: The README describes how imported delegations are bound to their requests, how delegations stored by earlier releases are migrated once, and what a record without a binding does.
- Updated dependencies [02b6773]
- Updated dependencies [37123c3]
- Updated dependencies [f25aa05]
- Updated dependencies [0652195]
- Updated dependencies [b7fd979]
- Updated dependencies [b7fd979]
- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
- Updated dependencies [a074fa5]
- Updated dependencies [e2ec154]
- Updated dependencies [7edc599]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [c923361]
- Updated dependencies [698654e]
- Updated dependencies [2c703fc]
- Updated dependencies [1f44a61]
  - @tinycloud/node-sdk@3.1.0
  - @tinycloud/operations@0.4.0
  - @tinycloud/node-sdk-wasm@1.7.7

## 0.4.0-beta.19

### Patch Changes

- Updated dependencies [1f44a61]
  - @tinycloud/node-sdk@3.1.0-beta.15
  - @tinycloud/operations@0.4.0-beta.19

## 0.4.0-beta.18

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.14
- @tinycloud/operations@0.4.0-beta.18

## 0.4.0-beta.17

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.13
- @tinycloud/operations@0.4.0-beta.17

## 0.4.0-beta.16

### Patch Changes

- Updated dependencies [2c703fc]
  - @tinycloud/node-sdk@3.1.0-beta.12
  - @tinycloud/operations@0.4.0-beta.16

## 0.4.0-beta.15

### Patch Changes

- Updated dependencies [02b6773]
  - @tinycloud/node-sdk@3.1.0-beta.11
  - @tinycloud/operations@0.4.0-beta.15

## 0.4.0-beta.14

### Patch Changes

- Updated dependencies [37123c3]
  - @tinycloud/operations@0.4.0-beta.14
  - @tinycloud/node-sdk@3.1.0-beta.10

## 0.4.0-beta.13

### Patch Changes

- Updated dependencies [698654e]
  - @tinycloud/node-sdk@3.1.0-beta.9
  - @tinycloud/operations@0.4.0-beta.13

## 0.4.0-beta.12

### Patch Changes

- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
  - @tinycloud/node-sdk@3.1.0-beta.8
  - @tinycloud/operations@0.4.0-beta.12
  - @tinycloud/node-sdk-wasm@1.7.7-beta.0

## 0.4.0-beta.11

### Minor Changes

- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

### Patch Changes

- Updated dependencies [e2ec154]
  - @tinycloud/operations@0.4.0-beta.11

## 0.4.0-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.7
- @tinycloud/operations@0.4.0-beta.10

## 0.4.0-beta.9

### Minor Changes

- 045c2d3: Classify KV and SQL HTTP authorization refusals in operation and MCP structured results. A plain 401 is nonretryable `AUTH_REQUIRED`; 403 or a 401 naming a validated missing capability is nonretryable `PERMISSION_DENIED`, so an agent does not retry signing in when a capability grant is needed. Keep 5xx node failures retryable except uncertain SQL writes, and never expose node response text or transport metadata in canonical results.

### Patch Changes

- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
  - @tinycloud/operations@0.4.0-beta.9
  - @tinycloud/node-sdk@3.1.0-beta.6

## 0.3.4-beta.8

### Patch Changes

- Updated dependencies [7edc599]
  - @tinycloud/operations@0.4.0-beta.8

## 0.3.4-beta.7

### Patch Changes

- b7fd979: The README describes how imported delegations are bound to their requests, how delegations stored by earlier releases are migrated once, and what a record without a binding does.
- Updated dependencies [b7fd979]
- Updated dependencies [b7fd979]
  - @tinycloud/node-sdk@3.1.0-beta.5
  - @tinycloud/operations@0.4.0-beta.7

## 0.3.4-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.4
- @tinycloud/operations@0.3.4-beta.6

## 0.3.4-beta.5

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.3
- @tinycloud/operations@0.3.4-beta.5

## 0.3.4-beta.4

### Patch Changes

- Updated dependencies [c923361]
  - @tinycloud/operations@0.3.4-beta.4

## 0.3.4-beta.3

### Patch Changes

- Updated dependencies [a074fa5]
  - @tinycloud/node-sdk@3.1.0-beta.2
  - @tinycloud/operations@0.3.4-beta.3

## 0.3.4-beta.2

### Patch Changes

- Updated dependencies [0652195]
  - @tinycloud/node-sdk@3.1.0-beta.1
  - @tinycloud/operations@0.3.4-beta.2

## 0.3.4-beta.1

### Patch Changes

- Updated dependencies [f25aa05]
  - @tinycloud/operations@0.3.4-beta.1

## 0.3.4-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.1-beta.0
- @tinycloud/operations@0.3.4-beta.0

## 0.3.3

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- 7340498: The hosted MCP now stores an approved operation delegation only when the wallet that signed it is the OpenKey account whose MCP request created the approval link, the same check `tinycloud_connect` already applied. A delegation signed by any other account is refused before anything is written, and `/connect/callback` answers `403` with code `approval_owner_mismatch` and a fixed message. The OpenKey approval page now shows which TinyCloud account requested the approval.
- Updated dependencies [46c83a7]
- Updated dependencies [036ce34]
- Updated dependencies [c690844]
- Updated dependencies [31043b5]
- Updated dependencies [b852650]
- Updated dependencies [70e6c95]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [48eca36]
- Updated dependencies [48eca36]
- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0
  - @tinycloud/operations@0.3.3

## 0.3.3-beta.19

### Patch Changes

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20
  - @tinycloud/operations@0.3.3-beta.18

## 0.3.3-beta.18

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/node-sdk@3.0.0-beta.19
  - @tinycloud/operations@0.3.3-beta.17

## 0.3.3-beta.17

### Patch Changes

- 7340498: The hosted MCP now stores an approved operation delegation only when the wallet that signed it is the OpenKey account whose MCP request created the approval link, the same check `tinycloud_connect` already applied. A delegation signed by any other account is refused before anything is written, and `/connect/callback` answers `403` with code `approval_owner_mismatch` and a fixed message. The OpenKey approval page now shows which TinyCloud account requested the approval.

## 0.3.3-beta.16

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.18
- @tinycloud/operations@0.3.3-beta.16

## 0.3.3-beta.15

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.17
- @tinycloud/operations@0.3.3-beta.15

## 0.3.3-beta.14

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- Updated dependencies [48eca36]
- Updated dependencies [48eca36]
  - @tinycloud/operations@0.3.3-beta.14
  - @tinycloud/node-sdk@3.0.0-beta.16

## 0.3.3-beta.13

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.15
- @tinycloud/operations@0.3.3-beta.13

## 0.3.3-beta.12

### Patch Changes

- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14
  - @tinycloud/operations@0.3.3-beta.12

## 0.3.3-beta.11

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/node-sdk@3.0.0-beta.13
  - @tinycloud/operations@0.3.3-beta.11

## 0.3.3-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.12
- @tinycloud/operations@0.3.3-beta.10

## 0.3.3-beta.9

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.11
- @tinycloud/operations@0.3.3-beta.9

## 0.3.3-beta.8

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/node-sdk@3.0.0-beta.10
  - @tinycloud/operations@0.3.3-beta.8

## 0.3.3-beta.7

### Patch Changes

- Updated dependencies [c690844]
  - @tinycloud/node-sdk@3.0.0-beta.9
  - @tinycloud/operations@0.3.3-beta.7

## 0.3.3-beta.6

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/node-sdk@3.0.0-beta.8
  - @tinycloud/operations@0.3.3-beta.6

## 0.3.3-beta.5

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.7
- @tinycloud/operations@0.3.3-beta.5

## 0.3.3-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/node-sdk@3.0.0-beta.6
  - @tinycloud/operations@0.3.3-beta.4

## 0.3.3-beta.3

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.5
- @tinycloud/operations@0.3.3-beta.3

## 0.3.3-beta.2

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.2
- @tinycloud/operations@0.3.3-beta.2

## 0.3.3-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.1
- @tinycloud/operations@0.3.3-beta.1

## 0.3.3-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.0
- @tinycloud/operations@0.3.3-beta.0

## 0.3.2

### Patch Changes

- Updated dependencies [746cb02]
- Updated dependencies [d1d675b]
- Updated dependencies [44ecf56]
- Updated dependencies [b38dd12]
- Updated dependencies [68faad4]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0
  - @tinycloud/operations@0.3.2
  - @tinycloud/node-sdk-wasm@1.7.6

## 0.3.2-beta.10

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0-beta.12
  - @tinycloud/operations@0.3.2-beta.11

## 0.3.2-beta.9

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/node-sdk@2.11.0-beta.11
  - @tinycloud/operations@0.3.2-beta.10

## 0.3.2-beta.8

### Patch Changes

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/node-sdk@2.11.0-beta.10
  - @tinycloud/operations@0.3.2-beta.9

## 0.3.2-beta.7

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.9
- @tinycloud/operations@0.3.2-beta.8

## 0.3.2-beta.6

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/node-sdk-wasm@1.7.6-beta.0
  - @tinycloud/node-sdk@2.11.0-beta.8
  - @tinycloud/operations@0.3.2-beta.7

## 0.3.2-beta.5

### Patch Changes

- Updated dependencies [44ecf56]
  - @tinycloud/node-sdk@2.11.0-beta.7
  - @tinycloud/operations@0.3.2-beta.6

## 0.3.2-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/node-sdk@2.11.0-beta.5
  - @tinycloud/operations@0.3.2-beta.4

## 0.3.2-beta.3

### Patch Changes

- Updated dependencies [746cb02]
  - @tinycloud/node-sdk@2.11.0-beta.4
  - @tinycloud/operations@0.3.2-beta.3

## 0.3.2-beta.2

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.3
- @tinycloud/operations@0.3.2-beta.2

## 0.3.2-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/node-sdk@2.11.0-beta.1
  - @tinycloud/operations@0.3.2-beta.1

## 0.3.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.0
- @tinycloud/operations@0.3.2-beta.0

## 0.3.1

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0
  - @tinycloud/operations@0.3.1

## 0.3.1-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.10.0-beta.1
- @tinycloud/operations@0.3.1-beta.1

## 0.3.1-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0
  - @tinycloud/operations@0.3.1-beta.0

## 0.3.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0

## 0.3.0-beta.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0-beta.0

## 0.2.2

### Patch Changes

- @tinycloud/operations@0.2.1

## 0.2.1

### Patch Changes

- a2adb87: Publish the stable 16-tool MCP setup, delegated workflow, KV CRUD, and SQLite
  surface in the npm README and package discovery metadata.

## 0.2.1-beta.0

### Patch Changes

- a2adb87: Publish the stable 16-tool MCP setup, delegated workflow, KV CRUD, and SQLite
  surface in the npm README and package discovery metadata.

## 0.2.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0

## 0.2.0-beta.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0-beta.0

## 0.1.0

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- Updated dependencies [492a656]
- Updated dependencies [1269a58]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [abe8083]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
  - @tinycloud/operations@0.1.0

## 0.1.0-beta.2

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- Updated dependencies [1269a58]
  - @tinycloud/operations@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- Updated dependencies [492a656]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [abe8083]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
  - @tinycloud/operations@0.1.0-beta.1

# @tinycloud/operations

## 0.7.7-beta.6

### Patch Changes

- Updated dependencies [44c439a]
  - @tinycloud/sdk-core@3.8.0-beta.5
  - @tinycloud/node-sdk@3.8.0-beta.5

## 0.7.7-beta.5

### Patch Changes

- Updated dependencies [c541786]
  - @tinycloud/sdk-core@3.8.0-beta.4
  - @tinycloud/node-sdk@3.8.0-beta.4

## 0.7.7-beta.4

### Patch Changes

- 1fc87b6: Fix personal-app MCP guidance and generated write schemas for server-owned `by` metadata. Write examples omit `by`, and edit/move instructions tell clients to remove it from read-back values before submitting them. Advertised put/move schemas now reject top-level `by` before invocation, matching the existing runtime restriction. CLI records, nested data fields and stored/read-back attribution remain unchanged.

## 0.7.7-beta.3

### Patch Changes

- @tinycloud/sdk-core@3.8.0-beta.3
- @tinycloud/node-sdk@3.8.0-beta.3

## 0.7.7-beta.2

### Patch Changes

- Updated dependencies [4a19c47]
  - @tinycloud/sdk-services@3.8.0-beta.2
  - @tinycloud/sdk-core@3.8.0-beta.2
  - @tinycloud/node-sdk@3.8.0-beta.2

## 0.7.7-beta.1

### Patch Changes

- Updated dependencies [2789240]
  - @tinycloud/sdk-services@3.8.0-beta.1
  - @tinycloud/sdk-core@3.8.0-beta.1
  - @tinycloud/node-sdk@3.8.0-beta.1

## 0.7.7-beta.0

### Patch Changes

- Updated dependencies [15080ed]
  - @tinycloud/node-sdk@3.8.0-beta.0

## 0.7.6

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
- Updated dependencies [279c8e9]
- Updated dependencies [71fa087]
- Updated dependencies [147bb78]
  - @tinycloud/sdk-services@3.7.0
  - @tinycloud/node-sdk@3.7.0
  - @tinycloud/sdk-core@3.7.0

## 0.7.6-beta.4

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
  - @tinycloud/sdk-services@3.7.0-beta.4
  - @tinycloud/node-sdk@3.7.0-beta.4
  - @tinycloud/sdk-core@3.7.0-beta.4

## 0.7.6-beta.3

### Patch Changes

- Updated dependencies [279c8e9]
  - @tinycloud/node-sdk@3.7.0-beta.3
  - @tinycloud/sdk-services@3.7.0-beta.3
  - @tinycloud/sdk-core@3.7.0-beta.3

## 0.7.6-beta.2

### Patch Changes

- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0-beta.2
  - @tinycloud/sdk-services@3.7.0-beta.2
  - @tinycloud/sdk-core@3.7.0-beta.2

## 0.7.6-beta.1

### Patch Changes

- Updated dependencies [71fa087]
  - @tinycloud/node-sdk@3.7.0-beta.1
  - @tinycloud/sdk-core@3.7.0-beta.1

## 0.7.6-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.6.2-beta.0

## 0.7.5

### Patch Changes

- Updated dependencies [271155a]
- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1
  - @tinycloud/sdk-core@3.6.1
  - @tinycloud/sdk-services@3.6.1

## 0.7.5-beta.1

### Patch Changes

- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1-beta.1

## 0.7.5-beta.0

### Patch Changes

- Updated dependencies [271155a]
  - @tinycloud/node-sdk@3.6.1-beta.0

## 0.7.4

### Patch Changes

- e18946e: Add the separate `/chatgpt/mcp` public personal-record endpoint with exactly connect, context, read, write and query tools. Public OAuth audiences, tenant state, approvals and recovery suggestions are isolated from the existing broad `/mcp` service; excluded tools cannot be invoked by name. Preserve local/private integrations and return an inert browser recovery page for invalid approval links.

  Correct context/query mutation annotations and operation effects, ask for an IANA timezone rather than location, and preserve the hosted 100,000-character context and derived-query output limit without truncating canonical write outcomes. Add reproducible MCP-only plugin packaging and explicit reviewer/publication gates.

  Advertise equivalent JSON Schema 2020-12 tool inputs and results on stdio and both hosted surfaces so the official v2 client works with its default validator. Preserve the shared Draft-07 operations catalog for non-MCP consumers; reject unsupported dialect-specific forms rather than silently changing their validation.

  Deploy the matching OpenKey API audience and exact web callback registrations before candidate acceptance. The package is not a published plugin: actual ChatGPT web/mobile tests, independent reviewer access, approved policies, recording and portal review remain required. Default-branch integration and deployment require explicit owner approval.

- 82cbd43: A 413 from the SQL or DuckDB node is classified by side. A request rejected for size returns `SQL_REQUEST_TOO_LARGE` or `DUCKDB_REQUEST_TOO_LARGE`. A response that is too large keeps `SQL_RESPONSE_TOO_LARGE` or `DUCKDB_RESPONSE_TOO_LARGE`.

  Details: TC-1823

- Updated dependencies [e600a1a]
- Updated dependencies [0c09d7b]
- Updated dependencies [82cbd43]
- Updated dependencies [dc61583]
- Updated dependencies [1f831e3]
- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
- Updated dependencies [e32bc41]
- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0
  - @tinycloud/sdk-core@3.6.0
  - @tinycloud/sdk-services@3.6.0

## 0.7.4-beta.8

### Patch Changes

- Updated dependencies [1f831e3]
  - @tinycloud/sdk-core@3.6.0-beta.8
  - @tinycloud/node-sdk@3.6.0-beta.8

## 0.7.4-beta.7

### Patch Changes

- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
  - @tinycloud/node-sdk@3.6.0-beta.7

## 0.7.4-beta.6

### Patch Changes

- Updated dependencies [e600a1a]
  - @tinycloud/node-sdk@3.6.0-beta.6

## 0.7.4-beta.5

### Patch Changes

- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0-beta.5

## 0.7.4-beta.4

### Patch Changes

- Updated dependencies [e32bc41]
  - @tinycloud/sdk-core@3.6.0-beta.4
  - @tinycloud/node-sdk@3.6.0-beta.4

## 0.7.4-beta.3

### Patch Changes

- 82cbd43: A 413 from the SQL or DuckDB node is classified by side. A request rejected for size returns `SQL_REQUEST_TOO_LARGE` or `DUCKDB_REQUEST_TOO_LARGE`. A response that is too large keeps `SQL_RESPONSE_TOO_LARGE` or `DUCKDB_RESPONSE_TOO_LARGE`.

  Details: TC-1823

- Updated dependencies [82cbd43]
  - @tinycloud/sdk-services@3.6.0-beta.3
  - @tinycloud/node-sdk@3.6.0-beta.3
  - @tinycloud/sdk-core@3.6.0-beta.3

## 0.7.4-beta.2

### Patch Changes

- e18946e: Add the separate `/chatgpt/mcp` public personal-record endpoint with exactly connect, context, read, write and query tools. Public OAuth audiences, tenant state, approvals and recovery suggestions are isolated from the existing broad `/mcp` service; excluded tools cannot be invoked by name. Preserve local/private integrations and return an inert browser recovery page for invalid approval links.

  Correct context/query mutation annotations and operation effects, ask for an IANA timezone rather than location, and preserve the hosted 100,000-character context and derived-query output limit without truncating canonical write outcomes. Add reproducible MCP-only plugin packaging and explicit reviewer/publication gates.

  Advertise equivalent JSON Schema 2020-12 tool inputs and results on stdio and both hosted surfaces so the official v2 client works with its default validator. Preserve the shared Draft-07 operations catalog for non-MCP consumers; reject unsupported dialect-specific forms rather than silently changing their validation.

  Deploy the matching OpenKey API audience and exact web callback registrations before candidate acceptance. The package is not a published plugin: actual ChatGPT web/mobile tests, independent reviewer access, approved policies, recording and portal review remain required. Default-branch integration and deployment require explicit owner approval.

## 0.7.4-beta.1

### Patch Changes

- Updated dependencies [dc61583]
  - @tinycloud/sdk-services@3.6.0-beta.2
  - @tinycloud/node-sdk@3.6.0-beta.2
  - @tinycloud/sdk-core@3.6.0-beta.2

## 0.7.4-beta.0

### Patch Changes

- Updated dependencies [0c09d7b]
  - @tinycloud/sdk-core@3.6.0-beta.0
  - @tinycloud/node-sdk@3.6.0-beta.0

## 0.7.3

### Patch Changes

- Updated dependencies [d60f81d]
- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/sdk-services@3.5.0
  - @tinycloud/node-sdk@3.5.0
  - @tinycloud/sdk-core@3.5.0

## 0.7.3-beta.1

### Patch Changes

- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0-beta.1

## 0.7.3-beta.0

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/sdk-services@3.5.0-beta.0
  - @tinycloud/node-sdk@3.5.0-beta.0
  - @tinycloud/sdk-core@3.5.0-beta.0

## 0.7.2

### Patch Changes

- @tinycloud/node-sdk@3.4.0
- @tinycloud/sdk-core@3.4.0
- @tinycloud/sdk-services@3.3.2

## 0.7.2-beta.1

### Patch Changes

- @tinycloud/sdk-core@3.3.2-beta.1
- @tinycloud/node-sdk@3.3.2-beta.1

## 0.7.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.0

## 0.7.1

### Patch Changes

- @tinycloud/sdk-core@3.3.1
- @tinycloud/node-sdk@3.3.1
- @tinycloud/sdk-services@3.3.1

## 0.7.1-beta.0

### Patch Changes

- @tinycloud/sdk-core@3.3.1-beta.0
- @tinycloud/node-sdk@3.3.1-beta.0

## 0.7.0

### Minor Changes

- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. `--preset apps-agent --write --app <app_id>` is a separate opt-in for the named apps: KV put only in each app's `knowledge/` and `prefs/` folders (the folders the sample apps' manifests write to) plus SQL write, which adds, changes and deletes rows. Creating, changing and dropping tables also needs `tinycloud.sql/schema`, which the preset grants only on an app's catalog database (`xyz.tinycloud.sample.healthlog` gets `healthlog`, at the exact path `<app_id>/healthlog`). Everything else under `<app_id>/` stays read-only, so the app's code and its stored `<app_id>/app/manifest.json` and `<app_id>/app/install.json` cannot be changed through it (the root-level `<app_id>/manifest.json` and `<app_id>/install.json` are refused too) (TC-1620); it is refused without `--app`. Neither variant carries KV delete, SQL admin, schema on any other database, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

- 5373fa2: Preserve validated node revocation context for hosted approval renewal while keeping other authorization results unchanged.

  Details: TC-1627

### Patch Changes

- 6ad58de: Consolidated dependency update: bump `@modelcontextprotocol/{node,server,client}` to 2.0.0-beta.5, `zod-to-json-schema` to ^3.25.2, `@openkey/sdk` to 0.9.0 in the example apps, and refresh the tokio entry in Cargo.lock.
- f2cb165: `tc delegation revoke <cid>` now revokes an owner-signed grant (such as one from `tc auth grant`) from a profile that has no local record of it, for example another CLI profile or machine of the same owner. When the profile has no matching record, the CLI reads the owner's delegation records from the node and uses that record's space only if the grant was issued by the signed-in owner, directly or through a chain of delegations recorded on the node that ends at the owner or the signed-in session key, and every space it covers is one plain space id that belongs to that owner; a CID the node does not list, an issuer or space that does not match, or an ambiguous record keeps the existing `RAW_RECAP_RESOURCE_UNSUPPORTED` refusal, now saying "this CLI profile has no record of this grant and the node's record does not match the signed-in owner". A locally recorded grant still resolves first and unchanged. An agent that presents a revoked grant now gets "This grant was revoked. Ask the owner for a new grant" instead of a bare authentication error: the CLI reports it as `GRANT_REVOKED` (exit 5, the same code and exit as `tc replica`), and operations (including `knowledge list|read` and the MCP tools) keep `AUTH_REQUIRED` with that message, only when the node's 401 says the delegation (or one it derives from) was revoked; any other 401 is unchanged.
- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

- baca422: Pin profile and replica directories before SQLite opens during reset and sync, and for local report reads and logout cleanup. Reject whole-profile aliases, symlinked replica roots, entries, database files and persisted report descendants, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files.

  `@tinycloud/operations` resolves user-owned symlinked TinyCloud home directories to a pinned real directory while refusing aliases inside a profile; profile JSON reads verify leaf identity. `@tinycloud/replica` creates SQLite database files exclusively for concurrent openers and checks their identity before migration; on macOS and Windows, replica removal checks each known file and directory before nonrecursive deletion and stops on a changed or unknown entry.

  Breaking change (beta feature): `tc replica report` now reads persisted events and identity partitions without starting a replication runtime. `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`. Use `tc replica reset --replica <name> --purge` only as a partial alternative for named local replicas. Flag-owned purge and pending clearing have no equivalent yet; TC-1309 tracks safe replacement commands.

- Updated dependencies [2aa917e]
- Updated dependencies [c92953f]
- Updated dependencies [b6d0b9f]
- Updated dependencies [d2ad845]
- Updated dependencies [6ad58de]
- Updated dependencies [29440be]
- Updated dependencies [9592d3d]
- Updated dependencies [4aae658]
- Updated dependencies [4ac7592]
- Updated dependencies [a553392]
- Updated dependencies [fc88c48]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [41e5fca]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [9891ed9]
- Updated dependencies [ac612c0]
- Updated dependencies [87a137e]
- Updated dependencies [ef9653b]
- Updated dependencies [370a8e4]
- Updated dependencies [ef49c14]
- Updated dependencies [90bc0ae]
- Updated dependencies [cce8b26]
- Updated dependencies [eb9defd]
- Updated dependencies [0c4c6b2]
- Updated dependencies [e99a127]
- Updated dependencies [f97d73d]
- Updated dependencies [18b6c9f]
- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0
  - @tinycloud/sdk-core@3.3.0
  - @tinycloud/sdk-services@3.3.0

## 0.7.0-beta.38

### Patch Changes

- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

- Updated dependencies [ef49c14]
  - @tinycloud/sdk-services@3.3.0-beta.39
  - @tinycloud/node-sdk@3.3.0-beta.39
  - @tinycloud/sdk-core@3.3.0-beta.39

## 0.7.0-beta.37

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.38
- @tinycloud/node-sdk@3.3.0-beta.38

## 0.7.0-beta.36

### Patch Changes

- Updated dependencies [4ac7592]
  - @tinycloud/sdk-core@3.3.0-beta.37
  - @tinycloud/node-sdk@3.3.0-beta.37

## 0.7.0-beta.35

### Minor Changes

- 5373fa2: Preserve validated node revocation context for hosted approval renewal while keeping other authorization results unchanged.

  Details: TC-1627

## 0.7.0-beta.34

### Patch Changes

- Updated dependencies [9592d3d]
  - @tinycloud/sdk-core@3.3.0-beta.36
  - @tinycloud/node-sdk@3.3.0-beta.36

## 0.7.0-beta.33

### Patch Changes

- f2cb165: `tc delegation revoke <cid>` now revokes an owner-signed grant (such as one from `tc auth grant`) from a profile that has no local record of it, for example another CLI profile or machine of the same owner. When the profile has no matching record, the CLI reads the owner's delegation records from the node and uses that record's space only if the grant was issued by the signed-in owner, directly or through a chain of delegations recorded on the node that ends at the owner or the signed-in session key, and every space it covers is one plain space id that belongs to that owner; a CID the node does not list, an issuer or space that does not match, or an ambiguous record keeps the existing `RAW_RECAP_RESOURCE_UNSUPPORTED` refusal, now saying "this CLI profile has no record of this grant and the node's record does not match the signed-in owner". A locally recorded grant still resolves first and unchanged. An agent that presents a revoked grant now gets "This grant was revoked. Ask the owner for a new grant" instead of a bare authentication error: the CLI reports it as `GRANT_REVOKED` (exit 5, the same code and exit as `tc replica`), and operations (including `knowledge list|read` and the MCP tools) keep `AUTH_REQUIRED` with that message, only when the node's 401 says the delegation (or one it derives from) was revoked; any other 401 is unchanged.

## 0.7.0-beta.32

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.35

## 0.7.0-beta.31

### Minor Changes

- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. Don't request `--write` during the tiny-apps beta. It currently also allows changes to the app's own code and manifest; the narrowed write ships in TC-1620. (The flag adds KV put and SQL write for the named apps and is refused without `--app`.) Because of how TinyCloud permissions work today, SQL write also lets the agent create, change or drop those apps' tables, and the scope text says so; TC-1581 (node-side: `sql/write` must not permit DDL) is the real cure. Neither variant carries KV delete, SQL admin or schema, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

### Patch Changes

- Updated dependencies [a553392]
  - @tinycloud/node-sdk@3.3.0-beta.34

## 0.6.1-beta.30

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.33

## 0.6.1-beta.29

### Patch Changes

- 6ad58de: Consolidated dependency update: bump `@modelcontextprotocol/{node,server,client}` to 2.0.0-beta.5, `zod-to-json-schema` to ^3.25.2, `@openkey/sdk` to 0.9.0 in the example apps, and refresh the tokio entry in Cargo.lock.
- Updated dependencies [6ad58de]
  - @tinycloud/sdk-core@3.3.0-beta.31
  - @tinycloud/node-sdk@3.3.0-beta.31

## 0.6.1-beta.28

### Patch Changes

- Updated dependencies [fc88c48]
  - @tinycloud/sdk-core@3.3.0-beta.30
  - @tinycloud/node-sdk@3.3.0-beta.30

## 0.6.1-beta.27

### Patch Changes

- Updated dependencies [e99a127]
  - @tinycloud/node-sdk@3.3.0-beta.29

## 0.6.1-beta.26

### Patch Changes

- Updated dependencies [ac612c0]
  - @tinycloud/sdk-core@3.3.0-beta.28
  - @tinycloud/node-sdk@3.3.0-beta.28

## 0.6.1-beta.25

### Patch Changes

- Updated dependencies [4aae658]
  - @tinycloud/sdk-core@3.3.0-beta.27
  - @tinycloud/node-sdk@3.3.0-beta.27

## 0.6.1-beta.24

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.26

## 0.6.1-beta.23

### Patch Changes

- Updated dependencies [87a137e]
  - @tinycloud/node-sdk@3.3.0-beta.25
  - @tinycloud/sdk-services@3.3.0-beta.25
  - @tinycloud/sdk-core@3.3.0-beta.25

## 0.6.1-beta.22

### Patch Changes

- Updated dependencies [b6d0b9f]
  - @tinycloud/node-sdk@3.3.0-beta.24

## 0.6.1-beta.21

### Patch Changes

- Updated dependencies [d2ad845]
  - @tinycloud/sdk-core@3.3.0-beta.23
  - @tinycloud/node-sdk@3.3.0-beta.23

## 0.6.1-beta.20

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.22
- @tinycloud/node-sdk@3.3.0-beta.22

## 0.6.1-beta.19

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.21
- @tinycloud/node-sdk@3.3.0-beta.21

## 0.6.1-beta.18

### Patch Changes

- Updated dependencies [cce8b26]
  - @tinycloud/sdk-core@3.3.0-beta.20
  - @tinycloud/node-sdk@3.3.0-beta.20

## 0.6.1-beta.17

### Patch Changes

- Updated dependencies [eb9defd]
  - @tinycloud/sdk-core@3.3.0-beta.18
  - @tinycloud/node-sdk@3.3.0-beta.18

## 0.6.1-beta.16

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.17
- @tinycloud/node-sdk@3.3.0-beta.17

## 0.6.1-beta.15

### Patch Changes

- Updated dependencies [18b6c9f]
  - @tinycloud/node-sdk@3.3.0-beta.16

## 0.6.1-beta.14

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.15
- @tinycloud/node-sdk@3.3.0-beta.15

## 0.6.1-beta.13

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.14
- @tinycloud/node-sdk@3.3.0-beta.14

## 0.6.1-beta.12

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.13
- @tinycloud/node-sdk@3.3.0-beta.13

## 0.6.1-beta.11

### Patch Changes

- Updated dependencies [2292db7]
  - @tinycloud/sdk-services@3.3.0-beta.11
  - @tinycloud/node-sdk@3.3.0-beta.11
  - @tinycloud/sdk-core@3.3.0-beta.11

## 0.6.1-beta.10

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.10
- @tinycloud/node-sdk@3.3.0-beta.10

## 0.6.1-beta.9

### Patch Changes

- Updated dependencies [ef9653b]
  - @tinycloud/node-sdk@3.3.0-beta.9

## 0.6.1-beta.8

### Patch Changes

- Updated dependencies [f97d73d]
  - @tinycloud/sdk-core@3.3.0-beta.8
  - @tinycloud/node-sdk@3.3.0-beta.8

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
- Updated dependencies [94566db]
- Updated dependencies [90bc0ae]
- Updated dependencies [0c4c6b2]
  - @tinycloud/node-sdk@3.3.0-beta.7
  - @tinycloud/sdk-core@3.3.0-beta.7
  - @tinycloud/sdk-services@3.3.0-beta.7

## 0.6.1-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.6

## 0.6.1-beta.5

### Patch Changes

- baca422: Pin profile and replica directories before SQLite opens during reset and sync, and for local report reads and logout cleanup. Reject whole-profile aliases, symlinked replica roots, entries, database files and persisted report descendants, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files.

  `@tinycloud/operations` resolves user-owned symlinked TinyCloud home directories to a pinned real directory while refusing aliases inside a profile; profile JSON reads verify leaf identity. `@tinycloud/replica` creates SQLite database files exclusively for concurrent openers and checks their identity before migration; on macOS and Windows, replica removal checks each known file and directory before nonrecursive deletion and stops on a changed or unknown entry.

  Breaking change (beta feature): `tc replica report` now reads persisted events and identity partitions without starting a replication runtime. `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`. Use `tc replica reset --replica <name> --purge` only as a partial alternative for named local replicas. Flag-owned purge and pending clearing have no equivalent yet; TC-1309 tracks safe replacement commands.
  - @tinycloud/node-sdk@3.2.6-beta.5

## 0.6.1-beta.4

### Patch Changes

- Updated dependencies [9891ed9]
  - @tinycloud/sdk-services@3.2.6-beta.4
  - @tinycloud/node-sdk@3.2.6-beta.4
  - @tinycloud/sdk-core@3.2.6-beta.4

## 0.6.1-beta.3

### Patch Changes

- Updated dependencies [41e5fca]
  - @tinycloud/node-sdk@3.2.6-beta.3

## 0.6.1-beta.2

### Patch Changes

- Updated dependencies [370a8e4]
  - @tinycloud/node-sdk@3.2.6-beta.2
  - @tinycloud/sdk-services@3.2.6-beta.2
  - @tinycloud/sdk-core@3.2.6-beta.2

## 0.6.1-beta.1

### Patch Changes

- Updated dependencies [c92953f]
  - @tinycloud/sdk-core@3.2.6-beta.1
  - @tinycloud/node-sdk@3.2.6-beta.1

## 0.6.1-beta.0

### Patch Changes

- Updated dependencies [2aa917e]
  - @tinycloud/node-sdk@3.2.6-beta.0

## 0.6.0

### Minor Changes

- 527c91b: Add hosted personal-record queries through the optional fast, searchable copy. Check stale markers and KV/copy counts, rebuild kinds in byte-bounded sequential chunks, and resume remaining kinds with COPY_PARTIAL. Sync completed record writes and move steps without hiding their outcomes; mark kinds stale when upkeep cannot finish. A quarantined database returns nonretryable copy_unavailable for node-team repair. Ship the full pinned tc-apps rules and final hosted-tool documentation.
- cfc9d1b: Add hosted personal-record context, batch reads and ordered conditional writes using the tc-apps catalog and CLI-compatible JSON bytes. Preserve ETags and partial move outcomes, enforce the default-space prefix, and generate guidance from a pinned published skill. Hosted results are readable in text-only MCP clients; secrets remain structured-only and large writes retain every outcome. Request 30-day grants with 15-minute approval links, recover expired sessions through OpenKey, and log only tool, outcome, duration and replayed-grant count.

### Patch Changes

- Updated dependencies [0b02662]
  - @tinycloud/sdk-services@3.2.5
  - @tinycloud/node-sdk@3.2.5
  - @tinycloud/sdk-core@3.2.5

## 0.6.0-beta.2

### Minor Changes

- 527c91b: Add hosted personal-record queries through the optional fast, searchable copy. Check stale markers and KV/copy counts, rebuild kinds in byte-bounded sequential chunks, and resume remaining kinds with COPY_PARTIAL. Sync completed record writes and move steps without hiding their outcomes; mark kinds stale when upkeep cannot finish. A quarantined database returns nonretryable copy_unavailable for node-team repair. Ship the full pinned tc-apps rules and final hosted-tool documentation.

## 0.6.0-beta.1

### Minor Changes

- cfc9d1b: Add hosted personal-record context, batch reads and ordered conditional writes using the tc-apps catalog and CLI-compatible JSON bytes. Preserve ETags and partial move outcomes, enforce the default-space prefix, and generate guidance from a pinned published skill. Hosted results are readable in text-only MCP clients; secrets remain structured-only and large writes retain every outcome. Request 30-day grants with 15-minute approval links, recover expired sessions through OpenKey, and log only tool, outcome, duration and replayed-grant count.

## 0.5.5-beta.0

### Patch Changes

- Updated dependencies [0b02662]
  - @tinycloud/sdk-services@3.2.5-beta.0
  - @tinycloud/node-sdk@3.2.5-beta.0
  - @tinycloud/sdk-core@3.2.5-beta.0

## 0.5.4

### Patch Changes

- b6038b1: Diagnostics only: the hosted MCP's `/connect/callback` now says which stage refused an approval. Nothing about what is accepted, refused or stored changes. A refusal is still `400`, and its body adds `error` (the stage: `restore_approval`, `siwe_runtime_delegation`, `auth_import`, `activation` or `unknown`) and `code` (for example `DELEGATION_REJECTED`, `AUTH_EXPIRED`, `CALLBACK_INCOMPLETE`, `SESSION_MISMATCH`, `UNKNOWN`), with an optional `reason` (a `RuntimeDelegationRejectedError` reason such as `activation_rejected` or `proof_invalid`; any other value is reported as `unknown`). The human-readable text moves to `message`.

  The server also writes one stderr line per refusal: `[tinycloud-mcp-http] connect callback rejected: stage=… code=…[ reason=…] detail=…`. `detail` names the check that failed before the approval is read: `state_missing`, `state_invalid`, `state_expired`, `state_not_pending`, `tenant_missing` or `body_invalid`, and `none` otherwise. It appears only in the log; every such refusal gets the same `{ error: "unknown", code: "UNKNOWN" }` body, so a caller cannot probe whether a state is valid. `tenant_missing` includes a validly signed state whose whole tenant directory is gone, such as after a state-volume reset. `state_not_pending` is not proof of replay: retrying an expired link also produces it, because the first attempt deletes the expired pending approval.

  Neither the body nor the line includes callback input, delegations, tokens, session DIDs or node responses. The `403` `approval_owner_mismatch` response is unchanged.

  `tinycloud.auth.import` now puts the activation rejection reason in `DELEGATION_REJECTED` error details as `details.reason`, for example `activation_rejected` when the node's `/delegate` refuses the delegation. Only `RuntimeDelegationRejectedError` reasons cross the result boundary.

- 079afb6: Release a new beta built from its version commit. npm's 0.5.4-beta.1 (operations) and 0.1.4-beta.1 (courier) came from b6038b10, a run whose version commit never landed (TC-1095).
  - @tinycloud/node-sdk@3.2.4
  - @tinycloud/sdk-core@3.2.4
  - @tinycloud/sdk-services@3.2.4

## 0.5.4-beta.2

### Patch Changes

- 079afb6: Release a new beta built from its version commit. npm's 0.5.4-beta.1 (operations) and 0.1.4-beta.1 (courier) came from b6038b10, a run whose version commit never landed (TC-1095).

## 0.5.4-beta.1

### Patch Changes

- b6038b1: Diagnostics only: the hosted MCP's `/connect/callback` now says which stage refused an approval. Nothing about what is accepted, refused or stored changes. A refusal is still `400`, and its body adds `error` (the stage: `restore_approval`, `siwe_runtime_delegation`, `auth_import`, `activation` or `unknown`) and `code` (for example `DELEGATION_REJECTED`, `AUTH_EXPIRED`, `CALLBACK_INCOMPLETE`, `SESSION_MISMATCH`, `UNKNOWN`), with an optional `reason` (a `RuntimeDelegationRejectedError` reason such as `activation_rejected` or `proof_invalid`; any other value is reported as `unknown`). The human-readable text moves to `message`.

  The server also writes one stderr line per refusal: `[tinycloud-mcp-http] connect callback rejected: stage=… code=…[ reason=…] detail=…`. `detail` names the check that failed before the approval is read: `state_missing`, `state_invalid`, `state_expired`, `state_not_pending`, `tenant_missing` or `body_invalid`, and `none` otherwise. It appears only in the log; every such refusal gets the same `{ error: "unknown", code: "UNKNOWN" }` body, so a caller cannot probe whether a state is valid. `tenant_missing` includes a validly signed state whose whole tenant directory is gone, such as after a state-volume reset. `state_not_pending` is not proof of replay: retrying an expired link also produces it, because the first attempt deletes the expired pending approval.

  Neither the body nor the line includes callback input, delegations, tokens, session DIDs or node responses. The `403` `approval_owner_mismatch` response is unchanged.

  `tinycloud.auth.import` now puts the activation rejection reason in `DELEGATION_REJECTED` error details as `details.reason`, for example `activation_rejected` when the node's `/delegate` refuses the delegation. Only `RuntimeDelegationRejectedError` reasons cross the result boundary.

## 0.5.4-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.4-beta.0

## 0.5.3

### Patch Changes

- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.
- Updated dependencies [c13720c]
  - @tinycloud/sdk-core@3.2.3
  - @tinycloud/node-sdk@3.2.3
  - @tinycloud/sdk-services@3.2.3

## 0.5.3-beta.1

### Patch Changes

- Updated dependencies [c13720c]
  - @tinycloud/sdk-core@3.2.3-beta.0
  - @tinycloud/node-sdk@3.2.3-beta.0

## 0.5.3-beta.0

### Patch Changes

- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.

## 0.5.2

### Patch Changes

- 0e8ee33: **If a command now fails with `AUTH_REQUIRED` and `auth status` shows `session.state: "unverified"`, sign in again: `tc --profile <profile> auth login --method openkey`.** This happens to an OpenKey owner profile whose saved session has no signed OpenKey proof, either from the old unverified paste login or from an older `tc auth import` on an owner profile; for an import, re-import into a delegate-session profile instead. Sessions from any real OpenKey sign-in are unaffected.

  `tc auth login --method openkey`, including `--paste`, now requires a SIWE proof signed for this profile's session key, and saves nothing without one (TC-1053). Before, a plain login (with no `--manifest`, `--owner` or `--expiry`) stored a pasted delegation that had no signature, reported `authenticated: true` and took the profile's `spaceId` from unverified input. Such a paste now fails with `OPENKEY_PROOF_INVALID` (exit 3). Real OpenKey logins always carry this proof and are unaffected.

  The approved session's space must also belong to the account that signed it (`OPENKEY_SCOPE_MISMATCH`), and the saved session always signs with the profile's own key, never a key echoed by the callback.

  A session without a signed proof on an OpenKey owner profile is now reported as `unverified` by `auth status`, `whoami`, `context` and `status`. Commands refuse it, printing the sign-in command, instead of sending it to the node. That covers both the CLI's own restore and the operations runtime behind `tc secrets` and the MCP server (`ownerSessionLacksProof` in `@tinycloud/operations/profile`). It applies to anything the old unverified login saved, and to legacy delegation imports on profiles with no recorded posture. Sign in again, or re-import into a delegate-session profile.

  This doesn't yet tie the proof to this particular login attempt: on a profile with no pinned owner, any wallet's valid proof for the session key is still accepted (TC-1058).
  - @tinycloud/node-sdk@3.2.2
  - @tinycloud/sdk-core@3.2.2
  - @tinycloud/sdk-services@3.2.2

## 0.5.2-beta.1

### Patch Changes

- 0e8ee33: `tc auth login --method openkey`, including `--paste`, now requires a SIWE proof signed for this profile's session key, and saves nothing without one (TC-1053). Before, a plain login (with no `--manifest`, `--owner` or `--expiry`) stored a pasted delegation that had no signature, reported `authenticated: true` and took the profile's `spaceId` from unverified input. Such a paste now fails with `OPENKEY_PROOF_INVALID` (exit 3). Real OpenKey logins always carry this proof and are unaffected.

  The approved session's space must also belong to the account that signed it (`OPENKEY_SCOPE_MISMATCH`), and the saved session always signs with the profile's own key, never a key echoed by the callback.

  A session without a signed proof on an OpenKey owner profile is now reported as `unverified` by `auth status`, `whoami`, `context` and `status`. Commands refuse it, printing the sign-in command, instead of sending it to the node. That covers both the CLI's own restore and the operations runtime behind `tc secrets` and the MCP server (`ownerSessionLacksProof` in `@tinycloud/operations/profile`). It applies to anything the old unverified login saved, and to legacy delegation imports on profiles with no recorded posture. Sign in again, or re-import into a delegate-session profile.

  This doesn't yet tie the proof to this particular login attempt: on a profile with no pinned owner, any wallet's valid proof for the session key is still accepted (TC-1058).

## 0.5.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.2-beta.0

## 0.5.1

### Patch Changes

- Updated dependencies [10359c5]
- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1
  - @tinycloud/sdk-core@3.2.1
  - @tinycloud/sdk-services@3.2.1

## 0.5.1-beta.1

### Patch Changes

- Updated dependencies [10359c5]
  - @tinycloud/node-sdk@3.2.1-beta.1

## 0.5.1-beta.0

### Patch Changes

- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1-beta.0

## 0.5.0

### Minor Changes

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

- 4f851e6: New operation `tinycloud.secrets.status@1`. It is read-only and never signs in: it restores the profile's stored session only, writes no profile state (no session, store, lock or migration marker), saves no authority requests, and returns `ready`, `pending` (with a Secret Manager `/request` link for the missing names, or a `tc secrets put … --stdin` hint for a local identity) or `consent_required` (with the `denied` names). It has an 18 s response deadline. Its errors carry `details.recovery`: `sign_in` with the persistent login command for the profile's posture, or `complete_migration` with `tc --profile <profile> auth caps` (`operationId: "tinycloud.auth.capabilities"`); a command is included only for a profile name that is safe in a shell command.

  New exports and contracts:
  - `@tinycloud/operations/secret-request`: the one Secret Manager link builder (`buildSecretRequestUrl`, `secretSetupFor`, `buildSecretManagerUrl`), the TC-832 owner/name/scope rules (`canonicalSecretRequestOwner`, `isValidSecretName`, `isValidSecretRequestScope`, `validSecretNames`), `resolveSecretsOwner`, `missingSecretRecovery`, `ownerOfSpace` and `isSafeRequestAccessRecovery`.
  - `@tinycloud/operations/recovery`: `signInRecovery`, `migrationRecovery`, `isSafeRecovery`, `SAFE_PROFILE_TOKEN`.
  - `isLocalOwnerProfile` from `@tinycloud/operations/profile`: the one local-owner predicate (posture `local-owner-key`, `authMethod: "local"`, or a stored `privateKey`), now shared with the CLI.
  - The `"restored"` runtime requirement. The kernel dispatches the declared requirement and applies the same owner opt-in and posture checks to `"restored"` as to `"authenticated"`. `replayStoredDelegationRecords` replays stored grants without migrating; `replayProfileDelegations` is unchanged.
  - `OperationDefinition.deadlineMs`, the new error code `PROFILE_MIGRATION_REQUIRED`, and the stored-grant skip reasons `activation_unavailable` and `activation_unauthenticated`.
  - Error details that now survive redaction, each strictly validated: `AUTH_REQUIRED.recovery`/`reason` (`explicit_key`), `SESSION_NOT_FOUND.recovery`, `PROFILE_MIGRATION_REQUIRED.recovery`, `INPUT_INVALID.reason` (`OWNER_MISMATCH`, `OWNER_DID_UNKNOWN`) and `KV_NOT_FOUND.{names, scope, owner, recoveryKind}`. Runtime-preparation errors now pass the same allowlist as execution errors.

  Breaking behavior:
  - `tinycloud.secrets.get`'s `setup_required.setup` moves from the `/app?secret=…&space=…` link to the canonical `/request?owner=…&name=…&v=1` link and gains the required fields `action: "add_secret"`, `names` and `owner`; the generated result schema requires them.
  - A missing secret for a local identity (including a profile with a stored `privateKey`), or one no request link can express (a legacy scope such as `scoped`, a name or scope over 64 characters, or an unknown owner), now returns error `KV_NOT_FOUND` with `details.recoveryKind` (`put_locally` or `not_requestable`) instead of `setup_required`.
  - `buildSecretSetupUrl` is removed. Code that enumerates `OPERATION_ERROR_CODES`, `STORED_GRANT_SKIP_REASONS` or `OperationRuntimeRequirement` sees the new values. `generated/operations.json` gains the new operation, error code, skip reasons and setup fields.

### Patch Changes

- 33efc8c: Operation authority checks now judge each required capability against every grant in its owner-exact space together. A session restored from an OpenKey signed login reports one grant per signed action, so an operation needing `tinycloud.kv/get` and `tinycloud.kv/list` on one path was reported as `authority_required` even though both actions were signed.
- 9836159: A process that finds its own PID in a profile-lock record it did not write — a restarted container's PID 1 meeting its crashed predecessor's turn and `.lock` — no longer waits forever once that predecessor is provably gone. Turn and `.lock` owner records gain JSON fields only (`instanceId`; on Linux `bootId`, `pidNamespace`, `processStartTime`, `liveness`), and each Linux acquisition listens on a UNIX socket `profile-locks/<profile>/.live-<dir dev>-<dir ino>-<uuid>`, named after the turn directory it is bound in, until it releases. Such a record from the same boot is abandoned when it comes from the same PID namespace with a different process start time (no socket needed, Bun included), or from another PID namespace when its socket was bound in the checking process's own turn directory (same device and inode) and is either gone or refused by the kernel; a refusal counts only under Node, and only if the checking process can then connect to its own socket in that directory, which catches sandboxes that refuse every connect, while sandboxes that fabricate refusals selectively are unsupported, as for the PID check. A live or paused same-PID holder is waited for whatever its hostname. Records from older releases or other boots, holders without a socket, sockets bound in another turn directory (`profile-locks/` not shared, or recreated), checking processes without a working socket of their own, macOS and Windows keep waiting (manual remedy in the tc-cli reference). Staging directories of a dead same-PID predecessor are now collected, and each release under Node removes liveness sockets the kernel refuses, including ones no record names. Records of other PIDs are judged as before: the lock still does not protect processes with different PIDs in different PID namespaces.
- 6a7fa64: A SIWE-less session created by `tc auth import` now expires locally at the compact UCAN's signed `exp`; expired restores throw `AUTH_EXPIRED` before host lookup, including sessions imported by earlier releases. The new `signedCompactUcanExpiry` export reads that signed lifetime. CACAO-headed sessions remain refused only by the node.

  A request-bound compact import whose signed expiry passes during its locked store write now reports `DELEGATION_EXPIRED` and rolls back the grant and any provisional session. If a fresh delegate profile's provisional session expires during import, it is rolled back unless another writer has since changed the profile. Cross-user compact imports require transport expiry to match signed `exp`, and persist the signed expiry. An import that is already expired or expires before activation also reports `DELEGATION_EXPIRED` without storing a grant.

  The client clock is authoritative. `context` reports imported-session expiry, and the scoped paste login named by the hint is no longer blocked by an unknown expiry. Before probing a configured local node, session-using commands verify the stored session locally; this also covers older imported sessions. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable`, `auth request` without `--grant`, explicit private-key commands, and profiles without a stored session retain discovery behavior. Deferred discovery after owner refresh respects a context copied with another host.

- Updated dependencies [33efc8c]
- Updated dependencies [26f86bd]
- Updated dependencies [ad4a11f]
- Updated dependencies [6a7fa64]
- Updated dependencies [4756923]
- Updated dependencies [4f851e6]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [47eb547]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [d825e49]
- Updated dependencies [df18325]
  - @tinycloud/node-sdk@3.2.0
  - @tinycloud/sdk-services@3.2.0
  - @tinycloud/sdk-core@3.2.0

## 0.5.0-beta.10

### Patch Changes

- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0-beta.9

## 0.5.0-beta.9

### Patch Changes

- Updated dependencies [4756923]
  - @tinycloud/sdk-core@3.2.0-beta.8
  - @tinycloud/sdk-services@3.2.0-beta.8
  - @tinycloud/node-sdk@3.2.0-beta.8

## 0.5.0-beta.8

### Patch Changes

- Updated dependencies [26f86bd]
  - @tinycloud/sdk-services@3.2.0-beta.7
  - @tinycloud/sdk-core@3.2.0-beta.7
  - @tinycloud/node-sdk@3.2.0-beta.7

## 0.5.0-beta.7

### Patch Changes

- 33efc8c: Operation authority checks now judge each required capability against every grant in its owner-exact space together. A session restored from an OpenKey signed login reports one grant per signed action, so an operation needing `tinycloud.kv/get` and `tinycloud.kv/list` on one path was reported as `authority_required` even though both actions were signed.
- Updated dependencies [33efc8c]
  - @tinycloud/node-sdk@3.2.0-beta.6

## 0.5.0-beta.6

### Patch Changes

- 9836159: A process that finds its own PID in a profile-lock record it did not write — a restarted container's PID 1 meeting its crashed predecessor's turn and `.lock` — no longer waits forever once that predecessor is provably gone. Turn and `.lock` owner records gain JSON fields only (`instanceId`; on Linux `bootId`, `pidNamespace`, `processStartTime`, `liveness`), and each Linux acquisition listens on a UNIX socket `profile-locks/<profile>/.live-<dir dev>-<dir ino>-<uuid>`, named after the turn directory it is bound in, until it releases. Such a record from the same boot is abandoned when it comes from the same PID namespace with a different process start time (no socket needed, Bun included), or from another PID namespace when its socket was bound in the checking process's own turn directory (same device and inode) and is either gone or refused by the kernel; a refusal counts only under Node, and only if the checking process can then connect to its own socket in that directory, which catches sandboxes that refuse every connect, while sandboxes that fabricate refusals selectively are unsupported, as for the PID check. A live or paused same-PID holder is waited for whatever its hostname. Records from older releases or other boots, holders without a socket, sockets bound in another turn directory (`profile-locks/` not shared, or recreated), checking processes without a working socket of their own, macOS and Windows keep waiting (manual remedy in the tc-cli reference). Staging directories of a dead same-PID predecessor are now collected, and each release under Node removes liveness sockets the kernel refuses, including ones no record names. Records of other PIDs are judged as before: the lock still does not protect processes with different PIDs in different PID namespaces.

## 0.5.0-beta.5

### Patch Changes

- Updated dependencies [47eb547]
  - @tinycloud/node-sdk@3.2.0-beta.5
  - @tinycloud/sdk-services@3.2.0-beta.5
  - @tinycloud/sdk-core@3.2.0-beta.5

## 0.5.0-beta.4

### Patch Changes

- @tinycloud/node-sdk@3.2.0-beta.4

## 0.5.0-beta.3

### Patch Changes

- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
  - @tinycloud/sdk-services@3.2.0-beta.3
  - @tinycloud/sdk-core@3.2.0-beta.3
  - @tinycloud/node-sdk@3.2.0-beta.3

## 0.5.0-beta.2

### Minor Changes

- 4f851e6: New operation `tinycloud.secrets.status@1`. It is read-only and never signs in: it restores the profile's stored session only, writes no profile state (no session, store, lock or migration marker), saves no authority requests, and returns `ready`, `pending` (with a Secret Manager `/request` link for the missing names, or a `tc secrets put … --stdin` hint for a local identity) or `consent_required` (with the `denied` names). It has an 18 s response deadline. Its errors carry `details.recovery`: `sign_in` with the persistent login command for the profile's posture, or `complete_migration` with `tc --profile <profile> auth caps` (`operationId: "tinycloud.auth.capabilities"`); a command is included only for a profile name that is safe in a shell command.

  New exports and contracts:
  - `@tinycloud/operations/secret-request`: the one Secret Manager link builder (`buildSecretRequestUrl`, `secretSetupFor`, `buildSecretManagerUrl`), the TC-832 owner/name/scope rules (`canonicalSecretRequestOwner`, `isValidSecretName`, `isValidSecretRequestScope`, `validSecretNames`), `resolveSecretsOwner`, `missingSecretRecovery`, `ownerOfSpace` and `isSafeRequestAccessRecovery`.
  - `@tinycloud/operations/recovery`: `signInRecovery`, `migrationRecovery`, `isSafeRecovery`, `SAFE_PROFILE_TOKEN`.
  - `isLocalOwnerProfile` from `@tinycloud/operations/profile`: the one local-owner predicate (posture `local-owner-key`, `authMethod: "local"`, or a stored `privateKey`), now shared with the CLI.
  - The `"restored"` runtime requirement. The kernel dispatches the declared requirement and applies the same owner opt-in and posture checks to `"restored"` as to `"authenticated"`. `replayStoredDelegationRecords` replays stored grants without migrating; `replayProfileDelegations` is unchanged.
  - `OperationDefinition.deadlineMs`, the new error code `PROFILE_MIGRATION_REQUIRED`, and the stored-grant skip reasons `activation_unavailable` and `activation_unauthenticated`.
  - Error details that now survive redaction, each strictly validated: `AUTH_REQUIRED.recovery`/`reason` (`explicit_key`), `SESSION_NOT_FOUND.recovery`, `PROFILE_MIGRATION_REQUIRED.recovery`, `INPUT_INVALID.reason` (`OWNER_MISMATCH`, `OWNER_DID_UNKNOWN`) and `KV_NOT_FOUND.{names, scope, owner, recoveryKind}`. Runtime-preparation errors now pass the same allowlist as execution errors.

  Breaking behavior:
  - `tinycloud.secrets.get`'s `setup_required.setup` moves from the `/app?secret=…&space=…` link to the canonical `/request?owner=…&name=…&v=1` link and gains the required fields `action: "add_secret"`, `names` and `owner`; the generated result schema requires them.
  - A missing secret for a local identity (including a profile with a stored `privateKey`), or one no request link can express (a legacy scope such as `scoped`, a name or scope over 64 characters, or an unknown owner), now returns error `KV_NOT_FOUND` with `details.recoveryKind` (`put_locally` or `not_requestable`) instead of `setup_required`.
  - `buildSecretSetupUrl` is removed. Code that enumerates `OPERATION_ERROR_CODES`, `STORED_GRANT_SKIP_REASONS` or `OperationRuntimeRequirement` sees the new values. `generated/operations.json` gains the new operation, error code, skip reasons and setup fields.

### Patch Changes

- Updated dependencies [4f851e6]
  - @tinycloud/sdk-services@3.2.0-beta.2
  - @tinycloud/sdk-core@3.2.0-beta.2
  - @tinycloud/node-sdk@3.2.0-beta.2

## 0.5.0-beta.1

### Patch Changes

- 6a7fa64: A SIWE-less session created by `tc auth import` now expires locally at the compact UCAN's signed `exp`; expired restores throw `AUTH_EXPIRED` before host lookup, including sessions imported by earlier releases. The new `signedCompactUcanExpiry` export reads that signed lifetime. CACAO-headed sessions remain refused only by the node.

  A request-bound compact import whose signed expiry passes during its locked store write now reports `DELEGATION_EXPIRED` and rolls back the grant and any provisional session. If a fresh delegate profile's provisional session expires during import, it is rolled back unless another writer has since changed the profile. Cross-user compact imports require transport expiry to match signed `exp`, and persist the signed expiry. An import that is already expired or expires before activation also reports `DELEGATION_EXPIRED` without storing a grant.

  The client clock is authoritative. `context` reports imported-session expiry, and the scoped paste login named by the hint is no longer blocked by an unknown expiry. Before probing a configured local node, session-using commands verify the stored session locally; this also covers older imported sessions. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable`, `auth request` without `--grant`, explicit private-key commands, and profiles without a stored session retain discovery behavior. Deferred discovery after owner refresh respects a context copied with another host.

- Updated dependencies [6a7fa64]
  - @tinycloud/node-sdk@3.2.0-beta.1

## 0.5.0-beta.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [ad4a11f]
  - @tinycloud/sdk-core@3.2.0-beta.0
  - @tinycloud/node-sdk@3.2.0-beta.0

## 0.4.0

### Minor Changes

- b7fd979: Stored compact-UCAN delegations now replay only inside the request they were imported against. `tinycloud.auth.import` stores that request (`authorityRequest`) with each delegation, and replay installs a stored compact-UCAN or signed-login record only when its binding is valid and the delegation's signed capabilities fit inside it, using the same containment check as import. The check runs before anything is activated, so a delegation broader than its binding is never installed. A validated re-import replaces every stored row for its CID with one record bound to the new request, whatever binding the old rows carried.

  Records stored before bindings existed are migrated once per profile. Before reading a profile's records, the first runtime that has restored the profile's own session takes the profile lock, binds each unbound compact-UCAN record whose signed capabilities validated activation can read to exactly those capabilities (request ID `migrated:<cid>`, with an `authorityRequestAudit` note), and writes a `delegation-binding-migration.json` marker in the same critical section. Each record is handled on its own: one that cannot be bound stays unbound, is listed in the marker's `unbound`, and does not stop the others from migrating. Migration runs only while the persisted session is still the one the runtime restored, and is best-effort and restartable: bound records are written first and the marker last, so an interrupted run leaves the rest to the next runtime. A record whose `delegationHeader` is anything but a single string `Authorization`, or a non-compact record without `siweProof` that carries an `authorityRequest`, installs nothing. If the lock is busy, that runtime replays under the earlier rule and writes nothing. After migration, a compact-UCAN record without a valid binding installs nothing. A migrated record never grants more than it did before, because any delegation in it must fit inside the capabilities it was bound to.

  New `@tinycloud/operations/delegation-binding` entry point: the replay rule and migration (`prepareStoredDelegationReplay`, `replayStoredDelegation`), storage for delegations imported without a request (`activateUnboundCompactImport`, and `mergeDelegationsWithoutRequest`, which never replaces a stored record for the same CID that carries a binding), `storedDelegationKind`, `replayLimit`, `bindingMigrationPath`, `bindingMigrationRecorded` and `operationSpaceResolver`, so the CLI applies the same rule. `DelegationRequestBindingSchema` and `DelegationRequestBinding` are new exports of `@tinycloud/operations/artifacts`.

  `liveAdditionalDelegationCount` in `tinycloud.status.get` and `tinycloud.auth.status` now counts only stored, unexpired records the replay rule accepts. A stored element that is not an object installs nothing, is never migrated, and no longer blocks migration or runtime initialization.

  Profile-lock reentrancy and the invocation state root (`withTinyCloudStateRoot`) are now shared by every operations entry point in a process, so holding a lock through `@tinycloud/operations/state` and calling into `@tinycloud/operations/delegation-binding` no longer waits on that lock. The shared context lives under versioned process-wide keys (`tinycloud.operations.heldProfileLocks.v1`, `tinycloud.operations.invocationStateRoot.v1`); copies with a different held-lock format use different keys and wait for the lock instead of trusting each other's entries. TC-633 changes the held-lock shape and adds a per-process `turnsInProgress` set: whichever of TC-602 and TC-633 lands second bumps these keys to `.v2` and makes that set process-wide under the same version.

  `tinycloud.status.get` and `tinycloud.auth.status` skip stored records replay refuses outright (no delegation object, malformed header) instead of failing with `INTERNAL_ERROR`.

  The binding is local profile data. It stops records written by other paths from granting authority. It does not stop someone who can write the profile directory, who already holds the session key and the signed bytes. Older releases do not enforce bindings.

- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

- 045c2d3: Classify KV and SQL HTTP authorization refusals in operation and MCP structured results. A plain 401 is nonretryable `AUTH_REQUIRED`; 403 or a 401 naming a validated missing capability is nonretryable `PERMISSION_DENIED`, so an agent does not retry signing in when a capability grant is needed. Keep 5xx node failures retryable except uncertain SQL writes, and never expose node response text or transport metadata in canonical results.

### Patch Changes

- 37123c3: `withProfileLock` takes `requireProfile: true` for writers of state that lives inside an existing profile (TC-18 replicas): the lock is taken only while the profile's `profile.json` exists, checked before and after waiting for its turn, and never creates the profile directory. A missing or deleted profile is refused with `ProfileDeletedError` (`PROFILE_NOT_FOUND`), and an empty directory a deletion left behind is removed. Without the option the lock behaves as before.
- f25aa05: Bring the remaining profile writers under the profile lock. `tc profile delete` waits for the lock and removes the profile's files while holding it (session and key first, settings last), never another holder's lock, and unlinks a symlinked profile directory without touching its target. It refuses a name that is not one path segment with `INVALID_PROFILE_NAME`; before, `tc profile delete ..` removed the whole TinyCloud home. Local `tc auth rotate` keeps the previous session when a concurrent change refuses its commit (`PROFILE_CHANGED_DURING_LOGIN`). The delegate-session bootstrap in `tc auth import` reads the profile, key and session under the lock, never replaces a session that appeared meanwhile (`PROFILE_CHANGED_DURING_IMPORT`), and rolls itself back if it fails. A failed request-bound import rolls back that bootstrap only if the profile still holds what the bootstrap wrote, and keeps (and reports) newer state otherwise; if the rollback cannot run, the import's error is still the one reported. Other import forms keep a successful bootstrap when a later step fails, as before. A lock acquirer that finds its profile directory removed by a concurrent delete recreates it and retries within its deadline instead of failing.
- dca972f: An expired stored session now asks for a new sign-in instead of looking like a node failure (TC-607). When node-sdk refuses a persisted signed session as expired or no longer valid (`AUTH_EXPIRED`), the operations runtime returns a non-retryable `AUTH_REQUIRED` (the code TC-634 uses for a node's 401) instead of a retryable `NODE_ERROR`, and the CLI reports `AUTH_REQUIRED` (exit 3) with a sign-in hint for the profile's kind (scoped paste login for a delegate, `--method local` for a local owner key, `--method openkey` for an OpenKey owner). This covers `tc secrets get/list/put/delete`, `tc auth import` of a request-bound delegation, and every other command that restores a stored session; the refusal happens before any node request. Share commands keep their share-publishing sign-in guidance. Operations and MCP consumers that switch on error codes see `AUTH_REQUIRED` where they previously saw `NODE_ERROR` for this case. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, duckdb, kv, secrets list/put/delete, space, sql, vars and vault); for example, `tc secrets list` without a grant returns the NodeSecretsService's status-less `PERMISSION_DENIED` with exit 5. `tc secrets get` and `tc auth import` also supply the profile kind's sign-in hint for `AUTH_REQUIRED`. A delegate session bootstrapped by `tc auth import` carries no signed expiry and is still refused by the node instead.

  Interactive secret escalation and `tc auth request --grant` now send OpenKey `/delegate` a request it signs, and the approved grant now authorizes `secrets get` (TC-609). Each request adds `tinycloud.capabilities/read` on its space root, keeps raw decrypt in the `encryption` pseudo-space with an EIP-55 owner, and anchors a decrypt-only request in the secrets space (`--space` when given) or, for `auth request --grant`, the profile's primary space. The signed proof is verified before anything is activated or stored; the added `capabilities/read` counts as requested, and any other authority beyond the request is refused.

  `activateValidatedRuntimeDelegation` now accepts wallet-signed CACAO session grants (OpenKey `/delegate`, `grantRuntimePermissions`) as well as compact UCANs. Such a grant must carry `siweProof` (its SIWE and signature, now set by `grantRuntimePermissions` and by the CLI when it stores an OpenKey grant); it is verified with the new `TinyCloudNode.verifySessionGrant` against the live session key, must be signed by the session's owner for one owner space and owner networks, and installs exactly the verified ReCap. The CLI stores each such grant (`tc auth request --grant`, secret-read approvals) with its `siweProof` and an `authorityRequest` binding to exactly its signed capabilities as validated activation reads them (`cli-grant:<cid>`, new `bindCliGrant` in `@tinycloud/operations/delegation-binding`), so the request-binding replay rule installs it in the CLI, `secrets get` and MCP; a signed-login record with a proof but no valid binding installs nothing. Grants stored without a proof by earlier releases are not used by operations. `replayStoredDelegation` now returns `{ status: "installed" | "skipped" | "not-replayed" }` with a fixed skip `reason` instead of the installed delegation or `undefined`. Refusals throw `RuntimeDelegationRejectedError` with a stable `reason` (`RUNTIME_DELEGATION_REJECTIONS`). Operation results gain an optional `warnings` array: every unexpired stored grant the runtime skips is listed as `{ code: "STORED_GRANT_SKIPPED", reason, grantCid? }` with a fixed reason code (including `unbound` and `outside_request` for the request-binding rule) and never error text, node responses or stored URLs (expired grants are still dropped silently); `grantCid` appears only when it is the CID recomputed from the stored authorization bytes. The CLI prints them inside its JSON error, beside TC-634's `meta` (also when an `-o` write or browser approval fails), as one JSON line on stderr after a successful command's output, or as one human-readable line. `--json` now selects JSON errors and warnings, and suppresses progress spinners, the banner and the missing-profile notice, even when stdout is a terminal; it is read from the parsed options, so a `--json` operand after `--` does not count. `secrets get` reports missing authority as `PERMISSION_DENIED` with exit 5 instead of exit 1.

- 7edc599: Make the profile lock safe against paused processes and older releases, and usable without hard links. This release takes a turn in `~/.tinycloud/profile-locks/<profile>/` before the `.lock` directory shared with CLI 1.0.0-beta.16 and older and 1.0.0-beta.17 … 1.0.1-beta.4. Turns do not expire with time: a paused process of this release cannot let another writer in, and only one at a time reclaims an abandoned `.lock`. This assumes one host and PID namespace and a filesystem whose directory `rename` fails onto an existing directory; a `TC_HOME` shared across machines or containers without a shared PID namespace is unsupported. Older releases still race when one pauses after `mkdir(.lock)` past the stale threshold or reclaims concurrently with that paused writer.

  With hard links, dead-owner recovery claims and verifies the observed record without moving a live owner or removing a new empty `.lock` after a failed claim. Without hard links (FAT/exFAT, some SMB mounts), owner publication uses exclusive creation and recovery moves the record into `.recover-*`; an incomplete record left by a crash is reclaimed once 30 s old. On either path, a recoverer can claim a replacement live owner's record, detect the mismatch, and crash before dropping its hard link or restoring its moved record. If the holder then releases but its process stays alive, the next current-release acquisition restores the claim as `owner.json` and may remain blocked until the PID exits and the record is at least 30 s old (for a long-lived MCP server, possibly until it restarts). This costs availability only, never exclusion. Releases through 1.0.1-beta.4 cannot reclaim a `.recover-*` claim left by a crashed current-release recoverer, even once aged; a current release can process it. To clear a stalled profile manually, remove its `.lock` only when no tc or MCP process is running.

  A failed lock-file write (a full disk, a permission error) is retried. A turn left unfinished is settled once writes work again, by the same process (in the background, or on its next write) or by others once it exits; an unreadable turn record is never voided on that account. If the turn lock is damaged, `PROFILE_LOCK_TIMEOUT` names `~/.tinycloud/profile-locks/<profile>`, which can be removed while no tc or MCP process uses the profile. Process-wide held-lock entries now use `tinycloud.operations.heldProfileLocks.v2` to exclude TC-602's earlier shape; the invocation state root remains the same string path in `.v1`.

  A key, session, delegation or permission-request write that waited for the lock while `tc profile delete` removed the profile (whether it arrived before or after the deletion's files were removed) now fails with `PROFILE_NOT_FOUND` instead of recreating a profile without settings. `@tinycloud/operations/state` exports `recordProfileDeletion`, `refuseWriteToDeletedProfile`, `ProfileDeletedError` and `profileTurnLockPath` for this. `tc profile delete` of a profile that does not exist no longer creates lock state. The rollback of a failed `tc auth import` bootstrap compares only what the bootstrap wrote (the session, and the profile's session DID and space), so an unrelated profile change made meanwhile, such as a new default space, no longer keeps the provisional session and is itself kept. Its notes name failures by code and never quote file contents.

- c923361: TC-649: For a missing secret, the setup link printed by `tc secrets get` and returned by MCP `secrets.get` now opens Secret Manager with the name filled in: `https://secrets.tinycloud.xyz/app?secret=NAME` plus `&scope=…` when scoped. Before, `https://secrets.tinycloud.xyz?name=NAME` opened the landing page and filled in nothing.
- Updated dependencies [02b6773]
- Updated dependencies [ee4fd2d]
- Updated dependencies [37123c3]
- Updated dependencies [0652195]
- Updated dependencies [6484eba]
- Updated dependencies [b7fd979]
- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
- Updated dependencies [a074fa5]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [698654e]
- Updated dependencies [4df61ed]
- Updated dependencies [2c703fc]
- Updated dependencies [d11a8b6]
- Updated dependencies [1f44a61]
  - @tinycloud/sdk-core@3.1.0
  - @tinycloud/node-sdk@3.1.0
  - @tinycloud/sdk-services@3.1.0

## 0.4.0-beta.19

### Patch Changes

- Updated dependencies [1f44a61]
  - @tinycloud/node-sdk@3.1.0-beta.15

## 0.4.0-beta.18

### Patch Changes

- Updated dependencies [4df61ed]
  - @tinycloud/sdk-services@3.1.0-beta.14
  - @tinycloud/node-sdk@3.1.0-beta.14
  - @tinycloud/sdk-core@3.1.0-beta.14

## 0.4.0-beta.17

### Patch Changes

- Updated dependencies [d11a8b6]
  - @tinycloud/sdk-services@3.1.0-beta.13
  - @tinycloud/node-sdk@3.1.0-beta.13
  - @tinycloud/sdk-core@3.1.0-beta.13

## 0.4.0-beta.16

### Patch Changes

- Updated dependencies [2c703fc]
  - @tinycloud/sdk-core@3.1.0-beta.12
  - @tinycloud/node-sdk@3.1.0-beta.12

## 0.4.0-beta.15

### Patch Changes

- Updated dependencies [02b6773]
  - @tinycloud/sdk-core@3.1.0-beta.11
  - @tinycloud/node-sdk@3.1.0-beta.11
  - @tinycloud/sdk-services@3.1.0-beta.11

## 0.4.0-beta.14

### Patch Changes

- 37123c3: `withProfileLock` takes `requireProfile: true` for writers of state that lives inside an existing profile (TC-18 replicas): the lock is taken only while the profile's `profile.json` exists, checked before and after waiting for its turn, and never creates the profile directory. A missing or deleted profile is refused with `ProfileDeletedError` (`PROFILE_NOT_FOUND`), and an empty directory a deletion left behind is removed. Without the option the lock behaves as before.
- Updated dependencies [37123c3]
  - @tinycloud/sdk-services@3.1.0-beta.10
  - @tinycloud/node-sdk@3.1.0-beta.10
  - @tinycloud/sdk-core@3.1.0-beta.10

## 0.4.0-beta.13

### Patch Changes

- Updated dependencies [698654e]
  - @tinycloud/sdk-services@3.1.0-beta.9
  - @tinycloud/sdk-core@3.1.0-beta.9
  - @tinycloud/node-sdk@3.1.0-beta.9

## 0.4.0-beta.12

### Patch Changes

- dca972f: An expired stored session now asks for a new sign-in instead of looking like a node failure (TC-607). When node-sdk refuses a persisted signed session as expired or no longer valid (`AUTH_EXPIRED`), the operations runtime returns a non-retryable `AUTH_REQUIRED` (the code TC-634 uses for a node's 401) instead of a retryable `NODE_ERROR`, and the CLI reports `AUTH_REQUIRED` (exit 3) with a sign-in hint for the profile's kind (scoped paste login for a delegate, `--method local` for a local owner key, `--method openkey` for an OpenKey owner). This covers `tc secrets get/list/put/delete`, `tc auth import` of a request-bound delegation, and every other command that restores a stored session; the refusal happens before any node request. Share commands keep their share-publishing sign-in guidance. Operations and MCP consumers that switch on error codes see `AUTH_REQUIRED` where they previously saw `NODE_ERROR` for this case. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, duckdb, kv, secrets list/put/delete, space, sql, vars and vault); for example, `tc secrets list` without a grant returns the NodeSecretsService's status-less `PERMISSION_DENIED` with exit 5. `tc secrets get` and `tc auth import` also supply the profile kind's sign-in hint for `AUTH_REQUIRED`. A delegate session bootstrapped by `tc auth import` carries no signed expiry and is still refused by the node instead.

  Interactive secret escalation and `tc auth request --grant` now send OpenKey `/delegate` a request it signs, and the approved grant now authorizes `secrets get` (TC-609). Each request adds `tinycloud.capabilities/read` on its space root, keeps raw decrypt in the `encryption` pseudo-space with an EIP-55 owner, and anchors a decrypt-only request in the secrets space (`--space` when given) or, for `auth request --grant`, the profile's primary space. The signed proof is verified before anything is activated or stored; the added `capabilities/read` counts as requested, and any other authority beyond the request is refused.

  `activateValidatedRuntimeDelegation` now accepts wallet-signed CACAO session grants (OpenKey `/delegate`, `grantRuntimePermissions`) as well as compact UCANs. Such a grant must carry `siweProof` (its SIWE and signature, now set by `grantRuntimePermissions` and by the CLI when it stores an OpenKey grant); it is verified with the new `TinyCloudNode.verifySessionGrant` against the live session key, must be signed by the session's owner for one owner space and owner networks, and installs exactly the verified ReCap. The CLI stores each such grant (`tc auth request --grant`, secret-read approvals) with its `siweProof` and an `authorityRequest` binding to exactly its signed capabilities as validated activation reads them (`cli-grant:<cid>`, new `bindCliGrant` in `@tinycloud/operations/delegation-binding`), so the request-binding replay rule installs it in the CLI, `secrets get` and MCP; a signed-login record with a proof but no valid binding installs nothing. Grants stored without a proof by earlier releases are not used by operations. `replayStoredDelegation` now returns `{ status: "installed" | "skipped" | "not-replayed" }` with a fixed skip `reason` instead of the installed delegation or `undefined`. Refusals throw `RuntimeDelegationRejectedError` with a stable `reason` (`RUNTIME_DELEGATION_REJECTIONS`). Operation results gain an optional `warnings` array: every unexpired stored grant the runtime skips is listed as `{ code: "STORED_GRANT_SKIPPED", reason, grantCid? }` with a fixed reason code (including `unbound` and `outside_request` for the request-binding rule) and never error text, node responses or stored URLs (expired grants are still dropped silently); `grantCid` appears only when it is the CID recomputed from the stored authorization bytes. The CLI prints them inside its JSON error, beside TC-634's `meta` (also when an `-o` write or browser approval fails), as one JSON line on stderr after a successful command's output, or as one human-readable line. `--json` now selects JSON errors and warnings, and suppresses progress spinners, the banner and the missing-profile notice, even when stdout is a terminal; it is read from the parsed options, so a `--json` operand after `--` does not count. `secrets get` reports missing authority as `PERMISSION_DENIED` with exit 5 instead of exit 1.

- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
  - @tinycloud/node-sdk@3.1.0-beta.8
  - @tinycloud/sdk-core@3.1.0-beta.8

## 0.4.0-beta.11

### Minor Changes

- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

## 0.4.0-beta.10

### Patch Changes

- Updated dependencies [ee4fd2d]
  - @tinycloud/sdk-services@3.1.0-beta.7
  - @tinycloud/node-sdk@3.1.0-beta.7
  - @tinycloud/sdk-core@3.1.0-beta.7

## 0.4.0-beta.9

### Minor Changes

- 045c2d3: Classify KV and SQL HTTP authorization refusals in operation and MCP structured results. A plain 401 is nonretryable `AUTH_REQUIRED`; 403 or a 401 naming a validated missing capability is nonretryable `PERMISSION_DENIED`, so an agent does not retry signing in when a capability grant is needed. Keep 5xx node failures retryable except uncertain SQL writes, and never expose node response text or transport metadata in canonical results.

### Patch Changes

- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
  - @tinycloud/sdk-core@3.1.0-beta.6
  - @tinycloud/node-sdk@3.1.0-beta.6
  - @tinycloud/sdk-services@3.1.0-beta.6

## 0.4.0-beta.8

### Patch Changes

- 7edc599: Make the profile lock safe against paused processes and older releases, and usable without hard links. This release takes a turn in `~/.tinycloud/profile-locks/<profile>/` before the `.lock` directory shared with CLI 1.0.0-beta.16 and older and 1.0.0-beta.17 … 1.0.1-beta.4. Turns do not expire with time: a paused process of this release cannot let another writer in, and only one at a time reclaims an abandoned `.lock`. This assumes one host and PID namespace and a filesystem whose directory `rename` fails onto an existing directory; a `TC_HOME` shared across machines or containers without a shared PID namespace is unsupported. Older releases still race when one pauses after `mkdir(.lock)` past the stale threshold or reclaims concurrently with that paused writer.

  With hard links, dead-owner recovery claims and verifies the observed record without moving a live owner or removing a new empty `.lock` after a failed claim. Without hard links (FAT/exFAT, some SMB mounts), owner publication uses exclusive creation and recovery moves the record into `.recover-*`; an incomplete record left by a crash is reclaimed once 30 s old. On either path, a recoverer can claim a replacement live owner's record, detect the mismatch, and crash before dropping its hard link or restoring its moved record. If the holder then releases but its process stays alive, the next current-release acquisition restores the claim as `owner.json` and may remain blocked until the PID exits and the record is at least 30 s old (for a long-lived MCP server, possibly until it restarts). This costs availability only, never exclusion. Releases through 1.0.1-beta.4 cannot reclaim a `.recover-*` claim left by a crashed current-release recoverer, even once aged; a current release can process it. To clear a stalled profile manually, remove its `.lock` only when no tc or MCP process is running.

  A failed lock-file write (a full disk, a permission error) is retried. A turn left unfinished is settled once writes work again, by the same process (in the background, or on its next write) or by others once it exits; an unreadable turn record is never voided on that account. If the turn lock is damaged, `PROFILE_LOCK_TIMEOUT` names `~/.tinycloud/profile-locks/<profile>`, which can be removed while no tc or MCP process uses the profile. Process-wide held-lock entries now use `tinycloud.operations.heldProfileLocks.v2` to exclude TC-602's earlier shape; the invocation state root remains the same string path in `.v1`.

  A key, session, delegation or permission-request write that waited for the lock while `tc profile delete` removed the profile (whether it arrived before or after the deletion's files were removed) now fails with `PROFILE_NOT_FOUND` instead of recreating a profile without settings. `@tinycloud/operations/state` exports `recordProfileDeletion`, `refuseWriteToDeletedProfile`, `ProfileDeletedError` and `profileTurnLockPath` for this. `tc profile delete` of a profile that does not exist no longer creates lock state. The rollback of a failed `tc auth import` bootstrap compares only what the bootstrap wrote (the session, and the profile's session DID and space), so an unrelated profile change made meanwhile, such as a new default space, no longer keeps the provisional session and is itself kept. Its notes name failures by code and never quote file contents.

## 0.4.0-beta.7

### Minor Changes

- b7fd979: Stored compact-UCAN delegations now replay only inside the request they were imported against. `tinycloud.auth.import` stores that request (`authorityRequest`) with each delegation, and replay installs a stored compact-UCAN or signed-login record only when its binding is valid and the delegation's signed capabilities fit inside it, using the same containment check as import. The check runs before anything is activated, so a delegation broader than its binding is never installed. A validated re-import replaces every stored row for its CID with one record bound to the new request, whatever binding the old rows carried.

  Records stored before bindings existed are migrated once per profile. Before reading a profile's records, the first runtime that has restored the profile's own session takes the profile lock, binds each unbound compact-UCAN record whose signed capabilities validated activation can read to exactly those capabilities (request ID `migrated:<cid>`, with an `authorityRequestAudit` note), and writes a `delegation-binding-migration.json` marker in the same critical section. Each record is handled on its own: one that cannot be bound stays unbound, is listed in the marker's `unbound`, and does not stop the others from migrating. Migration runs only while the persisted session is still the one the runtime restored, and is best-effort and restartable: bound records are written first and the marker last, so an interrupted run leaves the rest to the next runtime. A record whose `delegationHeader` is anything but a single string `Authorization`, or a non-compact record without `siweProof` that carries an `authorityRequest`, installs nothing. If the lock is busy, that runtime replays under the earlier rule and writes nothing. After migration, a compact-UCAN record without a valid binding installs nothing. A migrated record never grants more than it did before, because any delegation in it must fit inside the capabilities it was bound to.

  New `@tinycloud/operations/delegation-binding` entry point: the replay rule and migration (`prepareStoredDelegationReplay`, `replayStoredDelegation`), storage for delegations imported without a request (`activateUnboundCompactImport`, and `mergeDelegationsWithoutRequest`, which never replaces a stored record for the same CID that carries a binding), `storedDelegationKind`, `replayLimit`, `bindingMigrationPath`, `bindingMigrationRecorded` and `operationSpaceResolver`, so the CLI applies the same rule. `DelegationRequestBindingSchema` and `DelegationRequestBinding` are new exports of `@tinycloud/operations/artifacts`.

  `liveAdditionalDelegationCount` in `tinycloud.status.get` and `tinycloud.auth.status` now counts only stored, unexpired records the replay rule accepts. A stored element that is not an object installs nothing, is never migrated, and no longer blocks migration or runtime initialization.

  Profile-lock reentrancy and the invocation state root (`withTinyCloudStateRoot`) are now shared by every operations entry point in a process, so holding a lock through `@tinycloud/operations/state` and calling into `@tinycloud/operations/delegation-binding` no longer waits on that lock. The shared context lives under versioned process-wide keys (`tinycloud.operations.heldProfileLocks.v1`, `tinycloud.operations.invocationStateRoot.v1`); copies with a different held-lock format use different keys and wait for the lock instead of trusting each other's entries. TC-633 changes the held-lock shape and adds a per-process `turnsInProgress` set: whichever of TC-602 and TC-633 lands second bumps these keys to `.v2` and makes that set process-wide under the same version.

  `tinycloud.status.get` and `tinycloud.auth.status` skip stored records replay refuses outright (no delegation object, malformed header) instead of failing with `INTERNAL_ERROR`.

  The binding is local profile data. It stops records written by other paths from granting authority. It does not stop someone who can write the profile directory, who already holds the session key and the signed bytes. Older releases do not enforce bindings.

### Patch Changes

- Updated dependencies [b7fd979]
  - @tinycloud/node-sdk@3.1.0-beta.5

## 0.3.4-beta.6

### Patch Changes

- @tinycloud/sdk-core@3.1.0-beta.4
- @tinycloud/node-sdk@3.1.0-beta.4

## 0.3.4-beta.5

### Patch Changes

- Updated dependencies [6484eba]
  - @tinycloud/sdk-core@3.1.0-beta.3
  - @tinycloud/node-sdk@3.1.0-beta.3

## 0.3.4-beta.4

### Patch Changes

- c923361: TC-649: For a missing secret, the setup link printed by `tc secrets get` and returned by MCP `secrets.get` now opens Secret Manager with the name filled in: `https://secrets.tinycloud.xyz/app?secret=NAME` plus `&scope=…` when scoped. Before, `https://secrets.tinycloud.xyz?name=NAME` opened the landing page and filled in nothing.

## 0.3.4-beta.3

### Patch Changes

- Updated dependencies [a074fa5]
  - @tinycloud/sdk-core@3.1.0-beta.2
  - @tinycloud/node-sdk@3.1.0-beta.2

## 0.3.4-beta.2

### Patch Changes

- Updated dependencies [0652195]
  - @tinycloud/sdk-core@3.1.0-beta.1
  - @tinycloud/node-sdk@3.1.0-beta.1

## 0.3.4-beta.1

### Patch Changes

- f25aa05: Bring the remaining profile writers under the profile lock. `tc profile delete` waits for the lock and removes the profile's files while holding it (session and key first, settings last), never another holder's lock, and unlinks a symlinked profile directory without touching its target. It refuses a name that is not one path segment with `INVALID_PROFILE_NAME`; before, `tc profile delete ..` removed the whole TinyCloud home. Local `tc auth rotate` keeps the previous session when a concurrent change refuses its commit (`PROFILE_CHANGED_DURING_LOGIN`). The delegate-session bootstrap in `tc auth import` reads the profile, key and session under the lock, never replaces a session that appeared meanwhile (`PROFILE_CHANGED_DURING_IMPORT`), and rolls itself back if it fails. A failed request-bound import rolls back that bootstrap only if the profile still holds what the bootstrap wrote, and keeps (and reports) newer state otherwise; if the rollback cannot run, the import's error is still the one reported. Other import forms keep a successful bootstrap when a later step fails, as before. A lock acquirer that finds its profile directory removed by a concurrent delete recreates it and retries within its deadline instead of failing.

## 0.3.4-beta.0

### Patch Changes

- @tinycloud/sdk-core@3.0.1-beta.0
- @tinycloud/node-sdk@3.0.1-beta.0

## 0.3.3

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- Updated dependencies [46c83a7]
- Updated dependencies [036ce34]
- Updated dependencies [ce34dc1]
- Updated dependencies [4b60562]
- Updated dependencies [b0069f7]
- Updated dependencies [cc27c3a]
- Updated dependencies [657c1ff]
- Updated dependencies [12e5c4d]
- Updated dependencies [c690844]
- Updated dependencies [31043b5]
- Updated dependencies [b852650]
- Updated dependencies [70e6c95]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [48eca36]
- Updated dependencies [a132b77]
- Updated dependencies [2e9db6e]
- Updated dependencies [877097d]
  - @tinycloud/sdk-core@3.0.0
  - @tinycloud/node-sdk@3.0.0

## 0.3.3-beta.18

### Patch Changes

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20

## 0.3.3-beta.17

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/sdk-core@3.0.0-beta.19
  - @tinycloud/node-sdk@3.0.0-beta.19

## 0.3.3-beta.16

### Patch Changes

- Updated dependencies [a132b77]
  - @tinycloud/sdk-core@3.0.0-beta.18
  - @tinycloud/node-sdk@3.0.0-beta.18

## 0.3.3-beta.15

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.17
- @tinycloud/node-sdk@3.0.0-beta.17

## 0.3.3-beta.14

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- Updated dependencies [48eca36]
  - @tinycloud/node-sdk@3.0.0-beta.16

## 0.3.3-beta.13

### Patch Changes

- Updated dependencies [2e9db6e]
  - @tinycloud/sdk-core@3.0.0-beta.15
  - @tinycloud/node-sdk@3.0.0-beta.15

## 0.3.3-beta.12

### Patch Changes

- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14
  - @tinycloud/sdk-core@3.0.0-beta.14

## 0.3.3-beta.11

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/sdk-core@3.0.0-beta.13
  - @tinycloud/node-sdk@3.0.0-beta.13

## 0.3.3-beta.10

### Patch Changes

- Updated dependencies [cc27c3a]
  - @tinycloud/sdk-core@3.0.0-beta.12
  - @tinycloud/node-sdk@3.0.0-beta.12

## 0.3.3-beta.9

### Patch Changes

- Updated dependencies [12e5c4d]
  - @tinycloud/sdk-core@3.0.0-beta.11
  - @tinycloud/node-sdk@3.0.0-beta.11

## 0.3.3-beta.8

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/sdk-core@3.0.0-beta.10
  - @tinycloud/node-sdk@3.0.0-beta.10

## 0.3.3-beta.7

### Patch Changes

- Updated dependencies [c690844]
  - @tinycloud/sdk-core@3.0.0-beta.9
  - @tinycloud/node-sdk@3.0.0-beta.9

## 0.3.3-beta.6

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/sdk-core@3.0.0-beta.8
  - @tinycloud/node-sdk@3.0.0-beta.8

## 0.3.3-beta.5

### Patch Changes

- Updated dependencies [657c1ff]
  - @tinycloud/sdk-core@3.0.0-beta.7
  - @tinycloud/node-sdk@3.0.0-beta.7

## 0.3.3-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/sdk-core@3.0.0-beta.6
  - @tinycloud/node-sdk@3.0.0-beta.6

## 0.3.3-beta.3

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.5
- @tinycloud/node-sdk@3.0.0-beta.5

## 0.3.3-beta.2

### Patch Changes

- Updated dependencies [b0069f7]
  - @tinycloud/sdk-core@3.0.0-beta.2
  - @tinycloud/node-sdk@3.0.0-beta.2

## 0.3.3-beta.1

### Patch Changes

- Updated dependencies [4b60562]
  - @tinycloud/sdk-core@3.0.0-beta.1
  - @tinycloud/node-sdk@3.0.0-beta.1

## 0.3.3-beta.0

### Patch Changes

- Updated dependencies [ce34dc1]
  - @tinycloud/sdk-core@3.0.0-beta.0
  - @tinycloud/node-sdk@3.0.0-beta.0

## 0.3.2

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- Updated dependencies [746cb02]
- Updated dependencies [d1d675b]
- Updated dependencies [44ecf56]
- Updated dependencies [b38dd12]
- Updated dependencies [68faad4]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
- Updated dependencies [55e76c5]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [10363b6]
- Updated dependencies [b5d2e10]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/sdk-core@2.11.0
  - @tinycloud/node-sdk@2.11.0

## 0.3.2-beta.11

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0-beta.12
  - @tinycloud/sdk-core@2.11.0-beta.12

## 0.3.2-beta.10

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/sdk-core@2.11.0-beta.11
  - @tinycloud/node-sdk@2.11.0-beta.11

## 0.3.2-beta.9

### Patch Changes

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/sdk-core@2.11.0-beta.10
  - @tinycloud/node-sdk@2.11.0-beta.10

## 0.3.2-beta.8

### Patch Changes

- Updated dependencies [10363b6]
  - @tinycloud/sdk-core@2.11.0-beta.9
  - @tinycloud/node-sdk@2.11.0-beta.9

## 0.3.2-beta.7

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/sdk-core@2.11.0-beta.8
  - @tinycloud/node-sdk@2.11.0-beta.8

## 0.3.2-beta.6

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- Updated dependencies [44ecf56]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/node-sdk@2.11.0-beta.7
  - @tinycloud/sdk-core@2.11.0-beta.7

## 0.3.2-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/sdk-core@2.11.0-beta.5
  - @tinycloud/node-sdk@2.11.0-beta.5

## 0.3.2-beta.3

### Patch Changes

- Updated dependencies [746cb02]
  - @tinycloud/sdk-core@2.11.0-beta.4
  - @tinycloud/node-sdk@2.11.0-beta.4

## 0.3.2-beta.2

### Patch Changes

- Updated dependencies [55e76c5]
  - @tinycloud/sdk-core@2.11.0-beta.3
  - @tinycloud/node-sdk@2.11.0-beta.3

## 0.3.2-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/sdk-core@2.11.0-beta.1
  - @tinycloud/node-sdk@2.11.0-beta.1

## 0.3.2-beta.0

### Patch Changes

- Updated dependencies [b5d2e10]
  - @tinycloud/sdk-core@2.11.0-beta.0
  - @tinycloud/node-sdk@2.11.0-beta.0

## 0.3.1

### Patch Changes

- Updated dependencies [28cc430]
- Updated dependencies [48a5408]
  - @tinycloud/node-sdk@2.10.0
  - @tinycloud/sdk-core@2.10.0

## 0.3.1-beta.1

### Patch Changes

- Updated dependencies [48a5408]
  - @tinycloud/sdk-core@2.10.0-beta.1
  - @tinycloud/node-sdk@2.10.0-beta.1

## 0.3.1-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0
  - @tinycloud/sdk-core@2.10.0-beta.0

## 0.3.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

## 0.3.0-beta.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

## 0.2.1

### Patch Changes

- Updated dependencies [9afb09c]
  - @tinycloud/sdk-core@2.9.0
  - @tinycloud/node-sdk@2.9.0

## 0.2.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- @tinycloud/node-sdk@2.8.0
- @tinycloud/sdk-core@2.8.0

## 0.2.0-beta.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- @tinycloud/node-sdk@2.8.0-beta.0
- @tinycloud/sdk-core@2.8.0-beta.0

## 0.1.0

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.
- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- 1c73181: Add the public `@tinycloud/operations/artifacts` authority and v1 permission-artifact APIs.

### Patch Changes

- 492a656: Bind request-bound delegation imports to the selected profile host before activation, including legacy hostless portable delegations.
- 5172cf9: Reject persisted profiles whose posture conflicts with their authentication method so delegated sessions cannot enter local owner authentication.
- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- 39cc055: Register the reviewed I2 status and authentication operations and publish their deterministic catalog metadata.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 96b9e21: Require explicit owner-profile opt-in for authenticated operations, harden exact delegation request/import handling, and expose verified base-session authority to canonical auth operations.
- 160c16e: Canonicalize JSON object keys using RFC 8785 raw UTF-16 code-unit ordering,
  including astral-plane keys. Update operations' exact sdk-core dependency at
  release so retry digests use the corrected canonicalization.
- c62f72a: Add the experimental delegated stdio MCP projection with generated operation
  schemas, pinned startup profile selection, canonical structured envelopes, and
  the packaged delegated-secrets workflow. Expose the existing operations-owned
  profile-name resolver needed to pin a projection process before stdio starts.
- Updated dependencies [367c17c]
- Updated dependencies [1269a58]
- Updated dependencies [f6048b7]
- Updated dependencies [f7a1d4f]
- Updated dependencies [f5b1c75]
- Updated dependencies [4dee0a9]
- Updated dependencies [b982b90]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [96b9e21]
  - @tinycloud/node-sdk@2.7.0
  - @tinycloud/sdk-core@2.7.0

## 0.1.0-beta.2

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- Updated dependencies [1269a58]
  - @tinycloud/node-sdk@2.7.0-beta.5

## 0.1.0-beta.1

### Minor Changes

- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- 1c73181: Add the public `@tinycloud/operations/artifacts` authority and v1 permission-artifact APIs.

### Patch Changes

- 492a656: Bind request-bound delegation imports to the selected profile host before activation, including legacy hostless portable delegations.
- 5172cf9: Reject persisted profiles whose posture conflicts with their authentication method so delegated sessions cannot enter local owner authentication.
- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- 39cc055: Register the reviewed I2 status and authentication operations and publish their deterministic catalog metadata.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 96b9e21: Require explicit owner-profile opt-in for authenticated operations, harden exact delegation request/import handling, and expose verified base-session authority to canonical auth operations.
- 160c16e: Canonicalize JSON object keys using RFC 8785 raw UTF-16 code-unit ordering,
  including astral-plane keys. Update operations' exact sdk-core dependency at
  release so retry digests use the corrected canonicalization.
- c62f72a: Add the experimental delegated stdio MCP projection with generated operation
  schemas, pinned startup profile selection, canonical structured envelopes, and
  the packaged delegated-secrets workflow. Expose the existing operations-owned
  profile-name resolver needed to pin a projection process before stdio starts.
- Updated dependencies [f5b1c75]
- Updated dependencies [b982b90]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [96b9e21]
  - @tinycloud/sdk-core@2.7.0-beta.4
  - @tinycloud/node-sdk@2.7.0-beta.4

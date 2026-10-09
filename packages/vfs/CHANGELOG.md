# @tinycloud/vfs

## 0.2.0-beta.16

### Patch Changes

- Updated dependencies [1f44a61]
  - @tinycloud/node-sdk@3.1.0-beta.15

## 0.2.0-beta.15

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.14

## 0.2.0-beta.14

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.13

## 0.2.0-beta.13

### Patch Changes

- Updated dependencies [2c703fc]
  - @tinycloud/node-sdk@3.1.0-beta.12

## 0.2.0-beta.12

### Patch Changes

- Updated dependencies [02b6773]
  - @tinycloud/node-sdk@3.1.0-beta.11

## 0.2.0-beta.11

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.10

## 0.2.0-beta.10

### Patch Changes

- Updated dependencies [698654e]
  - @tinycloud/node-sdk@3.1.0-beta.9

## 0.2.0-beta.9

### Patch Changes

- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
  - @tinycloud/node-sdk@3.1.0-beta.8

## 0.2.0-beta.8

### Minor Changes

- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

## 0.1.15-beta.7

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.7

## 0.1.15-beta.6

### Patch Changes

- Updated dependencies [045c2d3]
  - @tinycloud/node-sdk@3.1.0-beta.6

## 0.1.15-beta.5

### Patch Changes

- Updated dependencies [b7fd979]
  - @tinycloud/node-sdk@3.1.0-beta.5

## 0.1.15-beta.4

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.4

## 0.1.15-beta.3

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.3

## 0.1.15-beta.2

### Patch Changes

- Updated dependencies [a074fa5]
  - @tinycloud/node-sdk@3.1.0-beta.2

## 0.1.15-beta.1

### Patch Changes

- Updated dependencies [0652195]
  - @tinycloud/node-sdk@3.1.0-beta.1

## 0.1.15-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.1-beta.0

## 0.1.14

### Patch Changes

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
- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0

## 0.1.14-beta.18

### Patch Changes

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20

## 0.1.14-beta.17

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/node-sdk@3.0.0-beta.19

## 0.1.14-beta.16

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.18

## 0.1.14-beta.15

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.17

## 0.1.14-beta.14

### Patch Changes

- Updated dependencies [48eca36]
  - @tinycloud/node-sdk@3.0.0-beta.16

## 0.1.14-beta.13

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.15

## 0.1.14-beta.12

### Patch Changes

- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14

## 0.1.14-beta.11

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/node-sdk@3.0.0-beta.13

## 0.1.14-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.12

## 0.1.14-beta.9

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.11

## 0.1.14-beta.8

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/node-sdk@3.0.0-beta.10

## 0.1.14-beta.7

### Patch Changes

- Updated dependencies [c690844]
  - @tinycloud/node-sdk@3.0.0-beta.9

## 0.1.14-beta.6

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/node-sdk@3.0.0-beta.8

## 0.1.14-beta.5

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.7

## 0.1.14-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/node-sdk@3.0.0-beta.6

## 0.1.14-beta.3

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.5

## 0.1.14-beta.2

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.2

## 0.1.14-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.1

## 0.1.14-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.0

## 0.1.13

### Patch Changes

- Updated dependencies [746cb02]
- Updated dependencies [d1d675b]
- Updated dependencies [44ecf56]
- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0

## 0.1.13-beta.10

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0-beta.12

## 0.1.13-beta.9

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/node-sdk@2.11.0-beta.11

## 0.1.13-beta.8

### Patch Changes

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/node-sdk@2.11.0-beta.10

## 0.1.13-beta.7

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.9

## 0.1.13-beta.6

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.8

## 0.1.13-beta.5

### Patch Changes

- Updated dependencies [44ecf56]
  - @tinycloud/node-sdk@2.11.0-beta.7

## 0.1.13-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/node-sdk@2.11.0-beta.5

## 0.1.13-beta.3

### Patch Changes

- Updated dependencies [746cb02]
  - @tinycloud/node-sdk@2.11.0-beta.4

## 0.1.13-beta.2

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.3

## 0.1.13-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/node-sdk@2.11.0-beta.1

## 0.1.13-beta.0

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.0

## 0.1.12

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0

## 0.1.12-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.10.0-beta.1

## 0.1.12-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0

## 0.1.11

### Patch Changes

- Updated dependencies [9afb09c]
  - @tinycloud/node-sdk@2.9.0

## 0.1.10

### Patch Changes

- @tinycloud/node-sdk@2.8.0

## 0.1.10-beta.0

### Patch Changes

- @tinycloud/node-sdk@2.8.0-beta.0

## 0.1.9

### Patch Changes

- Updated dependencies [367c17c]
- Updated dependencies [1269a58]
- Updated dependencies [f6048b7]
- Updated dependencies [f7a1d4f]
- Updated dependencies [f5b1c75]
- Updated dependencies [4dee0a9]
- Updated dependencies [b982b90]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [96b9e21]
  - @tinycloud/node-sdk@2.7.0

## 0.1.9-beta.5

### Patch Changes

- Updated dependencies [1269a58]
  - @tinycloud/node-sdk@2.7.0-beta.5

## 0.1.9-beta.4

### Patch Changes

- Updated dependencies [f5b1c75]
- Updated dependencies [b982b90]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [96b9e21]
  - @tinycloud/node-sdk@2.7.0-beta.4

## 0.1.9-beta.3

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/node-sdk@2.7.0-beta.3

## 0.1.9-beta.2

### Patch Changes

- Updated dependencies [4dee0a9]
  - @tinycloud/node-sdk@2.7.0-beta.2

## 0.1.9-beta.1

### Patch Changes

- Updated dependencies [367c17c]
  - @tinycloud/node-sdk@2.6.4-beta.1

## 0.1.9-beta.0

### Patch Changes

- Updated dependencies [f6048b7]
  - @tinycloud/node-sdk@2.6.4-beta.0

## 0.1.8

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/node-sdk@2.6.3

## 0.1.8-beta.0

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/node-sdk@2.6.3-beta.0

## 0.1.7

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2

## 0.1.7-beta.0

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2-beta.0

## 0.1.6

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/node-sdk@2.6.1

## 0.1.6-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.6.1-beta.1

## 0.1.6-beta.0

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/node-sdk@2.6.1-beta.0

## 0.1.5

### Patch Changes

- Updated dependencies [ac48f85]
- Updated dependencies [2f31800]
- Updated dependencies [3ad0635]
- Updated dependencies [e07823b]
  - @tinycloud/node-sdk@2.6.0

## 0.1.5-beta.3

### Patch Changes

- Updated dependencies [e07823b]
  - @tinycloud/node-sdk@2.6.0-beta.3

## 0.1.5-beta.2

### Patch Changes

- Updated dependencies [3ad0635]
  - @tinycloud/node-sdk@2.6.0-beta.2

## 0.1.5-beta.1

### Patch Changes

- Updated dependencies [ac48f85]
  - @tinycloud/node-sdk@2.6.0-beta.1

## 0.1.5-beta.0

### Patch Changes

- Updated dependencies [2f31800]
  - @tinycloud/node-sdk@2.6.0-beta.0

## 0.1.4

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1

## 0.1.4-beta.0

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1-beta.0

## 0.1.3

### Patch Changes

- Updated dependencies [cbd5dcc]
- Updated dependencies [dda499e]
  - @tinycloud/node-sdk@2.5.0

## 0.1.3-beta.1

### Patch Changes

- Updated dependencies [dda499e]
  - @tinycloud/node-sdk@2.5.0-beta.1

## 0.1.3-beta.0

### Patch Changes

- Updated dependencies [cbd5dcc]
  - @tinycloud/node-sdk@2.4.1-beta.0

## 0.1.2

### Patch Changes

- Updated dependencies [6b554d6]
- Updated dependencies [0d397a8]
- Updated dependencies [895804a]
- Updated dependencies [6622043]
- Updated dependencies [75bebb1]
- Updated dependencies [0e8ccc6]
- Updated dependencies [934534d]
- Updated dependencies [79dd26c]
- Updated dependencies [08e292d]
- Updated dependencies [7c5fe21]
- Updated dependencies [eb44380]
- Updated dependencies [27f97d8]
- Updated dependencies [aa050d1]
- Updated dependencies [8e8f7e8]
- Updated dependencies [fa4a7c7]
- Updated dependencies [d4a0a69]
- Updated dependencies [a22a7f0]
- Updated dependencies [42f1235]
- Updated dependencies [b6c3fd8]
  - @tinycloud/node-sdk@2.4.0

## 0.1.2-beta.18

### Patch Changes

- Updated dependencies [42f1235]
  - @tinycloud/node-sdk@2.4.0-beta.19

## 0.1.2-beta.17

### Patch Changes

- Updated dependencies [08e292d]
  - @tinycloud/node-sdk@2.4.0-beta.18

## 0.1.2-beta.16

### Patch Changes

- Updated dependencies [6622043]
  - @tinycloud/node-sdk@2.4.0-beta.17

## 0.1.2-beta.15

### Patch Changes

- Updated dependencies [eb44380]
  - @tinycloud/node-sdk@2.4.0-beta.16

## 0.1.2-beta.14

### Patch Changes

- @tinycloud/node-sdk@2.4.0-beta.15

## 0.1.2-beta.13

### Patch Changes

- Updated dependencies [a22a7f0]
  - @tinycloud/node-sdk@2.4.0-beta.14

## 0.1.2-beta.12

### Patch Changes

- @tinycloud/node-sdk@2.4.0-beta.13

## 0.1.2-beta.11

### Patch Changes

- Updated dependencies [fa4a7c7]
  - @tinycloud/node-sdk@2.4.0-beta.12

## 0.1.2-beta.10

### Patch Changes

- Updated dependencies [aa050d1]
  - @tinycloud/node-sdk@2.4.0-beta.11

## 0.1.2-beta.9

### Patch Changes

- Updated dependencies [27f97d8]
- Updated dependencies [d4a0a69]
  - @tinycloud/node-sdk@2.4.0-beta.10

## 0.1.2-beta.8

### Patch Changes

- Updated dependencies [0d397a8]
  - @tinycloud/node-sdk@2.4.0-beta.9

## 0.1.2-beta.7

### Patch Changes

- Updated dependencies [895804a]
  - @tinycloud/node-sdk@2.4.0-beta.8

## 0.1.2-beta.6

### Patch Changes

- Updated dependencies [75bebb1]
  - @tinycloud/node-sdk@2.4.0-beta.7

## 0.1.2-beta.5

### Patch Changes

- Updated dependencies [6b554d6]
  - @tinycloud/node-sdk@2.4.0-beta.6

## 0.1.2-beta.4

### Patch Changes

- Updated dependencies [7c5fe21]
  - @tinycloud/node-sdk@2.4.0-beta.5

## 0.1.2-beta.3

### Patch Changes

- Updated dependencies [8e8f7e8]
  - @tinycloud/node-sdk@2.4.0-beta.3

## 0.1.2-beta.2

### Patch Changes

- Updated dependencies [934534d]
  - @tinycloud/node-sdk@2.4.0-beta.2

## 0.1.2-beta.1

### Patch Changes

- Updated dependencies [0e8ccc6]
  - @tinycloud/node-sdk@2.4.0-beta.1

## 0.1.2-beta.0

### Patch Changes

- Updated dependencies [b6c3fd8]
  - @tinycloud/node-sdk@2.3.1-beta.0

## 0.1.1

### Patch Changes

- Updated dependencies [9ee7404]
- Updated dependencies [a92819d]
- Updated dependencies [90bdc18]
- Updated dependencies [9550c18]
- Updated dependencies [ddab8fa]
- Updated dependencies [fb96a1e]
- Updated dependencies [d606baf]
- Updated dependencies [c7676d6]
- Updated dependencies [f11e468]
  - @tinycloud/node-sdk@2.3.0

## 0.1.1-beta.8

### Patch Changes

- Updated dependencies [ddab8fa]
- Updated dependencies [f11e468]
  - @tinycloud/node-sdk@2.3.0-beta.8

## 0.1.1-beta.7

### Patch Changes

- @tinycloud/node-sdk@2.3.0-beta.7

## 0.1.1-beta.6

### Patch Changes

- Updated dependencies [c7676d6]
  - @tinycloud/node-sdk@2.3.0-beta.6

## 0.1.1-beta.5

### Patch Changes

- Updated dependencies [d606baf]
  - @tinycloud/node-sdk@2.3.0-beta.5

## 0.1.1-beta.4

### Patch Changes

- Updated dependencies [90bdc18]
  - @tinycloud/node-sdk@2.3.0-beta.4

## 0.1.1-beta.3

### Patch Changes

- Updated dependencies [a92819d]
  - @tinycloud/node-sdk@2.3.0-beta.3

## 0.1.1-beta.2

### Patch Changes

- Updated dependencies [fb96a1e]
  - @tinycloud/node-sdk@2.3.0-beta.2

## 0.1.1-beta.1

### Patch Changes

- Updated dependencies [9550c18]
  - @tinycloud/node-sdk@2.2.1-beta.1

## 0.1.1-beta.0

### Patch Changes

- Updated dependencies [9ee7404]
  - @tinycloud/node-sdk@2.2.1-beta.0

## 0.1.0

### Minor Changes

- c1d4ecd: Initial beta release of `@tinycloud/vfs` for the TinyCloud VFS package.

### Patch Changes

- ce05b92: Update `@platformatic/vfs` to 0.4.0 and refresh TypeScript dev dependencies used by the workspace builds.
- Updated dependencies [9ab4644]
- Updated dependencies [9ff4b34]
- Updated dependencies [0401ff8]
- Updated dependencies [04a0d5c]
- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
- Updated dependencies [b9a24b5]
- Updated dependencies [6561589]
- Updated dependencies [010ee0f]
- Updated dependencies [8367cef]
- Updated dependencies [35212bb]
- Updated dependencies [46f126a]
- Updated dependencies [f43143d]
- Updated dependencies [78ef7eb]
  - @tinycloud/node-sdk@2.2.0

## 0.1.0-beta.14

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.13

## 0.1.0-beta.13

### Patch Changes

- Updated dependencies [010ee0f]
- Updated dependencies [f43143d]
  - @tinycloud/node-sdk@2.2.0-beta.12

## 0.1.0-beta.12

### Patch Changes

- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
  - @tinycloud/node-sdk@2.2.0-beta.11

## 0.1.0-beta.11

### Patch Changes

- Updated dependencies [35212bb]
  - @tinycloud/node-sdk@2.2.0-beta.10

## 0.1.0-beta.10

### Patch Changes

- Updated dependencies [78ef7eb]
  - @tinycloud/node-sdk@2.2.0-beta.9

## 0.1.0-beta.9

### Patch Changes

- Updated dependencies [8367cef]
  - @tinycloud/node-sdk@2.2.0-beta.8

## 0.1.0-beta.8

### Patch Changes

- Updated dependencies [46f126a]
  - @tinycloud/node-sdk@2.2.0-beta.7

## 0.1.0-beta.7

### Patch Changes

- Updated dependencies [b9a24b5]
  - @tinycloud/node-sdk@2.2.0-beta.6

## 0.1.0-beta.6

### Patch Changes

- ce05b92: Update `@platformatic/vfs` to 0.4.0 and refresh TypeScript dev dependencies used by the workspace builds.
- Updated dependencies [9ab4644]
  - @tinycloud/node-sdk@2.2.0-beta.5

## 0.1.0-beta.5

### Patch Changes

- Updated dependencies [0401ff8]
  - @tinycloud/node-sdk@2.2.0-beta.4

## 0.1.0-beta.4

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.3

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [04a0d5c]
  - @tinycloud/node-sdk@2.2.0-beta.2

## 0.1.0-beta.2

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.1

## 0.1.0-beta.1

### Patch Changes

- Updated dependencies [6561589]
  - @tinycloud/node-sdk@2.2.0-beta.0

## 0.1.0-beta.0

### Minor Changes

- c1d4ecd: Initial beta release of `@tinycloud/vfs` for the TinyCloud VFS package.

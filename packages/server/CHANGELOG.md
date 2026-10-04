# @tinycloud/server

## 2.4.13-beta.1

### Patch Changes

- 0652195: Session refresh and account-registry retry now decide from the typed HTTP status instead of the error text.
  - **Typed classification.** The new `authorizationVerdictOf(error)` reads a 4xx/5xx `status`, `statusCode` or `meta.status`, or the `AUTH_UNAUTHORIZED` code. It follows the `cause` chain from the outside in and skips success statuses. The outermost error status decides.
  - **Session refresh.** `withSessionRefresh` signs in again only after a 401. A 403 never triggers a refresh, whatever its body says. To keep the typed status, throw the `ServiceError` or an `Error` with it as `cause`.
  - **Untyped errors.** Message matching is now only a fallback. It drops double-quoted strings first (escape-aware), then takes the first 400-599 status in one of the SDK's diagnostic positions (`: 403` followed by whitespace or the end, `HTTP 401`, `returned 401`, `rejected (401)`, or a trailing `(403)`), and refreshes only if that status is 401. With no status, session wording on the original message decides. Numbers inside paths, ids, ports, byte counts or quoted keys no longer count.
  - **KV messages.** KV 401/403 errors now read `<operation>: <status> - <server text>`. They keep the server text, and `meta` is unchanged. Keys in KV error messages are written with `JSON.stringify`, so a key containing quotes stays well-formed.
  - **Hooks errors.** `HooksService` HTTP failures now carry `meta.status` (and `statusText`).
  - **Account-registry sync.** The wrappers keep the service error or host result as `cause`. These wrappers are `applications.register`, `spaces.syncAccessible`, owned-space activation, owned-space hosting and post-create re-activation. A 401 or 403 therefore stops after one request, even when the body is `Forbidden` or empty, and every wrapper message carries the status.
  - **Owner delegation import.** A failed activation during owner delegation import now keeps the activation result as `cause`.
  - **New method.** `NodeUserAuthorization.hostOwnedSpaceResult()` returns the full `SpaceHostResult`. `hostOwnedSpace()` still returns `boolean`.

- Updated dependencies [0652195]
  - @tinycloud/sdk-core@3.1.0-beta.1
  - @tinycloud/node-sdk@3.1.0-beta.1

## 2.4.13-beta.0

### Patch Changes

- @tinycloud/sdk-core@3.0.1-beta.0
- @tinycloud/node-sdk@3.0.1-beta.0

## 2.4.12

### Patch Changes

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

## 2.4.12-beta.18

### Patch Changes

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20

## 2.4.12-beta.17

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/sdk-core@3.0.0-beta.19
  - @tinycloud/node-sdk@3.0.0-beta.19

## 2.4.12-beta.16

### Patch Changes

- Updated dependencies [a132b77]
  - @tinycloud/sdk-core@3.0.0-beta.18
  - @tinycloud/node-sdk@3.0.0-beta.18

## 2.4.12-beta.15

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.17
- @tinycloud/node-sdk@3.0.0-beta.17

## 2.4.12-beta.14

### Patch Changes

- Updated dependencies [48eca36]
  - @tinycloud/node-sdk@3.0.0-beta.16

## 2.4.12-beta.13

### Patch Changes

- Updated dependencies [2e9db6e]
  - @tinycloud/sdk-core@3.0.0-beta.15
  - @tinycloud/node-sdk@3.0.0-beta.15

## 2.4.12-beta.12

### Patch Changes

- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14
  - @tinycloud/sdk-core@3.0.0-beta.14

## 2.4.12-beta.11

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/sdk-core@3.0.0-beta.13
  - @tinycloud/node-sdk@3.0.0-beta.13

## 2.4.12-beta.10

### Patch Changes

- Updated dependencies [cc27c3a]
  - @tinycloud/sdk-core@3.0.0-beta.12
  - @tinycloud/node-sdk@3.0.0-beta.12

## 2.4.12-beta.9

### Patch Changes

- Updated dependencies [12e5c4d]
  - @tinycloud/sdk-core@3.0.0-beta.11
  - @tinycloud/node-sdk@3.0.0-beta.11

## 2.4.12-beta.8

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/sdk-core@3.0.0-beta.10
  - @tinycloud/node-sdk@3.0.0-beta.10

## 2.4.12-beta.7

### Patch Changes

- Updated dependencies [c690844]
  - @tinycloud/sdk-core@3.0.0-beta.9
  - @tinycloud/node-sdk@3.0.0-beta.9

## 2.4.12-beta.6

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/sdk-core@3.0.0-beta.8
  - @tinycloud/node-sdk@3.0.0-beta.8

## 2.4.12-beta.5

### Patch Changes

- Updated dependencies [657c1ff]
  - @tinycloud/sdk-core@3.0.0-beta.7
  - @tinycloud/node-sdk@3.0.0-beta.7

## 2.4.12-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/sdk-core@3.0.0-beta.6
  - @tinycloud/node-sdk@3.0.0-beta.6

## 2.4.12-beta.3

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.5
- @tinycloud/node-sdk@3.0.0-beta.5

## 2.4.12-beta.2

### Patch Changes

- Updated dependencies [b0069f7]
  - @tinycloud/sdk-core@3.0.0-beta.2
  - @tinycloud/node-sdk@3.0.0-beta.2

## 2.4.12-beta.1

### Patch Changes

- Updated dependencies [4b60562]
  - @tinycloud/sdk-core@3.0.0-beta.1
  - @tinycloud/node-sdk@3.0.0-beta.1

## 2.4.12-beta.0

### Patch Changes

- Updated dependencies [ce34dc1]
  - @tinycloud/sdk-core@3.0.0-beta.0
  - @tinycloud/node-sdk@3.0.0-beta.0

## 2.4.11

### Patch Changes

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

## 2.4.11-beta.10

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0-beta.12
  - @tinycloud/sdk-core@2.11.0-beta.12

## 2.4.11-beta.9

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/sdk-core@2.11.0-beta.11
  - @tinycloud/node-sdk@2.11.0-beta.11

## 2.4.11-beta.8

### Patch Changes

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/sdk-core@2.11.0-beta.10
  - @tinycloud/node-sdk@2.11.0-beta.10

## 2.4.11-beta.7

### Patch Changes

- Updated dependencies [10363b6]
  - @tinycloud/sdk-core@2.11.0-beta.9
  - @tinycloud/node-sdk@2.11.0-beta.9

## 2.4.11-beta.6

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/sdk-core@2.11.0-beta.8
  - @tinycloud/node-sdk@2.11.0-beta.8

## 2.4.11-beta.5

### Patch Changes

- Updated dependencies [44ecf56]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/node-sdk@2.11.0-beta.7
  - @tinycloud/sdk-core@2.11.0-beta.7

## 2.4.11-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/sdk-core@2.11.0-beta.5
  - @tinycloud/node-sdk@2.11.0-beta.5

## 2.4.11-beta.3

### Patch Changes

- Updated dependencies [746cb02]
  - @tinycloud/sdk-core@2.11.0-beta.4
  - @tinycloud/node-sdk@2.11.0-beta.4

## 2.4.11-beta.2

### Patch Changes

- Updated dependencies [55e76c5]
  - @tinycloud/sdk-core@2.11.0-beta.3
  - @tinycloud/node-sdk@2.11.0-beta.3

## 2.4.11-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/sdk-core@2.11.0-beta.1
  - @tinycloud/node-sdk@2.11.0-beta.1

## 2.4.11-beta.0

### Patch Changes

- Updated dependencies [b5d2e10]
  - @tinycloud/sdk-core@2.11.0-beta.0
  - @tinycloud/node-sdk@2.11.0-beta.0

## 2.4.10

### Patch Changes

- Updated dependencies [28cc430]
- Updated dependencies [48a5408]
  - @tinycloud/node-sdk@2.10.0
  - @tinycloud/sdk-core@2.10.0

## 2.4.10-beta.1

### Patch Changes

- Updated dependencies [48a5408]
  - @tinycloud/sdk-core@2.10.0-beta.1
  - @tinycloud/node-sdk@2.10.0-beta.1

## 2.4.10-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0
  - @tinycloud/sdk-core@2.10.0-beta.0

## 2.4.9

### Patch Changes

- Updated dependencies [9afb09c]
  - @tinycloud/sdk-core@2.9.0
  - @tinycloud/node-sdk@2.9.0

## 2.4.8

### Patch Changes

- @tinycloud/node-sdk@2.8.0
- @tinycloud/sdk-core@2.8.0

## 2.4.8-beta.0

### Patch Changes

- @tinycloud/node-sdk@2.8.0-beta.0
- @tinycloud/sdk-core@2.8.0-beta.0

## 2.4.7

### Patch Changes

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

## 2.4.7-beta.5

### Patch Changes

- Updated dependencies [1269a58]
  - @tinycloud/node-sdk@2.7.0-beta.5

## 2.4.7-beta.4

### Patch Changes

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

## 2.4.7-beta.3

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/sdk-core@2.7.0-beta.3
  - @tinycloud/node-sdk@2.7.0-beta.3

## 2.4.7-beta.2

### Patch Changes

- Updated dependencies [4dee0a9]
  - @tinycloud/sdk-core@2.7.0-beta.2
  - @tinycloud/node-sdk@2.7.0-beta.2

## 2.4.7-beta.1

### Patch Changes

- Updated dependencies [367c17c]
  - @tinycloud/node-sdk@2.6.4-beta.1

## 2.4.7-beta.0

### Patch Changes

- Updated dependencies [f6048b7]
  - @tinycloud/node-sdk@2.6.4-beta.0

## 2.4.6

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/sdk-core@2.6.3
  - @tinycloud/node-sdk@2.6.3

## 2.4.6-beta.0

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/sdk-core@2.6.3-beta.0
  - @tinycloud/node-sdk@2.6.3-beta.0

## 2.4.5

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2
  - @tinycloud/sdk-core@2.6.2

## 2.4.5-beta.0

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2-beta.0
  - @tinycloud/sdk-core@2.6.2-beta.0

## 2.4.4

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/sdk-core@2.6.1
  - @tinycloud/node-sdk@2.6.1

## 2.4.4-beta.1

### Patch Changes

- @tinycloud/sdk-core@2.6.1-beta.1
- @tinycloud/node-sdk@2.6.1-beta.1

## 2.4.4-beta.0

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/sdk-core@2.6.1-beta.0
  - @tinycloud/node-sdk@2.6.1-beta.0

## 2.4.3

### Patch Changes

- Updated dependencies [ac48f85]
- Updated dependencies [2f31800]
- Updated dependencies [3ad0635]
- Updated dependencies [e07823b]
  - @tinycloud/node-sdk@2.6.0
  - @tinycloud/sdk-core@2.6.0

## 2.4.3-beta.3

### Patch Changes

- Updated dependencies [e07823b]
  - @tinycloud/sdk-core@2.6.0-beta.3
  - @tinycloud/node-sdk@2.6.0-beta.3

## 2.4.3-beta.2

### Patch Changes

- Updated dependencies [3ad0635]
  - @tinycloud/sdk-core@2.6.0-beta.2
  - @tinycloud/node-sdk@2.6.0-beta.2

## 2.4.3-beta.1

### Patch Changes

- Updated dependencies [ac48f85]
  - @tinycloud/node-sdk@2.6.0-beta.1
  - @tinycloud/sdk-core@2.6.0-beta.1

## 2.4.3-beta.0

### Patch Changes

- Updated dependencies [2f31800]
  - @tinycloud/sdk-core@2.6.0-beta.0
  - @tinycloud/node-sdk@2.6.0-beta.0

## 2.4.2

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1
  - @tinycloud/sdk-core@2.5.1

## 2.4.2-beta.0

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1-beta.0
  - @tinycloud/sdk-core@2.5.1-beta.0

## 2.4.1

### Patch Changes

- Updated dependencies [cbd5dcc]
- Updated dependencies [dda499e]
  - @tinycloud/node-sdk@2.5.0
  - @tinycloud/sdk-core@2.5.0

## 2.4.1-beta.1

### Patch Changes

- Updated dependencies [dda499e]
  - @tinycloud/sdk-core@2.5.0-beta.1
  - @tinycloud/node-sdk@2.5.0-beta.1

## 2.4.1-beta.0

### Patch Changes

- Updated dependencies [cbd5dcc]
  - @tinycloud/node-sdk@2.4.1-beta.0

## 2.4.0

### Minor Changes

- 81269b3: Add reusable server and agent helpers for stable did:pkh server identity,
  delegated TinyCloud secret reads, and single-signature SIWE session JWTs.

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
- Updated dependencies [7603d1f]
- Updated dependencies [27f97d8]
- Updated dependencies [aa050d1]
- Updated dependencies [8e8f7e8]
- Updated dependencies [fa4a7c7]
- Updated dependencies [d4a0a69]
- Updated dependencies [a22a7f0]
- Updated dependencies [42f1235]
- Updated dependencies [b6c3fd8]
  - @tinycloud/sdk-core@2.4.0
  - @tinycloud/node-sdk@2.4.0

## 2.4.0-beta.20

### Minor Changes

- 81269b3: Add reusable server and agent helpers for stable did:pkh server identity,
  delegated TinyCloud secret reads, and single-signature SIWE session JWTs.

# @tinycloudlabs/sdk-services-test

## 10.0.0-beta.9

### Patch Changes

- Updated dependencies [42f1235]
  - @tinycloud/sdk-services@2.4.0-beta.19

## 10.0.0-beta.8

### Patch Changes

- Updated dependencies [eb44380]
  - @tinycloud/sdk-services@2.4.0-beta.16

## 10.0.0-beta.7

### Patch Changes

- Updated dependencies [bd8a60f]
  - @tinycloud/sdk-services@2.4.0-beta.15

## 10.0.0-beta.6

### Patch Changes

- Updated dependencies [a22a7f0]
  - @tinycloud/sdk-services@2.4.0-beta.14

## 10.0.0-beta.5

### Patch Changes

- Updated dependencies [fa4a7c7]
  - @tinycloud/sdk-services@2.4.0-beta.12

## 10.0.0-beta.4

### Patch Changes

- Updated dependencies [aa050d1]
  - @tinycloud/sdk-services@2.4.0-beta.11

## 10.0.0-beta.3

### Patch Changes

- Updated dependencies [27f97d8]
- Updated dependencies [d4a0a69]
  - @tinycloud/sdk-services@2.4.0-beta.10

## 10.0.0-beta.2

### Patch Changes

- Updated dependencies [895804a]
  - @tinycloud/sdk-services@2.4.0-beta.8

## 10.0.0-beta.1

### Patch Changes

- Updated dependencies [934534d]
  - @tinycloud/sdk-services@2.4.0-beta.2

## 10.0.0-beta.0

### Patch Changes

- Updated dependencies [c94b81b]
  - @tinycloud/sdk-services@2.4.0-beta.1

## 9.0.0

### Patch Changes

- 4b3c50e: Add `batchPut` to `MockKVService` so the test utility package matches the current KV service interface.
- Updated dependencies [9ee7404]
- Updated dependencies [fb96a1e]
- Updated dependencies [d606baf]
- Updated dependencies [945f43c]
- Updated dependencies [c7676d6]
- Updated dependencies [f11e468]
  - @tinycloud/sdk-services@2.3.0

## 9.0.0-beta.5

### Patch Changes

- Updated dependencies [f11e468]
  - @tinycloud/sdk-services@2.3.0-beta.8

## 9.0.0-beta.4

### Patch Changes

- Updated dependencies [945f43c]
  - @tinycloud/sdk-services@2.3.0-beta.7

## 9.0.0-beta.3

### Patch Changes

- 4b3c50e: Add `batchPut` to `MockKVService` so the test utility package matches the current KV service interface.
- Updated dependencies [c7676d6]
  - @tinycloud/sdk-services@2.3.0-beta.6

## 9.0.0-beta.2

### Patch Changes

- Updated dependencies [d606baf]
  - @tinycloud/sdk-services@2.3.0-beta.5

## 9.0.0-beta.1

### Patch Changes

- Updated dependencies [fb96a1e]
  - @tinycloud/sdk-services@2.3.0-beta.2

## 8.0.1-beta.0

### Patch Changes

- Updated dependencies [9ee7404]
  - @tinycloud/sdk-services@2.2.1-beta.0

## 8.0.0

### Patch Changes

- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

- Updated dependencies [35212bb]
- Updated dependencies [46f126a]
- Updated dependencies [f43143d]
- Updated dependencies [976b3c7]
  - @tinycloud/sdk-services@2.2.0

## 8.0.0-beta.3

### Patch Changes

- Updated dependencies [976b3c7]
  - @tinycloud/sdk-services@2.2.0-beta.13

## 8.0.0-beta.2

### Patch Changes

- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

- Updated dependencies [f43143d]
  - @tinycloud/sdk-services@2.2.0-beta.12

## 8.0.0-beta.1

### Patch Changes

- Updated dependencies [35212bb]
  - @tinycloud/sdk-services@2.2.0-beta.10

## 8.0.0-beta.0

### Patch Changes

- Updated dependencies [46f126a]
  - @tinycloud/sdk-services@2.2.0-beta.7

## 7.0.0

### Patch Changes

- Updated dependencies [8abfb4e]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-services@2.1.0

## 7.0.0-beta.3

### Patch Changes

- Updated dependencies [c586568]
  - @tinycloud/sdk-services@2.1.0-beta.4

## 7.0.0-beta.2

### Patch Changes

- Updated dependencies [b88728a]
  - @tinycloud/sdk-services@2.1.0-beta.3

## 7.0.0-beta.1

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/sdk-services@2.1.0-beta.1

## 7.0.0-beta.0

### Patch Changes

- Updated dependencies [61c031d]
  - @tinycloud/sdk-services@2.1.0-beta.0

## 6.0.2

### Patch Changes

- Updated dependencies [7bb188f]
  - @tinycloud/sdk-services@2.0.2

## 6.0.1

### Patch Changes

- Updated dependencies [75690db]
  - @tinycloud/sdk-services@2.0.1

## 6.0.0

### Patch Changes

- Updated dependencies [8649de8]
- Updated dependencies [8649de8]
- Updated dependencies [def099d]
  - @tinycloud/sdk-services@1.7.0

## 5.0.0

### Patch Changes

- Updated dependencies [db50ae4]
  - @tinycloud/sdk-services@1.6.0

## 4.0.0

### Patch Changes

- Updated dependencies [9d6b79f]
  - @tinycloud/sdk-services@1.5.0

## 3.0.0

### Patch Changes

- Updated dependencies [94ad509]
  - @tinycloud/sdk-services@1.3.0

## 2.0.0

### Patch Changes

- Updated dependencies [ca9b2c6]
  - @tinycloud/sdk-services@1.2.0

## 1.0.0

### Patch Changes

- Updated dependencies [866981c]
  - @tinycloudlabs/sdk-services@1.0.0

# @tinycloud/courier

## 0.1.1-beta.0

### Patch Changes

- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1-beta.0

## 0.1.0

### Minor Changes

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.

### Patch Changes

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

- Updated dependencies [33efc8c]
- Updated dependencies [26f86bd]
- Updated dependencies [6a7fa64]
- Updated dependencies [4756923]
- Updated dependencies [4f851e6]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [47eb547]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0

## 0.1.0-beta.6

### Patch Changes

- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0-beta.9

## 0.1.0-beta.5

### Patch Changes

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

## 0.1.0-beta.4

### Patch Changes

- Updated dependencies [4756923]
  - @tinycloud/node-sdk@3.2.0-beta.8

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [26f86bd]
  - @tinycloud/node-sdk@3.2.0-beta.7

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [33efc8c]
  - @tinycloud/node-sdk@3.2.0-beta.6

## 0.1.0-beta.1

### Patch Changes

- Updated dependencies [47eb547]
  - @tinycloud/node-sdk@3.2.0-beta.5

## 0.1.0-beta.0

### Minor Changes

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.

# @tinycloud/cli

## 0.2.0

### Minor Changes

- 349ae57: Add `tc secrets` and `tc vars` CLI commands for managing encrypted secrets (vault) and plaintext variables (KV) with `secrets/` and `variables/` prefixes.

### Patch Changes

- 96ce2b3: Add `tc secrets manage` command to open the Secrets Manager web UI and `--space` flag for cross-space secret listing
  - @tinycloud/node-sdk@1.5.0

## 0.1.1

### Patch Changes

- Updated dependencies [da5a499]
  - @tinycloud/node-sdk-wasm@1.4.1
  - @tinycloud/node-sdk@1.4.1

## 0.1.0

### Minor Changes

- fd25623: Add browser-based delegate auth flow for CLI login via OpenKey. The CLI opens a `/delegate` page where users authenticate with a passkey, select a key, and approve a delegation. `TinyCloudNode.restoreSession()` allows injecting stored delegation data without a private key. Also fixes `kv list` result parsing and CLI process hang after auth.

### Patch Changes

- Updated dependencies [fd25623]
  - @tinycloud/node-sdk@1.4.0

## 0.0.2

### Patch Changes

- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
  - @tinycloud/node-sdk@1.3.0

## 0.0.1

### Patch Changes

- fe83edb: Initial release
- Updated dependencies [2014a20]
- Updated dependencies [bcbebbe]
- Updated dependencies [ca9b2c6]
  - @tinycloud/node-sdk@1.2.0

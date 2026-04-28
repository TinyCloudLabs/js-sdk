# @tinycloud/cli

## 0.4.8-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.1

## 0.4.8-beta.0

### Patch Changes

- Updated dependencies [6561589]
  - @tinycloud/node-sdk@2.2.0-beta.0
  - @tinycloud/node-sdk-wasm@1.7.3-beta.0

## 0.4.7

### Patch Changes

- fa130e0: Improve `tc sql` help output with SQLite workflow examples, parameter binding guidance, named database usage, and documented query/execute/export output shapes.
- Updated dependencies [303a8eb]
- Updated dependencies [8abfb4e]
- Updated dependencies [b55ffbd]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [9dad135]
- Updated dependencies [4fac901]
- Updated dependencies [9a9fae1]
- Updated dependencies [fb1d3fd]
- Updated dependencies [61c031d]
  - @tinycloud/node-sdk@2.1.0
  - @tinycloud/node-sdk-wasm@1.7.2

## 0.4.7-beta.7

### Patch Changes

- Updated dependencies [4fac901]
  - @tinycloud/node-sdk@2.1.0-beta.6

## 0.4.7-beta.6

### Patch Changes

- fa130e0: Improve `tc sql` help output with SQLite workflow examples, parameter binding guidance, named database usage, and documented query/execute/export output shapes.

## 0.4.7-beta.5

### Patch Changes

- Updated dependencies [303a8eb]
  - @tinycloud/node-sdk@2.1.0-beta.5

## 0.4.7-beta.4

### Patch Changes

- Updated dependencies [c586568]
  - @tinycloud/node-sdk@2.1.0-beta.4

## 0.4.7-beta.3

### Patch Changes

- Updated dependencies [b88728a]
  - @tinycloud/node-sdk@2.1.0-beta.3

## 0.4.7-beta.2

### Patch Changes

- Updated dependencies [9dad135]
  - @tinycloud/node-sdk@2.1.0-beta.2
  - @tinycloud/node-sdk-wasm@1.7.2-beta.2

## 0.4.7-beta.1

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/node-sdk@2.1.0-beta.1
  - @tinycloud/node-sdk-wasm@1.7.2-beta.1

## 0.4.7-beta.0

### Patch Changes

- Updated dependencies [b55ffbd]
- Updated dependencies [9a9fae1]
- Updated dependencies [61c031d]
  - @tinycloud/node-sdk-wasm@1.7.2-beta.0
  - @tinycloud/node-sdk@2.1.0-beta.0

## 0.4.6-beta.0

### Patch Changes

- Updated dependencies [fb1d3fd]
  - @tinycloud/node-sdk@2.0.4-beta.0

## 0.4.5

### Patch Changes

- Updated dependencies [e7e6ee7]
- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/node-sdk@2.0.3
  - @tinycloud/node-sdk-wasm@1.7.1

## 0.4.5-beta.2

### Patch Changes

- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/node-sdk@2.0.3-beta.3

## 0.4.5-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.0.3-beta.2

## 0.4.5-beta.0

### Patch Changes

- Updated dependencies [e7e6ee7]
  - @tinycloud/node-sdk@2.0.3-beta.0

## 0.4.4

### Patch Changes

- Updated dependencies [3401b3c]
  - @tinycloud/node-sdk@2.0.2

## 0.4.3

### Patch Changes

- 99219f8: Read version from package.json instead of hardcoding
  - @tinycloud/node-sdk@2.0.1

## 0.4.2

### Patch Changes

- Updated dependencies [6eebc29]
  - @tinycloud/node-sdk@2.0.0

## 0.4.1

### Patch Changes

- 3c82019: Add local Ethereum key authentication to `tc auth login`. Users can now choose between OpenKey (browser-based) and local key (Ethereum private key) auth methods. Local key auth generates a `did:pkh` identity and signs in directly without a browser, making it suitable for agents, CI/CD, and headless environments. Use `--method local` to skip the interactive prompt.

## 0.4.0

### Minor Changes

- f841493: Add `tc upgrade` command for self-updating the CLI to the latest published version. Detects the package manager used for the global install (bun or npm) and runs the appropriate upgrade command.

## 0.3.1

### Patch Changes

- Updated dependencies [8649de8]
- Updated dependencies [def099d]
  - @tinycloud/node-sdk-wasm@1.7.0
  - @tinycloud/node-sdk@1.7.0

## 0.3.0

### Minor Changes

- 153e9bb: Add `tc sql` and `tc duckdb` command groups to the CLI. SQL commands support `query`, `execute`, and `export`. DuckDB commands support `query`, `execute`, `describe`, `export`, and `import`. Both command groups accept `--db` for named databases and `--params` for bind parameters.

### Patch Changes

- Updated dependencies [db50ae4]
- Updated dependencies [bea6063]
  - @tinycloud/node-sdk@1.6.0
  - @tinycloud/node-sdk-wasm@1.6.0

## 0.2.0

### Minor Changes

- 349ae57: Add `tc secrets` and `tc vars` CLI commands for managing encrypted secrets (vault) and plaintext variables (KV) with `secrets/` and `variables/` prefixes.
- 8c08161: Updated CLI with usability improvements

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

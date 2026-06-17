# TinyCloud SDK

<img src="https://github.com/TinyCloudLabs/web-sdk/blob/master/documentation/static/img/tinycloudheader.png?raw=true" alt="TinyCloud" width="100%" />

TinyCloud SDK is a comprehensive toolkit for building decentralized applications with TinyCloud. It provides easy-to-use interfaces for storage, authentication, delegations, and sharing.

[![license](https://img.shields.io/badge/License-EGPL--1.5-green.svg)](https://github.com/TinyCloudLabs/web-sdk/blob/master/LICENSE.md)
[![version](https://img.shields.io/badge/Version-1.0.0-blue.svg)](https://github.com/TinyCloudLabs/web-sdk/releases)

## Features

- **Web3 Authentication** - Sign-in with Ethereum (SIWE) using your wallet
- **Space Management** - Create and manage user-owned data spaces
- **KV Storage** - Content-addressed key-value store scoped to user spaces
- **Delegation System** - Cryptographic capability chains for fine-grained access control
- **Sharing** - Portable delegation bundles for cross-user data sharing
- **Encryption Networks** - Network-scoped inline envelopes for secrets and vault data with `tinycloud.encryption/decrypt`
- **Protocol Version Check** - Automatic SDK-node compatibility verification during sign-in
- **Wallet Integration** - Seamless connection with popular Ethereum wallets (browser SDK)
- **Server Support** - Node.js SDK for server-side delegation chains and automation
- **Type Safety** - Written in TypeScript with comprehensive type definitions

## Packages

This monorepo contains the following packages:

### Core SDKs

| Package | Description | Platform |
|---------|-------------|----------|
| [`@tinycloud/web-sdk`](./packages/web-sdk/) | Browser SDK with wallet integration | Browser |
| [`@tinycloud/node-sdk`](./packages/node-sdk/) | Node.js SDK for server-side applications | Node.js |

### Core Libraries

| Package | Description |
|---------|-------------|
| [`@tinycloud/web-core`](./packages/web-core/) | Shared types and utilities for browser SDK |
| [`@tinycloud/sdk-core`](./packages/sdk-core/) | Core utilities and types shared across all SDKs |
| [`@tinycloud/sdk-rs`](./packages/sdk-rs/) | Rust implementation with cryptographic primitives |

### WASM Bindings

| Package | Description |
|---------|-------------|
| [`@tinycloud/web-sdk-wasm`](./packages/sdk-rs/web-sdk-wasm/) | WASM bindings for browser environments |
| [`@tinycloud/node-sdk-wasm`](./packages/sdk-rs/node-sdk-wasm/) | WASM bindings for Node.js environments |

## Quick Start

### Browser SDK

```bash
npm install @tinycloud/web-sdk
```

```typescript
import { TinyCloudWeb } from '@tinycloud/web-sdk';

const tc = new TinyCloudWeb();
await tc.signIn();

// KV storage
await tc.kv.put('myKey', { hello: 'world' });
const result = await tc.kv.get('myKey');
```

## Artifact Feed Submodule

This branch vendors the TinyCloud artifact feed as a git submodule at
[`submodules/feed`](./submodules/feed):

```bash
git submodule update --init --recursive submodules/feed
```

If you are cloning this project from scratch, either clone with submodules:

```bash
git clone --recurse-submodules https://github.com/TinyCloudLabs/js-sdk.git
```

or inflate the submodule after checkout or after a pull:

```bash
bun run artifact:inflate
```

`artifact:inflate` initializes `submodules/feed` and runs `bun install` inside
the feed repo. Use it whenever the checkout has an empty `submodules/feed`
directory or after a pull changes the recorded feed submodule commit.

### Run the artifact stack

The feed frontend talks directly to TinyCloud for artifact SQL/KV, and it talks
to the distillery agent backend for delegation and generation. For local stack
development, run both sides:

```bash
bun run artifact:dev
```

That command starts the distillery backend on `http://localhost:4097`, starts the
feed frontend on `http://localhost:5173`, and wires a matching local
`AGENT_API_TOKEN` / `VITE_AGENT_TOKEN` for the two processes.

To run the two sides manually in separate terminals:

```bash
# Terminal 1: distillery agent backend
export AGENT_API_TOKEN=local-artifact-dev
export AGENT_ALLOWED_ORIGIN=http://localhost:5173
bun run artifact:backend

# Terminal 2: feed frontend
export VITE_AGENT_HOST=http://localhost:4097
export VITE_AGENT_TOKEN=local-artifact-dev
bun run artifact:frontend
```

The backend script looks for a distillery checkout with
`harness/agent/src/server.ts`. In this Conductor workspace it detects the
distillery worktree automatically. In a standalone checkout, point it at the
backend explicitly:

```bash
DISTILLERY_REPO=/path/to/distillery bun run artifact:backend
```

### Test the artifact stack

```bash
bun run artifact:frontend:check
bun run artifact:backend:smoke
bun run artifact:test
```

`artifact:frontend:check` runs the feed typecheck and build.
`artifact:backend:smoke` starts the distillery backend on a temporary local port
and verifies `GET /agent/info`. `artifact:test` runs both checks, then runs
`bun test` in the detected distillery checkout.

### Node.js SDK

```bash
npm install @tinycloud/node-sdk
```

```typescript
import {
  DEFAULT_SIGNED_READ_URL_EXPIRY_MS,
  TinyCloudNode,
} from '@tinycloud/node-sdk';

const tc = new TinyCloudNode({
  privateKey: process.env.PRIVATE_KEY,
  domain: 'api.myapp.com',
});

await tc.signIn();

// KV storage
await tc.kv.put('myKey', { hello: 'world' });
const result = await tc.kv.get('myKey');

// Signed KV read URL for short-lived external reads.
// Requires tinycloud-node with the TC-1368 /signed/kv endpoint.
const signedAudio = await tc.kv.createSignedReadUrl('audio/meeting-1/recording', {
  expiresInSeconds: Math.ceil(DEFAULT_SIGNED_READ_URL_EXPIRY_MS / 1000),
});
if (signedAudio.ok) {
  console.log(signedAudio.data.url);
}

// Delegations
const delegation = await tc.createDelegation({
  delegateDID: 'did:pkh:eip155:1:0x...',
  abilities: ['tinycloud.kv/get', 'tinycloud.kv/put'],
});
```

## Documentation

For complete documentation, please visit:

- [**TinyCloud SDK Documentation**](https://docs.tinycloud.xyz/)
- [**Guides**](https://docs.tinycloud.xyz/docs/web-sdk/guides/)
  - [Getting Started Guide](https://docs.tinycloud.xyz/docs/web-sdk/guides/getting-started)
  - [Storage Guide](https://docs.tinycloud.xyz/docs/web-sdk/guides/storage-guide)
  - [Authentication Guide](https://docs.tinycloud.xyz/docs/web-sdk/guides/authentication-guide)
- [**API Reference**](https://docs.tinycloud.xyz/docs/web-sdk/api/)

## Examples

Check out our [examples directory](./examples/) for complete working examples of TinyCloud SDK integration.

## Development

### Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js v16+
- Rust for sdk-rs package

### Building the SDK

```bash
# Clone the repository
git clone https://github.com/TinyCloudLabs/web-sdk.git
cd web-sdk

# Install dependencies
bun install

# Build all packages
bun run build
```

### Running Tests

```bash
bun run test
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Inspiration

The TinyCloud Web SDK is the spiritual successor to the [SSX SDK](https://github.com/spruceid/ssx). SSX was an open source project built at SpruceID, made to make it easier to build apps with Sign in with Ethereum. While SSX saw limited adoption, it was a great project that pioneered the use of Ethereum for authentication and authorization. TinyCloud Web takes some of its architectural shape from SSX, but is built to be a modern SDK for building applications with TinyCloud.

## License

This project is licensed under the TinyCloud Ecosystem General Public License (EGPL) v1.5 - see the [LICENSE.md](./LICENSE.md) file for details.

## Support

If you encounter any issues or have questions, please file an issue on our [GitHub repository](https://github.com/TinyCloudLabs/web-sdk/issues).

## Community

Join the TinyCloud community:

- [Twitter](https://twitter.com/TinyCloudLabs)
- [Telegram](https://t.me/+pplkv1XbbU01MDVh)

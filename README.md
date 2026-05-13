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

### Node.js SDK

```bash
npm install @tinycloud/node-sdk
```

```typescript
import { TinyCloudNode } from '@tinycloud/node-sdk';

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
  expiresInSeconds: 300,
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

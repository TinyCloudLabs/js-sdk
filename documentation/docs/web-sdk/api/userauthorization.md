---
sidebar_position: 3
---

<img src="/img/tinycloudheader.png" alt="TinyCloud" width="100%" />

# UserAuthorization

The UserAuthorization module handles authentication and authorization for the TinyCloud Web SDK.

```typescript
import { UserAuthorization } from '@tinycloud/web-sdk';
```

## Description

UserAuthorization provides methods for connecting to Ethereum wallets, signing in with Ethereum (SIWE), and managing user sessions. It is a core component used by the TinyCloudWeb class.

## Constructor

```typescript
constructor(config: UserAuthorizationConfig)
```

Creates a new instance of the UserAuthorization class.

**Parameters:**
- `config` - Configuration options for user authorization
  - `siweConfig` - Configuration for Sign-In with Ethereum (SIWE), including a default `nonce`
  - `walletConnectProjectId` - Optional WalletConnect project ID

## Properties

| Name | Type | Description |
|------|------|-------------|
| `session` | `TCWClientSession \| undefined` | The current user session if signed in. |
| `web3Provider` | `ethers.providers.Web3Provider \| undefined` | The connected Ethereum provider. |

## Methods

### connect

```typescript
async connect(provider?: any): Promise<UserAuthorizationConnected>
```

Connects to a user's Ethereum wallet.

**Parameters:**
- `provider` - Optional Web3 provider to use. If not provided, it will detect and use the available provider.

**Returns:** A Promise that resolves to a UserAuthorizationConnected object.

**Example:**
```typescript
const auth = new UserAuthorization({
  siweConfig: {
    domain: 'example.com'
  }
});

const connected = await auth.connect();
console.log('Connected to wallet:', connected.address);
```

### signIn

```typescript
async signIn(options?: { nonce?: string }): Promise<TCWClientSession>
```

Signs the user in using Sign-In with Ethereum (SIWE).

**Returns:** A Promise that resolves to a TCWClientSession object containing the session information.

**Options:**
- `nonce` - Per-call nonce override. When provided, it takes precedence over `siweConfig.nonce` for that sign-in only. This nonce should come from your server and be validated there as a one-time challenge.

**Example:**
```typescript
await auth.connect();
const nonce = await fetch('/api/siwe/nonce').then((response) => response.text());
const session = await auth.signIn({ nonce });
console.log('User signed in:', session.address);
```

### signOut

```typescript
async signOut(): Promise<void>
```

Signs the user out and clears the current session.

**Example:**
```typescript
await auth.signOut();
console.log('User signed out');
```

### isConnected

```typescript
isConnected(): boolean
```

Checks if a user is connected to a wallet.

**Returns:** `true` if connected, `false` otherwise.

**Example:**
```typescript
const connected = auth.isConnected();
console.log('Connected:', connected);
```

### isSignedIn

```typescript
isSignedIn(): boolean
```

Checks if a user is currently signed in.

**Returns:** `true` if signed in, `false` otherwise.

**Example:**
```typescript
const signedIn = auth.isSignedIn();
console.log('Signed in:', signedIn);
```

### getSigner

```typescript
getSigner(): ethers.Signer
```

Gets the Ethereum signer for the connected wallet.

**Returns:** An ethers.js Signer object.

**Example:**
```typescript
const signer = auth.getSigner();
const address = await signer.getAddress();
console.log('Wallet address:', address);
```

### address

```typescript
address(): string
```

Gets the Ethereum address of the connected wallet.

**Returns:** The Ethereum address as a string.

**Example:**
```typescript
const userAddress = auth.address();
console.log('Wallet address:', userAddress);
```

### chainId

```typescript
chainId(): number
```

Gets the chain ID of the connected network.

**Returns:** The chain ID as a number.

**Example:**
```typescript
const chain = auth.chainId();
console.log('Connected to chain ID:', chain);
```

### signMessage

```typescript
async signMessage(message: string): Promise<string>
```

Signs a message with the connected wallet.

**Parameters:**
- `message` - The message to sign.

**Returns:** A Promise that resolves to the signature as a string.

**Example:**
```typescript
const message = 'Hello, world!';
const signature = await auth.signMessage(message);
console.log('Signature:', signature);
```

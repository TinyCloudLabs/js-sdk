---
sidebar_position: 4
---

<img src="/img/tinycloudheader.png" alt="TinyCloud" width="100%" />

# Authentication

This guide covers how to use the authentication functionality provided by the TinyCloud Web SDK.

## Overview

The TinyCloud Web SDK provides a simple way to authenticate users using Ethereum wallets through Sign-In with Ethereum (SIWE). This allows you to verify user identity and manage permissions securely.

## Initializing Authentication

Authentication is handled by the `UserAuthorization` module, which is automatically initialized when you create a TinyCloudWeb instance:

```typescript
import { TinyCloudWeb } from '@tinycloud/web-sdk';

// Initialize the SDK
const tc = new TinyCloudWeb({
  siweConfig: {
    domain: 'example.com',
    statement: 'Sign in to Example App',
  }
});
```

## Connecting to a Wallet

To authenticate a user, first connect to their wallet:

```typescript
// Connect to the user's wallet
await tc.connect();

// Check if connected
const isConnected = tc.isConnected();
console.log('Connected:', isConnected);
```

The `connect` method will detect available wallets (such as MetaMask) and prompt the user to connect if necessary.

## Signing In

After connecting to a wallet, you can sign the user in:

```typescript
const nonce = await fetch('/api/siwe/nonce').then((response) => response.text());

// Sign in the user
await tc.signIn({ nonce });

// Check if signed in
const isSignedIn = tc.isSignedIn();
console.log('Signed in:', isSignedIn);
```

The `signIn` method will:
1. Generate a SIWE (Sign-In with Ethereum) message
2. Prompt the user to sign the message with their wallet
3. Verify the signature
4. Create a session for the user

If you pass `nonce` to `signIn()`, that value overrides `siweConfig.nonce` for that one call.

The nonce must come from your server or relying party backend. It should be stored server-side, verified on sign-in, and invalidated after use. Do not generate the SIWE nonce in the browser for production authentication flows.

## Working with Sessions

The SDK manages user sessions automatically, but you can access session information if needed:

```typescript
// Get the current session
const session = tc.session;

// Access session properties
console.log('User address:', session.address);
console.log('Chain ID:', session.chainId);
```

Sessions are used to authorize operations like storage access without requiring the user to sign every request.

## Signing Out

To sign the user out:

```typescript
// Sign out the user
await tc.signOut();

// Verify signed out
console.log('Signed in:', tc.isSignedIn()); // false
```

## Custom Authorization

You can customize the authorization process with additional configuration:

```typescript
const tc = new TinyCloudWeb({
  siweConfig: {
    domain: 'example.com',
    statement: 'Sign in to Example App with your Ethereum account.',
    uri: 'https://example.com',
    version: '1',
    chainId: 1, // Ethereum Mainnet
    resources: [
      'https://example.com/terms-of-service',
    ],
  }
});
```

When your backend issues the nonce before sign-in, pass it per call instead of hard-coding it in the constructor:

```typescript
const nonce = await fetch('/api/siwe/nonce').then((response) => response.text());
await tc.signIn({ nonce });
```

## Error Handling

Always handle potential errors during authentication:

```typescript
try {
  await tc.connect();
  await tc.signIn();
} catch (error) {
  console.error('Authentication error:', error);
  
  // Handle specific error cases
  if (error.code === 4001) {
    console.log('User rejected the connection request');
  } else if (error.code === 4902) {
    console.log('The requested chain is not added to the user\'s wallet');
  }
}
```

## Next Steps

Now that you understand how to authenticate users, you might want to explore:

- [Working with Storage](./storage-guide.md) - Learn how to securely store and retrieve data
- [API Reference](../api/) - Detailed reference for all SDK methods

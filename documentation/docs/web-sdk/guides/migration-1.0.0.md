# Migration Guide: web-sdk 1.0.0 Auth Module

This guide covers the breaking changes and migration path for the new unified authentication module in web-sdk 1.0.0.

## Overview

Version 1.0.0 introduces a new unified auth architecture that brings feature parity with the node-sdk:

- **Session-only mode**: Start without a wallet, receive delegations
- **SignStrategy pattern**: Control how sign requests are handled
- **Clear identity model**: `did` vs `sessionDid` distinction
- **Upgrade pattern**: `connectWallet()` to transition from session-only to wallet mode

## Quick Start: Enabling New Auth

```typescript
// Before (legacy mode - still supported)
const tcw = new TinyCloudWeb({
  providers: { web3: { driver: window.ethereum } }
});

// After (new auth mode - recommended for new projects)
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  providers: { web3: { driver: window.ethereum } }
});
```

## Breaking Changes

### 1. Configuration Changes

#### TCWConfig

| Property | Change | Migration |
|----------|--------|-----------|
| `useNewAuth` | New (optional) | Add `useNewAuth: true` to enable new auth |
| `signStrategy` | New (optional) | Defaults to `wallet-popup` for web |
| `spaceCreationHandler` | New (optional) | Defaults to `ModalSpaceCreationHandler` |

```typescript
// New config options
interface TCWConfig {
  // ... existing options

  /** Enable new auth module (default: false for backward compat) */
  useNewAuth?: boolean;

  /** How to handle sign requests */
  signStrategy?: WebSignStrategy;

  /** How to confirm space creation */
  spaceCreationHandler?: ISpaceCreationHandler;
}
```

### 2. Deprecated Methods

These methods throw errors when `useNewAuth: true`:

| Method | Replacement |
|--------|-------------|
| `resolveEns()` | Use ethers.js or viem directly |
| `getProvider()` | Use `webAuth.isWalletConnected` |
| `getSigner()` | Use `signMessage()` |
| `generateSiweMessage()` | Use `webAuth.prepareSessionForSigning()` |
| `signInWithSignature()` | Use `webAuth.signInWithPreparedSession()` |

#### Before
```typescript
// Get provider for ENS
const provider = tcw.getProvider();
const name = await provider.lookupAddress(address);

// External signing flow
const siwe = await tcw.generateSiweMessage(address);
const signature = await externalWallet.sign(siwe.prepareMessage());
await tcw.signInWithSignature(siwe, signature);
```

#### After
```typescript
// ENS with viem
import { createPublicClient, http } from 'viem';
const client = createPublicClient({ chain: mainnet, transport: http() });
const name = await client.getEnsName({ address });

// External signing with new auth
const { prepared, keyId, jwk, address, chainId } =
  await tcw.webAuth.prepareSessionForSigning();
const signature = await externalWallet.sign(prepared.siwe);
await tcw.webAuth.signInWithPreparedSession(prepared, signature, keyId, jwk);
```

### 3. Identity Model Changes

The new auth introduces a clear distinction between identity types:

| Property | Description | When Available |
|----------|-------------|----------------|
| `did` | Primary identity | After wallet connected |
| `sessionDid` | Session key identity | Always (even before sign-in) |

```typescript
const manifest = { app_id: 'com.example.notes', name: 'Notes' };
const tcw = new TinyCloudWeb({ useNewAuth: true, manifest });

// Before sign-in
console.log(tcw.sessionDid); // did:key:z6Mk...#z6Mk...
console.log(tcw.did);        // Same as sessionDid (no wallet yet)

// After wallet sign-in
await tcw.connectWallet(window.ethereum);
await tcw.signIn();
console.log(tcw.sessionDid); // did:key:z6Mk...#z6Mk... (unchanged)
console.log(tcw.did);        // did:pkh:eip155:1:0x... (wallet identity)
```

### 4. Session-Only Mode (New Feature)

Start without a wallet and receive delegations:

```typescript
// Create in session-only mode (no wallet required)
const manifest = { app_id: 'com.example.notes', name: 'Notes' };
const tcw = new TinyCloudWeb({ useNewAuth: true, manifest });

// Properties available immediately
console.log(tcw.isSessionOnly);    // true
console.log(tcw.sessionDid);       // did:key:z6Mk...
console.log(tcw.isWalletConnected); // false

// Later, user can upgrade by connecting a wallet
tcw.connectWallet(window.ethereum);
console.log(tcw.isSessionOnly);    // false
console.log(tcw.isWalletConnected); // true

// Then sign in to create their own space
await tcw.signIn();
console.log(tcw.did);              // did:pkh:eip155:1:0x...
```

### 5. SignStrategy Pattern

Control how sign requests are handled:

```typescript
// Default: browser wallet popup
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  signStrategy: { type: 'wallet-popup' }
});

// Callback strategy: custom approval UI
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  signStrategy: {
    type: 'callback',
    handler: async (req) => {
      const approved = await showCustomApprovalDialog(req.message);
      return { approved };
    }
  }
});

// Event emitter: external handling
const emitter = new EventTarget();
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  signStrategy: { type: 'event-emitter', emitter, timeout: 60000 }
});

emitter.addEventListener('sign-request', (event) => {
  const { request, respond } = event.detail;
  // Handle externally, then call respond({ approved: true/false, signature? })
});
```

Available strategies:

| Type | Description | Use Case |
|------|-------------|----------|
| `wallet-popup` | Browser wallet popup (default for web) | Standard web dApps |
| `callback` | Custom callback function | Custom approval UIs |
| `event-emitter` | Events for external handling | Integration with external systems |
| `auto-sign` | Auto-approve (node-sdk only) | Backend services |
| `auto-reject` | Auto-reject all | Testing, read-only apps |

### 6. Space Creation Handler

Control how space creation is confirmed:

```typescript
import { ModalSpaceCreationHandler } from '@tinycloud/web-sdk';

// Default: shows modal dialog
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  spaceCreationHandler: new ModalSpaceCreationHandler()
});

// Auto-approve (no UI)
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  spaceCreationHandler: {
    confirmSpaceCreation: async () => true
  }
});

// Custom handler
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  spaceCreationHandler: {
    confirmSpaceCreation: async (context) => {
      return await showCustomDialog(`Create space: ${context.spaceId}?`);
    },
    onSpaceCreated: (context) => {
      showToast(`Space ${context.spaceId} created!`);
    },
    onSpaceCreationFailed: (context, error) => {
      showError(`Failed: ${error.message}`);
    }
  }
});
```

## Step-by-Step Migration

### Step 1: Update Package

```bash
npm install @tinycloud/web-sdk@1.0.0
```

### Step 2: Choose Migration Path

**Option A: Stay on Legacy (Minimal Changes)**

No code changes required. Legacy mode remains the default.

**Option B: Enable New Auth (Recommended)**

1. Add `useNewAuth: true` to config
2. Update any deprecated method calls
3. Consider using new features (session-only, strategies)

### Step 3: Update Initialization

```typescript
// Legacy
const tcw = new TinyCloudWeb({
  providers: { web3: { driver: window.ethereum } }
});

// New (with wallet from start)
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  providers: { web3: { driver: window.ethereum } }
});

// New (session-only mode)
const tcw = new TinyCloudWeb({ useNewAuth: true });
// Connect wallet later: tcw.connectWallet(window.ethereum);
```

### Step 4: Update Method Calls

```typescript
// Replace deprecated methods
// Before:
const provider = tcw.getProvider();
const signer = tcw.getSigner();

// After (if you need raw provider access):
if (tcw.isNewAuthEnabled) {
  // Use your own provider reference or check state
  const isConnected = tcw.isWalletConnected;
} else {
  const provider = tcw.getProvider();
}
```

### Step 5: Update External Signing (if used)

```typescript
// Before:
const siwe = await tcw.generateSiweMessage(address);
const sig = await externalSign(siwe.prepareMessage());
await tcw.signInWithSignature(siwe, sig);

// After:
const prep = await tcw.webAuth.prepareSessionForSigning();
const sig = await externalSign(prep.prepared.siwe);
await tcw.webAuth.signInWithPreparedSession(
  prep.prepared,
  sig,
  prep.keyId,
  prep.jwk
);
```

### Step 6: Leverage New Features (Optional)

```typescript
// Use session-only for delegation recipients
if (isReceivingDelegation) {
  const tcw = new TinyCloudWeb({ useNewAuth: true });
  // User can receive delegations with tcw.sessionDid
  // No wallet needed!
}

// Use callback strategy for custom UX
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  signStrategy: {
    type: 'callback',
    handler: async (req) => {
      // Custom approval UI
      return { approved: await myApprovalFlow(req) };
    }
  }
});
```

## New Type Exports

The following types are now exported from `@tinycloud/web-sdk`:

```typescript
// Auth module types
import {
  WebUserAuthorization,
  WebUserAuthorizationConfig,
  WebSignStrategy,
  WalletPopupStrategy,
  defaultWebSignStrategy,
  ModalSpaceCreationHandler,
  defaultWebSpaceCreationHandler,
  // Re-exports from sdk-core
  SignStrategy,
  SignRequest,
  SignResponse,
  ISpaceCreationHandler,
  SpaceCreationContext,
  AutoApproveSpaceCreationHandler,
} from '@tinycloud/web-sdk';

// Also available as alias
import { WebSpaceCreationHandler } from '@tinycloud/web-sdk';
// WebSpaceCreationHandler === ModalSpaceCreationHandler
```

## FAQ

### Q: Can I use legacy mode indefinitely?

Yes. Legacy mode (`useNewAuth: false`) is the default and will continue to be supported. However, new features will only be available in the new auth module.

### Q: What if I need both provider access and new auth features?

Keep your own reference to the provider:

```typescript
const provider = new ethers.providers.Web3Provider(window.ethereum);
const tcw = new TinyCloudWeb({
  useNewAuth: true,
  providers: { web3: { driver: provider } }
});
// Use provider directly for ethers operations
// Use tcw for TinyCloud operations
```

### Q: How do I handle the identity model change?

Use `tcw.did` for creating delegations and identifying users:

```typescript
// Creating a delegation for another user
await alice.delegations.create({
  delegateDID: bob.did,  // Works for both wallet and session-only users
  path: 'shared/',
  actions: ['tinycloud.kv/get']
});
```

### Q: Does session-only mode support storage operations?

No. Session-only mode allows receiving delegations but not creating your own space. To use storage, the user must connect a wallet and sign in:

```typescript
if (tcw.isSessionOnly) {
  // Can receive delegations via tcw.sessionDid
  // Cannot create own space

  // To enable storage:
  tcw.connectWallet(window.ethereum);
  await tcw.signIn();
}
```

### Q: When should I use the callback strategy?

Use callback strategy when you need custom approval UX:

- Custom modal with branding
- Biometric confirmation before signing
- Integration with approval workflows
- Logging/analytics before signing

### Q: How do I test the new auth module?

```typescript
// Check if new auth is enabled
if (tcw.isNewAuthEnabled) {
  console.log('New auth mode');
  console.log('DID:', tcw.did);
  console.log('Session DID:', tcw.sessionDid);
  console.log('Session only:', tcw.isSessionOnly);
} else {
  console.log('Legacy auth mode');
}
```

## Support

- GitHub Issues: https://github.com/tinycloudlabs/web-sdk/issues
- Documentation: https://docs.tinycloud.xyz

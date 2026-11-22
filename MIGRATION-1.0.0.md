# web-sdk 1.0.0 Migration Guide

Quick reference for migrating to the unified auth module. For detailed documentation, see [docs/web-sdk/guides/migration-1.0.0.md](documentation/docs/web-sdk/guides/migration-1.0.0.md).

## What's New

- **WebUserAuthorization is now the default**: The legacy `UserAuthorization` class has been removed. `useNewAuth` config flag has been removed.
- **Session-only mode**: Start without a wallet, receive delegations
- **SignStrategy pattern**: Control sign request handling
- **Identity model**: Clear `did` vs `sessionDid` distinction
- **`connectWallet()` upgrade**: Transition from session-only to wallet mode

## Breaking Changes Summary

### Removed: `useNewAuth` config flag

The `useNewAuth` config option has been removed. `WebUserAuthorization` is now always used.
If you were passing `useNewAuth: true`, simply remove it. If you were relying on the legacy
`UserAuthorization` class, you must migrate to `WebUserAuthorization`.

### Removed: Legacy `UserAuthorization` class

The `UserAuthorization` and `IUserAuthorization` exports from `@tinycloud/web-sdk` have been removed.

### Removed: `isNewAuthEnabled` property

`tcw.isNewAuthEnabled` has been removed since the new auth is always enabled.

### Removed Methods from Legacy Auth

| Legacy | Replacement |
|--------|-------------|
| `resolveEns()` | Use ethers.js/viem directly |
| `getProvider()` | `tcw.isWalletConnected` |
| `getSigner()` | `tcw.signMessage()` |
| `generateSiweMessage()` | `tcw.webAuth.prepareSessionForSigning()` |
| `signInWithSignature()` | `tcw.webAuth.signInWithPreparedSession()` |

### Properties

| Property | Description |
|----------|-------------|
| `tcw.did` | Primary identity (PKH when wallet, session key otherwise) |
| `tcw.sessionDid` | Session key DID (always available) |
| `tcw.isSessionOnly` | True if no wallet connected |
| `tcw.isWalletConnected` | True if wallet connected (may not be signed in) |
| `tcw.webAuth` | Access to WebUserAuthorization instance |

### Methods

| Method | Description |
|--------|-------------|
| `tcw.connectWallet(provider)` | Upgrade from session-only to wallet mode |

## Config Options

```typescript
interface TCWConfig {
  signStrategy?: WebSignStrategy;          // How to handle signing
  spaceCreationHandler?: ISpaceCreationHandler; // Space creation UI
}
```

## SignStrategy Options

```typescript
// Wallet popup (default for web)
signStrategy: { type: 'wallet-popup' }

// Callback for custom UI
signStrategy: {
  type: 'callback',
  handler: async (req) => ({ approved: true })
}

// Event emitter for external handling
signStrategy: { type: 'event-emitter', emitter: myEmitter }
```

## Migration Examples

### Standard Web App

```typescript
// Before (0.x)
const tcw = new TinyCloudWeb({
  providers: { web3: { driver: window.ethereum } }
});
await tcw.signIn();

// After (1.0.0) - same API, WebUserAuthorization is used automatically
const tcw = new TinyCloudWeb({
  providers: { web3: { driver: window.ethereum } },
  manifest: { app_id: 'com.example.notes', name: 'Notes' },
});
await tcw.signIn();
```

### Session-Only Mode

```typescript
// Start without wallet
const manifest = { app_id: 'com.example.notes', name: 'Notes' };
const tcw = new TinyCloudWeb({ manifest });
console.log(tcw.sessionDid);  // Available immediately

// Later, connect wallet
tcw.connectWallet(window.ethereum);
await tcw.signIn();
console.log(tcw.did);  // Now shows wallet PKH DID
```

### External Signing

```typescript
// Before
const siwe = await tcw.generateSiweMessage(address);
const sig = await external.sign(siwe.prepareMessage());
await tcw.signInWithSignature(siwe, sig);

// After
const prep = await tcw.webAuth.prepareSessionForSigning();
const sig = await external.sign(prep.prepared.siwe);
await tcw.webAuth.signInWithPreparedSession(prep.prepared, sig, prep.keyId, prep.jwk);
```

## Type Exports

```typescript
import {
  WebUserAuthorization,
  WebUserAuthorizationConfig,
  WebSignStrategy,
  ModalSpaceCreationHandler,
  SignStrategy,
  SignRequest,
  SignResponse,
  ISpaceCreationHandler,
  SpaceCreationContext,
} from '@tinycloud/web-sdk';
```

## FAQ

**Q: Can session-only users access storage?**
A: They can receive delegations but not create their own space. Connect a wallet and sign in to create a space.

**Q: How do I check which mode I'm in?**
A: Use `tcw.isSessionOnly`.

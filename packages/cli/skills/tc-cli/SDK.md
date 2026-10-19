# Programmatic Usage — @tinycloud/node-sdk

## Setup

```typescript
import { TinyCloudNode } from "@tinycloud/node-sdk";

const tc = new TinyCloudNode({ host: "https://tee.node.tinycloud.xyz" });
await tc.connectWallet(signer);
```

## Key-Value

```typescript
await tc.kv.put("key", "value");
const entry = await tc.kv.get("key");     // { key, data, metadata }
const keys = await tc.kv.list();           // string[]
const meta = await tc.kv.head("key");      // metadata only
await tc.kv.delete("key");
```

## Sharing

```typescript
const share = await tc.sharing.generate({
  path: "kv/key",
  actions: ["tinycloud.kv/get"],
  expiry: new Date(Date.now() + 7 * 86400000),
});
// share.shareData — portable token
// share.token — revocation handle

await tc.sharing.receive(shareData);
await tc.sharing.list();
await tc.sharing.revoke(token);
```

## Delegations

```typescript
// Mint and activate a delegation (signs with the session, POST /delegate)
const { delegation } = await tc.delegateTo("did:pkh:eip155:1:0x...", [
  { service: "tinycloud.kv", path: "kv/shared", actions: ["tinycloud.kv/get"] },
], { expiry: "1h" });

// Account-wide listing (what `tc delegation list` uses)
await tc.account.delegations.list({ direction: "all" });
await tc.delegationManager.revoke(cid);
```

## Properties

```typescript
tc.did       // Session key DID (before auth) or primary DID (after auth)
tc.spaceId   // Current space ID
```

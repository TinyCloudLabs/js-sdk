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
await tc.delegationManager.create({
  delegateDID: "did:pkh:eip155:1:0x...",
  path: "kv/shared",
  actions: ["tinycloud.kv/get"],
  expiry: new Date(Date.now() + 3600_000),
});

await tc.delegationManager.list();
await tc.delegationManager.get(cid);
await tc.delegationManager.revoke(cid);
```

## Properties

```typescript
tc.did       // Session key DID (before auth) or primary DID (after auth)
tc.spaceId   // Current space ID
```

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
// Names starting with a partial segment: list() only matches whole segments
// (node >= 1.19.0), so this standalone helper lists the folder and filters
// client-side. Reads the whole folder: use for type-ahead over small folders.
// import { listMatching } from "@tinycloud/sdk-core/kv-list-matching";
// (TypeScript needs moduleResolution node16/nodenext/bundler to see its types;
// "node" gives TS2307, though the runtime import works.)
const starting = await listMatching(tc.kv, "qa/b");  // Result: keys qa/b00, qa/b01, ...
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
  { service: "tinycloud.kv", space: "default", path: "kv/shared", actions: ["tinycloud.kv/get"] },
], { expiry: "1h" });

// Account delegation query, POST /delegation/query (what `tc delegation list` uses). It includes
// delegations signed by the session key; account.delegations.list() reads the SQL index and does not.
await tc.account.delegations.query({ direction: "all" });
await tc.delegationManager.revoke(cid);
```

`tinycloud.delegation/revoke` on a space is space-wide: it can revoke any delegation in that space, including other apps' grants and the owner's own sessions. Request it only for the command that needs it, with a short expiry, and don't keep it: the CLI's own fallback asks for 5 minutes and stores nothing. Never put it in a long-lived grant or an app manifest.

## Properties

```typescript
tc.did       // Session key DID (before auth) or primary DID (after auth)
tc.spaceId   // Current space ID
```

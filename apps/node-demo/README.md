# TinyCloud Node.js SDK Demo

Demonstrates the full TinyCloud delegation chain using the Node.js SDK:

1. **Alice** creates a space and stores data
2. **Alice** delegates access to **Bob** (with sub-delegation enabled)
3. **Bob** reads Alice's data and writes a response
4. **Bob** sub-delegates write access to **Charlie**
5. **Charlie** writes to Alice's space via the delegation chain
6. **Alice** reads messages from both Bob and Charlie

## Quick Start

```bash
# From the web-sdk repository root
bun install

# Run the demo
cd apps/node-demo
bun run demo
```


## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TINYCLOUD_URL` | TinyCloud server URL | `http://localhost:8000` |
| `ALICE_PRIVATE_KEY` | Alice's Ethereum private key (hex, no 0x) | Auto-generated |
| `BOB_PRIVATE_KEY` | Bob's Ethereum private key (hex, no 0x) | Auto-generated |
| `CHARLIE_PRIVATE_KEY` | Charlie's Ethereum private key (hex, no 0x) | Auto-generated |

Keys are automatically generated and saved to `apps/node-demo/.env` on first run.

## Running with a Live Server

```bash
# Start your TinyCloud server, then:
TINYCLOUD_URL=http://localhost:8000 bun run demo

# Or with custom keys for reproducibility:
export ALICE_PRIVATE_KEY="your-alice-key"
export BOB_PRIVATE_KEY="your-bob-key"
export CHARLIE_PRIVATE_KEY="your-charlie-key"
bun run demo
```

## Demo Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                   TinyCloud Delegation Chain                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌───────────┐                                                 │
│   │   Alice   │  Ethereum Wallet (space owner)             │
│   │  (Owner)  │  Full KV access: put, get, del, list           │
│   └─────┬─────┘                                                 │
│         │                                                       │
│         │ delegates (with sub-delegation enabled)               │
│         │ Actions: tinycloud.kv/get, tinycloud.kv/put          │
│         │ Path: shared/                                         │
│         ▼                                                       │
│   ┌───────────┐                                                 │
│   │    Bob    │  Ethereum Wallet (delegate)                    │
│   │(Delegate) │  Read/Write access to shared/                  │
│   └─────┬─────┘                                                 │
│         │                                                       │
│         │ sub-delegates                                         │
│         │ Actions: tinycloud.kv/put (attenuated)               │
│         │ Path: shared/                                         │
│         ▼                                                       │
│   ┌───────────┐                                                 │
│   │  Charlie  │  Ethereum Wallet (sub-delegate)                │
│   │   (Sub)   │  Write-only access to shared/                  │
│   └───────────┘                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## SDK Usage Examples

### Initialize TinyCloudNode

```typescript
import { TinyCloudNode, ownerFullAccess } from "@tinycloud/node-sdk";
import { Wallet } from "ethers";

// Create instance with private key
const tc = new TinyCloudNode({
  privateKey: "your-ethereum-private-key-hex",
  host: "http://localhost:8000",
  ...ownerFullAccess("my-app"),
  autoCreateSpace: true,
});

// Sign in (creates space if autoCreateSpace is true)
await tc.signIn();
console.log("Space:", tc.spaceId);
console.log("PKH DID:", tc.pkhDid);
```

### KV Storage Operations

```typescript
// Store data
await tc.kv.put("shared/greeting", {
  message: "Hello from Alice!",
  timestamp: new Date().toISOString(),
});

// Retrieve data
const result = await tc.kv.get<{ message: string }>("shared/greeting");
console.log(result.data?.message);

// List keys
const keys = await tc.kv.list({ prefix: "shared/" });
console.log(keys);

// Delete data
await tc.kv.delete("shared/greeting");
```

### Create Delegations

```typescript
// Create delegation for another user
const delegation = await tc.createDelegation({
  path: "shared/",
  actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
  delegateDID: bobClient.pkhDid, // Use pkhDid for user-to-user
  allowSubDelegation: true, // Allow Bob to sub-delegate
});

console.log("Delegation CID:", delegation.delegationCid);

// Serialize to send to the delegate
import { serializeDelegation } from "@tinycloud/node-sdk";
const serialized = serializeDelegation(delegation);
// Send `serialized` to Bob via secure channel
```

### Use Delegations

```typescript
import { deserializeDelegation } from "@tinycloud/node-sdk";

// Bob receives serialized delegation from Alice
const delegation = deserializeDelegation(serialized);

// Use the delegation to access Alice's space
const accessToAlice = await bobClient.useDelegation(delegation);

// Read and write with delegation
const greeting = await accessToAlice.kv.get("greeting");
await accessToAlice.kv.put("bob-was-here", { from: "Bob" });
```

### Create Sub-Delegations

```typescript
// Bob creates sub-delegation for Charlie (attenuated permissions)
const subDelegation = await bobClient.createSubDelegation(delegation, {
  path: "shared/",
  actions: ["tinycloud.kv/put"], // More restrictive: write-only
  delegateDID: charlieClient.pkhDid,
});

// Charlie can now use the delegation chain
const charlieAccess = await charlieClient.useDelegation(subDelegation);
await charlieAccess.kv.put("charlie-was-here", { from: "Charlie" });
```

## Key Concepts

- **Space**: A user-owned data container identified by `tinycloud:pkh:eip155:{chainId}:{address}:{name}`
- **Space Owner**: The Ethereum address that controls a space
- **Delegation**: Authorization to access another user's space with specific permissions
- **Sub-Delegation**: A delegation created from an existing delegation (with attenuated permissions)
- **Attenuation**: Reducing permissions when creating a sub-delegation (e.g., read/write → write-only)
- **PKH DID**: Public Key Hash DID (`did:pkh:eip155:1:0x...`) identifying an Ethereum address
- **Session Key**: An Ed25519 key pair managed by the SDK for signing invocations
- **Actions**: Permitted operations (e.g., `tinycloud.kv/get`, `tinycloud.kv/put`) on resource paths
- **Delegation Chain**: A sequence of delegations (Alice → Bob → Charlie) with cumulative attestations

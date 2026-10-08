# @tinycloud/replica

A durable, read-only local replica of one TinyCloud KV prefix. Sync while online; read the latest locally observed values while offline. Replicas do not support offline writes or SQL data.

**Status: beta / release candidate (Replication RC1).** APIs, limitations, and release versions may change.

## Requirements

- The TinyCloud node must advertise `kv-sync-v1` in its `/info` response.
- Node.js 22.13 or later, or Bun, for SQLite storage.
- Browser: IndexedDB for durable storage and Web Locks for `sync()`; without Web Locks, local reads remain available but sync is unsupported.
- A device grant covering the configured prefix with both `get` and `sync` abilities.

Install an explicit version; do not rely on a moving dist-tag:

```sh
npm install @tinycloud/replica@0.1.0-beta.1
```

## Browser

Import the browser API from `@tinycloud/replica/browser`. Open a replica with the signed-in user's identity DID as `principal`, install a device UCAN grant, sync, then read locally:

```ts
import { openReplica, ReplicaError } from "@tinycloud/replica/browser";

declare const spaceId: string;
declare const signedInUserDid: string;
declare const deviceGrant: string;

const replica = await openReplica({
  host: "https://tee.node.tinycloud.xyz",
  space: spaceId,
  prefix: "notes/",
  principal: signedInUserDid,
});

try {
  // Supply the compact UCAN issued to this replica's device DID.
  await replica.installGrant(deviceGrant);
  const report = await replica.sync();
  if (report.status === "busy") {
    console.log("Another tab is syncing.");
  } else {
    // get() and list() only read local storage; neither falls back to the network.
    const result = await replica.get("notes/today.txt");
    if (result.status === "present") {
      const text = new TextDecoder().decode(result.value);
      console.log(text);
    }
    const keys = await replica.list({ prefix: "notes/" });
    console.log(keys.entries.map(({ key }) => key));
  }
} catch (error) {
  if (error instanceof ReplicaError) {
    switch (error.code) {
      case "GRANT_MISSING":
      case "GRANT_EXPIRED":
      case "GRANT_REVOKED":
        // Install or renew authority before syncing/reading.
        break;
      case "SECRETS_OPT_IN_REQUIRED":
      case "NOT_COVERED":
      case "RUNTIME_UNSUPPORTED":
      case "NETWORK_ERROR":
        console.error(error.code, error.message);
        break;
    }
  }
  throw error;
} finally {
  await replica.close();
}
```

`openReplica()` requires `host`, native-form `space`, `prefix`, and `principal`. The principal partitions replicas for signed-in users sharing an origin; it is not an authorization check. The node authorizes each sync. `deviceGrant` above is the compact delegation string (for example `issued.delegation.delegationHeader.Authorization`) for `replica.deviceDid`; the owner must authorize `get` and `sync` on the prefix.

`get()` may return `present`, `content_missing`, `deleted`, `absent`, `coverage_incomplete`, or `not_covered`. Check its status before using a value. `sync()` returns `synced` with a report or `busy` when another tab holds the sync lock. Errors are `ReplicaError` instances with a stable `code`; browser exports `ReplicaError` and `ReplicaErrorCode` from its entry point. Local reads never make network requests, but they remain subject to grant and retention authority.

## Node and SQLite

The SQLite store API is exported directly from `@tinycloud/replica/sqlite`:

```ts
import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";

const store = await SqliteReplicaStore.open("./replica-data", { create: true });
// Pass `store` to `new Replica({ store, transport })` from `@tinycloud/replica`.
```

`SqliteReplicaStore.open()` defaults to the runtime's built-in SQLite driver: `node:sqlite` on Node 22.13+ or `bun:sqlite` on Bun. For a managed CLI workflow, use `tc replica` from `@tinycloud/cli`.

## Security and storage

- A replica stores only the configured KV prefix. The grant may be broader, but keys and values outside the replica prefix are not stored.
- Reads stop when the sync grant expires. A separate node-attested retention grant can allow already-synced reads for a bounded period after expiry; it does not authorize more syncs. A learned revocation blocks reads.
- Replicating the secrets space or a prefix overlapping the `vault` namespace (including bare `vault`) requires explicit `allowSecrets: true` opt-in. This copies encrypted secret material; it does not grant decryption. Decrypt authority is network-wide, not limited to a secret name (TC-755).
- SQLite replica files are mode `0600`; replica data directories are mode `0700`. Browser storage is scoped to the origin; same-origin scripts can access that origin's IndexedDB.

See the [full local replicas guide](https://docs.tinycloud.xyz/guides/local-replicas) for grant setup, CLI usage, retention, error handling, and limitations.

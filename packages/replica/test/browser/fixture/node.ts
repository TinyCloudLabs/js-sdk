/**
 * Read-through replication in the browser: node-sdk's `TinyCloudNode` with
 * `replication: { enabled, prefixes, storage: indexedDbReplicaStorage() }`,
 * signing in through a throwaway secp256k1 key, against a real node. The
 * page's whole API is `window.__node.run(...)`, which returns the
 * `replication.*` events so the test can see where each read was served.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { TinyCloudNode, registerReplicationLoaders } from "@tinycloud/node-sdk/core";
import type { ISigner, ReplicationEvent } from "@tinycloud/node-sdk/core";
import { BrowserWasmBindings } from "@tinycloud/web-sdk";
import { indexedDbReplicaStorage } from "@tinycloud/replica/kv-storage";
// @ts-expect-error `?url` is a Vite module query.
import workerUrl from "@tinycloud/replica/kv-storage/worker?url";

registerReplicationLoaders({
  runtime: () => import("@tinycloud/node-sdk/replication/runtime"),
  authority: () => import("@tinycloud/node-sdk/replication/authority"),
  gate: () => import("@tinycloud/replica/profile-gate"),
});

/** EIP-191 `personal_sign` over a raw secp256k1 key — a test wallet. */
function keySigner(privateKeyHex: string, checksum: (address: string) => string): ISigner {
  const secret = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  const publicKey = secp256k1.getPublicKey(secret, false);
  const address = checksum(`0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`);
  return {
    getAddress: async () => address,
    getChainId: async () => 1,
    async signMessage(message) {
      const bytes = typeof message === "string" ? new TextEncoder().encode(message) : Uint8Array.from(message);
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
      const digest = keccak_256(new Uint8Array([...prefix, ...bytes]));
      const signature = secp256k1.sign(digest, secret);
      return `0x${bytesToHex(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`;
    },
  };
}

type ReadEvent = Extract<ReplicationEvent, { type: "replication.read" }>;

const api = {
  /**
   * Sign in, write `notes/a` over the network, sync the replica, then read it
   * twice: the read events say whether the replica or the network served it.
   */
  async run(input: { host: string; privateKey: string }): Promise<{ value: string | null; reads: Array<Pick<ReadEvent, "op" | "source" | "reason" | "key">>; syncs: string[] }> {
    const events: ReplicationEvent[] = [];
    const bindings = new BrowserWasmBindings();
    await bindings.ensureInitialized();
    const node = new TinyCloudNode({
      host: input.host,
      signer: keySigner(input.privateKey, (address) => bindings.ensureEip55(address)),
      wasmBindings: bindings,
      autoCreateSpace: true,
      replication: {
        enabled: true,
        prefixes: ["notes/"],
        storage: indexedDbReplicaStorage({ worker: new URL(workerUrl, import.meta.url) }),
        mode: "foreground",
        onEvent: (event) => events.push(event),
      },
    });
    await node.signIn();
    const put = await node.kv.put("notes/a", "served locally");
    if (!put.ok) throw new Error(`put failed: ${JSON.stringify(put.error)}`);
    await node.replication!.sync({ prefix: "notes/" });
    await node.kv.get<string>("notes/a");
    const second = await node.kv.get<string>("notes/a");
    await node.replication!.close();
    return {
      value: second.ok ? String(second.data.data) : null,
      reads: events
        .filter((event): event is ReadEvent => event.type === "replication.read")
        .map(({ op, source, reason, key }) => ({ op, source, reason, key })),
      syncs: events.filter((event) => event.type === "replication.sync").map((event) => ("outcome" in event ? String(event.outcome) : "")),
    };
  },
};

declare global {
  interface Window {
    __node: typeof api;
  }
}

window.__node = api;
document.getElementById("status")!.textContent = "ready";

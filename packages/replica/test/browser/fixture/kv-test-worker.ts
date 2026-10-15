/**
 * Test-only kv-storage worker: the production worker host over a fake feed.
 * `transportFor` speaks JSON to the Bun test server at the spec's host
 * (`<origin>/fake/<feed>`), which drives an in-process `FakeNode`, so tests
 * can hold, fail and abort individual page and content requests. The device
 * key is a fresh Ed25519 `did:key` — no WASM, no signing (the fake feed does
 * not verify invocations; grants are still parsed and audience-checked).
 */
import { ed25519 } from "@noble/curves/ed25519";

import { createKvWorkerHost } from "../../../src/kv-storage/host.js";
import { ledgerFor } from "../../../src/kv-storage/ledger.js";
import type { KvRequest } from "../../../src/kv-storage/protocol.js";
import { ReplicaError } from "../../../src/errors.js";
import type { FetchedContent, ReplicaTransport, SyncPage } from "../../../src/types.js";
import { createTestGate } from "../../test-gate.js";

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent<{ id: number } & KvRequest>) => void) | null;
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  return out;
}

async function call(url: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
  const data: unknown = await response.json();
  if (!response.ok) {
    const err = data as { code: string; message: string; detail?: Record<string, unknown> };
    throw new ReplicaError(err.code as never, err.message, err.detail);
  }
  return data;
}

const host = createKvWorkerHost({
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
  createDevice() {
    const secret = ed25519.utils.randomPrivateKey();
    const did = `did:key:z${base58(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(secret)]))}`;
    return { did, jwk: { kty: "OKP", crv: "Ed25519" } };
  },
  transportFor(grant, spec): ReplicaTransport {
    const base = spec.identity.host;
    return {
      async syncPage(a) {
        return (await call(`${base}/page`, { prefix: a.prefix, cursor: a.cursor, limit: a.limit, grantCid: grant.cid }, a.signal)) as SyncPage;
      },
      async fetchContent(keys, a) {
        const data = (await call(`${base}/content`, { keys }, a?.signal)) as Record<string, { b64: string; etag: string } | { missing: true }>;
        const out = new Map<string, FetchedContent>();
        for (const [key, value] of Object.entries(data)) {
          out.set(key, "missing" in value ? { missing: true } : { bytes: Uint8Array.from(atob(value.b64), (char) => char.charCodeAt(0)), etag: value.etag });
        }
        return out;
      },
    };
  },
  gateTx: createTestGate(),
  // Exercise the real IndexedDB quota failure path, not the earlier optional
  // estimate-based floor: browsers may report no usable free-space estimate.
  ledgerFor: (quota) => ({ ...ledgerFor(quota), freeBytes: async () => null }),
  ...(navigator.locks === undefined ? {} : { locks: navigator.locks }),
});

scope.onmessage = (message) => host.receive(message.data);
scope.postMessage({ event: { event: "ready" } });

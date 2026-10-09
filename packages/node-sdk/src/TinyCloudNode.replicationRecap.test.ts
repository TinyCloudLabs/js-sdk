/**
 * Real-WASM recap probes for the TC-858 sign-in augmentation (review):
 * the authority gate and the effective-request coverage are asserted on the
 * SIWE the SDK actually signs — `prepareSession` output decoded by the real
 * `parseRecapFromSiwe`, not a mocked binding. No server: fetch is stubbed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ComposedManifestRequest, WasmRecapEntry } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";

const PRIVATE_KEY =
  "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

function signInFetch(): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ activated: [], skipped: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

/** Sign in with the REAL WASM and return the signed SIWE's recap entries. */
async function signedRecap(node: TinyCloudNode, wasm: NodeWasmBindings): Promise<WasmRecapEntry[]> {
  let siwe = "";
  const prepare = wasm.prepareSession.bind(wasm);
  wasm.prepareSession = (config: Parameters<typeof prepare>[0]) => {
    const prepared = prepare(config);
    siwe = prepared.siwe;
    return prepared;
  };
  await node.auth.signIn();
  return wasm.parseRecapFromSiwe(siwe);
}

/** KV entries whose path covers `prefix` exactly as the recap names it. */
function kvEntriesAt(recap: WasmRecapEntry[], path: string): WasmRecapEntry[] {
  return recap.filter((entry) => entry.service === "kv" && entry.path === path);
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = signInFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("signed recap probes (review: real WASM)", () => {
  test("secrets-primary: allowSecrets + prefix notes signs NO notes get/sync", async () => {
    // The effective secrets-primary request is `get` on `vault/secrets/`
    // only. Under the bug, coverage was measured against defaultActions'
    // root get and the SIWE gained an unrestricted get+sync on `notes`.
    const wasm = new NodeWasmBindings();
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: new PrivateKeySigner(PRIVATE_KEY),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      prefix: "secrets",
      replication: {
        enabled: true,
        storage: {} as never,
        prefixes: ["notes"],
        allowSecrets: true,
      },
    });
    const recap = await signedRecap(node, wasm);
    const notes = kvEntriesAt(recap, "notes");
    expect(notes).toEqual([]);
    expect(
      recap.every((entry) => !entry.actions.includes("tinycloud.kv/sync")),
    ).toBe(true);
  });

  test("an exact-path get(notes) signs no notes/private augmentation", async () => {
    // The request holds an EXACT `get` on `notes`. The signed-capability
    // subset check never lets that cover `notes/private`, so the flag must
    // not sign one — `kvPrefixCovers` wrongly said it did (review).
    const wasm = new NodeWasmBindings();
    const capabilityRequest: ComposedManifestRequest = {
      manifests: [],
      resources: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "notes",
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        },
      ],
      delegationTargets: [],
      registryRecords: [],
      expiryMs: 86_400_000,
      includePublicSpace: false,
    };
    const uncovered = new TinyCloudNode({
      wasmBindings: wasm,
      signer: new PrivateKeySigner(PRIVATE_KEY),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      capabilityRequest,
      replication: {
        enabled: true,
        storage: {} as never,
        prefixes: ["notes/private"],
      },
    });
    const recap = await signedRecap(uncovered, wasm);
    expect(kvEntriesAt(recap, "notes/private")).toEqual([]);

    // Positive control: a trailing-slash `get(notes/)` DOES cover
    // `notes/private` under the same subset semantics, and the flag signs it.
    const covered = new TinyCloudNode({
      wasmBindings: wasm,
      signer: new PrivateKeySigner(PRIVATE_KEY),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      capabilityRequest: {
        ...capabilityRequest,
        resources: [{ ...capabilityRequest.resources[0]!, path: "notes/" }],
      },
      replication: {
        enabled: true,
        storage: {} as never,
        prefixes: ["notes/private"],
      },
    });
    const coveredRecap = await signedRecap(covered, wasm);
    const entries = kvEntriesAt(coveredRecap, "notes/private");
    expect(entries.length).toBe(1);
    expect(entries[0]!.actions).toEqual(
      expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/sync"]),
    );
  });
});

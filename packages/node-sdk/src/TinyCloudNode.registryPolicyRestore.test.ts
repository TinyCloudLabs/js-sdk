/**
 * `restoreSession` for a persisted session without hosts resolves the host
 * again. Under `registryPolicy: "fail-closed"` that resolution acts on the
 * registry verdict and never falls back to the hosted node (TC-1443).
 */
import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  RegistryUnavailableError,
  signLocationRecord,
} from "@tinycloud/sdk-core";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";

const REGISTRY = "https://registry.test";
const owner = new PrivateKeySigner(PROOF_PRIVATE_KEY);

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

/** The registry answers every lookup with `answer`; anything else is unreachable. */
function installRegistry(answer: () => Promise<Response>): string[] {
  const requests: string[] = [];
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith(`${REGISTRY}/`)) return answer();
    throw new TypeError(`unreachable: ${url}`);
  }) as typeof fetch;
  return requests;
}

async function restoreWithoutHosts(): Promise<TinyCloudNode> {
  const node = new TinyCloudNode({
    signer: owner,
    wasmBindings: new NodeWasmBindings(),
    registryPolicy: "fail-closed",
    tinycloudRegistryUrl: REGISTRY,
    autoDiscoverLocalNode: false,
  });
  const proof = await signedRestorableSession();
  await node.restoreSession({ ...proof, tinycloudHosts: undefined });
  return node;
}

test("fail-closed restore with an unavailable registry fails instead of using the hosted node", async () => {
  const requests = installRegistry(async () => new Response("down", { status: 503 }));

  await expect(restoreWithoutHosts()).rejects.toBeInstanceOf(RegistryUnavailableError);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  expect(requests.some((url) => url.startsWith(DEFAULT_TINYCLOUD_FALLBACK_HOST))).toBe(false);
});

test("fail-closed restore of a registered owner uses the record's host", async () => {
  installRegistry(async () => {
    const record = await signLocationRecord(
      {
        version: 1,
        subject: `did:pkh:eip155:1:${await owner.getAddress()}`,
        multiaddrs: ["/dns4/my.node.example/tcp/443/https"],
        updated_at: "2026-10-18T00:00:00.000Z",
        sequence: 1,
      },
      { type: "did:pkh", signMessage: (message) => owner.signMessage(message) },
    );
    return Response.json({ record });
  });

  const node = await restoreWithoutHosts();

  expect(node.hosts[0]).toBe("https://my.node.example");
});

import {
  REGISTRY_NOT_FOUND_BODY,
  registryOwnerKeyV2,
  signLocationRecordV2,
  type LocationRecordV2Payload,
} from "@tinycloud/sdk-core";
import { TinyCloudNode } from "../TinyCloudNode";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { signedRestorableSession } from "./signed-restorable-session";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { unregisteredLocationRegistryResponse } from "./unregistered-location-registry";

/** An independent, owner-signed routing oracle for fixtures that change live destinations. */
export function signedLocationRecordForTest(options: {
  ownerDid: string;
  ownerPrivateKey: string;
  host: string;
  nodeDid: string;
  spaces: readonly string[];
  sequence: number;
}) {
  const signer = new PrivateKeySigner(options.ownerPrivateKey);
  const payload: LocationRecordV2Payload = {
    version: 2,
    subject: options.ownerDid,
    nodes: [{ did: options.nodeDid, url: options.host }],
    spaces: [...new Set(options.spaces)].map((space) => ({
      space: space.toLowerCase(),
      nodes: [{ did: options.nodeDid, mode: "read-write" }],
    })),
    encryptionNode: options.nodeDid,
    sequence: options.sequence,
    updated_at: "2026-10-18T00:00:00.000Z",
  };
  return signLocationRecordV2(payload, {
    type: "did:pkh",
    signMessage: (message) => signer.signMessage(message),
  });
}

/** Matching signed v2 metadata; other owned lookups retain canonical no-entry responses. */
export function signedRegistryResponseForTest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  origin: string,
  record: Awaited<ReturnType<typeof signedLocationRecordForTest>>,
): Response | undefined {
  const noEntry = unregisteredLocationRegistryResponse(input, origin, init);
  if (!noEntry) return;
  const url = new URL(input instanceof Request ? input.url : String(input));
  const ownerKey = registryOwnerKeyV2(record.subject).toLowerCase();
  if (url.pathname.startsWith("/v2/locations/") &&
      decodeURIComponent(url.pathname.slice("/v2/locations/".length)).toLowerCase() === ownerKey) {
    return Response.json({ record });
  }
  return noEntry;
}

/** Public responses from the explicitly owned unit-test peer, never an authorization substitute. */
export function ownedNodeMetadata(
  input: string | URL | Request,
  init: RequestInit | undefined,
  origin: string,
  nodeDid: string,
): Response | undefined {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url.origin !== origin || method !== "GET") return;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has("authorization")) throw new Error("Public fixture metadata received a credential");
  if (/^\/v[12]\/locations\/[^/]+$/.test(url.pathname)) return new Response(REGISTRY_NOT_FOUND_BODY, {
    status: 404, headers: { "Content-Type": "application/json" },
  });
  if (url.pathname === "/info") return Response.json({ nodeId: nodeDid });
  if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid });
}

/** A real verified SIWE session and real invocation signer for policy-body tests. */
export async function restoredPolicyNode(options: {
  host: string;
  registryUrl?: string;
  onInvoke?: () => void;
}): Promise<TinyCloudNode> {
  const proof = await signedRestorableSession();
  const wasmBindings = new NodeWasmBindings();
  const invoke = wasmBindings.invoke.bind(wasmBindings);
  wasmBindings.invoke = (...args) => {
    options.onInvoke?.();
    return invoke(...args);
  };
  const node = new TinyCloudNode({
    host: options.host, tinycloudRegistryUrl: options.registryUrl ?? options.host,
    wasmBindings, autoDiscoverLocalNode: false,
  });
  await node.restoreSession({ ...proof, tinycloudHosts: [options.host] });
  return node;
}

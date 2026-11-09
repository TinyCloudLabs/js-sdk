import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "../TinyCloudNode";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { signedRestorableSession } from "./signed-restorable-session";

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

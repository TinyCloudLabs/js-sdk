// What the SDK hands to OpenKey for a sign-in carries only the public session key. Uses the real WASM session key,
// NodeUserAuthorization and OpenKey bridge; only the OpenKey SDK object is a recording stand-in.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";

import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { wireOpenKeyAuthorize, type OpenKeyAuthorizeTinyCloud } from "./openKeyBridge";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];

function expectPublicEd25519(jwk: unknown, x: unknown): void {
  expect(jwk).toEqual({ kty: "OKP", crv: "Ed25519", x });
  for (const member of PRIVATE_MEMBERS) expect(jwk).not.toHaveProperty(member);
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/delegate") && init?.method === "POST") return Response.json({ activated: ["space"], skipped: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const signer = new PrivateKeySigner("1".padStart(64, "0"));

function authorization(): NodeUserAuthorization {
  return new NodeUserAuthorization({
    signer,
    wasmBindings: new NodeWasmBindings(),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });
}

/** An OpenKey SDK stand-in that records each request and approves the SIWE unchanged. */
function recordingOpenKey(): OpenKeyAuthorizeTinyCloud & { requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  return {
    requests,
    async authorizeTinyCloud(request) {
      requests.push(structuredClone(request) as Record<string, unknown>);
      const selectedActionKeys: string[] = [];
      const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
      for (const [resource, actions] of Object.entries(extractRecapAttenuations(request.siwe))) {
        const { space, path } = parseCanonicalRecapResource(resource);
        const grouped = new Map<string, string[]>();
        for (const ability of Object.keys(actions)) {
          const service = ability.slice(0, ability.indexOf("/"));
          if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
          grouped.set(service, [...(grouped.get(service) ?? []), ability]);
        }
        for (const [service, granted] of grouped) permissions.push({ service, space, path, actions: granted });
      }
      return {
        protocolVersion: 1,
        address: await signer.getAddress(),
        signature: await signer.signMessage(request.siwe),
        signedMessage: request.siwe,
        selectedActionKeys,
        permissions,
      };
    },
  };
}

test("signInWithOpenKey sends OpenKey only the public session key and keeps the private key local", async () => {
  const auth = authorization();
  const openkey = recordingOpenKey();
  await auth.signInWithOpenKey(wireOpenKeyAuthorize(openkey));

  expect(openkey.requests).toHaveLength(1);
  const local = auth.tinyCloudSession!.jwk;
  expect(typeof local.d).toBe("string");
  expectPublicEd25519(openkey.requests[0]!.jwk, local.x);
});

test("a prepared OpenKey sign-in request carries only the public session key", async () => {
  const auth = authorization();
  const pending = await auth.prepareOpenKeySignIn();
  expectPublicEd25519(pending.request.jwk, pending.jwk.x);

  const openkey = recordingOpenKey();
  const authorize = wireOpenKeyAuthorize(openkey);
  await auth.completeOpenKeySignIn(pending, authorize(pending.request));
  expectPublicEd25519(openkey.requests[0]!.jwk, pending.jwk.x);
  expect(auth.tinyCloudSession!.verificationMethod).toBe(pending.prepared.verificationMethod);
});

test("the OpenKey bridge strips private members from a caller-built request", async () => {
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const privateJwk = JSON.parse(manager.jwk("default")!) as Record<string, unknown>;
  const openkey = recordingOpenKey();
  await wireOpenKeyAuthorize(openkey)({
    protocolVersion: 1,
    siwe: "siwe",
    jwk: privateJwk,
    verificationMethod: manager.getDID("default"),
  }).catch(() => undefined);
  expectPublicEd25519(openkey.requests[0]!.jwk, privateJwk.x);
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";

import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { wireOpenKeyAuthorize, type OpenKeyAuthorizeTinyCloud } from "./openKeyBridge";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

const REGISTRY_ORIGIN = "https://registry.openkey-session-jwk.test";
const NODE_ORIGIN = "https://tinycloud.test";
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];
let restoreFetch: (() => void) | undefined;

beforeEach(() => {
  const mocked = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === REGISTRY_ORIGIN && url.pathname.startsWith("/v1/locations/")) {
      return Response.json({ error: "location record not found" }, { status: 404 });
    }
    if (url.origin === NODE_ORIGIN && url.pathname === "/info") {
      return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    }
    if (url.origin === NODE_ORIGIN && url.pathname === "/delegate" && init?.method === "POST") {
      return Response.json({ activated: ["space"], skipped: [] });
    }
    throw new Error("Unexpected endpoint in the isolated sign-in fixture");
  });
  restoreFetch = () => mocked.mockRestore();
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

const signer = new PrivateKeySigner("1".padStart(64, "0"));
function authorization(): NodeUserAuthorization {
  return new NodeUserAuthorization({
    tinycloudRegistryUrl: REGISTRY_ORIGIN,
    signer,
    wasmBindings: new NodeWasmBindings(),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: [NODE_ORIGIN],
    sessionStorage: new MemorySessionStorage(),
  });
}

function expectPublicEd25519(sent: Record<string, unknown>, local: Record<string, unknown>): void {
  expect(typeof local.d).toBe("string");
  expect(PRIVATE_MEMBERS.some((member) => Object.hasOwn(sent, member))).toBe(false);
  expect(Object.keys(sent).sort()).toEqual(["crv", "kid", "kty", "x"]);
  expect(sent.kty).toBe("OKP");
  expect(sent.crv).toBe("Ed25519");
  expect(sent.x === local.x && sent.kid === local.kid).toBe(true);
}

function recordingOpenKey(): OpenKeyAuthorizeTinyCloud & { requests: Array<{ jwk: Record<string, unknown>; siwe: string }> } {
  const requests: Array<{ jwk: Record<string, unknown>; siwe: string }> = [];
  return {
    requests,
    async authorizeTinyCloud(request) {
      requests.push({ jwk: structuredClone(request.jwk), siwe: request.siwe });
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

test("OpenKey sign-in uses the public session key and preserves local signing", async () => {
  const auth = authorization();
  const openkey = recordingOpenKey();
  await auth.signInWithOpenKey(wireOpenKeyAuthorize(openkey));
  expect(openkey.requests.length).toBe(1);
  expectPublicEd25519(openkey.requests[0]!.jwk, auth.tinyCloudSession!.jwk);
});

test("prepared OpenKey sign-in uses the same public session identity", async () => {
  const auth = authorization();
  const pending = await auth.prepareOpenKeySignIn();
  expectPublicEd25519(pending.request.jwk, pending.jwk);
  const openkey = recordingOpenKey();
  await auth.completeOpenKeySignIn(pending, wireOpenKeyAuthorize(openkey)(pending.request));
  expect(openkey.requests.length).toBe(1);
  expectPublicEd25519(openkey.requests[0]!.jwk, pending.jwk);
  expect(auth.tinyCloudSession!.verificationMethod === pending.prepared.verificationMethod).toBe(true);
});

test("OpenKey bridge projects caller-supplied asymmetric keys before dispatch", async () => {
  const manager = new NodeWasmBindings().createSessionManager();
  const local: Record<string, unknown> = JSON.parse(manager.jwk("default")!);
  const sent: Array<Record<string, unknown>> = [];
  const openkey: OpenKeyAuthorizeTinyCloud = {
    async authorizeTinyCloud(request) {
      sent.push(structuredClone(request.jwk));
      throw new Error("approval declined");
    },
  };
  await expect(wireOpenKeyAuthorize(openkey)({
    protocolVersion: 1,
    siwe: "siwe",
    jwk: local,
    verificationMethod: manager.getDID("default"),
  })).rejects.toThrow("approval declined");
  expect(sent.length).toBe(1);
  expectPublicEd25519(sent[0]!, local);
});

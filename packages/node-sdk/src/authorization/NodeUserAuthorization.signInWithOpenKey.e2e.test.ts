// End-to-end test for the production OpenKey integration path.
//
// Sol continuation contract: `signInWithOpenKey` MUST have a working
// non-test caller. This test proves the `wireOpenKeyAuthorize` bridge
// plus a REALISTIC OpenKey-server simulation (using the SAME WASM stack
// OpenKey uses server-side, generating the SAME rich-result wire shape)
// round-trips cleanly into a TinyCloud client session — no ad-hoc
// pre-built payload.
//
// The simulation lives in `simulateOpenKeyServer` below. It mirrors
// exactly what OpenKey's /authorize-sign-prepare + /authorize-sign
// routes produce: canonical four-part IDs, permissions grouped by
// resource, `signedMessage` narrowed via `prepareSession()` when the
// selection is not the full baseline. No two-part legacy IDs, no
// empty-permissions shortcuts — the shape is what the SDK contractually
// requires.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  extractRecapAttenuations,
  parseCanonicalRecapResource,
} from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { wireOpenKeyAuthorize, type OpenKeyAuthorizeTinyCloud } from "./openKeyBridge";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

// Route /info + /delegate hits through a stub so signIn's activation
// flow doesn't hit a real network. `signInWithOpenKey → signInWithPreparedSession
// → ensureSpaceExists` calls /delegate once.
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ activated: ["space"], skipped: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PRIVATE_KEY = "1".padStart(64, "0");

/**
 * Simulate the OpenKey server's authorize-sign pipeline. Uses the same
 * WASM `prepareSession` OpenKey uses to regenerate a narrowed SIWE.
 * Produces the CANONICAL rich-result wire shape:
 *   - address: EIP-55
 *   - signature: real signature over signedMessage
 *   - signedMessage: exact bytes (unchanged when selection is full)
 *   - selectedActionKeys: four-part `service\0space\0path\0ability`
 *   - permissions: grouped by resource
 */
function makeSimulatedOpenKey(opts: {
  wasm: NodeWasmBindings;
  signer: PrivateKeySigner;
  /** Optional narrowing: return an abilities map to override the caller's SIWE. */
  narrow?: (originalSiwe: string) => Record<string, Record<string, string[]>> | null;
}): OpenKeyAuthorizeTinyCloud {
  return {
    async authorizeTinyCloud(request) {
      if (request.protocolVersion !== 1) throw new Error("unsupported");
      if (typeof request.siwe !== "string" || !request.siwe) throw new Error("siwe required");
      if (!request.jwk) throw new Error("jwk required");

      // Decide the SIWE bytes to sign. If the caller wants to simulate
      // a user narrowing capabilities, they pass a narrow() that returns
      // a new abilities map; otherwise sign the caller's exact bytes.
      const nonceMatch = request.siwe.match(/Nonce:\s*(.+)/);
      const issuedMatch = request.siwe.match(/Issued At:\s*(.+)/);
      const expireMatch = request.siwe.match(/Expiration Time:\s*(.+)/);
      const domainMatch = request.siwe.match(
        /^(.+?) wants you to sign in with your Ethereum account:$/m,
      );
      const chainMatch = request.siwe.match(/Chain ID:\s*(\d+)/);
      const addressMatch = request.siwe.match(/^0x[a-fA-F0-9]{40}$/m);
      const uriMatch = request.siwe.match(/URI:\s*(.+)/);
      const uri = uriMatch?.[1]?.trim() ?? "";
      // spaceId is inside the ReCap — for a bootstrap SIWE that references
      // one space, we can extract it from the resource lines.
      const attn = extractRecapAttenuations(request.siwe);
      const firstResource = Object.keys(attn)[0] ?? "";
      const spaceId = firstResource.startsWith("tinycloud:")
        ? firstResource.split("/")[0] ?? firstResource
        : firstResource;

      const narrowed = opts.narrow?.(request.siwe) ?? null;
      let signedMessage: string;
      if (narrowed) {
        const regenerated = opts.wasm.prepareSession({
          abilities: narrowed,
          address: addressMatch![0],
          chainId: Number(chainMatch![1]),
          domain: domainMatch![1]!,
          issuedAt: issuedMatch![1]!,
          expirationTime: expireMatch![1]!,
          spaceId,
          jwk: request.jwk as any,
          nonce: nonceMatch![1]!,
          ...(uri ? { uri } : {}),
        });
        signedMessage = regenerated.siwe;
      } else {
        signedMessage = request.siwe;
      }
      const signature = await opts.signer.signMessage(signedMessage);
      const address = await opts.signer.getAddress();

      // Build canonical four-part selectedActionKeys AND permissions
      // grouped by resource — matching the /authorize-sign response.
      const signedAttn = extractRecapAttenuations(signedMessage);
      const selectedActionKeys: string[] = [];
      const permissions: Array<{
        service: string;
        space: string;
        path: string;
        actions: string[];
      }> = [];
      for (const [resource, actions] of Object.entries(signedAttn)) {
        // Sol final continuation contract requirement 1: use the SHARED
        // canonical resource parser so the simulated OpenKey server
        // emits the same shape the real OpenKey Hono route emits (via
        // WASM `parseRecapFromSiwe`) and the same shape the SDK
        // consumer expects. Prior inline code left the service segment
        // inside `path`, so an OpenKey-shaped simulation could quietly
        // diverge from the real server.
        const { space, path } = parseCanonicalRecapResource(resource);
        const grouped = new Map<string, string[]>();
        for (const ability of Object.keys(actions)) {
          const slashIdx = ability.indexOf("/");
          const service = slashIdx > 0 ? ability.slice(0, slashIdx) : "";
          if (!service) continue;
          // Structurally-required capabilities/read is excluded from
          // selectedActionKeys — see the SDK's Rule A carve-out.
          if (
            ability !== "tinycloud.capabilities/read" &&
            ability !== "capabilities/read"
          ) {
            selectedActionKeys.push(
              `${service}\0${space}\0${path}\0${ability}`,
            );
          }
          const list = grouped.get(service) ?? [];
          list.push(ability);
          grouped.set(service, list);
        }
        for (const [service, abilities] of grouped) {
          permissions.push({ service, space, path, actions: abilities });
        }
      }
      return {
        protocolVersion: 1,
        address,
        signature,
        signedMessage,
        selectedActionKeys,
        permissions,
      };
    },
  };
}

test("signInWithOpenKey completes an unmodified round trip via the bridge", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });

  const openkey = makeSimulatedOpenKey({ wasm, signer });
  const authorize = wireOpenKeyAuthorize(openkey);
  const clientSession = await auth.signInWithOpenKey(authorize);
  expect(clientSession.address).toBe(await signer.getAddress());
  // The bridge routed a REAL OpenKey-shaped call end to end; if any
  // wire drift existed (canonical IDs, permissions coverage) the
  // signInWithOpenKeyResult validators would have rejected it.
  expect(auth.session).toBeDefined();
});

test("signInWithOpenKey binds the registry/fallback-resolved host before authorization", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    // Exercise the normal initially-unset host path without making a network
    // request: disable local/registry discovery and let the resolver choose
    // this deterministic fallback.
    autoDiscoverLocalNode: false,
    tinycloudRegistryUrl: null,
    tinycloudFallbackHosts: ["https://resolved.tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });

  const openkey = makeSimulatedOpenKey({ wasm, signer });
  const authorize = wireOpenKeyAuthorize(openkey);
  let authorizedHost: string | undefined;
  await auth.signInWithOpenKey(async (input) => {
    authorizedHost = input.host;
    return authorize(input);
  });

  expect(authorizedHost).toBe("https://resolved.tinycloud.test");
  expect(auth.hosts).toEqual(["https://resolved.tinycloud.test"]);
});

test("signInWithOpenKey uses a host override for both approval and activation", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://configured.tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });

  const openkey = makeSimulatedOpenKey({ wasm, signer });
  const authorize = wireOpenKeyAuthorize(openkey);
  let authorizedHost: string | undefined;
  await auth.signInWithOpenKey(
    async (input) => {
      authorizedHost = input.host;
      return authorize(input);
    },
    { host: "https://override.tinycloud.test" },
  );

  expect(authorizedHost).toBe("https://override.tinycloud.test");
  expect(auth.hosts).toEqual(["https://override.tinycloud.test"]);
});

test("signInWithOpenKey completes with a narrowed selection via the bridge", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    defaultActions: {
      kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] },
      sql: { "": ["tinycloud.sql/read", "tinycloud.sql/write"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    },
  });

  const openkey = makeSimulatedOpenKey({
    wasm,
    signer,
    // Simulate the user removing every KV mutation ability and every
    // SQL ability — the narrowed SIWE keeps only kv/get + capabilities/read.
    narrow: () => ({
      kv: { "": ["tinycloud.kv/get"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    }),
  });
  const authorize = wireOpenKeyAuthorize(openkey);
  const clientSession = await auth.signInWithOpenKey(authorize);
  expect(clientSession.address).toBe(await signer.getAddress());
  // Confirm the resulting SIWE is truly narrower than the default.
  const finalCaps = extractRecapAttenuations(clientSession.siwe!);
  const flat = Object.values(finalCaps).flatMap((abilities) => Object.keys(abilities));
  expect(flat).toContain("tinycloud.kv/get");
  expect(flat).not.toContain("tinycloud.kv/put");
  expect(flat).not.toContain("tinycloud.sql/read");
});

test("wireOpenKeyAuthorize rejects a response missing signedMessage", async () => {
  const badOpenKey: OpenKeyAuthorizeTinyCloud = {
    async authorizeTinyCloud() {
      return {
        protocolVersion: 1,
        address: "0x0000000000000000000000000000000000000001",
        signature: "0xdeadbeef",
        // MISSING signedMessage — bridge should throw.
        signedMessage: "" as unknown as string,
        selectedActionKeys: [],
        permissions: [],
      };
    },
  };
  const authorize = wireOpenKeyAuthorize(badOpenKey);
  await expect(
    authorize({ protocolVersion: 1, siwe: "irrelevant", jwk: {} }),
  ).rejects.toThrow(/no signedMessage/);
});

test("wireOpenKeyAuthorize rejects an unsupported protocol version", async () => {
  const badOpenKey: OpenKeyAuthorizeTinyCloud = {
    async authorizeTinyCloud() {
      return {
        protocolVersion: 2 as unknown as 1,
        address: "0x0000000000000000000000000000000000000001",
        signature: "0xdeadbeef",
        signedMessage: "irrelevant",
        selectedActionKeys: [],
        permissions: [],
      };
    },
  };
  const authorize = wireOpenKeyAuthorize(badOpenKey);
  await expect(
    authorize({ protocolVersion: 1, siwe: "irrelevant", jwk: {} }),
  ).rejects.toThrow(/unsupported protocolVersion 2/);
});

// Sol MAJOR-7 (continuation): production-shape SIWE round-trip through
// signInWithOpenKeyResult. The `NodeUserAuthorization.prepareSessionForSigning()`
// call produces a SIWE with a non-empty ReCap-derived `statement` line
// (the "I further authorize..." prose) and a full production header set.
// This test exercises the client's acceptance path against the CANONICAL
// wire shape the OpenKey server emits — no shortcuts, no legacy 2-part IDs,
// no empty permissions.
test("signInWithOpenKeyResult accepts a narrowed production-shape response verbatim", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    defaultActions: {
      kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    },
  });

  // The simulated server narrows AND regenerates via prepareSession —
  // mirroring the OpenKey delegate route's `narrowSiwePreservingImmutable`
  // behaviour byte-for-byte (statement changes, immutable header fields
  // survive).
  const openkey = makeSimulatedOpenKey({
    wasm,
    signer,
    narrow: () => ({
      kv: { "": ["tinycloud.kv/get"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    }),
  });
  const authorize = wireOpenKeyAuthorize(openkey);
  const session = await auth.signInWithOpenKey(authorize);
  // The client accepted every wire-format check:
  //   1. Signature verifies against signedMessage
  //   2. Immutable SIWE fields preserved between prepared + signed
  //   3. Capabilities subset (narrowing OK, no broadening)
  //   4. selectedActionKeys grounded in signedCaps (canonical 4-part IDs)
  //   5. permissions grouped and non-empty for a capability-bearing SIWE
  expect(session.address).toBe(await signer.getAddress());
  expect(session.siwe).toBeDefined();
  const finalCaps = extractRecapAttenuations(session.siwe!);
  const flat = Object.values(finalCaps).flatMap((abilities) => Object.keys(abilities));
  // The narrowing survived end to end.
  expect(flat).toContain("tinycloud.kv/get");
  expect(flat).not.toContain("tinycloud.kv/put");
  // The ReCap-derived statement in the signed message reflects the narrow.
  expect(session.siwe!).toContain("I further authorize");
  expect(session.siwe!).not.toMatch(/tinycloud\.kv': 'put/);
});

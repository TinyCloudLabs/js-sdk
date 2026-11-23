// TC-4082: the OpenKey-signed sign-in (prepared request, then continuation) follows the same proof as a wallet's.
// Simulated OpenKey: an authorize function that signs the SIWE it is given with a local key. Nothing reaches OpenKey.
import { afterEach, describe, expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { richResultFor } from "./test-support/openkey-result";

const DEFAULT_NODE = "https://node.tinycloud.xyz";
const REGISTRY = "https://registry.hosted-owner-openkey.test";
const HOSTILE = "https://configured.hosted-owner-openkey.test";
const signer = new PrivateKeySigner("22".repeat(32));
const address = await signer.getAddress();
const applications = `tinycloud:pkh:eip155:1:${address}:applications`;
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function codeOf(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function run(options: { actions?: string[]; invoke?: () => Response; delegate?: () => Response } = {}) {
  const requests: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url: `${url.origin}${url.pathname}`, method: init?.method ?? "GET" });
    if (url.origin === REGISTRY) return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    if (url.origin === DEFAULT_NODE) {
      if (url.pathname === "/info") return Response.json({ protocol: 1, version: "1.26.22", features: [] });
      if (url.pathname === "/delegate") return options.delegate?.() ?? Response.json({ activated: [applications], skipped: [] });
      if (url.pathname === "/invoke") return options.invoke?.() ?? Response.json([]);
    }
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  const node = new TinyCloudNode({
    host: HOSTILE, newUserHost: HOSTILE, tinycloudRegistryUrl: REGISTRY, autoDiscoverLocalNode: false,
    wasmBindings: new NodeWasmBindings(), signer, requireExistingAccount: true, allowHostedOwnerProof: true,
    autoBootstrapAccount: false, includeAccountRegistryPermissions: false, enablePublicSpace: false,
    manifest: { app_id: "tc4082-notes", name: "Notes", defaults: false, includePublicSpace: false, permissions: [{ service: "tinycloud.kv", path: "notes/", actions: options.actions ?? ["get", "list"] }] },
  } as ConstructorParameters<typeof TinyCloudNode>[0]);
  const authorized: string[] = [];
  let failure: unknown;
  try {
    await node.signInWithOpenKey(async (request) => {
      authorized.push(request.host ?? "");
      return richResultFor(signer, request.siwe);
    });
  } catch (error) {
    failure = error;
  }
  return { node, requests, authorized, failure };
}

describe("an OpenKey sign-in for a hosted owner with no registry record", () => {
  test("binds the pinned default node, then proves with one /delegate and one limit-1 read", async () => {
    const { node, requests, authorized, failure } = await run();
    expect(failure).toBeUndefined();
    expect(authorized).toEqual([DEFAULT_NODE]);
    expect(requests.filter((request) => request.url === `${DEFAULT_NODE}/delegate`)).toHaveLength(1);
    expect(requests.filter((request) => request.url === `${DEFAULT_NODE}/invoke`)).toHaveLength(1);
    expect(requests.filter((request) => request.url.startsWith(HOSTILE))).toEqual([]);
    expect(requests.map((request) => request.url)).not.toContain(`${DEFAULT_NODE}/session/retire`);
    expect(node.session?.spaceId).toBe(applications);
  });

  test("a request with no held list or info is refused before OpenKey is asked", async () => {
    const { requests, authorized, failure } = await run({ actions: ["get", "put"] });
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(authorized).toEqual([]);
    expect(requests.filter((request) => request.url.startsWith(DEFAULT_NODE))).toEqual([]);
  });

  test("a read that is not a 2xx is refused: setup required, session discarded locally, no retire", async () => {
    const { node, requests, failure } = await run({ invoke: () => new Response("Space not found", { status: 404 }) });
    expect(codeOf(failure)).toBe("ACCOUNT_SETUP_REQUIRED");
    expect(node.session).toBeUndefined();
    expect(requests.filter((request) => request.url === `${DEFAULT_NODE}/delegate`)).toHaveLength(1);
    expect(requests.map((request) => request.url)).not.toContain(`${DEFAULT_NODE}/session/retire`);
  });
});

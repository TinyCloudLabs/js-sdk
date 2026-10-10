import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
const { mintCompactDelegation } = await import(new URL("../../../node-sdk/src/test-support/compact-delegation.ts", import.meta.url).href) as {
  mintCompactDelegation(options: { audience: string; expSecs: number }): Promise<{
    delegation: { delegationHeader: { Authorization: string }; cid: string };
    ownerDid: string;
    spaceId: string;
  }>;
};
const home = await mkdtemp(join(tmpdir(), "tc-host-discovery-"));
process.env.TC_HOME = home;
delete process.env.TC_HOST;
const { ProfileManager } = await import("../config/profiles.js");
const { completeDeferredLocalDiscovery } = await import("./host.js");
const { storedSessionVerifiesLocally } = await import("./sdk.js");
let healthChecks = 0;
let infoChecks = 0;
let localNode: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  localNode = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        healthChecks++;
        return new Response("ok", { status: 200 });
      }
      if (path === "/info") {
        infoChecks++;
        return Response.json({ nodeId: "did:key:z6MkLocalNodeTc674" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  localNode.stop(true);
  await rm(home, { recursive: true, force: true });
});

async function configuredProfile(): Promise<void> {
  await ProfileManager.setProfile("delegate", {
    name: "delegate",
    host: "https://fallback.example.test",
    chainId: 1,
    spaceName: "secrets",
    did: "did:key:z6MkDelegateTc674",
    createdAt: new Date().toISOString(),
    posture: "delegate-session",
    authMethod: "openkey",
    localNodeUrl: localNode.url.origin,
  });
}

// TC-674 regression: fails before the fix
 test("deferred discovery keeps a copied context with another host and makes no probe", async () => {
  await configuredProfile();
  const ctx = {
    profile: "delegate",
    host: "https://other.example.test",
    verbose: false,
    noCache: false,
    quiet: false,
    localDiscovery: { deferredFrom: "https://fallback.example.test" },
  };
  await completeDeferredLocalDiscovery(ctx);
  expect(ctx.host).toBe("https://other.example.test");
  expect(healthChecks).toBe(0);
  expect(infoChecks).toBe(0);
});

// TC-674 control: passes before and after
test("deferred discovery completes while the context still uses its fallback", async () => {
  await configuredProfile();
  const ctx = {
    profile: "delegate",
    host: "https://fallback.example.test",
    verbose: false,
    noCache: false,
    quiet: false,
    localDiscovery: { deferredFrom: "https://fallback.example.test" },
  };
  await completeDeferredLocalDiscovery(ctx);
  expect(ctx.host).toBe(localNode.url.origin);
  expect(healthChecks).toBe(1);
  expect(infoChecks).toBe(1);
});

// TC-674 regression: fails before the fix
test("a valid imported session with no profile host verifies locally without registry fetch", async () => {
  await configuredProfile();
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const sessionDid = manager.getDID("default").split("#", 1)[0]!;
  const imported = await mintCompactDelegation({ audience: sessionDid, expSecs: Math.floor(Date.now() / 1000) + 3600 });
  const profile = {
    name: "delegate",
    chainId: 1,
    spaceName: "secrets",
    did: sessionDid,
    sessionDid,
    ownerDid: imported.ownerDid,
    spaceId: imported.spaceId,
    createdAt: new Date().toISOString(),
    posture: "delegate-session" as const,
    authMethod: "openkey" as const,
  };
  await ProfileManager.setProfile("delegate", profile as never);
  await ProfileManager.setKey("delegate", JSON.parse(manager.jwk("default")!));
  await ProfileManager.setSession("delegate", {
    delegationHeader: imported.delegation.delegationHeader,
    delegationCid: imported.delegation.cid,
    spaceId: imported.spaceId,
    jwk: JSON.parse(manager.jwk("default")!),
    verificationMethod: sessionDid,
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (): Promise<Response> => {
    throw new Error("unexpected network fetch");
  }, { preconnect: globalThis.fetch.preconnect }));
  try {
    expect(await storedSessionVerifiesLocally("delegate")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

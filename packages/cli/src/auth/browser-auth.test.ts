import { describe, expect, test } from "bun:test";
import {
  buildAuthUrl,
  assertAppReadDiscoveryAvailable,
  publicJwkForDelegation,
  validateDelegationCallbackPayload,
} from "./browser-auth.js";

function decodedJwkFromUrl(url: string): Record<string, unknown> {
  const encoded = new URL(url).searchParams.get("jwk");
  expect(encoded).toBeTruthy();
  return JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
}

describe("browser auth delegation URLs", () => {
  test("app-read discovery forwards the expected owner without fixed permissions", () => {
    const owner = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
    const url = new URL(buildAuthUrl("did:key:synthetic", { discoverAppRead: true, expectedOwner: owner,
      permissions: [{ service: "tinycloud.kv", space: "account", path: "applications/", actions: ["get", "list"] }] }));
    expect(url.searchParams.get("owner")).toBe(owner);
    expect(url.searchParams.get("discovery")).toBe("app-read");
    expect(url.searchParams.get("discoveryProtocolVersion")).toBe("1");
    expect(url.searchParams.has("permissions")).toBe(false);
    expect(new URL(buildAuthUrl("did:key:synthetic", { expectedOwner: owner })).searchParams.has("owner")).toBe(false);
  });

  test("only sends public JWK fields to OpenKey", () => {
    const privateJwk = {
      kid: "cli",
      kty: "OKP",
      crv: "Ed25519",
      x: "public-key",
      d: "private-key",
      p: "rsa-prime",
      q: "rsa-prime",
      dp: "rsa-exponent",
      dq: "rsa-exponent",
      qi: "rsa-coefficient",
      oth: [{ r: "private" }],
      k: "symmetric-secret",
    };

    expect(publicJwkForDelegation(privateJwk)).toEqual({
      kid: "cli",
      kty: "OKP",
      crv: "Ed25519",
      x: "public-key",
    });

    const url = buildAuthUrl("did:key:z6MkDelegate", {
      openkeyHost: "https://openkey.test",
      jwk: privateJwk,
    });

    expect(decodedJwkFromUrl(url)).toEqual({
      kid: "cli",
      kty: "OKP",
      crv: "Ed25519",
      x: "public-key",
    });
  });

  test("advertises versioned protocol via protocolVersion=1", () => {
    const url = buildAuthUrl("did:key:z6MkDelegate", {
      openkeyHost: "https://openkey.test",
    });
    expect(new URL(url).searchParams.get("protocolVersion")).toBe("1");
  });

  test("validateDelegationCallbackPayload accepts a well-formed response", () => {
    const good = {
      delegationHeader: { Authorization: "Bearer x" },
      delegationCid: "bafy",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
    };
    expect(validateDelegationCallbackPayload(good)).toBeNull();
  });

  test("validateDelegationCallbackPayload rejects missing fields", () => {
    expect(validateDelegationCallbackPayload(null)).toContain("expected");
    expect(validateDelegationCallbackPayload({})).toContain("delegationHeader");
    expect(
      validateDelegationCallbackPayload({
        delegationHeader: { Authorization: "" },
        delegationCid: "cid",
        spaceId: "space",
      }),
    ).toContain("Authorization");
  });

  test("includes permission request reason for OpenKey consent", () => {
    const url = buildAuthUrl("did:key:z6MkDelegate", {
      openkeyHost: "https://openkey.test",
      reason: "Allow `tc secrets get DEPLOY_KEY` to read and decrypt this secret.",
      permissions: [
        {
          service: "tinycloud.kv",
          space: "secrets",
          path: "vault/secrets/DEPLOY_KEY",
          actions: ["tinycloud.kv/get"],
        },
      ],
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("reason")).toBe(
      "Allow `tc secrets get DEPLOY_KEY` to read and decrypt this secret.",
    );

    const payload = JSON.parse(
      Buffer.from(parsed.searchParams.get("permissions")!, "base64url").toString("utf8"),
    );
    expect(payload.reason).toBe("Allow `tc secrets get DEPLOY_KEY` to read and decrypt this secret.");
    expect(payload.permissions).toHaveLength(1);
  });
});

describe("app-read deployment compatibility", () => {
  const marker = { schemaVersion: 1, protocolVersion: 1, implementationVersion: "1", apiBacked: true, discovery: "app-read", scope: "registry-and-selected-app", transport: "paste" };
  test("requires API-backed evidence for the exact app-read protocol revision", async () => {
    let requested = "";
    await assertAppReadDiscoveryAvailable("https://openkey.test", (async (url) => {
      requested = String(url);
      return Response.json(marker);
    }) as typeof fetch);
    expect(requested).toBe("https://openkey.test/.well-known/tinycloud-app-read.json");
  });
  test.each([
    null, {}, { ...marker, schemaVersion: "1" }, { ...marker, discovery: "other" },
    { ...marker, scope: "registry" }, { ...marker, transport: "callback" },
    { ...marker, apiBacked: undefined }, { ...marker, apiBacked: false },
    { ...marker, protocolVersion: undefined }, { ...marker, protocolVersion: 2 },
    { ...marker, implementationVersion: undefined }, { ...marker, implementationVersion: "2" },
  ])("rejects incompatible marker %j", async (value) => {
    await expect(assertAppReadDiscoveryAvailable("https://openkey.test", (async () => Response.json(value)) as typeof fetch))
      .rejects.toMatchObject({ code: "OPENKEY_DEPLOYMENT_INCOMPATIBLE" });
  });
  test("rejects old HTML fallback, missing route, and network failures", async () => {
    for (const request of [
      async () => new Response("<!doctype html><title>Old OpenKey</title>"),
      async () => new Response("Not found", { status: 404 }),
      async () => { throw new Error("offline"); },
    ]) await expect(assertAppReadDiscoveryAvailable("https://openkey.test", request as typeof fetch))
      .rejects.toMatchObject({ code: "OPENKEY_DEPLOYMENT_INCOMPATIBLE" });
  });
  test("a new web marker with an old API never emits an approval URL or falls back to paste", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ schemaVersion: 1, discovery: "app-read", scope: "registry-and-selected-app", transport: "paste" }) });
    try {
      const child = Bun.spawn([process.execPath, "--eval", `
        import { startAuthFlow } from "./packages/cli/src/auth/browser-auth.ts";
        try { await startAuthFlow("did:key:synthetic", { discoverAppRead: true, paste: true, noPopup: true, openkeyHost: ${JSON.stringify(server.url.origin)} }); }
        catch(error) { console.log(JSON.stringify({code:error.code})); }
      `], { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await child.exited;
      expect(stdout).toContain('"code":"OPENKEY_DEPLOYMENT_INCOMPATIBLE"');
      expect(stderr).not.toContain("/delegate?");
      expect(stderr).not.toContain("Falling back");
    } finally { server.stop(true); }
  });
});

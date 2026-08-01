import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ProfileManager } from "../config/profiles.js";
import { NodeWasmBindings } from "../../../node-sdk/src/NodeWasmBindings.js";
import { PrivateKeySigner } from "../../../node-sdk/src/signers/PrivateKeySigner.js";
import { createProductionUploadAuthorizer, createShareAuthorityAdapters } from "./adapters.js";

const upload = {
  blob: new Uint8Array([1, 2, 3]),
  cid: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  deleteAfter: "2030-01-01T00:00:00.000Z",
  contentLength: 3,
};

const profile = {
  name: "openkey-profile",
  host: "https://node.example",
  chainId: 1,
  spaceName: "default",
  did: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
  sessionDid: "did:key:session",
  createdAt: "2026-01-01T00:00:00.000Z",
  authMethod: "openkey" as const,
};
const session = await (async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner("7".repeat(64));
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  profile.sessionDid = manager.getDID("default");
  const spaceId = wasm.makeSpaceId(address, chainId, "default");
  const prepared = wasm.prepareSession({ abilities: { kv: { "": ["tinycloud.kv/get"] } }, address, chainId, domain: "localhost", issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 60_000).toISOString(), spaceId, jwk });
  const complete = wasm.completeSessionSetup({ ...prepared, signature: await signer.signMessage(prepared.siwe) });
  return { ...complete, jwk, verificationMethod: profile.sessionDid };
})();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("base64url");
const exactNodeResponse = JSON.parse(await readFile(new URL("./upload-attestation-node-response.json", import.meta.url), "utf8")) as Record<string, unknown>;
const nodeResponse = (): Record<string, unknown> => ({
  ...exactNodeResponse,
  sessionDid: profile.sessionDid,
  shareOrigin: "https://share.tinycloud.xyz",
  encryptedBlobCid: upload.cid,
  encryptedBlobSha256: sha256(upload.blob),
  byteLength: upload.contentLength,
  deleteAfter: upload.deleteAfter,
  issuedAt: new Date().toISOString(),
  authorityExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const restore: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  restore.push(spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).endsWith("/delegate")) {
      return new Response(JSON.stringify({ activated: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected test fetch");
  }));
});

afterEach(() => {
  while (restore.length > 0) restore.pop()?.mockRestore();
});

describe("Share upload authority adapter", () => {
  it("uses an explicit noninteractive acquisition hook without reading or persisting a private JWK", async () => {
    let received: string | undefined;
    const authorize = createProductionUploadAuthorizer({
      profileName: async () => "openkey-profile",
      testOnly: true,
      acquireUploadAuthorization: async (input) => {
        received = input.profileName;
        expect(input.upload.cid).toBe(upload.cid);
        return { cookie: "share_session_opaque" };
      },
    });

    await expect(authorize(upload)).resolves.toEqual({ cookie: "share_session_opaque" });
    expect(received).toBe("openkey-profile");
  });

  it("accepts an already host-issued session as the resumable authority", async () => {
    const authorize = createProductionUploadAuthorizer({
      profileName: async () => "openkey-profile",
      testOnly: true,
      sessionAuthorization: async () => ({ cookie: "share_session_opaque" }),
    });
    await expect(authorize(upload)).resolves.toEqual({ cookie: "share_session_opaque" });
  });

  it("uses the real OpenKey session signer and Node attestation route in production wiring", async () => {
    restore.push(spyOn(ProfileManager, "getProfile").mockResolvedValue(profile));
    restore.push(spyOn(ProfileManager, "getSession").mockResolvedValue(session));
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const authorize = createProductionUploadAuthorizer({
      origin: "https://share.tinycloud.xyz",
      profileName: async () => profile.name,
      fetchFn: (async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify(nodeResponse()), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch,
    });

    const authorization = await authorize(upload);
    expect(new Headers(authorization).has("x-tinycloud-upload-attestation")).toBe(true);
    expect(new Headers(authorization).get("x-tinycloud-retention")).toBe('"until-delete"');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://node.example/share/upload/attestation");
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(new Headers(requests[0]?.init?.headers).has("authorization")).toBe(true);
    const invocation = new Headers(requests[0]?.init?.headers).get("authorization");
    const payload = JSON.parse(Buffer.from(invocation!.split(".")[1]!, "base64url")) as { aud?: string };
    expect(payload.aud).toBe("did:web:node.example");
    expect(requests[0]?.init?.body).toContain('"requestBodyDigest"');
  });

  it("activates a complete OpenKey session before the packed invocation reaches Node", async () => {
    restore.push(spyOn(ProfileManager, "getProfile").mockResolvedValue(profile));
    restore.push(spyOn(ProfileManager, "getSession").mockResolvedValue(session));
    let activated = false;
    const activationFetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe("https://node.example/delegate");
      activated = true;
      return new Response(JSON.stringify({ activated: ["redacted-space"] }), { status: 200 });
    });
    restore.push(activationFetch);
    const authorize = createProductionUploadAuthorizer({
      origin: "https://share.tinycloud.xyz",
      profileName: async () => profile.name,
      fetchFn: (async () => {
        if (!activated) return new Response("upload delegation missing", { status: 403 });
        return new Response(JSON.stringify(nodeResponse()), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch,
    });

    await expect(authorize(upload)).resolves.toEqual(expect.objectContaining({
      "x-tinycloud-retention": '"until-delete"',
    }));
    expect(activationFetch).toHaveBeenCalledTimes(1);
  });

  it("requires Node's authority expiry and retains it in the Share authorization", async () => {
    restore.push(spyOn(ProfileManager, "getProfile").mockResolvedValue(profile));
    restore.push(spyOn(ProfileManager, "getSession").mockResolvedValue(session));
    const response = nodeResponse();
    const authorize = createProductionUploadAuthorizer({
      origin: "https://share.tinycloud.xyz",
      profileName: async () => profile.name,
      fetchFn: (async () => new Response(JSON.stringify(response), { status: 200 })) as typeof globalThis.fetch,
    });
    const authorization = await authorize(upload);
    const attestation = JSON.parse(new Headers(authorization).get("x-tinycloud-upload-attestation")!);
    expect(attestation.authorityExpiresAt).toBe(response.authorityExpiresAt);
  });

  it("rejects a Node response missing authorityExpiresAt or using a noncanonical authority expiry", async () => {
    restore.push(spyOn(ProfileManager, "getProfile").mockResolvedValue(profile));
    restore.push(spyOn(ProfileManager, "getSession").mockResolvedValue(session));
    for (const authorityExpiresAt of [undefined, "2026-08-01T00:02:00Z"]) {
      const response = nodeResponse();
      if (authorityExpiresAt === undefined) delete response.authorityExpiresAt;
      else response.authorityExpiresAt = authorityExpiresAt;
      const authorize = createProductionUploadAuthorizer({
        origin: "https://share.tinycloud.xyz",
        profileName: async () => profile.name,
        fetchFn: (async () => new Response(JSON.stringify(response), { status: 200 })) as typeof globalThis.fetch,
      });
      await expect(authorize(upload)).rejects.toThrow();
    }
  });

  it("rejects malformed Node attestations without invoking test-only acquisition seams", async () => {
    restore.push(spyOn(ProfileManager, "getProfile").mockResolvedValue(profile));
    restore.push(spyOn(ProfileManager, "getSession").mockResolvedValue(session));
    let acquired = false;
    const authorize = createProductionUploadAuthorizer({
      profileName: async () => profile.name,
      acquireUploadAuthorization: async () => { acquired = true; return { cookie: "should-not-be-used" }; },
      fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    await expect(authorize(upload)).rejects.toThrow();
    expect(acquired).toBe(false);
  });

  it("uses the persisted recipient DID and rejects a wrong-DID envelope before the Node ceremony", async () => {
    restore.push(spyOn(ProfileManager, "getProfile").mockResolvedValue(profile));
    restore.push(spyOn(ProfileManager, "getSession").mockResolvedValue(session));
    const calls: string[] = [];
    const services = createShareAuthorityAdapters({
      profileName: async () => profile.name,
      fetchFn: (async (input: unknown) => {
        calls.push(String(input));
        return new Response(JSON.stringify({
          shareOrigin: "https://share.tinycloud.xyz", registryOrigin: "https://registry.tinycloud.xyz", nodeOrigin: profile.host, emailOrigin: "https://email.tinycloud.xyz", credentialsOrigin: "https://credentials.tinycloud.xyz", nodeAudience: "did:web:node.example", enforcerDid: "did:key:enforcer", nodeInvitationKid: "did:web:node.example#invitation", nodeInvitationPublicKey: "A".repeat(43),
        }), { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });
    const envelope = {
      version: 2, shareId: "share-id", recipientMatcher: { kind: "recipientDid", value: "did:key:other" }, actions: ["read"], resource: { kind: "exact", path: "docs/plan.md" }, target: { origin: profile.host, nodeAudience: "did:web:node.example", spaceId: "space" }, delegationCid: "bafy-delegation", authorityMaterialHandle: "handle", authorityMaterialDigest: "A".repeat(43), contentSource: { kind: "kv", space: "space", path: "docs/plan.md", action: "tinycloud.kv/get" }, contentSourceDigest: "B".repeat(43), authorizationTarget: { kind: "recipientDid", did: "did:key:other" }, display: {}, expiry: "2030-01-01T00:00:00.000Z", encrypted: true, metadata: { byteLength: 1, mediaType: "text/markdown" }, signature: { signerDid: "did:key:owner", algorithm: "Ed25519", value: "" },
    } as any;
    await expect(services.authorization.begin({ envelope, method: "openkey-device" })).resolves.toEqual({ state: "denied", reason: "rejected" });
    expect(calls).toHaveLength(1);
  });
});

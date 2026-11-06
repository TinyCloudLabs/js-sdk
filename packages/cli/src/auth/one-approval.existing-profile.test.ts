import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { profilePath, readJson } from "@tinycloud/operations/state";
import { ProfileManager } from "../config/profiles.js";
import { ensureDelegationAuthority, type OpenKeyAcquisition } from "../commands/auth.js";
import { acquireApprovalRequest } from "./approval-request.js";
import { onboardingPermissions } from "./onboarding-scope.js";
const { TinyCloudNode } = await import(new URL("../../../node-sdk/src/TinyCloudNode.ts", import.meta.url).href) as { TinyCloudNode: typeof import("@tinycloud/node-sdk").TinyCloudNode };

// Existing-profile coordinator boundary used by onboard: a real restored, signed
// session needs task authority, while only the OpenKey transport is simulated.
test("existing-profile onboarding stores both spaces in one 1/1 approval and resumes the same saved request", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
  const address = await signer.getAddress();
  const manager = wasm.createSessionManager();
  const key = JSON.parse(manager.jwk("default")!);
  const did = manager.getDID("default");
  const spaceId = wasm.makeSpaceId(address, 1, "applications");
  const prepared = wasm.prepareSession({ address, chainId: 1, domain: "existing.test", spaceId, jwk: key,
    abilities: { kv: { "old-task/": ["tinycloud.kv/get"] } }, issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 3600_000).toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  const session = { ...wasm.completeSessionSetup({ ...prepared, signature }), spaceId, jwk: key, verificationMethod: did, address, chainId: 1, siwe: prepared.siwe, signature };
  const ctx = { profile: "existing-one-approval", host: "https://node.test" };
  await ProfileManager.setProfile(ctx.profile, { name: ctx.profile, host: ctx.host, did, sessionDid: did, authMethod: "openkey", posture: "owner-openkey", ownerDid: `did:pkh:eip155:1:${address}`, chainId: 1, spaceName: "applications", spaceId, createdAt: new Date().toISOString() });
  await ProfileManager.setKey(ctx.profile, key);
  await ProfileManager.setSession(ctx.profile, session);
  const profile = await ProfileManager.getProfile(ctx.profile);
  const node = new TinyCloudNode({ host: ctx.host, wasmBindings: wasm, autoBootstrapAccount: false });
  await node.restoreSession(session);
  const requested = onboardingPermissions("feed");
  expect(node.hasRuntimePermissions(requested)).toBe(false);
  let creates = 0, discovers = 0;
  const urls: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/v1/links") {
      creates++;
      return Response.json({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbb", expiresAt: JSON.parse(init!.body as string).header.expiresAt }, { status: 201 });
    }
    if (url.pathname.endsWith("/result")) { discovers++; return new Response(null, { status: 202 }); }
    throw new Error(`Unexpected transport ${url.pathname}`);
  }, { preconnect: globalThis.fetch.preconnect }));
  const now = Date.now();
  const acquire: OpenKeyAcquisition = (target, flow) => acquireApprovalRequest(target, {
    ...flow, noPopup: true, approvalWait: { deadlineMs: now + 1000, now: () => now + 1001, step: 1, of: 1 },
    onApprovalRequest: ({ approvalUrl }) => { urls.push(approvalUrl); },
  });
  const run = () => ensureDelegationAuthority({ ctx, profile, node, requested, expiryOption: "30d", reason: "Existing onboarding fixture", yes: true, exactApproval: true, openKeyAcquisition: acquire });
  const pendingPath = join(profilePath(ctx.profile), "approval-pending.json");
  type Stored = { requestId: string; bodyCid: string; ackId: string; request: { permissions: Array<{ space: string }> } };
  try {
    await expect(run()).rejects.toMatchObject({ code: "APPROVAL_PENDING", metadata: { pending: { step: 1, of: 1 } } });
    const first = await readJson<Stored[]>(pendingPath);
    expect(first).toHaveLength(1);
    expect(new Set(first![0]!.request.permissions.map(p => p.space))).toEqual(new Set(["account", "applications"]));
    await expect(run()).rejects.toMatchObject({ code: "APPROVAL_PENDING", metadata: { pending: { step: 1, of: 1 } } });
    expect(await readJson(pendingPath)).toEqual(first);
    expect(creates).toBe(1);
    expect(discovers).toBe(1);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(urls[0]);
  } finally { fetch.mockRestore(); }
});

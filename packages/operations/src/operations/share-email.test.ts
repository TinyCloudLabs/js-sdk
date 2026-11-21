import { describe, expect, test } from "bun:test";
import { EmailProofError } from "@tinycloud/node-sdk/credentials";
import { revokeShare, type PublishedShare, type SenderShareRecord, type SenderShareRecordStorage } from "@tinycloud/share-sdk";

import type { OperationContext, RuntimeOperationContext } from "../contract.js";
import type { InvitationApprovalOutcome } from "../invitation-approval.js";
import {
  executeShareEmail,
  shareEmailOperationDefinition,
  type ShareEmailInput,
  type ShareEmailNode,
  type ShareEmailPorts,
} from "./share-email.js";

const OWNER = "did:pkh:eip155:1:0x2Aef9946EFbacdA956380DB7Eb6802FAd7a9634B";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const SPACE = "tinycloud:pkh:eip155:1:0x2Aef9946EFbacdA956380DB7Eb6802FAd7a9634B:default";
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const APPROVED_ID = "a".repeat(32);
const INPUT: ShareEmailInput = { content: "# note\nfor you", filename: "note.md", recipient: "Person@Example.com", expiresInSeconds: 3600 };

type Calls = string[];

function fakeNode(calls: Calls, options: { sessionOnly: boolean }): ShareEmailNode {
  return {
    isSessionOnly: options.sessionOnly,
    restorableSession: { spaceId: SPACE } as ShareEmailNode["restorableSession"],
    credentialHolderDid: "did:key:z6MkSession",
    keys: {} as ShareEmailNode["keys"],
    spaceId: SPACE,
    resourceTransport: {} as ShareEmailNode["resourceTransport"],
    getDefaultEncryptionNetworkId: () => NETWORK,
    hasRuntimePermissions: () => false,
    getRuntimePermissionDelegations: () => [],
    activeNodeIdentity: async () => ({ origin: "https://node.example", nodeDid: "did:key:z6MkNode" }) as Awaited<ReturnType<ShareEmailNode["activeNodeIdentity"]>>,
    publishActiveNodeLocation: async () => { calls.push("location"); },
    kvForSpace: () => ({
      put: async (path: string) => { calls.push(`put ${path}`); return { ok: true }; },
      delete: async (path: string) => { calls.push(`delete ${path}`); return { ok: true }; },
    }) as unknown as ReturnType<ShareEmailNode["kvForSpace"]>,
    createUnifiedOwnerRoot: async () => { throw new Error("not used"); },
    signSessionBytes: async () => new Uint8Array(64),
    registerPolicy: async () => { throw new Error("not used"); },
    authorizeShareDeliveryV3: async (request: { recipientEmail: string }) => { calls.push(`authorize ${request.recipientEmail}`); return { receipt: true }; },
  } as unknown as ShareEmailNode;
}

function published(shareId: string, calls: Calls): PublishedShare {
  const result = {
    protocol: "tinycloud-share", version: 1, url: "https://share.tinycloud.xyz/s/full#v=4&k=secretkey&r=record", link: { kind: "policy", cid: "bafy-envelope" },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId, origin: "https://share.tinycloud.xyz",
      target: { kind: "email", origin: "https://node.example", nodeAudience: "did:key:z6MkNode", spaceId: SPACE },
      resource: { kind: "exact", path: `shares/${shareId}/note.md` }, actions: ["read"], expiresAt: new Date(NOW + 3_600_000).toISOString(),
      display: { filename: "note.md" }, recipientMatcher: { kind: "exactEmail", value: "person@example.com" },
      ownerDid: OWNER, ownerDelegationCid: "bafkr4owner", enforcementDelegationCid: "bafkr4enforce",
    },
  } as unknown as PublishedShare;
  Object.defineProperty(result, "deliveryMaterial", { enumerable: false, value: { envelope: {}, shareCid: "bafy", sealedEnvelope: "AA", envelopeKey: "AA" } });
  calls.push(`publish ${shareId}`);
  return result;
}

function memoryHistory(calls: Calls, unreadable = false): SenderShareRecordStorage & { readonly records: Map<string, SenderShareRecord> } {
  const records = new Map<string, SenderShareRecord>();
  return {
    records,
    async put(record) { calls.push(`history put ${record.shareId}`); records.set(record.shareId, record); },
    async update(shareId, change) {
      const current = records.get(shareId);
      if (current === undefined) return undefined;
      const next = await change(current);
      records.set(shareId, next);
      return next;
    },
    async list() { if (unreadable) throw new Error("unreadable"); return [...records.values()]; },
    async get(shareId) { return records.get(shareId); },
    async delete(shareId) { records.delete(shareId); },
  };
}

interface Harness {
  readonly history: ReturnType<typeof memoryHistory>;
  readonly calls: Calls;
  readonly ports: ShareEmailPorts;
  readonly approvals: { recipientEmail: string; subjectName: string; accessExpiresAt: Date; contentSha256?: string }[];
}

function harness(options: {
  approval?: InvitationApprovalOutcome;
  issuer?: "ok" | "down" | "mismatch";
  deliver?: "ok" | "fail";
  revoke?: "ok" | "fail";
  historyUnreadable?: boolean;
} = {}): Harness {
  const calls: Calls = [];
  const history = memoryHistory(calls, options.historyUnreadable);
  const approvals: Harness["approvals"] = [];
  const ports: ShareEmailPorts = {
    openHistory: () => history,
    fetch: (async () => Response.json({
      version: "tinycloud.share/config-v2", shareOrigin: "https://share.tinycloud.xyz", registryOrigin: "https://registry.example", credentialsOrigin: "https://credentials.example",
    })) as unknown as typeof fetch,
    now: () => NOW,
    emailProofDescriptor: (async () => {
      calls.push("issuer");
      if (options.issuer === "down") throw new EmailProofError("request", "NETWORK");
      if (options.issuer === "mismatch") throw new EmailProofError("request", "PROFILE_UNAVAILABLE");
      return { issuer: { did: "did:web:issuer.credentials.org", kid: "did:web:issuer.credentials.org#controller", origin: "https://witness.credentials.org" } };
    }) as unknown as ShareEmailPorts["emailProofDescriptor"],
    requestInvitationApproval: (async (request) => {
      calls.push("approval");
      approvals.push(request);
      return options.approval ?? { status: "pending", approvalUrl: "https://openkey.example/approve/1", requestId: "req-1", expiresAt: "2030-01-02T00:00:00.000Z" };
    }) as ShareEmailPorts["requestInvitationApproval"],
    sealContent: async ({ plan }) => { calls.push(`seal ${plan.keyPath}`); return { storedBytes: new Uint8Array([1]), contentSource: {} as never }; },
    publishEmailShareV3: (async (request: { shareId: string; deliveryEmail?: string; credentialDescriptor: unknown; issuerDid: string }) => {
      expect(request.deliveryEmail).toBe("person@example.com");
      expect(request.issuerDid).toBe("did:web:issuer.credentials.org");
      return published(request.shareId, calls);
    }) as unknown as ShareEmailPorts["publishEmailShareV3"],
    createLink: (async () => { calls.push("link"); return { link: "https://share.tinycloud.xyz/s/short#v=4&k=secretkey&c=cid" }; }) as unknown as ShareEmailPorts["createLink"],
    deliverCredentialInvitation: (async () => {
      calls.push("deliver");
      if (options.deliver === "fail") throw new Error("credentials service refused");
      return {};
    }) as unknown as ShareEmailPorts["deliverCredentialInvitation"],
    revokePolicyRootV3: (async (request: { rootCid: string; targetRole: string }) => {
      calls.push(`revoke ${request.targetRole} ${request.rootCid}`);
      if (options.revoke === "fail") throw new Error("node unreachable");
    }) as unknown as ShareEmailPorts["revokePolicyRootV3"],
  };
  return { calls, ports, approvals, history };
}

function context(node: ShareEmailNode): OperationContext {
  return {
    summary: { profile: "agent", host: "https://node.example", posture: "delegate-session", ownerDid: OWNER },
    runtime: { node, granted: [] },
  };
}

const sideEffects = (calls: Calls) => calls.filter((call) => /^(location|put|seal|publish|link|history|authorize|deliver|revoke|delete)/.test(call));

describe("tinycloud.share.publish_email input", () => {
  const parse = (value: unknown) => shareEmailOperationDefinition.input.safeParse(value);

  test("accepts a text file for one recipient and rejects everything outside that", () => {
    expect(parse(INPUT).success).toBe(true);
    for (const bad of [
      { ...INPUT, filename: "../note.md" },
      { ...INPUT, filename: "a/b.md" },
      { ...INPUT, filename: "" },
      { ...INPUT, content: "" },
      { ...INPUT, expiresInSeconds: 60 },
      { ...INPUT, expiresInSeconds: 31 * 86_400 },
      { ...INPUT, expiresInSeconds: 3600.5 },
      { ...INPUT, issuerDid: "did:web:other.example" },
      { ...INPUT, target: "domain:example.com" },
      { ...INPUT, notify: false },
    ]) expect(parse(bad).success).toBe(false);
  });

  test("never makes the read key's link or the content an output, and marks the content sensitive", () => {
    expect(Object.keys(shareEmailOperationDefinition.output.parse({ shared: true, shareId: "a", recipient: "b@c.d", expiresAt: "x", delivery: "sent", message: "m" }))).not.toContain("link");
    expect(() => shareEmailOperationDefinition.output.parse({ shared: true, shareId: "a", recipient: "b@c.d", expiresAt: "x", delivery: "sent", message: "m", link: "https://x" })).toThrow();
    expect(shareEmailOperationDefinition.sensitivity.input).toEqual(["/content"]);
  });
});

describe("tinycloud.share.publish_email authority", () => {
  test("plans only the share store; the key's decrypt is left to the invitation approval", async () => {
    const planned = await shareEmailOperationDefinition.authority(context(fakeNode([], { sessionOnly: true })) as RuntimeOperationContext, INPUT);
    expect(planned).toEqual([{
      service: "tinycloud.kv", space: SPACE.toLowerCase(), path: "shares/", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put", "tinycloud.kv/del"],
    }]);
  });
});

describe("tinycloud.share.publish_email execution", () => {
  test("an owner who can decrypt publishes and delivers, and the output carries neither the link nor the content", async () => {
    const { calls, ports, approvals } = harness();
    const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: false })), INPUT, ports);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.output).toMatchObject({ shared: true, delivery: "sent", recipient: "person@example.com" });
    expect(outcome.output.revoked).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain("secretkey");
    expect(JSON.stringify(outcome)).not.toContain("for you");
    expect(approvals).toEqual([]);
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["issuer", "location", "seal", "put", "publish", "link", "history", "authorize", "deliver"]);
  });

  test("a session that cannot decrypt gets the owner's approval first and creates nothing", async () => {
    const { calls, ports, approvals } = harness();
    const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: true })), INPUT, ports);
    expect(outcome).toMatchObject({
      status: "authority_required",
      approval: { kind: "openkey", requestId: "req-1", url: "https://openkey.example/approve/1" },
      request: { requestId: "req-1" },
      missing: [{ service: "tinycloud.encryption", actions: ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"] }],
    });
    expect(sideEffects(calls)).toEqual([]);
    expect(approvals).toHaveLength(1);
    // What the owner is shown is the recipient (canonical), file name and expiry from this input, never labels of the agent's own.
    expect(approvals[0]).toMatchObject({ recipientEmail: "person@example.com", subjectName: "note.md", accessExpiresAt: new Date(NOW + 3_600_000) });
    expect(approvals[0]!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("after the approval it publishes under the key the owner approved", async () => {
    const { calls, ports } = harness({ approval: { status: "approved", shareId: APPROVED_ID, accessExpiresAt: new Date(NOW + 3_600_000).toISOString(), resumed: true } });
    const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: true })), INPUT, ports);
    expect(outcome).toMatchObject({ status: "ok", output: { shared: true, shareId: APPROVED_ID, delivery: "sent" } });
    expect(calls).toContain(`seal share/${APPROVED_ID}`);
    expect(calls).toContain(`put shares/${APPROVED_ID}/note.md`);
  });

  test("an approval signed for another access date creates nothing", async () => {
    const later = new Date(NOW + 7_200_000).toISOString();
    const { calls, ports } = harness({ approval: { status: "approved", shareId: APPROVED_ID, accessExpiresAt: later, resumed: false } });
    const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: true })), INPUT, ports);
    expect(outcome).toMatchObject({ status: "error", error: { code: "PERMISSION_DENIED" } });
    expect(sideEffects(calls)).toEqual([]);
  });

  test("an issuer that cannot be reached, or is not the pinned one, stops before any approval or write", async () => {
    for (const [issuer, code, retryable] of [["down", "NODE_UNREACHABLE", true], ["mismatch", "NODE_ERROR", false]] as const) {
      const { calls, ports, approvals } = harness({ issuer });
      const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: true })), INPUT, ports);
      expect(outcome).toMatchObject({ status: "error", error: { code, retryable } });
      expect(approvals).toEqual([]);
      expect(sideEffects(calls)).toEqual([]);
    }
  });

  test("a recipient that is not one email address is refused before anything else", async () => {
    for (const recipient of ["example.com", "@example.com", "domain:example.com", "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav", "a@b.com, c@d.com"]) {
      const { calls, ports, approvals } = harness();
      const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: true })), { ...INPUT, recipient }, ports);
      expect(outcome, recipient).toMatchObject({ status: "error", error: { code: "INPUT_INVALID" } });
      expect(calls).toEqual([]);
      expect(approvals).toEqual([]);
    }
  });

  test("a failed delivery revokes both roots and says so only once they are revoked", async () => {
    const { calls, ports } = harness({ deliver: "fail" });
    const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: false })), INPUT, ports);
    expect(outcome).toMatchObject({ status: "ok", output: { shared: false, delivery: "failed", revoked: true } });
    expect(calls).toContain("revoke policy-enforcement bafkr4enforce");
    expect(calls).toContain("revoke policy-authority bafkr4owner");
    expect(calls.some((call) => call.startsWith("delete shares/"))).toBe(true);
  });

  test("a failed delivery whose revoke fails reports revoked:false and names the share", async () => {
    const { calls, ports } = harness({ deliver: "fail", revoke: "fail" });
    const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: false })), INPUT, ports);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.output).toMatchObject({ shared: false, delivery: "failed", revoked: false });
    expect(outcome.output.message).toContain(outcome.output.shareId);
    expect(outcome.output.message).not.toMatch(/was revoked\./);
  });

  test("a share is in the owner's history, which lists it; a revoked one is listed as revoked", async () => {
    const delivered = harness();
    await executeShareEmail(context(fakeNode(delivered.calls, { sessionOnly: false })), INPUT, delivered.ports);
    const [listed] = await delivered.history.list();
    expect(listed).toMatchObject({ recipientMatcher: { kind: "exactEmail", value: "person@example.com" }, deliveredRecipients: ["person@example.com"], filename: "note.md" });
    expect(listed!.revokedAt).toBeUndefined();
    expect(listed!.link).toContain("short");

    const failed = harness({ deliver: "fail" });
    await executeShareEmail(context(fakeNode(failed.calls, { sessionOnly: false })), INPUT, failed.ports);
    const [revokedRecord] = await failed.history.list();
    expect(revokedRecord!.revokedAt).toBeDefined();

    const stuck = harness({ deliver: "fail", revoke: "fail" });
    await executeShareEmail(context(fakeNode(stuck.calls, { sessionOnly: false })), INPUT, stuck.ports);
    expect((await stuck.history.list())[0]!.revokedAt).toBeUndefined();
  });

  test("the owner's revoke, run on the history record the share left, ends both roots and marks it revoked", async () => {
    const { calls, ports, history } = harness();
    await executeShareEmail(context(fakeNode(calls, { sessionOnly: false })), INPUT, ports);
    const [record] = await history.list();
    const revoked: string[] = [];
    const result = await revokeShare({
      record: record!, records: history,
      adapter: { revokePolicyRoot: async (request: { rootCid: string; targetRole: string }) => { revoked.push(`${request.targetRole} ${request.rootCid}`); return undefined; } } as never,
    });
    expect(result).toMatchObject({ state: "revoked" });
    expect(revoked.sort()).toEqual(["policy-authority bafkr4owner", "policy-enforcement bafkr4enforce"]);
    expect((await history.get(record!.shareId))!.revokedAt).toBeDefined();
  });

  test("history that cannot be read stops everything before any approval or write", async () => {
    const { calls, ports, approvals } = harness({ historyUnreadable: true });
    const outcome = await executeShareEmail(context(fakeNode(calls, { sessionOnly: true })), INPUT, ports);
    expect(outcome).toMatchObject({ status: "error", error: { code: "INTERNAL_ERROR" } });
    expect(approvals).toEqual([]);
    expect(sideEffects(calls)).toEqual([]);
  });
});

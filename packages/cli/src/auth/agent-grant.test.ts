import { describe, expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";
import { requiresAgentApproval, verifyAgentApproval, type AgentApprovalExpectations } from "./agent-grant.js";
import { APPS_AGENT_SPACE, appsAgentPermissions } from "../lib/apps-agent-preset.js";
import { parseRequestedExpiry } from "./scoped-login.js";

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const HOST = "https://tee.node.tinycloud.xyz";
const DAY_MS = 24 * 60 * 60 * 1000;

const session = wasm.createSessionManager();
const sessionJwk = JSON.parse(session.jwk("default")!);
const sessionDid = session.getDID("default");
const other = wasm.createSessionManager();
const otherJwk = JSON.parse(other.jwk("default")!);
const otherDid = other.getDID("default");

const requested: PermissionEntry[] = [
  { service: "tinycloud.capabilities", space: "applications", path: "", actions: ["tinycloud.capabilities/read"] },
  { service: "tinycloud.kv", space: "applications", path: "demo/", actions: ["tinycloud.kv/get"] },
];

function expectations(overrides: Partial<AgentApprovalExpectations> = {}): AgentApprovalExpectations {
  return { sessionDid, expectedOwner: ownerDid, expiry: parseRequestedExpiry("7d"), requested, host: HOST, ...overrides };
}

async function approval(options: {
  permissions?: PermissionEntry[];
  key?: object;
  did?: string;
  domain?: string;
} = {}): Promise<Record<string, unknown>> {
  const { delegate } = openKeyDelegate({
    wasm, signer, sessionKey: options.key ?? sessionJwk, sessionDid: options.did ?? sessionDid,
    ...(options.domain ? { domain: options.domain } : {}),
  });
  return await delegate(options.did ?? sessionDid, { permissions: options.permissions ?? requested });
}

/** Edit the signed SIWE message and sign the result, so only the edited field can fail verification. */
async function resign(data: Record<string, unknown>, edit: (message: SiweMessage) => void): Promise<Record<string, unknown>> {
  const message = new SiweMessage(data.siwe as string);
  edit(message);
  const siwe = message.prepareMessage();
  return { ...data, siwe, signature: await signer.signMessage(siwe) };
}

async function refusalCode(data: Record<string, unknown>, overrides: Partial<AgentApprovalExpectations> = {}) {
  try {
    await verifyAgentApproval(data, expectations(overrides));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) return error.code;
  }
  return undefined;
}

describe("verifyAgentApproval", () => {
  test("accepts an approval that matches the request", async () => {
    const verified = await verifyAgentApproval(await approval(), expectations());
    expect(verified.ownerDid).toBe(ownerDid);
    expect(verified.permissions.length).toBeGreaterThan(0);
    expect(Date.parse(verified.expiresAt)).toBeGreaterThan(Date.now());
  });

  test("refuses an approval issued to another session", async () => {
    expect(await refusalCode(await approval({ key: otherJwk, did: otherDid }))).toBe("OPENKEY_PROOF_INVALID");
  });

  test("refuses a signed audience that differs from the session", async () => {
    const data = { ...(await approval({ key: otherJwk, did: otherDid })), verificationMethod: sessionDid };
    expect(await refusalCode(data)).toBe("OPENKEY_AUDIENCE_MISMATCH");
  });

  test("refuses an approval from a different owner", async () => {
    const otherOwner = `did:pkh:eip155:1:0x0000000000000000000000000000000000000001`;
    expect(await refusalCode(await approval(), { expectedOwner: otherOwner })).toBe("OPENKEY_OWNER_MISMATCH");
  });

  test("refuses an approval whose signed domain is not OpenKey's approval domain", async () => {
    const data = await approval({ domain: "other.example" });
    expect(await refusalCode(data)).toBe("OPENKEY_AUDIENCE_MISMATCH");
  });

  test("refuses a statement the ReCap does not produce", async () => {
    const data = await resign(await approval(), (message) => {
      message.statement = "Also grant everything.";
    });
    expect(await refusalCode(data)).toBe("OPENKEY_PROOF_INVALID");
  });

  test("refuses a resource outside the ReCap", async () => {
    const data = await resign(await approval(), (message) => {
      message.resources = [...(message.resources ?? []), "https://evil.example"];
    });
    expect(await refusalCode(data)).toBe("OPENKEY_PROOF_INVALID");
  });

  test("refuses a signature that does not verify", async () => {
    const data = { ...(await approval()), signature: await signer.signMessage("unrelated message") };
    expect(await refusalCode(data)).toBe("OPENKEY_PROOF_INVALID");
  });

  test("refuses an approval that has already expired", async () => {
    const data = await resign(await approval(), (message) => {
      message.expirationTime = new Date(Date.now() - 1000).toISOString();
    });
    expect(await refusalCode(data)).toBe("AUTH_EXPIRED");
  });

  test("refuses an approval that outlives the 7 day cap by more than clock skew", async () => {
    const data = await resign(await approval(), (message) => {
      message.expirationTime = new Date(Date.now() + 7 * DAY_MS + 120_000).toISOString();
    });
    expect(await refusalCode(data)).toBe("OPENKEY_EXPIRY_EXCEEDED");
  });

  test("refuses an approval whose ReCap names another space", async () => {
    const data = await approval({
      permissions: requested.map((entry) => ({ ...entry, space: "secrets" })),
    });
    expect(await refusalCode(data)).toBe("OPENKEY_SCOPE_MISMATCH");
  });

  test("refuses a spaceId that differs from the approved ReCap space", async () => {
    const data = await approval();
    const other = wasm.makeSpaceId(address, 1, "secrets");
    expect(await refusalCode({ ...data, spaceId: other })).toBe("OPENKEY_SCOPE_MISMATCH");
  });

  test("refuses an approval that grants an extra ability", async () => {
    const data = await approval({
      permissions: [...requested, { service: "tinycloud.kv", space: "applications", path: "demo/", actions: ["tinycloud.kv/put"] }],
    });
    expect(await refusalCode(data)).toBe("OPENKEY_GRANT_BROADENED");
  });

  test("refuses an approval that widens the path", async () => {
    const data = await approval({
      permissions: requested.map((entry) => entry.path === "demo/" ? { ...entry, path: "" } : entry),
    });
    expect(await refusalCode(data)).toBe("OPENKEY_GRANT_BROADENED");
  });
});

describe("requiresAgentApproval", () => {
  const presetRead = appsAgentPermissions("read", ["demo"]);

  test("requires approval for an apps-agent preset request from an OpenKey owner", () => {
    expect(requiresAgentApproval("openkey", presetRead, "7d", APPS_AGENT_SPACE)).toBe(true);
  });

  test("keeps the existing path for a local-key owner", () => {
    expect(requiresAgentApproval("local", presetRead, "7d", APPS_AGENT_SPACE)).toBe(false);
  });

  test("keeps the existing path for a request that is not the preset lifetime", () => {
    expect(requiresAgentApproval("openkey", presetRead, "1d", APPS_AGENT_SPACE)).toBe(false);
  });
});

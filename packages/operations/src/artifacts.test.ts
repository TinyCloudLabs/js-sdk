import { expect, test } from "bun:test";
import { grantAuthRequest, type PortableDelegation } from "@tinycloud/node-sdk";

import {
  DelegationImportArtifactSchema,
  PermissionRequestArtifactSchema,
  buildPermissionRequestArtifact,
  createPermissionRequestIdentity,
  validateDelegationImportArtifact,
  validatePermissionRequestArtifact,
} from "./artifacts.js";

const now = new Date("2026-07-14T12:00:00.000Z");

const required = [
  {
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/secrets/API_KEY",
    actions: ["tinycloud.kv/get"],
  },
  {
    service: "tinycloud.encryption",
    space: "encryption",
    path: "urn:tinycloud:encryption:did:pkh:owner:default",
    actions: ["tinycloud.encryption/decrypt"],
  },
];

function request(overrides: Record<string, unknown> = {}) {
  return buildPermissionRequestArtifact({
    profile: "delegate",
    posture: "delegate-session",
    operatorType: "agent",
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:session",
    ownerDid: "did:pkh:owner",
    missing: required,
    now: () => now,
    createRequestId: () => "req_test",
    ...overrides,
  });
}

test("builds and validates the canonical v1 request artifact with optional command", () => {
  const mcpRequest = request();
  expect(mcpRequest).toEqual({
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: "req_test",
    createdAt: now.toISOString(),
    profile: "delegate",
    posture: "delegate-session",
    operatorType: "agent",
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:session",
    ownerDid: "did:pkh:owner",
    requested: [required[1]!, required[0]!],
  });
  expect(validatePermissionRequestArtifact(mcpRequest)).toEqual(mcpRequest);

  const cliRequest = request({ command: { argv: ["secrets", "get", "API_KEY"], cwd: "/workspace" } });
  expect(cliRequest.command).toEqual({ argv: ["secrets", "get", "API_KEY"], cwd: "/workspace" });
  expect(PermissionRequestArtifactSchema.safeParse(cliRequest).success).toBe(true);
});

test("uses a sorted exact missing-capability set in a request identity bound to profile, session, and host", () => {
  const identity = createPermissionRequestIdentity({
    profile: "delegate",
    sessionDid: "did:key:session",
    host: "https://node.tinycloud.test",
    missing: required,
  });

  expect(identity).toBe(createPermissionRequestIdentity({
    profile: "delegate",
    sessionDid: "did:key:session",
    host: "https://node.tinycloud.test",
    missing: [...required].reverse(),
  }));
  expect(identity).not.toBe(createPermissionRequestIdentity({
    profile: "other-profile",
    sessionDid: "did:key:session",
    host: "https://node.tinycloud.test",
    missing: required,
  }));
  expect(identity).not.toBe(createPermissionRequestIdentity({
    profile: "delegate",
    sessionDid: "did:key:rotated-session",
    host: "https://node.tinycloud.test",
    missing: required,
  }));
  expect(identity).not.toBe(createPermissionRequestIdentity({
    profile: "delegate",
    sessionDid: "did:key:session",
    host: "https://other.tinycloud.test",
    missing: required,
  }));
});

test("an MCP request without command is accepted by the owner grant primitive used by the existing CLI", async () => {
  const artifact = request();
  const delegation = portableDelegation();
  const grant = await grantAuthRequest({
    delegateTo: async (did, permissions) => {
      expect(did).toBe(artifact.sessionDid);
      expect(permissions).toEqual(artifact.requested);
      return { delegation, prompted: false };
    },
  }, artifact);

  expect(grant).toMatchObject({
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: artifact.requestId,
    permissions: artifact.requested,
  });
});

test("refuses malformed and unsupported v1 artifacts", () => {
  expect(() => validatePermissionRequestArtifact({ kind: "tinycloud.auth.request", version: 2 }))
    .toThrow();
  expect(PermissionRequestArtifactSchema.safeParse({
    ...request(),
    requested: [{ ...required[0], actions: [] }],
  }).success).toBe(false);

  expect(() => validateDelegationImportArtifact({
    kind: "tinycloud.auth.delegation",
    version: 2,
    requestId: "req_test",
    delegation: portableDelegation(),
  })).toThrow();
  expect(DelegationImportArtifactSchema.safeParse({
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: "req_test",
    delegation: { cid: "not-a-portable-delegation" },
  }).success).toBe(false);
});

test("validates the v1 delegation-import shape but does not turn display permissions into authority", () => {
  const importArtifact = validateDelegationImportArtifact({
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: "req_test",
    delegation: portableDelegation(),
    permissions: [{
      service: "tinycloud.kv",
      space: "secrets",
      path: "/",
      actions: ["tinycloud.kv/*"],
    }],
  });

  expect(importArtifact.permissions).toEqual([{
    service: "tinycloud.kv",
    space: "secrets",
    path: "/",
    actions: ["tinycloud.kv/*"],
  }]);
  // The importer in the next increment must obtain effective authority from
  // validated delegation bytes; this canonical artifact surface only retains
  // optional display metadata and exposes no authority derivation API.
  expect("effectivePermissions" in importArtifact).toBe(false);
});

function portableDelegation(): PortableDelegation {
  return {
    cid: "bafy-test-delegation",
    spaceId: "tinycloud:pkh:eip155:1:0xowner:secrets",
    path: "vault/secrets/API_KEY",
    actions: ["tinycloud.kv/get"],
    delegateDID: "did:key:session",
    ownerAddress: "0xowner",
    chainId: 1,
    expiry: new Date("2099-01-01T00:00:00.000Z"),
    delegationHeader: { Authorization: "Bearer test" },
  };
}

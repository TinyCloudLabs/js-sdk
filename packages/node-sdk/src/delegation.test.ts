import { describe, expect, test } from "bun:test";

import {
  activateValidatedRuntimeDelegation,
  grantAuthRequest,
  type AuthRequestArtifact,
  type DelegationAuthority,
  type RuntimeDelegationActivator,
  type PortableDelegation,
} from "./delegation";

const REQUESTER_DID = "did:key:z6MkRequesterSessionKey";

function makeRequest(overrides: Partial<AuthRequestArtifact> = {}): AuthRequestArtifact {
  return {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: "req_test_1",
    sessionDid: REQUESTER_DID,
    requested: [
      {
        service: "tinycloud.sql",
        space: "tinycloud:pkh:eip155:1:0xowner:applications",
        path: "xyz.tinycloud.artifacts/feed",
        actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
      },
    ],
    ...overrides,
  };
}

function makePortableDelegation(): PortableDelegation {
  return {
    cid: "bafy-granted",
    delegationHeader: { Authorization: "Bearer granted" },
    spaceId: "tinycloud:pkh:eip155:1:0xowner:applications",
    path: "xyz.tinycloud.artifacts/feed",
    actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
    expiry: new Date("2099-01-01T00:00:00.000Z"),
    ownerAddress: "0xowner",
    chainId: 1,
  } as PortableDelegation;
}

/** Records what delegateTo received and returns a canned delegation. */
function makeAuthority(): DelegationAuthority & {
  calls: Array<{ did: string; permissions: unknown; options: unknown }>;
} {
  const calls: Array<{ did: string; permissions: unknown; options: unknown }> = [];
  return {
    calls,
    async delegateTo(did, permissions, options) {
      calls.push({ did, permissions, options });
      return { delegation: makePortableDelegation(), prompted: false };
    },
  };
}

describe("grantAuthRequest", () => {
  test("turns a request into a tinycloud.auth.delegation grant audienced to the requester", async () => {
    const authority = makeAuthority();
    const request = makeRequest();

    const grant = await grantAuthRequest(authority, request);

    // Delegation is issued to the requester's session DID, for exactly the
    // requested caps.
    expect(authority.calls).toHaveLength(1);
    expect(authority.calls[0].did).toBe(REQUESTER_DID);
    expect(authority.calls[0].permissions).toEqual(request.requested);

    // Grant artifact has the shape `tc auth import` accepts.
    expect(grant).toEqual({
      kind: "tinycloud.auth.delegation",
      version: 1,
      requestId: "req_test_1",
      delegationCid: "bafy-granted",
      delegation: expect.objectContaining({ cid: "bafy-granted" }),
      permissions: request.requested,
      expiry: "2099-01-01T00:00:00.000Z",
      prompted: false,
    });
  });

  test("forwards the request's requestedExpiry to delegateTo", async () => {
    const authority = makeAuthority();
    await grantAuthRequest(authority, makeRequest({ requestedExpiry: "7d" }));
    expect(authority.calls[0].options).toEqual({ expiry: "7d" });
  });

  test("an explicit expiry option overrides the request's requestedExpiry", async () => {
    const authority = makeAuthority();
    await grantAuthRequest(authority, makeRequest({ requestedExpiry: "7d" }), { expiry: "30m" });
    expect(authority.calls[0].options).toEqual({ expiry: "30m" });
  });

  test("omits the options argument when no expiry is specified", async () => {
    const authority = makeAuthority();
    await grantAuthRequest(authority, makeRequest());
    expect(authority.calls[0].options).toBeUndefined();
  });

  test("rejects a non-request artifact", async () => {
    const authority = makeAuthority();
    await expect(
      grantAuthRequest(
        authority,
        { kind: "tinycloud.auth.delegation" } as unknown as AuthRequestArtifact,
      ),
    ).rejects.toThrow(/tinycloud.auth.request/);
    expect(authority.calls).toHaveLength(0);
  });

  test("rejects a request with no requested capabilities", async () => {
    const authority = makeAuthority();
    await expect(
      grantAuthRequest(authority, makeRequest({ requested: [] })),
    ).rejects.toThrow(/no requested capabilities/);
    expect(authority.calls).toHaveLength(0);
  });
});

describe("activateValidatedRuntimeDelegation", () => {
  test("preserves provenance metadata on the installed delegation", async () => {
    const authorizationPayload = {
      iss: "did:key:signed-delegator",
      aud: REQUESTER_DID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      prf: ["bafy-signed-parent"],
      fct: [{ remainingRedelegationDepth: 0 }],
      att: {
        "tinycloud:pkh:eip155:1:0xowner:applications/sql/docs": {
          "tinycloud.sql/read": [{}],
        },
      },
    };
    const authorization = `header.${Buffer.from(
      JSON.stringify(authorizationPayload),
    ).toString("base64url")}.signature`;
    const delegation: PortableDelegation = {
      cid: `cid:${authorization}`,
      delegationHeader: { Authorization: authorization },
      ownerAddress: "0xowner",
      chainId: 1,
      delegatorDID: "did:key:spoofed-delegator",
      parentCid: "bafy-spoofed-parent",
      allowSubDelegation: true,
      disableSubDelegation: false,
      authHeader: "spoofed-authorization",
      spaceId: "tinycloud:pkh:eip155:1:0xowner:applications",
      path: "docs",
      actions: ["tinycloud.sql/read"],
      expiry: new Date(authorizationPayload.exp * 1000),
      delegateDID: REQUESTER_DID,
      resources: [
        {
          service: "sql",
          space: "tinycloud:pkh:eip155:1:0xowner:applications",
          path: "docs",
          actions: ["tinycloud.sql/read"],
        },
      ],
    };

    const installed: PortableDelegation[] = [];
    const node: RuntimeDelegationActivator = {
      sessionDid: REQUESTER_DID,
      computeDelegationCid: (value) => `cid:${value}`,
      async useRuntimeDelegation(candidate) {
        installed.push(candidate);
      },
      getRuntimePermissionDelegations() {
        return installed;
      },
    };

    const activated = await activateValidatedRuntimeDelegation(node, delegation, {
      host: "https://node.example",
    });

    expect(activated.delegation).toMatchObject({
      delegatorDID: "did:key:signed-delegator",
      parentCid: "bafy-signed-parent",
      allowSubDelegation: false,
      disableSubDelegation: true,
      authHeader: authorization,
    });
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      delegatorDID: "did:key:signed-delegator",
      parentCid: "bafy-signed-parent",
      allowSubDelegation: false,
      disableSubDelegation: true,
      authHeader: authorization,
    });

    const excessiveDepthPayload = {
      ...authorizationPayload,
      fct: [{ remainingRedelegationDepth: 9 }],
    };
    const excessiveDepthAuthorization = `header.${Buffer.from(
      JSON.stringify(excessiveDepthPayload),
    ).toString("base64url")}.signature`;
    await expect(activateValidatedRuntimeDelegation(node, {
      ...delegation,
      cid: `cid:${excessiveDepthAuthorization}`,
      delegationHeader: { Authorization: excessiveDepthAuthorization },
    }, {
      host: "https://node.example",
    })).rejects.toThrow("invalid signed redelegation depth");
  });
});

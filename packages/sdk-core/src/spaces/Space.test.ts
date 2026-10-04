import { describe, expect, it } from "bun:test";
import { authorizationVerdictOf, ErrorCodes } from "@tinycloud/sdk-services";
import type {
  IDataVaultService,
  ISecretsService,
  IKVService,
  Result,
  ServiceError,
} from "@tinycloud/sdk-services";

import { SpaceService, type SpaceServiceConfig } from "./SpaceService";
import { httpResponseError } from "../http-error";

const session = {
  delegationHeader: { Authorization: "Bearer test" },
  delegationCid: "bafy-test",
  spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
  verificationMethod: "did:key:z6MkTest",
  jwk: {},
};

function makeConfig(
  calls: { kv: string[]; vault: string[]; secrets: string[] },
): SpaceServiceConfig {
  return {
    hosts: ["https://node.tinycloud.xyz"],
    session,
    invoke: () => ({}),
    userDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    createKVService: (spaceId) => {
      calls.kv.push(spaceId);
      return { spaceId } as unknown as IKVService;
    },
    createVaultService: (spaceId) => {
      calls.vault.push(spaceId);
      return { spaceId } as unknown as IDataVaultService;
    },
    createSecretsService: (spaceId) => {
      calls.secrets.push(spaceId);
      return { spaceId } as unknown as ISecretsService;
    },
    createDelegation: async () =>
      ({
        ok: false,
        error: {
          code: "NOT_IMPLEMENTED",
          message: "not implemented",
          service: "delegation",
        },
      }) as Result<never, ServiceError>,
  };
}

const delegatedSpaceId =
  "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:shared";

function configWithDelegatedSpace(): SpaceServiceConfig {
  return {
    ...makeConfig({ kv: [], vault: [], secrets: [] }),
    capabilityRegistry: {
      getAllCapabilities: () => [{
        delegation: {
          spaceId: delegatedSpaceId,
          delegatorDID: "did:pkh:eip155:1:0x0000000000000000000000000000000000000002",
          actions: ["tinycloud.kv/get"],
        },
      }],
    } as unknown as NonNullable<SpaceServiceConfig["capabilityRegistry"]>,
  };
}

describe("SpaceService space factories", () => {
  it("creates a space-scoped vault", () => {
    const calls = { kv: [] as string[], vault: [] as string[], secrets: [] as string[] };
    const spaces = new SpaceService(makeConfig(calls));

    const secrets = spaces.get("secrets");

    expect((secrets.kv as unknown as { spaceId: string }).spaceId).toBe(
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
    );
    expect((secrets.vault as unknown as { spaceId: string }).spaceId).toBe(
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
    );
    expect((secrets.secrets as unknown as { spaceId: string }).spaceId).toBe(
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
    );
    expect(calls).toEqual({
      kv: [
        "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
      ],
      vault: [
        "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
      ],
      secrets: [
        "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
      ],
    });
  });

  it("caches space instances with their scoped services", () => {
    const calls = { kv: [] as string[], vault: [] as string[], secrets: [] as string[] };
    const spaces = new SpaceService(makeConfig(calls));

    expect(spaces.get("secrets")).toBe(spaces.get("secrets"));
    expect(calls.kv).toHaveLength(1);
    expect(calls.vault).toHaveLength(1);
    expect(calls.secrets).toHaveLength(1);
  });
});

describe("SpaceService HTTP failures", () => {
  it("preserves 401/403 status and Node text on space and delegation operations", async () => {
    const calls = { kv: [] as string[], vault: [] as string[], secrets: [] as string[] };
    for (const [status, body, verdict] of [
      [401, "Forbidden", "unauthenticated"],
      [403, "session expired", "forbidden"],
    ] as const) {
      const spaces = new SpaceService({
        ...makeConfig(calls),
        fetch: async () => new Response(body, { status }),
      });
      const space = spaces.get("secrets");
      const operations = [
        spaces.create("secrets"),
        space.info(),
        space.delegations.list(),
        space.delegations.listReceived(),
        space.delegations.revoke("bafy-delegation"),
      ];
      for (const operation of operations) {
        const result = await operation;
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe(ErrorCodes.AUTH_UNAUTHORIZED);
        expect(result.error.meta?.status).toBe(status);
        expect(result.error.message).toContain(String(status));
        expect(result.error.message).toContain(body);
        expect(authorizationVerdictOf(result.error)).toBe(verdict);
      }
    }
  });

  it("keeps domain-specific 404 and 409 result codes, status, and response body", async () => {
    const calls = { kv: [] as string[], vault: [] as string[], secrets: [] as string[] };
    for (const [status, action, code] of [
      [404, "info", "SPACE_NOT_FOUND"],
      [409, "create", "SPACE_ALREADY_EXISTS"],
    ] as const) {
      const spaces = new SpaceService({
        ...makeConfig(calls),
        fetch: async () => new Response("Node explains refusal", { status }),
      });
      const result = action === "info" ? await spaces.get("secrets").info() : await spaces.create("secrets");
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatchObject({ code, meta: { status } });
      expect(result.error.message).toContain("Node explains refusal");
      expect(authorizationVerdictOf(result.error)).toBe("other");
    }
  });
});

describe("SpaceService.list owned-space failures", () => {
  it.each([
    [401, "session expired", "unauthenticated"],
    [403, "permission revoked", "forbidden"],
  ] as const)("returns HTTP %i instead of delegated spaces", async (status, body, verdict) => {
    const spaces = new SpaceService({
      ...configWithDelegatedSpace(),
      fetch: async () => new Response(body, { status }),
    });

    const result = await spaces.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: ErrorCodes.AUTH_UNAUTHORIZED,
      meta: { status },
    });
    expect(result.error.message).toBe(`Failed to list owned spaces: HTTP ${status} - ${body}`);
    expect(authorizationVerdictOf(result.error)).toBe(verdict);
  });

  it("retains delegated spaces when the owned-space endpoint returns 502", async () => {
    const spaces = new SpaceService({
      ...configWithDelegatedSpace(),
      fetch: async () => new Response("Bad Gateway", { status: 502 }),
    });

    const result = await spaces.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((space) => [space.id, space.type, space.permissions])).toEqual([[
      delegatedSpaceId,
      "delegated",
      ["tinycloud.kv/get"],
    ]]);
  });

  it("preserves HTTP status and status text if reading an error body fails", async () => {
    const spaces = new SpaceService({
      ...configWithDelegatedSpace(),
      fetch: async () => {
        const response = new Response(null, { status: 403, statusText: "Forbidden" });
        Object.defineProperty(response, "text", {
          value: () => Promise.reject(new Error("body stream unavailable")),
        });
        return response;
      },
    });

    const result = await spaces.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: ErrorCodes.AUTH_UNAUTHORIZED,
      meta: { status: 403 },
    });
    expect(result.error.message).toBe("Failed to list owned spaces: HTTP 403 - Forbidden");
  });
});

describe("httpResponseError", () => {
  it("trims and bounds HTTP diagnostics without losing the status", async () => {
    const failure = await httpResponseError(
      new Response(`  ${"x".repeat(600)}  `, { status: 502 }),
      "request rejected",
    );
    expect(failure.status).toBe(502);
    expect(failure.message).toBe(`request rejected: HTTP 502 - ${"x".repeat(512)}`);
  });

  it("omits the separator for empty or unreadable bodies without status text", async () => {
    const empty = await httpResponseError(new Response("  ", { status: 403 }), "request rejected");
    expect(empty.message).toBe("request rejected: HTTP 403");
    expect(empty.status).toBe(403);

    const response = new Response(null, { status: 502 });
    Object.defineProperty(response, "text", {
      value: () => Promise.reject(new Error("body stream unavailable")),
    });
    const unreadable = await httpResponseError(response, "request rejected");
    expect(unreadable.message).toBe("request rejected: HTTP 502");
    expect(unreadable.status).toBe(502);
  });
});

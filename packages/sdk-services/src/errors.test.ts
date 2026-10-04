import { describe, expect, test } from "bun:test";

import { authorizationVerdictOf, authUnauthorizedError, validatedCapabilityOf } from "./errors";
import { ErrorCodes, serviceError } from "./types";

/** Nest `inner` under `depth` plain wrapper errors linked by `cause`. */
function wrapped(inner: unknown, depth: number): unknown {
  let error = inner;
  for (let i = 0; i < depth; i += 1) {
    error = Object.assign(new Error(`wrapper ${i}`), { cause: error });
  }
  return error;
}

describe("authorizationVerdictOf", () => {
  test.each([
    ["status 401", { status: 401 }, "unauthenticated"],
    ["statusCode 403", { statusCode: 403 }, "forbidden"],
    ["meta.status 401", { meta: { status: 401 } }, "unauthenticated"],
    ["KV-style AUTH_UNAUTHORIZED with meta.status 401", authUnauthorizedError("kv", "Forbidden", { status: 401 }), "unauthenticated"],
    ["AUTH_UNAUTHORIZED with meta.status 403", authUnauthorizedError("kv", "session expired", { status: 403 }), "forbidden"],
    ["AUTH_UNAUTHORIZED without a status", authUnauthorizedError("kv", "Unauthorized Action: x / y"), "forbidden"],
    ["non-auth error status", serviceError(ErrorCodes.KV_WRITE_FAILED, "Unauthorized Action", "kv", { meta: { status: 500 } }), "other"],
    ["404", { status: 404 }, "other"],
  ] as const)("%s → %s", (_name, error, verdict) => {
    expect(authorizationVerdictOf(error)).toBe(verdict);
  });

  test.each([
    ["no structure", new Error("401 Unauthorized Action")],
    ["non-auth code without status", serviceError(ErrorCodes.NETWORK_ERROR, "401", "kv")],
    ["string", "403"],
    ["null", null],
    ["out-of-range numeric status", { status: 0 }],
    ["string status", { status: "401" }],
  ] as const)("untyped: %s → undefined", (_name, error) => {
    expect(authorizationVerdictOf(error)).toBeUndefined();
  });

  test("follows cause through rethrowing wrappers", () => {
    const kvError = authUnauthorizedError("kv", "Forbidden", { status: 401 });
    expect(authorizationVerdictOf(wrapped(kvError, 3))).toBe("unauthenticated");
  });

  test("the outermost error status decides: an outer 5xx keeps its retry budget", () => {
    const error = Object.assign(new Error("gateway"), { status: 502, cause: { status: 401 } });
    expect(authorizationVerdictOf(error)).toBe("other");
  });

  test("an outer error status decides over inner ones; a status-less code defers to an inner status", () => {
    const outer403 = Object.assign(new Error("outer"), {
      status: 403,
      cause: authUnauthorizedError("kv", "x", { status: 401 }),
    });
    expect(authorizationVerdictOf(outer403)).toBe("forbidden");

    // A code without a status defers to a status further down the chain.
    const codeOverStatus = Object.assign(new Error("outer"), {
      code: ErrorCodes.AUTH_UNAUTHORIZED,
      cause: { status: 401 },
    });
    expect(authorizationVerdictOf(codeOverStatus)).toBe("unauthenticated");
  });

  test("non-error statuses are skipped, not decisive", () => {
    expect(authorizationVerdictOf({ status: 200, cause: { meta: { status: 401 } } })).toBe("unauthenticated");
    expect(
      authorizationVerdictOf(Object.assign(new Error("x"), { cause: new Response(null, { status: 200 }) })),
    ).toBeUndefined();
    expect(authorizationVerdictOf({ status: 302, meta: { status: 403 } })).toBe("forbidden");
  });

  test("stops at the depth limit", () => {
    const kvError = authUnauthorizedError("kv", "x", { status: 401 });
    // The walk visits at most 8 links: the error and 7 causes.
    expect(authorizationVerdictOf(wrapped(kvError, 7))).toBe("unauthenticated");
    expect(authorizationVerdictOf(wrapped(kvError, 8))).toBeUndefined();
  });

  test("terminates on cause cycles", () => {
    const a: Record<string, unknown> = { message: "a" };
    const b: Record<string, unknown> = { message: "b", cause: a };
    a.cause = b;
    expect(authorizationVerdictOf(a)).toBeUndefined();

    const coded: Record<string, unknown> = { code: ErrorCodes.AUTH_UNAUTHORIZED };
    coded.cause = coded;
    expect(authorizationVerdictOf(coded)).toBe("forbidden");
  });
});

describe("validatedCapabilityOf", () => {
  const kvResource = "tinycloud:pkh:eip155:1:0xabc:default/kv/vault/secrets/API_KEY";
  const capability = {
    service: "kv",
    code: ErrorCodes.AUTH_UNAUTHORIZED,
    meta: {
      status: 401,
      resource: kvResource,
      requiredAction: "tinycloud.kv/get",
    },
  };

  test("only typed authorization errors with a safe, grantable service action identify a missing capability", () => {
    const expected = { resource: kvResource, requiredAction: "tinycloud.kv/get" };
    expect(validatedCapabilityOf(capability)).toEqual(expected);
    expect(validatedCapabilityOf(wrapped(capability, 2))).toEqual(expected);
    expect(validatedCapabilityOf({ ...capability, meta: { ...capability.meta, status: 403 } })).toEqual(expected);
    expect(validatedCapabilityOf({ ...capability, meta: { status: 401 } })).toBeUndefined();
    expect(validatedCapabilityOf({ ...capability, meta: { ...capability.meta, status: 500 } })).toBeUndefined();
  });

  test("service-less CLI errors infer only a TinyCloud resource's matching service", () => {
    const resource = "tinycloud:pkh:eip155:1:0xabc:applications/notes/sql/default";
    const meta = { status: 401, resource, requiredAction: "tinycloud.sql/write" };
    expect(validatedCapabilityOf({ meta })).toEqual({
      resource,
      requiredAction: "tinycloud.sql/write",
    });
    expect(validatedCapabilityOf({ meta: { ...meta, requiredAction: "tinycloud.kv/put" } })).toBeUndefined();
    expect(validatedCapabilityOf({ meta: { ...meta, service: "kv" } })).toBeUndefined();
    expect(validatedCapabilityOf({ meta: { status: 401, resource: "vault/secrets/API_KEY", requiredAction: "tinycloud.kv/get" } })).toBeUndefined();
    expect(validatedCapabilityOf({ service: "kv", meta: { status: 401, resource: "vault/secrets/API_KEY", requiredAction: "tinycloud.kv/get" } })).toBeUndefined();
  });

  test("accepts a documented encryption network URN without accepting an arbitrary URN", () => {
    const resource = "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:dev";
    const meta = { status: 403, resource, requiredAction: "tinycloud.encryption/decrypt" };
    expect(validatedCapabilityOf({ service: "encryption", meta })).toEqual({
      resource,
      requiredAction: "tinycloud.encryption/decrypt",
    });
    expect(validatedCapabilityOf({ service: "kv", meta })).toBeUndefined();
    expect(validatedCapabilityOf({ service: "encryption", meta: { ...meta, resource: "urn:tinycloud:encryption:other" } })).toBeUndefined();
  });

  test.each([
    ["URL", "https://attacker.example/grant", "tinycloud.kv/get", "kv"],
    ["non-HTTP URL", "ftp:attacker.example/grant", "tinycloud.kv/get", "kv"],
    ["fragment", `${kvResource}#other`, "tinycloud.kv/get", "kv"],
    ["shell expansion", "tinycloud:pkh:eip155:1:0xabc:default/kv/vault/${HOME}", "tinycloud.kv/get", "kv"],
    ["control character", "tinycloud:pkh:eip155:1:0xabc:default/kv/vault/key\nnext", "tinycloud.kv/get", "kv"],
    ["path traversal", "tinycloud:pkh:eip155:1:0xabc:default/kv/vault/../secrets", "tinycloud.kv/get", "kv"],
    ["cross-service action", kvResource, "tinycloud.sql/read", "kv"],
    ["non-grantable action", kvResource, "tinycloud.kv/get;curl", "kv"],
    ["wildcard action", kvResource, "tinycloud.kv/*", "kv"],
    ["action suffix", kvResource, "tinycloud.kv/get/other", "kv"],
    ["unknown action", kvResource, "tinycloud.kv/execute", "kv"],
  ] as const)("rejects %s metadata", (_kind, resource, requiredAction, service) => {
    expect(validatedCapabilityOf({
      service,
      code: ErrorCodes.AUTH_UNAUTHORIZED,
      meta: { status: 403, resource, requiredAction },
    })).toBeUndefined();
  });

  test("outer errors retain authority over a cause carrying capability metadata", () => {
    expect(validatedCapabilityOf({ status: 502, cause: capability })).toBeUndefined();
    expect(validatedCapabilityOf({ status: 403, cause: { ...capability, meta: { ...capability.meta, status: 500 } } })).toBeUndefined();
  });
});

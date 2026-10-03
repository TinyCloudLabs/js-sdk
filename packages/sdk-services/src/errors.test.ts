import { describe, expect, test } from "bun:test";

import { authorizationVerdictOf, authUnauthorizedError } from "./errors";
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

import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { ServiceContext } from "../context";
import { SQLService } from "./SQLService";
import { ErrorCodes } from "../types";

const marker = "SYNTHETIC-SQL-CODE-BOUNDARY-PRIVATE";
function service(host: string) {
  const context = new ServiceContext({
    invoke: () => ({ Authorization: "test-invocation" }), hosts: [host], retryPolicy: { maxAttempts: 1 },
    session: {
      delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid",
      spaceId: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:applications",
      verificationMethod: "did:key:test", jwk: {},
    },
  });
  const ordinary: unknown[] = [];
  context.on("service.error", (event) => ordinary.push(event));
  const sql = new SQLService(); sql.initialize(context);
  return { sql, ordinary };
}

test("redacted SQL failures retain the known readonly code and status before ordinary delivery", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ error: "sql_readonly_violation", detail: marker }, { status: 403 }),
  });
  try {
    const { sql, ordinary } = service(server.url.href);
    const result = await sql.query("SELECT 1", [], { redactErrors: true });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_READONLY_VIOLATION, meta: { status: 403 } } });
    expect(ordinary).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: ErrorCodes.SQL_READONLY_VIOLATION, meta: { status: 403 } }) })]);
    expect(inspect({ result, ordinary }, { depth: 20 })).not.toContain(marker);
  } finally { server.stop(true); }
});

test("untrusted backend code spellings and nonstrings cannot replace SQL error classification", async () => {
  for (const code of ["UNKNOWN_BACKEND_CODE", "__proto__", "constructor", "toString", undefined, 42]) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ error: { code, message: marker, cause: { value: marker } } }, { status: 400 }),
    });
    try {
      const { sql, ordinary } = service(server.url.href);
      const result = await sql.query("SELECT 1", [], { redactErrors: true });
      expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR, meta: { status: 400 } } });
      expect(ordinary).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }) })]);
      expect(inspect({ result, ordinary }, { depth: 20 })).not.toContain(marker);
    } finally { server.stop(true); }
  }
});

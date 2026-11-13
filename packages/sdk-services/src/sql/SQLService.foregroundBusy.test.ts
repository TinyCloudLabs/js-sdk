import { expect, test } from "bun:test";
import { ServiceContext } from "../context";
import { ErrorCodes } from "../types";
import { SQLService } from "./SQLService";

test("browser foreground SQL returns typed busy after one oversized Retry-After", async () => {
  let attempts = 0;
  const context = new ServiceContext({
    hosts: ["https://sql-foreground-busy.fixture"],
    session: {
      delegationHeader: { Authorization: "Bearer fixture" },
      delegationCid: "fixture",
      spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      verificationMethod: "did:key:fixture",
      jwk: {},
    },
    invoke: () => ({}),
    retryPolicy: { foregroundBusyMaxTotalMs: 4_000 },
    fetch: async (_url, init) => {
      attempts++;
      expect(init?.priority).toBe("high");
      return new Response("sql_busy: begin: database is locked", {
        status: 503,
        headers: { "retry-after": "5" },
      });
    },
  });
  const sql = new SQLService({});
  sql.initialize(context);
  const started = performance.now();
  const result = await sql.db("main").query("SELECT 1");

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a typed busy result");
  expect(result.error.code).toBe(ErrorCodes.NODE_BUSY);
  expect(result.error.meta).toMatchObject({ retryable: true, retryAfterMs: 5_000 });
  expect(attempts).toBe(1);
  expect(performance.now() - started).toBeLessThan(500);
});

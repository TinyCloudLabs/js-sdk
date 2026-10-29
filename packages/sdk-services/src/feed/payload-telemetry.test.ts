import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { ServiceContext } from "../context";
import { SQLService } from "../sql/SQLService";
import { ErrorCodes } from "../types";
import type { FetchFunction } from "../types";
import type { QueryOptions } from "../sql/types";

const marker = "SYNTHETIC-PRIVATE-SQL-ERROR-CODE-88";
const privateOptions: QueryOptions & { redactErrors: true } = { redactErrors: true };
const session = {
  delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid",
  spaceId: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:applications",
  verificationMethod: "did:key:test", jwk: {},
};

function sqlService(host: string, fetch?: FetchFunction) {
  const context = new ServiceContext({
    invoke: () => ({ Authorization: "test-invocation" }), hosts: [host], session, fetch,
    retryPolicy: { maxAttempts: 1 },
  });
  const ordinary: unknown[] = [];
  context.on("service.error", (event) => { ordinary.push(event); });
  const service = new SQLService();
  service.initialize(context);
  return { service, ordinary };
}

for (const operation of ["query", "execute", "batch"] as const) {
  test(`${operation} private HTTP failure is sanitized before ordinary SERVICE_ERROR delivery`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ error: `SQL value ${marker}`, cause: { private: marker }, meta: { payload: marker } }, { status: 400 }),
    });
    try {
      const { service, ordinary } = sqlService(server.url.href);
      const result = operation === "query" ? await service.query("SELECT ?", [marker], privateOptions)
        : operation === "execute" ? await service.execute("INSERT INTO t(value) VALUES (?)", [marker], privateOptions)
        : await service.batch([{ sql: "INSERT INTO t(value) VALUES (?)", params: [marker] }], privateOptions);
      expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR, meta: { status: 400 } } });
      expect(ordinary).toEqual([expect.objectContaining({
        service: "sql", error: expect.objectContaining({ code: ErrorCodes.SQL_ERROR, meta: { status: 400 } }),
      })]);
      expect(inspect({ result, ordinary }, { depth: 20 })).not.toContain(marker);
    } finally { server.stop(true); }
  });

  test(`${operation} private thrown transport cause and metadata never escape result or ordinary subscribers`, async () => {
    const { service, ordinary } = sqlService("https://unused.test", async () => {
      const error = new Error(`transport ${marker}`, { cause: new Error(`nested ${marker}`) });
      Object.assign(error, { meta: { privatePayload: { code: marker } } });
      throw error;
    });
    const result = operation === "query" ? await service.query("SELECT ?", [marker], privateOptions)
      : operation === "execute" ? await service.execute("INSERT INTO t(value) VALUES (?)", [marker], privateOptions)
      : await service.batch([{ sql: "INSERT INTO t(value) VALUES (?)", params: [marker] }], privateOptions);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.NETWORK_ERROR } });
    expect(ordinary).toEqual([expect.objectContaining({
      service: "sql", error: expect.objectContaining({ code: ErrorCodes.NETWORK_ERROR }),
    })]);
    expect(inspect({ result, ordinary }, { depth: 20 })).not.toContain(marker);
  });
}

test("ordinary SQL calls keep their existing public error details when redaction is not requested", async () => {
  const detail = "PUBLIC-SQL-DIAGNOSTIC-DETAIL";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(detail, { status: 400 }) });
  try {
    const { service, ordinary } = sqlService(server.url.href);
    const result = await service.query("SELECT 1");
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.SQL_ERROR } });
    expect(inspect(result, { depth: 10 })).toContain(detail);
    expect(inspect(ordinary, { depth: 10 })).toContain(detail);
  } finally { server.stop(true); }
});

test("the actual CLI error renderer and an ordinary subscriber do not echo private SQL failure data", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(`synthetic SQL payload failure ${marker}`, { status: 400 }),
  });
  try {
    const sqlPath = new URL("../sql/SQLService.ts", import.meta.url).pathname;
    const contextPath = new URL("../context.ts", import.meta.url).pathname;
    const errorsPath = new URL("../../../cli/src/output/errors.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "--eval", `
      import { SQLService } from ${JSON.stringify(sqlPath)};
      import { ServiceContext } from ${JSON.stringify(contextPath)};
      import { cliErrorFromService, handleError } from ${JSON.stringify(errorsPath)};
      const context = new ServiceContext({
        invoke: () => ({ Authorization: 'test-invocation' }), hosts: [${JSON.stringify(server.url.href)}],
        session: ${JSON.stringify(session)}, retryPolicy: { maxAttempts: 1 },
      });
      context.on('service.error', event => process.stderr.write(JSON.stringify(event) + '\\n'));
      const service = new SQLService(); service.initialize(context);
      const result = await service.query('SELECT ?', [${JSON.stringify(marker)}], { redactErrors: true });
      if (result.ok) throw new Error('The private SQL failure was mislabeled as success');
      await handleError(cliErrorFromService(result.error));
    `], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain(ErrorCodes.SQL_ERROR);
    expect(stdout + stderr).not.toContain(marker);
  } finally { server.stop(true); }
});

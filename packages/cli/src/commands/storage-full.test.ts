import { describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

// A node whose account is over its plan: every write that would store more is
// refused with the SDK's storage error (node 402), every read still works.
const fullStorage = {
  ok: false,
  error: {
    code: "STORAGE_QUOTA_EXCEEDED",
    message: "TinyCloud storage is full, so this change was not saved. Reading still works. Free up space or upgrade your plan to save again.",
    service: "kv",
    meta: { status: 402, usedBytes: 155_744, limitBytes: 0, account: { usedBytes: 389_777_359, limitBytes: 104_857_600, plan: "free" } },
  },
};
const writes: string[] = [];
function refuse(label: string) {
  return async () => {
    writes.push(label);
    return fullStorage;
  };
}
const kv = {
  put: refuse("kv.put"),
  get: async () => ({ ok: true, data: { data: new TextEncoder().encode("still readable"), headers: {} } }),
  withPrefix: () => ({ put: refuse("vars.put") }),
};
// `tc sql copy` source rows; the destination takes two before storage fills up.
const sourceRows = [["a"], ["b"], ["c"]];
let destinationRoom = 0;
const fullNode = {
  kv,
  sql: {
    db: (name: string) => name === "source"
      ? {
        query: async (sql: string) => ({
          ok: true,
          data: sql.startsWith("SELECT count(*)")
            ? { columns: ["n"], rows: [[sourceRows.length]], rowCount: 1 }
            : { columns: ["body"], rows: sourceRows, rowCount: sourceRows.length },
        }),
      }
      : {
        execute: async (...args: unknown[]) => {
          if (destinationRoom > 0) {
            destinationRoom -= 1;
            return { ok: true, data: { changes: 1 } };
          }
          return refuse("sql.execute")(...args);
        },
        query: async () => ({ ok: true, data: { columns: ["n"], rows: [[1]], rowCount: 1 } }),
      },
  },
  duckdb: { db: () => ({ execute: refuse("duckdb.execute") }) },
  vault: { unlock: async () => ({ ok: true }), put: refuse("vault.put") },
  account: { spaces: { syncAccessible: refuse("account.spaces.sync") } },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "full", host: "https://node.example" }),
    getProfile: async () => ({}),
  },
}));
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => fullNode,
}));

const { registerKvCommand } = await import("./kv.js");
// Loaded after the mocks above so the commands bind to the full node.
const { registerSqlCommand } = await import("./sql.js");
const { registerDuckdbCommand } = await import("./duckdb.js");
const { registerVarsCommand } = await import("./vars.js");
const { registerVaultCommand } = await import("./vault.js");
const { registerAccountCommand } = await import("./account.js");

async function run(args: string[]): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const program = new Command();
  for (const register of [registerKvCommand, registerSqlCommand, registerDuckdbCommand, registerVarsCommand, registerVaultCommand, registerAccountCommand]) {
    register(program);
  }
  const originalExit = process.exit;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  process.exit = ((code?: number): never => {
    exitCode = code;
    throw new Error("process.exit");
  }) as typeof process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await program.parseAsync(["node", "tc", ...args]).catch((error: unknown) => {
      if (!(error instanceof Error && error.message === "process.exit")) throw error;
    });
  } finally {
    process.exit = originalExit;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return { exitCode, stdout, stderr };
}

describe("a full TinyCloud account", () => {
  const privateKey = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

  test("every write command prints the one storage-full error and exits 10", async () => {
    const commands = [
      ["kv", "put", "note", "hello"],
      ["sql", "execute", "INSERT INTO notes (body) VALUES ('x')"],
      ["duckdb", "execute", "INSERT INTO notes VALUES (1)"],
      ["vars", "put", "NAME", "value", "--private-key", privateKey],
      ["vault", "put", "note", "hello", "--private-key", privateKey],
      // account commands convert the result once; the account totals must survive it.
      ["account", "spaces", "sync"],
    ];
    for (const args of commands) {
      const { exitCode, stdout, stderr } = await run(args);
      expect({ args, exitCode }).toEqual({ args, exitCode: 10 });
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toEqual({
        error: {
          code: "STORAGE_QUOTA_EXCEEDED",
          message: "TinyCloud storage is full; nothing was written.",
          hint: "371.7 MiB used of 100 MiB (free plan). Reading still works.\nFree up space or upgrade: https://account.tinycloud.xyz/billing",
        },
      });
    }
    expect(writes).toEqual(["kv.put", "sql.execute", "duckdb.execute", "vars.put", "vault.put", "account.spaces.sync"]);
  });

  test("sql copy that fills storage part-way reports how far it got, not that nothing was written", async () => {
    destinationRoom = 2;
    const { exitCode, stdout, stderr } = await run(["sql", "copy", "--from-db", "source", "--to-db", "dest", "--table", "notes"]);
    expect(exitCode).toBe(10);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "STORAGE_QUOTA_EXCEEDED",
        message: 'Insert into "notes" failed after 2 row(s): TinyCloud storage is full.',
        hint: "371.7 MiB used of 100 MiB (free plan). Reading still works.\nFree up space or upgrade: https://account.tinycloud.xyz/billing",
      },
    });
  });

  test("reads keep working", async () => {
    const kvRead = await run(["kv", "get", "note"]);
    expect(kvRead.exitCode).toBeUndefined();
    expect(kvRead.stderr).toBe("");
    expect(kvRead.stdout).toContain("\"key\": \"note\"");

    const sqlRead = await run(["sql", "query", "SELECT 1 AS n"]);
    expect(sqlRead.exitCode).toBeUndefined();
    expect(JSON.parse(sqlRead.stdout)).toMatchObject({ rows: [[1]], rowCount: 1 });
  });
});

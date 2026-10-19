import { CLIError } from "../output/errors.js";
import { afterEach, describe, expect, test } from "bun:test";
import { createCliReplicationConfig } from "./replication-config.js";

const previousVerify = process.env.TC_REPLICATION_VERIFY;

afterEach(() => {
  if (previousVerify === undefined) delete process.env.TC_REPLICATION_VERIFY;
  else process.env.TC_REPLICATION_VERIFY = previousVerify;
});

describe("CLI replication configuration", () => {
  test("enables verification when TC_REPLICATION_VERIFY=1", () => {
    process.env.TC_REPLICATION_VERIFY = "1";

    const config = createCliReplicationConfig("replication-config-test", { prefixes: ["test/"] }, { debug: false, quiet: true }, true);

    expect(config?.verify).toBe(true);
  });
  test("saved prefixes reject malformed values as usage errors with a repair hint", () => {
    for (const prefix of ["", "notes", "notes//", "/notes/"]) {
      let error: unknown;
      try {
        createCliReplicationConfig("replication-config-test", { prefixes: [prefix] }, { debug: false, quiet: true }, true);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CLIError);
      expect(error).toMatchObject({ code: "INVALID_REPLICATION_PREFIX", exitCode: 2 });
      expect(error instanceof CLIError ? error.message : "").toContain("Replication prefix");
      expect(error instanceof CLIError ? error.metadata?.hint : "").toContain("purging a replica alone");
    }
  });

  test("accepts a whole-space saved prefix", () => {
    expect(createCliReplicationConfig(
      "replication-config-test",
      { prefixes: ["/"], allowSecrets: true },
      { debug: false, quiet: true },
      true,
    )?.prefixes).toEqual(["/"]);
  });
});

describe("CLI replication grant TTL and byte budget env", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const names = ["TC_REPLICATION_GRANT_TTL_MS", "TC_REPLICATION_MAX_BYTES"] as const;
  const previous: Record<(typeof names)[number], string | undefined> = {
    TC_REPLICATION_GRANT_TTL_MS: process.env.TC_REPLICATION_GRANT_TTL_MS,
    TC_REPLICATION_MAX_BYTES: process.env.TC_REPLICATION_MAX_BYTES,
  };

  afterEach(() => {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function configFor() {
    return createCliReplicationConfig("replication-config-test", { prefixes: ["test/"] }, { debug: false, quiet: true }, true);
  }

  test("grantTtlMs defaults to 24 hours when TC_REPLICATION_GRANT_TTL_MS is unset", () => {
    delete process.env.TC_REPLICATION_GRANT_TTL_MS;
    expect(configFor()?.grantTtlMs).toBe(DAY_MS);
  });

  test("TC_REPLICATION_GRANT_TTL_MS sets grantTtlMs up to exactly 7 days", () => {
    process.env.TC_REPLICATION_GRANT_TTL_MS = String(7 * DAY_MS);
    expect(configFor()?.grantTtlMs).toBe(7 * DAY_MS);
  });

  test("TC_REPLICATION_GRANT_TTL_MS above 7 days is a usage error that names the variable", () => {
    process.env.TC_REPLICATION_GRANT_TTL_MS = String(7 * DAY_MS + 1);
    let error: unknown;
    try {
      configFor();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CLIError);
    expect(error).toMatchObject({ exitCode: 2 });
    expect(error instanceof CLIError ? error.message : "").toContain("TC_REPLICATION_GRANT_TTL_MS");
  });

  test("non-integer, zero, negative and non-numeric grant TTLs are usage errors", () => {
    for (const value of ["0", "-1", "1.5", "soon", "", "0x10", "1e3", " 1000", "1000 ", "+1000", "010"]) {
      process.env.TC_REPLICATION_GRANT_TTL_MS = value;
      expect(() => configFor()).toThrow(CLIError);
    }
  });

  test("TC_REPLICATION_MAX_BYTES sets the origin-wide byte budget", () => {
    process.env.TC_REPLICATION_MAX_BYTES = String(1024 * 1024);
    expect(configFor()?.maxBytes).toBe(1024 * 1024);
  });

  test("non-integer, zero and negative byte budgets are usage errors", () => {
    for (const value of ["0", "-5", "2.5", "lots", "0x10", "1e3", " 1024", "1024 ", "+1024", "010", String(Number.MAX_SAFE_INTEGER) + "0"]) {
      process.env.TC_REPLICATION_MAX_BYTES = value;
      expect(() => configFor()).toThrow(CLIError);
    }
  });

  // Storage-side predicates, duplicated because storage inlines them (not exported):
  //   grantTtlMs: packages/node-sdk/src/replication/sqlite.ts:2732-2733 on master
  //     (!isSafeInteger || <= 0 || > MAX_GRANT_TTL_MS throws TypeError).
  //   maxBytes: packages/node-sdk/src/replication/sqlite.ts:2833-2834 on PR #547 at ffb8ce55
  //     (!isSafeInteger || < 0 throws TypeError; 0 is accepted by storage, rejected by the CLI).
  // minFreeBytes is not read by the CLI. Invariant: CLI-accepted values are a subset of these.
  const storageAcceptsGrantTtl = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 7 * DAY_MS;
  const storageAcceptsMaxBytes = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const SAFE_MAX = "9007199254740991";

  const table: Array<{ raw: string; ttl: boolean; maxBytes: boolean }> = [
    { raw: "0", ttl: false, maxBytes: false },
    { raw: "-1", ttl: false, maxBytes: false },
    { raw: "1", ttl: true, maxBytes: true },
    { raw: "1.5", ttl: false, maxBytes: false },
    { raw: "0x10", ttl: false, maxBytes: false },
    { raw: "1e3", ttl: false, maxBytes: false },
    { raw: " 10", ttl: false, maxBytes: false },
    { raw: "+10", ttl: false, maxBytes: false },
    { raw: "010", ttl: false, maxBytes: false },
    { raw: "9007199254740992", ttl: false, maxBytes: false },
    { raw: SAFE_MAX, ttl: false, maxBytes: true },
    { raw: "NaN", ttl: false, maxBytes: false },
    { raw: "", ttl: false, maxBytes: false },
    { raw: String(7 * DAY_MS), ttl: true, maxBytes: true },
    { raw: String(7 * DAY_MS + 1), ttl: false, maxBytes: true },
  ];

  test("CLI acceptance table; every accepted value is also accepted by storage", () => {
    for (const row of table) {
      for (const [name, expected, storageAccepts, read] of [
        ["TC_REPLICATION_GRANT_TTL_MS", row.ttl, storageAcceptsGrantTtl, (config: ReturnType<typeof configFor>) => config?.grantTtlMs],
        ["TC_REPLICATION_MAX_BYTES", row.maxBytes, storageAcceptsMaxBytes, (config: ReturnType<typeof configFor>) => config?.maxBytes],
      ] as const) {
        delete process.env.TC_REPLICATION_GRANT_TTL_MS;
        delete process.env.TC_REPLICATION_MAX_BYTES;
        process.env[name] = row.raw;
        if (!expected) {
          expect(() => configFor()).toThrow(CLIError);
          continue;
        }
        const accepted = read(configFor());
        expect(accepted).toBe(Number(row.raw));
        expect(storageAccepts(accepted as number)).toBe(true);
      }
    }
  });

  test("the CLI is deliberately stricter than storage for maxBytes 0", () => {
    expect(storageAcceptsMaxBytes(0)).toBe(true);
    process.env.TC_REPLICATION_MAX_BYTES = "0";
    expect(() => configFor()).toThrow(CLIError);
  });
});

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

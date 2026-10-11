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

    const config = createCliReplicationConfig("replication-config-test", { prefixes: ["test"] }, { debug: false, quiet: true }, true);

    expect(config?.verify).toBe(true);
  });
});

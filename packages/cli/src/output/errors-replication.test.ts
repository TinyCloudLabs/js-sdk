import { afterEach, describe, expect, test } from "bun:test";
import type { ReplicationControl } from "@tinycloud/node-sdk";
import { closeReplication, registerReplication } from "../lib/replication-registry.js";
import { CLIError, handleError } from "./errors.js";

afterEach(async () => { await closeReplication(); });

function control(closed: () => void): ReplicationControl {
  return {
    status: async () => [],
    sync: async () => undefined,
    purge: async () => ({ purged: [], failed: [] }),
    clearPending: async () => 0,
    close: async () => { closed(); },
  };
}

describe("handleError replication cleanup", () => {
  test("awaits registered controllers before exiting with the original code", async () => {
    const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
    const originalWrite = stderr.write;
    const originalExit = process.exit;
    const sequence: string[] = [];
    stderr.write = () => true;
    process.exit = ((code?: number) => { sequence.push(`exit:${code}`); throw new Error("expected exit"); }) as typeof process.exit;
    registerReplication("error-cleanup-test", control(() => { sequence.push("closed"); }));
    try {
      await expect(handleError(new CLIError("NODE_ERROR", "failure", 7))).rejects.toThrow("expected exit");
    } finally {
      stderr.write = originalWrite;
      process.exit = originalExit;
    }
    expect(sequence).toEqual(["closed", "exit:7"]);
  });
});

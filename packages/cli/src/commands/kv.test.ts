import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

type PutCall = { handle: string; key: string; value: unknown };
type DeleteCall = { handle: string; key: string };

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
  puts: [] as PutCall[],
  deletes: [] as DeleteCall[],
  resolveSpace: [] as Array<{ input: string | undefined; profile: string }>,
  kvForSpace: [] as string[],
};

function resetState(): void {
  recorded.outputs = [];
  recorded.errors = [];
  recorded.puts = [];
  recorded.deletes = [];
  recorded.resolveSpace = [];
  recorded.kvForSpace = [];
}

// A KV handle whose name records which space ("primary" vs the resolved uri)
// each operation routed through.
function makeKv(handle: string) {
  return {
    put: async (key: string, value: unknown) => {
      recorded.puts.push({ handle, key, value });
      return { ok: true, data: { data: undefined, headers: {} } };
    },
    delete: async (key: string) => {
      recorded.deletes.push({ handle, key });
      return { ok: true, data: undefined };
    },
  };
}

const node = {
  kv: makeKv("primary"),
  kvForSpace: (spaceUri: string) => {
    recorded.kvForSpace.push(spaceUri);
    return makeKv(spaceUri);
  },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "cli-test", host: "https://host" }),
  },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => node,
}));

mock.module("../lib/space.js", () => ({
  // Mirrors the real helper contract: undefined input => undefined (primary
  // space), otherwise a resolved full space URI.
  resolveSpaceUri: async (input: string | undefined, profile: string) => {
    recorded.resolveSpace.push({ input, profile });
    if (!input) return undefined;
    return `tinycloud:pkh:eip155:1:0xabc:${input}`;
  },
}));

mock.module("../output/formatter.js", () => ({
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  withSpinner: async (_message: string, fn: () => unknown) => await fn(),
  shouldOutputJson: () => true,
  formatTable: () => "",
  formatBytes: () => "",
  formatTimeAgo: () => "",
}));

mock.module("../output/theme.js", () => ({
  theme: { muted: (v: string) => v },
}));

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
    ) {
      super(message);
    }
  },
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
}));

const { registerKvCommand } = await import("./kv.js");

async function runKv(args: string[]): Promise<void> {
  const program = new Command();
  registerKvCommand(program);
  await program.parseAsync(["node", "tc", "kv", ...args], { from: "node" });
}

describe("CLI kv put --space", () => {
  beforeEach(resetState);

  test("writes to the primary space when --space is omitted", async () => {
    await runKv(["put", "note", "hello"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.kvForSpace).toEqual([]);
    expect(recorded.puts).toEqual([
      { handle: "primary", key: "note", value: "hello" },
    ]);
  });

  test("routes through kvForSpace when --space is provided", async () => {
    await runKv(["put", "note", "hello", "--space", "applications"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.resolveSpace).toEqual([
      { input: "applications", profile: "cli-test" },
    ]);
    expect(recorded.kvForSpace).toEqual([
      "tinycloud:pkh:eip155:1:0xabc:applications",
    ]);
    expect(recorded.puts).toEqual([
      {
        handle: "tinycloud:pkh:eip155:1:0xabc:applications",
        key: "note",
        value: "hello",
      },
    ]);
  });
});

describe("CLI kv delete --space", () => {
  beforeEach(resetState);

  test("deletes from the primary space when --space is omitted", async () => {
    await runKv(["delete", "note"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.kvForSpace).toEqual([]);
    expect(recorded.deletes).toEqual([{ handle: "primary", key: "note" }]);
  });

  test("routes through kvForSpace when --space is provided", async () => {
    await runKv(["delete", "note", "--space", "applications"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.kvForSpace).toEqual([
      "tinycloud:pkh:eip155:1:0xabc:applications",
    ]);
    expect(recorded.deletes).toEqual([
      { handle: "tinycloud:pkh:eip155:1:0xabc:applications", key: "note" },
    ]);
  });
});

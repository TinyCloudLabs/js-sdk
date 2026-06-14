import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

type PutCall = { handle: string; key: string; value: unknown };
type DeleteCall = { handle: string; key: string };
type GetCall = { handle: string; key: string; options: unknown };

// Bytes the fake KV handle returns from get(). Includes a non-UTF-8 byte (0xff)
// to prove raw bytes pass through unchanged, not a lossy text round-trip.
const GET_BYTES = new Uint8Array([137, 80, 78, 71, 0, 255, 1]);

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
  puts: [] as PutCall[],
  deletes: [] as DeleteCall[],
  gets: [] as GetCall[],
  resolveSpace: [] as Array<{ input: string | undefined; profile: string }>,
  kvForSpace: [] as string[],
  stdoutWrites: [] as Uint8Array[],
  fileWrites: [] as Array<{ path: string; data: Uint8Array }>,
};

function resetState(): void {
  recorded.outputs = [];
  recorded.errors = [];
  recorded.puts = [];
  recorded.deletes = [];
  recorded.gets = [];
  recorded.resolveSpace = [];
  recorded.kvForSpace = [];
  recorded.stdoutWrites = [];
  recorded.fileWrites = [];
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  return new TextEncoder().encode(String(chunk));
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
    get: async (key: string, options: unknown) => {
      recorded.gets.push({ handle, key, options });
      // Mirror the SDK: when { binary: true }, data is the raw bytes.
      return { ok: true, data: { data: GET_BYTES, headers: {} } };
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

mock.module("node:fs/promises", () => ({
  writeFile: async (path: string, data: unknown) => {
    recorded.fileWrites.push({ path, data: toBytes(data) });
  },
  readFile: async () => Buffer.from(""),
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

mock.module("../lib/host.js", () => ({
  // The unhosted-space normalizer is exercised in host.test.ts; here we keep it
  // a no-op so kv command routing tests don't pull in its real dependency graph.
  unhostedSpaceError: async () => null,
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

describe("CLI kv get binary output", () => {
  const realStdoutWrite = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    resetState();
    // Capture raw stdout writes without printing during the test run.
    (process.stdout.write as unknown) = (chunk: unknown) => {
      recorded.stdoutWrites.push(toBytes(chunk));
      return true;
    };
  });

  afterEach(() => {
    (process.stdout.write as unknown) = realStdoutWrite;
  });

  test("--raw requests binary mode and emits exact bytes to stdout", async () => {
    await runKv(["get", "img.png", "--raw"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.gets).toEqual([
      { handle: "primary", key: "img.png", options: { binary: true } },
    ]);
    // Exactly the bytes, nothing else (no trailing newline, no JSON wrapping).
    expect(recorded.stdoutWrites).toEqual([GET_BYTES]);
    expect(recorded.fileWrites).toEqual([]);
  });

  test("-o requests binary mode and writes exact bytes to the file", async () => {
    await runKv(["get", "img.png", "-o", "out.png"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.gets).toEqual([
      { handle: "primary", key: "img.png", options: { binary: true } },
    ]);
    expect(recorded.fileWrites).toEqual([
      { path: "out.png", data: GET_BYTES },
    ]);
    // No raw bytes leaked to stdout on the -o path (only the JSON status line,
    // which goes through outputJson, not process.stdout.write here).
    expect(recorded.stdoutWrites).toEqual([]);
  });

  test("default get (no --raw/-o) does NOT request binary mode", async () => {
    await runKv(["get", "img.png"]);

    expect(recorded.errors).toEqual([]);
    // wantBytes is false → get is called with `undefined` options.
    expect(recorded.gets).toEqual([
      { handle: "primary", key: "img.png", options: undefined },
    ]);
  });
});

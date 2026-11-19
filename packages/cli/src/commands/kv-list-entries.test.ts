import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

// TC-2492: `tc kv list` fills its Size and Updated table columns from list
// entries; JSON output stays keys only.

type ListPage = {
  keys: string[];
  entries?: Array<{ key: string; size?: number; updatedAt?: string }>;
  truncated?: boolean;
  nextCursor?: string;
};

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
  lists: [] as Array<Record<string, unknown>>,
  tables: [] as Array<{ headers: string[]; rows: string[][] }>,
};
let page: ListPage = { keys: [] };
let jsonOutput = true;

const kv = {
  list: async (options: Record<string, unknown> = {}) => {
    recorded.lists.push(options);
    return { ok: true, data: page };
  },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "cli-test", host: "https://host" }) },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => ({ kv, kvForSpace: () => kv }),
}));

mock.module("../lib/space.js", () => ({
  resolveSpaceUri: async () => undefined,
}));

mock.module("../output/formatter.js", () => ({
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  withSpinner: async (_message: string, fn: () => unknown) => await fn(),
  shouldOutputJson: () => jsonOutput,
  formatTable: (headers: string[], rows: string[][]) => {
    recorded.tables.push({ headers, rows });
    return "";
  },
  formatBytes: (bytes: number) => `${bytes} B`,
  formatTimeAgo: (date: string) => `ago(${date})`,
}));

mock.module("../output/theme.js", () => ({
  theme: { muted: (v: string) => v },
}));

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {},
  cliErrorFromService: (error: { message: string }) => new Error(error.message),
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
}));

mock.module("../lib/host.js", () => ({
  unhostedSpaceError: async () => null,
}));

// Imported after the mocks above are registered, so kv.js binds to them.
const { registerKvCommand } = await import("./kv.js");

async function runKv(args: string[]): Promise<void> {
  const program = new Command();
  registerKvCommand(program);
  await program.parseAsync(["node", "tc", "kv", ...args], { from: "node" });
}

describe("CLI kv list size and modified time (TC-2492)", () => {
  beforeEach(() => {
    recorded.outputs = [];
    recorded.errors = [];
    recorded.lists = [];
    recorded.tables = [];
    page = { keys: [] };
    jsonOutput = true;
  });

  test("the table asks for entries and shows each key's size and modified time", async () => {
    jsonOutput = false;
    page = {
      keys: ["a", "b"],
      entries: [{ key: "a", size: 28, updatedAt: "2026-11-13T15:00:00Z" }, { key: "b" }],
    };

    await runKv(["list"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.lists).toEqual([{ entries: true }]);
    expect(recorded.tables).toEqual([{
      headers: ["Key", "Size", "Updated"],
      rows: [["a", "28 B", "ago(2026-11-13T15:00:00Z)"], ["b", "—", "—"]],
    }]);
  });

  test("an offline table without entries still lists every key", async () => {
    jsonOutput = false;
    page = { keys: ["a", "b"] };

    await runKv(["list"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.tables).toEqual([{
      headers: ["Key", "Size", "Updated"],
      rows: [["a", "—", "—"], ["b", "—", "—"]],
    }]);
  });

  test("JSON output lists keys without asking for entries", async () => {
    page = { keys: ["a"], entries: [{ key: "a", size: 28 }] };

    await runKv(["list"]);

    expect(recorded.lists).toEqual([{}]);
    expect(recorded.outputs).toEqual([{ keys: ["a"], count: 1, prefix: null, truncated: null, nextCursor: null }]);
  });
});

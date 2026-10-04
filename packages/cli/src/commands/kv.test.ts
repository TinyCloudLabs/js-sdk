import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import * as fsPromises from "node:fs/promises";

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

// Sentinel key prefixes let a test drive the error path of a KV op:
//   UNHOSTED:* -> 404 + "Space not found" body (the unhosted-space signal)
//   MISSING:*  -> plain KV_NOT_FOUND "Key not found"
function errorFor(key: string) {
  if (key.startsWith("UNHOSTED:")) {
    return { ok: false, error: { code: "KV_NOT_FOUND", message: "KV 404 - Space not found", meta: { status: 404 } } };
  }
  if (key.startsWith("MISSING:")) {
    return { ok: false, error: { code: "KV_NOT_FOUND", message: "Key not found: " + key } };
  }
  if (key.startsWith("QUOTA-NO-SIZES:")) {
    return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "server quota text", service: "kv", meta: { status: 402 } } };
  }
  if (key.startsWith("QUOTA:")) {
    return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "server quota text", service: "kv", meta: { status: 402, usedBytes: 387_382_794, limitBytes: 8_119_195 } } };
  }
  return null;
}

// A KV handle whose name records which space ("primary" vs the resolved uri)
// each operation routed through.
function makeKv(handle: string) {
  return {
    put: async (key: string, value: unknown) => {
      recorded.puts.push({ handle, key, value });
      return errorFor(key) ?? { ok: true, data: { data: undefined, headers: {} } };
    },
    delete: async (key: string) => {
      recorded.deletes.push({ handle, key });
      return errorFor(key) ?? { ok: true, data: undefined };
    },
    get: async (key: string, options: unknown) => {
      recorded.gets.push({ handle, key, options });
      // Mirror the SDK: when { binary: true }, data is the raw bytes.
      return errorFor(key) ?? { ok: true, data: { data: GET_BYTES, headers: {} } };
    },
    head: async (key: string) => {
      recorded.gets.push({ handle, key, options: "head" });
      return errorFor(key) ?? { ok: true, data: { headers: {} } };
    },
    list: async () => ({ ok: true, data: { data: [] } }),
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
  formatBytes: (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`,
  formatTimeAgo: () => "",
}));

mock.module("../output/theme.js", () => ({
  theme: { muted: (v: string) => v },
}));

mock.module("node:fs/promises", () => ({
  // Modules this command loads (the profile store and its lock) import other
  // fs functions; keep them real so the mock only replaces what is asserted.
  ...fsPromises,
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
      public metadata?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  cliErrorFromService: (error: { code: string; message: string; meta?: Record<string, unknown> }) =>
    Object.assign(new Error(error.message), { code: error.code, exitCode: 1, metadata: error.meta }),
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
}));

mock.module("../lib/host.js", () => ({
  // Mirror the real predicate (status 404 + "Space not found") so the kv
  // command's error routing is genuinely exercised; the per-identity hint
  // wording is covered in host.test.ts. Returns a CLIError-like on match.
  unhostedSpaceError: async (
    error: { message: string; meta?: { status?: number } },
    spaceUri: string | undefined,
  ) => {
    if (!spaceUri) return null;
    if (error.meta?.status === 404 && /space not found/i.test(error.message)) {
      return Object.assign(new Error("SPACE_NOT_HOSTED"), { code: "SPACE_NOT_HOSTED", exitCode: 1 });
    }
    return null;
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
  test("rejects keys containing spaces before resolving authentication", async () => {
    await runKv(["put", "with space.txt", "hello"]);

    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: "KV keys cannot contain spaces or control characters; use a URL-safe key",
    });
    expect(recorded.resolveSpace).toEqual([]);
    expect(recorded.puts).toEqual([]);
  });

  test("get, head and delete refuse unaddressable keys before resolving authentication", async () => {
    await runKv(["get", "with space.txt"]);
    await runKv(["head", "tab\tkey"]);
    await runKv(["delete", "line\nkey"]);

    expect(recorded.errors).toHaveLength(3);
    for (const error of recorded.errors) {
      expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    }
    expect(recorded.resolveSpace).toEqual([]);
    expect(recorded.gets).toEqual([]);
    expect(recorded.deletes).toEqual([]);
  });

  test("list refuses an unaddressable --prefix before resolving authentication", async () => {
    await runKv(["list", "--prefix", "with space/"]);

    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    expect(recorded.resolveSpace).toEqual([]);
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
  test("reports quota exhaustion with used and limit sizes", async () => {
    await runKv(["put", "QUOTA:report", "hello"]);

    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      exitCode: 1,
      message: "storage quota exceeded (369.4 MB used of 7.7 MB limit); nothing was written",
    });
  });

  test("reports quota exhaustion without echoing server text when the sizes are missing", async () => {
    await runKv(["put", "QUOTA-NO-SIZES:report", "hello"]);

    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      exitCode: 1,
      message: "storage quota exceeded; nothing was written",
    });
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

describe("CLI kv SPACE_NOT_HOSTED routing for reads", () => {
  beforeEach(resetState);

  // get/head/delete must surface SPACE_NOT_HOSTED on an unhosted space (not a
  // benign "key not found" / exists:false), while a genuine missing key still
  // reports NOT_FOUND / exists:false.
  test("get on an unhosted space surfaces SPACE_NOT_HOSTED, not NOT_FOUND", async () => {
    await runKv(["get", "UNHOSTED:k", "--space", "applications"]);
    expect(recorded.outputs).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    expect((recorded.errors[0] as { code: string }).code).toBe("SPACE_NOT_HOSTED");
  });

  test("get on a genuinely missing key reports NOT_FOUND", async () => {
    await runKv(["get", "MISSING:k", "--space", "applications"]);
    expect(recorded.outputs).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    expect((recorded.errors[0] as { code: string }).code).toBe("NOT_FOUND");
  });

  test("head on an unhosted space surfaces SPACE_NOT_HOSTED, not exists:false", async () => {
    await runKv(["head", "UNHOSTED:k", "--space", "applications"]);
    expect(recorded.outputs).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    expect((recorded.errors[0] as { code: string }).code).toBe("SPACE_NOT_HOSTED");
  });

  test("head on a genuinely missing key reports exists:false", async () => {
    await runKv(["head", "MISSING:k", "--space", "applications"]);
    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs).toEqual([
      { key: "MISSING:k", exists: false, metadata: {} },
    ]);
  });

  test("delete on an unhosted space surfaces SPACE_NOT_HOSTED", async () => {
    await runKv(["delete", "UNHOSTED:k", "--space", "applications"]);
    expect(recorded.outputs).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    expect((recorded.errors[0] as { code: string }).code).toBe("SPACE_NOT_HOSTED");
  });
});

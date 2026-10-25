import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { ServiceContext } from "@tinycloud/sdk-services";
import { KVService } from "@tinycloud/sdk-services/kv";
import { applyNoRetryFlag, cliRetryPolicy } from "../lib/retry-policy.js";

// The probe contract (TC-1392): with --no-retry or TINYCLOUD_RETRY=0 a node that
// answers busy once is seen as one attempt and the typed NODE_BUSY exit; without
// them the CLI retries and `kv get --json` reports attempts: 2. Real Command
// options, real SDK context and KVService; only the node (fetch) and the
// session/auth seam are fake.

const BUSY = "sql_busy: begin: database is locked";
let requests = 0;
let script: Array<() => Response> = [];
let nodeReply: ((input: unknown, init: RequestInit | undefined) => Promise<Response> | Response) | undefined;

const nodeFetch = async (input: unknown, init?: RequestInit) => {
  requests++;
  if (nodeReply) return nodeReply(input, init);
  return script[Math.min(requests, script.length) - 1]();
};

function buildNode() {
  const context = new ServiceContext({
    invoke: () => ({ Authorization: "Bearer signed" }),
    fetch: nodeFetch as never,
    hosts: ["https://node.test"],
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafytest",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
      verificationMethod: "did:key:test",
      jwk: {},
    },
    ...cliRetryPolicy(), // what lib/sdk.ts passes to TinyCloudNode
  });
  const kv = new KVService({});
  kv.initialize(context);
  context.registerService("kv", kv);
  return { kv, kvForSpace: () => kv };
}

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "cli-test", host: "https://node.test" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => buildNode() }));
mock.module("../lib/space.js", () => ({ resolveSpaceUri: async () => undefined }));
mock.module("../lib/host.js", () => ({ unhostedSpaceError: async () => null }));

const { registerKvCommand } = await import("./kv.js");

async function runTc(args: string[]): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  const out = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as never);
  const errw = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { stderr += String(chunk); return true; }) as never);
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { exitCode = code; return undefined as never; }) as never);
  try {
    const program = new Command();
    program.option("--json").option("--no-retry");
    program.hook("preAction", (command) => applyNoRetryFlag(command.optsWithGlobals()));
    registerKvCommand(program);
    await program.parseAsync(["node", "tc", ...args], { from: "node" });
  } finally {
    out.mockRestore(); errw.mockRestore(); exit.mockRestore();
  }
  return { stdout, stderr, exitCode };
}

const busy = () => new Response(BUSY, { status: 503, headers: { "retry-after": "0" } });
const value = () => new Response(JSON.stringify("hello"), { status: 200, headers: { "content-type": "application/json" } });

describe("CLI retry opt-out (probe contract)", () => {
  beforeEach(() => {
    requests = 0;
    script = [busy, value];
    nodeReply = undefined;
    delete process.env.TINYCLOUD_RETRY;
  });
  afterEach(() => { delete process.env.TINYCLOUD_RETRY; });

  test("without opt-out, busy then OK succeeds and --json reports attempts: 2", async () => {
    const { stdout, exitCode } = await runTc(["--json", "kv", "get", "note"]);
    expect(requests).toBe(2);
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(stdout)).toMatchObject({ key: "note", data: "hello", attempts: 2 });
  });

  for (const [name, args, env] of [
    ["--no-retry", ["--no-retry", "--json", "kv", "get", "note"], undefined],
    ["TINYCLOUD_RETRY=0", ["--json", "kv", "get", "note"], "0"],
  ] as const) {
    test(`${name}: one attempt and the typed NODE_BUSY exit`, async () => {
      if (env) process.env.TINYCLOUD_RETRY = env;
      const { stdout, stderr, exitCode } = await runTc([...args]);
      expect(requests).toBe(1);
      expect(exitCode).toBe(7);
      expect(stdout + stderr).toContain("NODE_BUSY");
    });
  }
});

describe("CLI kv put --if-none-match with a node response", () => {
  const stored = new Map<string, string>();
  const headersSeen: Array<string | null> = [];

  beforeEach(() => {
    requests = 0;
    stored.clear();
    headersSeen.length = 0;
    nodeReply = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const conditional = headers.get("if-none-match");
      headersSeen.push(conditional);
      const key = "feed/item";
      if (conditional === "*" && stored.has(key)) return new Response("exists", { status: 412 });
      stored.set(key, await new Response(init?.body).text());
      return new Response("", { status: 200 });
    };
  });
  afterEach(() => { nodeReply = undefined; });

  test("creates once and refuses a second write while preserving the first value", async () => {
    const first = await runTc(["--json", "kv", "put", "feed/item", "first", "--if-none-match", "*"]);
    const second = await runTc(["--json", "kv", "put", "feed/item", "second", "--if-none-match", "*"]);

    expect(first.exitCode).toBeUndefined();
    expect(JSON.parse(first.stdout)).toMatchObject({ key: "feed/item", written: true });
    expect(second.exitCode).toBe(5);
    expect(second.stdout + second.stderr).toContain("KV_ALREADY_EXISTS");
    expect(requests).toBe(2);
    expect(headersSeen).toEqual(["*", "*"]);
    expect(stored.get("feed/item")).toBe("first");
  });

  test("refuses another option value with no node request", async () => {
    const result = await runTc(["--json", "kv", "put", "feed/item", "first", "--if-none-match", "foo"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout + result.stderr).toContain("--if-none-match accepts only *");
    expect(requests).toBe(0);
    expect(stored.size).toBe(0);
  });
});

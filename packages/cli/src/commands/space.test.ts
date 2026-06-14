import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

const SELF_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER_ADDR = "0xd559ccd9eb87c530a9a349262669386de93cf412";

type CLIErrorLike = { code: string; message: string; exitCode: number };

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
  fileWrites: [] as Array<{ path: string; data: string }>,
};

// Controls whether the resolved space is owned by the active profile.
let owner = false;
let profile: Record<string, unknown> = {};

function resetState(): void {
  recorded.outputs = [];
  recorded.errors = [];
  recorded.fileWrites = [];
  owner = false;
  profile = {
    name: "agent-test",
    chainId: 1,
    sessionDid: "did:key:z6MkAgentSession#z6MkAgentSession",
    did: "did:key:z6MkAgentSession",
  };
}

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "agent-test", host: "https://node.tinycloud.xyz" }),
    getProfile: async () => profile,
  },
}));

mock.module("../lib/sdk.js", () => ({
  // host-request must NOT contact the node; fail loudly if it tries.
  ensureAuthenticated: async () => {
    throw new Error("host-request must not authenticate");
  },
}));

mock.module("../lib/host.js", () => ({
  isRootAuthority: async () => owner,
  resolveHostSpace: async (name: string) =>
    name.startsWith("tinycloud:") ? name : `tinycloud:pkh:eip155:1:${OTHER_ADDR}:${name}`,
  spaceNameFromUri: (uri: string) => uri.slice(uri.lastIndexOf(":") + 1),
  ownerDidFromSpaceUri: (uri: string) => {
    const m = uri.match(/^tinycloud:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40}):/);
    return m ? `did:pkh:eip155:${m[1]}:${m[2]}` : null;
  },
}));

mock.module("../output/formatter.js", () => ({
  outputJson: (payload: unknown) => recorded.outputs.push(payload),
  shouldOutputJson: () => true,
  formatTable: () => "",
}));

mock.module("../output/theme.js", () => ({
  theme: { muted: (v: string) => v },
}));

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error implements CLIErrorLike {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
      public metadata?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  handleError: (error: unknown) => recorded.errors.push(error),
}));

mock.module("node:fs/promises", () => ({
  mkdir: async () => {},
  writeFile: async (path: string, data: string) => {
    recorded.fileWrites.push({ path, data });
  },
}));

const { registerSpaceCommand } = await import("./space.js");

async function runSpace(args: string[]): Promise<void> {
  const program = new Command();
  registerSpaceCommand(program);
  await program.parseAsync(["node", "tc", "space", ...args], { from: "node" });
}

describe("tc space host-request", () => {
  beforeEach(resetState);

  test("delegate emits a tinycloud.host.request artifact to the file", async () => {
    owner = false;
    await runSpace(["host-request", "applications", "--emit", "./host-request.json"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.fileWrites).toHaveLength(1);
    expect(recorded.fileWrites[0].path).toBe("./host-request.json");

    const artifact = JSON.parse(recorded.fileWrites[0].data);
    expect(artifact).toMatchObject({
      kind: "tinycloud.host.request",
      version: 1,
      spaceName: "applications",
      spaceId: `tinycloud:pkh:eip155:1:${OTHER_ADDR}:applications`,
      ownerDid: `did:pkh:eip155:1:${OTHER_ADDR}`,
      requesterDid: "did:key:z6MkAgentSession",
      host: "https://node.tinycloud.xyz",
    });
    expect(typeof artifact.requestId).toBe("string");
    expect(artifact.requestId.startsWith("hostreq_")).toBe(true);

    // Summary points back at the emitted file.
    expect(recorded.outputs[0]).toMatchObject({
      emitted: true,
      path: "./host-request.json",
      spaceName: "applications",
    });
  });

  test("delegate prints the artifact to stdout when --emit has no path", async () => {
    owner = false;
    await runSpace(["host-request", "applications", "--emit"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.fileWrites).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      kind: "tinycloud.host.request",
      spaceName: "applications",
    });
  });

  test("owner is refused and told to host directly", async () => {
    owner = true;
    await runSpace(["host-request", "applications", "--emit", "./host-request.json"]);

    expect(recorded.fileWrites).toEqual([]);
    expect(recorded.outputs).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    const error = recorded.errors[0] as CLIErrorLike;
    expect(error.code).toBe("ALREADY_ROOT_AUTHORITY");
    expect(error.message).toContain("tc space host applications");
  });
});

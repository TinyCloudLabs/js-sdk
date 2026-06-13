import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

type SetProfileCall = { name: string; data: Record<string, unknown> };

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
  setProfiles: [] as SetProfileCall[],
};

function resetState(): void {
  recorded.outputs = [];
  recorded.errors = [];
  recorded.setProfiles = [];
}

// Existing on-disk profile the manager hands back before mutation.
const existingProfile = {
  name: "cli-test",
  host: "https://host",
  chainId: 1,
  spaceName: "default",
  did: "did:key:zabc",
  createdAt: "2026-01-01T00:00:00.000Z",
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async (opts: { profile?: string }) => ({
      profile: opts.profile ?? "cli-test",
      host: "https://host",
    }),
    getProfile: async () => ({ ...existingProfile }),
    setProfile: async (name: string, data: Record<string, unknown>) => {
      recorded.setProfiles.push({ name, data });
    },
  },
}));

mock.module("../output/formatter.js", () => ({
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  isInteractive: () => false,
  shouldOutputJson: () => true,
  formatField: () => "",
}));

mock.module("../output/theme.js", () => ({
  theme: {
    muted: (v: string) => v,
    success: (v: string) => v,
    brand: (v: string) => v,
    heading: (v: string) => v,
  },
}));

class MockCLIError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: number,
  ) {
    super(message);
  }
}

// Export the full errors.js surface so a real import in any sibling test file
// resolving against this global mock never hits a missing-export error.
mock.module("../output/errors.js", () => ({
  CLIError: MockCLIError,
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));

// Full local-key.js surface (only generateKey is exercised here).
mock.module("../auth/local-key.js", () => ({
  generateKey: () => ({ jwk: {}, did: "did:key:zgen" }),
  keyToDID: () => "did:key:zgen",
  generateEthereumPrivateKey: () => "0x0",
  deriveAddress: async () => "0x0",
  addressToDID: () => "did:pkh:eip155:1:0x0",
  generateLocalIdentity: async () => ({ jwk: {}, did: "did:key:zgen", privateKey: "0x0", address: "0x0" }),
  localKeySignIn: async () => ({}),
}));

const { registerProfileCommand } = await import("./profile.js");

async function runProfile(args: string[]): Promise<void> {
  const program = new Command();
  registerProfileCommand(program);
  await program.parseAsync(["node", "tc", "profile", ...args], { from: "node" });
}

describe("tc profile set-default-space", () => {
  beforeEach(resetState);

  test("persists the default space to the profile json", async () => {
    await runProfile(["set-default-space", "applications"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.setProfiles).toHaveLength(1);
    expect(recorded.setProfiles[0]!.name).toBe("cli-test");
    expect(recorded.setProfiles[0]!.data.defaultSpace).toBe("applications");
    // Existing fields are preserved.
    expect(recorded.setProfiles[0]!.data.did).toBe("did:key:zabc");
    expect(recorded.outputs).toEqual([
      { profile: "cli-test", defaultSpace: "applications", updated: true },
    ]);
  });

  test("--unset clears the default space", async () => {
    await runProfile(["set-default-space", "--unset"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.setProfiles[0]!.data.defaultSpace).toBeUndefined();
    expect(recorded.outputs).toEqual([
      { profile: "cli-test", defaultSpace: null, updated: true },
    ]);
  });

  test("rejects an invalid space name", async () => {
    await runProfile(["set-default-space", "bad/name"]);

    expect(recorded.setProfiles).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    expect((recorded.errors[0] as { code: string }).code).toBe("INVALID_SPACE");
  });

  test("errors when neither a name nor --unset is given", async () => {
    await runProfile(["set-default-space"]);

    expect(recorded.setProfiles).toEqual([]);
    expect(recorded.errors).toHaveLength(1);
    expect((recorded.errors[0] as { code: string }).code).toBe("USAGE_ERROR");
  });
});

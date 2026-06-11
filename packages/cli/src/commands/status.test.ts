import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

type ProfileLike = {
  name: string;
  host: string;
  chainId: number;
  spaceName: string;
  did: string;
  sessionDid?: string;
  ownerDid?: string;
  spaceId?: string;
  createdAt: string;
  posture?: string;
  operatorType?: string;
  authMethod?: "openkey" | "local";
  privateKey?: string;
  address?: string;
};

type PermissionLike = {
  service: string;
  space: string;
  path: string;
  actions: string[];
};

type StoredDelegationLike = {
  delegation: {
    cid: string;
    spaceId: string;
    path: string;
    actions: string[];
    expiry: string;
    delegationHeader: object;
    resources?: PermissionLike[];
  };
  permissions: PermissionLike[];
};

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
};

let activeProfile = "default";
let defaultProfile = "default";
let profileNames: string[] = [];
let jsonMode = true;
let profiles = new Map<string, ProfileLike>();
let sessions = new Map<string, object>();
let keys = new Set<string>();
let delegations = new Map<string, StoredDelegationLike[]>();
let recaps = new Map<string, unknown[]>();

function resetState(): void {
  recorded.outputs.length = 0;
  recorded.errors.length = 0;
  activeProfile = "default";
  defaultProfile = "default";
  profileNames = [];
  jsonMode = true;
  profiles = new Map();
  sessions = new Map();
  keys = new Set();
  delegations = new Map();
  recaps = new Map();
}

function makeProfile(
  name: string,
  overrides: Partial<ProfileLike> = {},
): ProfileLike {
  return {
    name,
    host: "https://node.tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: `did:key:${name}`,
    createdAt: "2026-06-01T00:00:00.000Z",
    authMethod: "openkey",
    posture: "owner-openkey",
    operatorType: "human",
    ...overrides,
  };
}

function makeDelegation(
  cid: string,
  expiry: string,
  permissions: PermissionLike[],
): StoredDelegationLike {
  return {
    delegation: {
      cid,
      spaceId: permissions[0]?.space ?? "secrets",
      path: permissions[0]?.path ?? "/",
      actions: permissions[0]?.actions ?? ["read"],
      expiry,
      delegationHeader: {},
    },
    permissions,
  };
}

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({
      profile: activeProfile,
      host: "https://node.tinycloud.test",
    }),
    getConfig: async () => ({
      defaultProfile,
      version: 1,
    }),
    listProfiles: async () => [...profileNames],
    getProfile: async (name: string) => {
      const profile = profiles.get(name);
      if (!profile) throw new Error(`Profile "${name}" does not exist.`);
      return profile;
    },
    getSession: async (name: string) => sessions.get(name) ?? null,
    getKey: async (name: string) => (keys.has(name) ? {} : null),
  },
}));

mock.module("../lib/permissions.js", () => ({
  compactPermission: (permission: PermissionLike) => {
    const space = permission.space.startsWith("tinycloud:")
      ? permission.space.slice(permission.space.lastIndexOf(":") + 1)
      : permission.space;
    const actions = permission.actions
      .map((action) =>
        action.startsWith(`${permission.service}/`)
          ? action.slice(permission.service.length + 1)
          : action,
      )
      .join(",");
    return `${permission.service}:${space}:${permission.path}:${actions}`;
  },
  loadAdditionalDelegations: async (name: string) => delegations.get(name) ?? [],
  permissionsFromDelegation: (delegation: StoredDelegationLike["delegation"]) =>
    delegation.resources ?? [
      {
        service: "tinycloud.kv",
        space: delegation.spaceId,
        path: delegation.path,
        actions: delegation.actions,
      },
    ],
}));

mock.module("@tinycloud/node-sdk", () => ({
  NodeWasmBindings: class NodeWasmBindings {
    parseRecapFromSiwe(siwe: string): unknown[] {
      return recaps.get(siwe) ?? [];
    }
  },
}));

mock.module("../output/formatter.js", () => ({
  formatField: (label: string, value: unknown) => `${label}: ${String(value)}`,
  formatTable: (_headers: string[], rows: string[][]) =>
    rows.map((row) => row.join("  ")).join("\n"),
  isInteractive: () => false,
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  shouldOutputJson: () => jsonMode,
  withSpinner: async (_message: string, fn: () => unknown) => await fn(),
}));

mock.module("../output/theme.js", () => {
  const passthrough = (value: string) => value;
  return {
    theme: {
      success: passthrough,
      warn: passthrough,
      muted: passthrough,
      heading: passthrough,
      value: passthrough,
      label: passthrough,
      brand: passthrough,
    },
  };
});

mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
      public metadata?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "CLIError";
    }
  },
  handleError: (error: unknown) => {
    recorded.errors.push(error);
  },
  setActiveProfileName: () => {},
}));

const { registerStatusCommand } = await import("./status.js");

async function runStatusCommand(): Promise<void> {
  const program = new Command();
  registerStatusCommand(program);
  await program.parseAsync(["node", "tc", "status"], { from: "node" });
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

describe("CLI status command", () => {
  beforeEach(() => {
    resetState();
  });

  test("emits machine-readable profile, session, delegation, and permission state", async () => {
    const futureSiwe = [
      "tinycloud.test wants you to sign in",
      "Expiration Time: 2099-01-01T00:00:00.000Z",
    ].join("\n");
    const sessionPermission = {
      service: "kv",
      space: "secrets",
      path: "vault/secrets/",
      actions: ["list"],
    };
    const delegationPermission = {
      service: "tinycloud.encryption",
      space: "default",
      path: "urn:tinycloud:encryption:did:key:default:default",
      actions: ["decrypt"],
    };

    profileNames = ["staging", "default"];
    profiles.set("default", makeProfile("default", {
      sessionDid: "did:key:session",
      ownerDid: "did:pkh:eip155:1:0xabc",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
    }));
    profiles.set("staging", makeProfile("staging"));
    sessions.set("default", { siwe: futureSiwe });
    sessions.set("staging", { expiresAt: "2020-01-01T00:00:00.000Z" });
    keys.add("default");
    recaps.set(futureSiwe, [sessionPermission]);
    delegations.set("default", [
      makeDelegation(
        "bafy-active",
        "2099-01-01T00:00:00.000Z",
        [delegationPermission],
      ),
    ]);
    delegations.set("staging", [
      makeDelegation(
        "bafy-expired",
        "2020-01-01T00:00:00.000Z",
        [delegationPermission],
      ),
    ]);

    await runStatusCommand();

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs).toHaveLength(1);
    const output = recorded.outputs[0] as {
      activeProfile: string;
      defaultProfile: string;
      authenticatedProfileCount: number;
      profiles: Array<{
        name: string;
        authenticated: boolean;
        status: string;
        session: { present: boolean; expired: boolean | null; expiresAt: string | null };
        delegations: Array<{ cid: string; active: boolean; expired: boolean | null }>;
        permissionsCompact: string[];
      }>;
    };

    expect(output.activeProfile).toBe("default");
    expect(output.defaultProfile).toBe("default");
    expect(output.authenticatedProfileCount).toBe(1);

    const defaultStatus = output.profiles.find((p) => p.name === "default");
    expect(defaultStatus?.authenticated).toBe(true);
    expect(defaultStatus?.status).toBe("logged-in");
    expect(defaultStatus?.session).toEqual(expect.objectContaining({
      present: true,
      expired: false,
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    expect(defaultStatus?.delegations).toEqual([
      expect.objectContaining({
        cid: "bafy-active",
        active: true,
        expired: false,
      }),
    ]);
    expect(defaultStatus?.permissionsCompact).toEqual([
      "tinycloud.kv:secrets:vault/secrets/:list",
      "tinycloud.encryption:default:urn:tinycloud:encryption:did:key:default:default:decrypt",
    ]);

    const stagingStatus = output.profiles.find((p) => p.name === "staging");
    expect(stagingStatus?.authenticated).toBe(false);
    expect(stagingStatus?.status).toBe("expired");
    expect(stagingStatus?.delegations[0]).toEqual(expect.objectContaining({
      cid: "bafy-expired",
      active: false,
      expired: true,
    }));
    expect(stagingStatus?.permissionsCompact).toEqual([]);
  });

  test("renders a simple human status view", async () => {
    jsonMode = false;
    profileNames = ["default"];
    profiles.set("default", makeProfile("default"));
    sessions.set("default", { expiresAt: "2099-01-01T00:00:00.000Z" });
    delegations.set("default", [
      makeDelegation(
        "bafy-active",
        "2099-01-01T00:00:00.000Z",
        [{
          service: "tinycloud.kv",
          space: "secrets",
          path: "vault/secrets/",
          actions: ["list"],
        }],
      ),
    ]);

    const output = await captureStdout(runStatusCommand);

    expect(output).toContain("TinyCloud Status");
    expect(output).toContain("Active profile: default");
    expect(output).toContain("default (default)");
    expect(output).toContain("logged in");
    expect(output).toContain("permissions:");
    expect(output).toContain("tinycloud.kv:secrets:vault/secrets/:list");
    expect(output).toContain("delegations:");
    expect(output).toContain("bafy-active");
  });

  test("counts a local owner private key as usable auth without a session", async () => {
    activeProfile = "local";
    defaultProfile = "local";
    profileNames = ["local"];
    profiles.set("local", makeProfile("local", {
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: "0x123",
      address: "0xabc",
    }));
    keys.add("local");

    await runStatusCommand();

    const output = recorded.outputs[0] as {
      profiles: Array<{
        name: string;
        authenticated: boolean;
        status: string;
        session: { present: boolean };
        hasPrivateKey: boolean;
      }>;
    };
    expect(output.profiles).toEqual([
      expect.objectContaining({
        name: "local",
        authenticated: true,
        status: "local-key",
        session: expect.objectContaining({ present: false }),
        hasPrivateKey: true,
      }),
    ]);
  });
});

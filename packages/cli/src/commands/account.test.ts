import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

const recorded = {
  outputs: [] as unknown[],
  errors: [] as unknown[],
  opened: [] as string[],
  registered: [] as unknown[],
  revoked: [] as unknown[],
  registeredSpaces: [] as unknown[],
  removedSpaces: [] as string[],
};

function resetState(): void {
  recorded.outputs = [];
  recorded.errors = [];
  recorded.opened = [];
  recorded.registered = [];
  recorded.revoked = [];
  recorded.registeredSpaces = [];
  recorded.removedSpaces = [];
}

const node = {
  account: {
    status: async () => ({
      ok: true,
      data: {
        did: "did:pkh:eip155:1:0xabc",
        host: "https://node.tinycloud.xyz",
        primarySpaceId: "tinycloud:pkh:eip155:1:0xabc:default",
        accountSpaceId: "tinycloud:pkh:eip155:1:0xabc:account",
        applications: 1,
        spaces: 1,
        grantedDelegations: 1,
        receivedDelegations: 1,
      },
    }),
    applications: {
      list: async () => ({
        ok: true,
        data: [
          {
            appId: "com.listen.app",
            name: "Listen",
            manifests: [{ app_id: "com.listen.app", name: "Listen" }],
            updatedAt: "2026-06-20T00:00:00.000Z",
          },
        ],
      }),
      get: async (appId: string) => ({
        ok: true,
        data: {
          appId,
          name: "Listen",
          manifests: [{ app_id: appId, name: "Listen" }],
        },
      }),
      register: async (manifest: unknown) => {
        recorded.registered.push(manifest);
        return {
          ok: true,
          data: {
            appId: "com.notes.app",
            name: "Notes",
            manifests: [manifest],
          },
        };
      },
      remove: async () => ({ ok: true, data: undefined }),
    },
    spaces: {
      list: async () => ({
        ok: true,
        data: [
          {
            spaceId: "tinycloud:pkh:eip155:1:0xabc:applications",
            name: "applications",
            ownerDid: "did:pkh:eip155:1:0xabc",
            type: "owned",
            permissions: ["*"],
            status: "active",
            updatedAt: "2026-06-20T00:00:00.000Z",
          },
        ],
      }),
      get: async (spaceId: string) => ({
        ok: true,
        data: {
          spaceId,
          name: "applications",
          ownerDid: "did:pkh:eip155:1:0xabc",
          type: "owned",
          permissions: ["*"],
          status: "active",
        },
      }),
      register: async (space: unknown) => {
        recorded.registeredSpaces.push(space);
        return { ok: true, data: space };
      },
      syncAccessible: async () => ({
        ok: true,
        data: [
          {
            spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
            name: "default",
            ownerDid: "did:pkh:eip155:1:0xabc",
            type: "owned",
            permissions: ["*"],
            status: "active",
          },
        ],
      }),
      remove: async (spaceId: string) => {
        recorded.removedSpaces.push(spaceId);
        return { ok: true, data: undefined };
      },
    },
    delegations: {
      list: async (options: unknown) => ({
        ok: true,
        data: [
          {
            cid: "bafy-granted",
            direction: "granted",
            spaceId: "tinycloud:pkh:eip155:1:0xabc:applications",
            spaceName: "applications",
            counterpartyDid: "did:key:zdelegate",
            delegateDid: "did:key:zdelegate",
            delegatorDid: "did:pkh:eip155:1:0xabc",
            path: "applications/com.listen.app/",
            actions: ["tinycloud.kv/get"],
            expiry: new Date("2026-07-20T00:00:00.000Z"),
            status: "active",
            options,
          },
        ],
      }),
      revoke: async (input: unknown) => {
        recorded.revoked.push(input);
        return { ok: true, data: undefined };
      },
    },
    index: {
      rebuild: async () => ({
        ok: true,
        data: {
          database: "account",
          applications: 1,
          spaces: 1,
          delegations: 1,
          syncedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      applications: {
        list: async () => ({
          ok: true,
          data: [
            {
              appId: "com.indexed.app",
              name: "Indexed",
              manifests: [{ app_id: "com.indexed.app", name: "Indexed" }],
              updatedAt: "2026-06-20T00:00:00.000Z",
            },
          ],
        }),
      },
      spaces: {
        list: async () => ({
          ok: true,
          data: [
            {
              spaceId: "tinycloud:pkh:eip155:1:0xabc:indexed",
              name: "indexed",
              ownerDid: "did:pkh:eip155:1:0xabc",
              type: "owned",
              permissions: ["*"],
              status: "active",
              updatedAt: "2026-06-20T00:00:00.000Z",
            },
          ],
        }),
      },
      delegations: {
        list: async (options: unknown) => ({
          ok: true,
          data: [
            {
              cid: "bafy-indexed",
              direction: "received",
              spaceId: "tinycloud:pkh:eip155:1:0xabc:applications",
              spaceName: "applications",
              counterpartyDid: "did:key:zgrantor",
              delegateDid: "did:pkh:eip155:1:0xabc",
              delegatorDid: "did:key:zgrantor",
              path: "shared/",
              actions: ["tinycloud.kv/list"],
              expiry: new Date("2026-08-20T00:00:00.000Z"),
              status: "active",
              options,
            },
          ],
        }),
      },
      query: async (_sql: string, _params?: unknown[]) => ({
        ok: true,
        data: {
          columns: ["n"],
          rows: [[1]],
          rowCount: 1,
        },
      }),
      status: async () => ({
        ok: true,
        data: {
          database: "account",
          sources: [
            { source: "applications", syncedAt: "2026-06-20T00:00:00.000Z", count: 1 },
            { source: "spaces", syncedAt: "2026-06-20T00:00:00.000Z", count: 1 },
          ],
        },
      }),
    },
  },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "cli-test", host: "https://node.tinycloud.xyz" }),
  },
}));

mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => node,
}));

mock.module("../output/formatter.js", () => ({
  outputJson: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  output: (payload: unknown) => {
    recorded.outputs.push(payload);
  },
  outputError: (code: string, message: string) => {
    recorded.errors.push({ code, message });
  },
  isInteractive: () => false,
  withSpinner: async (_label: string, fn: () => unknown) => await fn(),
  shouldOutputJson: () => true,
  formatTable: () => "",
  formatField: () => "",
  formatBytes: () => "",
  formatTimeAgo: () => "",
  formatCheck: () => "",
  formatSection: () => "",
}));

mock.module("../output/theme.js", () => ({
  theme: {
    accent: (value: string) => value,
    brand: (value: string) => value,
    command: (value: string) => value,
    dim: (value: string) => value,
    error: (value: string) => value,
    heading: (value: string) => value,
    hint: (value: string) => value,
    label: (value: string) => value,
    muted: (value: string) => value,
    success: (value: string) => value,
    value: (value: string) => value,
    warn: (value: string) => value,
  },
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
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));

mock.module("node:fs/promises", () => ({
  readFile: async () => JSON.stringify({ app_id: "com.notes.app", name: "Notes", defaults: false }),
}));

mock.module("open", () => ({
  default: async (url: string) => {
    recorded.opened.push(url);
  },
}));

const { registerAccountCommand } = await import("./account.js");

async function runAccount(args: string[]): Promise<void> {
  const program = new Command();
  registerAccountCommand(program);
  await program.parseAsync(["node", "tc", "account", ...args], { from: "node" });
}

describe("tc account", () => {
  beforeEach(resetState);

  test("prints account status", async () => {
    await runAccount(["status"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      did: "did:pkh:eip155:1:0xabc",
      applications: 1,
      spaces: 1,
      grantedDelegations: 1,
      receivedDelegations: 1,
    });
  });

  test("lists account applications", async () => {
    await runAccount(["apps", "list"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      count: 1,
      applications: [{ appId: "com.indexed.app", name: "Indexed" }],
    });
  });

  test("lists live account applications", async () => {
    await runAccount(["apps", "list", "--live"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      count: 1,
      applications: [{ appId: "com.listen.app", name: "Listen" }],
    });
  });

  test("lists indexed account spaces", async () => {
    await runAccount(["spaces", "list"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      count: 1,
      spaces: [{ spaceId: "tinycloud:pkh:eip155:1:0xabc:indexed", name: "indexed" }],
    });
  });

  test("lists live account spaces", async () => {
    await runAccount(["spaces", "list", "--live"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      count: 1,
      spaces: [{ spaceId: "tinycloud:pkh:eip155:1:0xabc:applications", name: "applications" }],
    });
  });

  test("registers an account space", async () => {
    await runAccount([
      "spaces",
      "register",
      "tinycloud:pkh:eip155:1:0xabc:photos",
      "--name",
      "photos",
      "--owner",
      "did:pkh:eip155:1:0xabc",
      "--type",
      "owned",
      "--permission",
      "*",
    ]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.registeredSpaces).toEqual([
      {
        spaceId: "tinycloud:pkh:eip155:1:0xabc:photos",
        name: "photos",
        ownerDid: "did:pkh:eip155:1:0xabc",
        type: "owned",
        permissions: ["*"],
        status: "active",
      },
    ]);
    expect(recorded.outputs[0]).toMatchObject({
      registered: true,
      space: { name: "photos" },
    });
  });

  test("syncs accessible account spaces", async () => {
    await runAccount(["spaces", "sync"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      synced: true,
      count: 1,
      spaces: [{ name: "default" }],
    });
  });

  test("registers an account application manifest", async () => {
    await runAccount(["apps", "register", "./manifest.json"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.registered).toEqual([
      { app_id: "com.notes.app", name: "Notes", defaults: false },
    ]);
    expect(recorded.outputs[0]).toMatchObject({
      registered: true,
      application: { appId: "com.notes.app" },
    });
  });

  test("lists account delegations with filters", async () => {
    await runAccount(["delegations", "list", "--granted", "--space", "applications", "--live"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      count: 1,
      delegations: [
        {
          cid: "bafy-granted",
          direction: "granted",
          spaceName: "applications",
          expiry: "2026-07-20T00:00:00.000Z",
        },
      ],
    });
  });

  test("lists indexed account delegations", async () => {
    await runAccount(["delegations", "list", "--received"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      count: 1,
      delegations: [
        {
          cid: "bafy-indexed",
          direction: "received",
          expiry: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
  });

  test("revokes account delegations by space", async () => {
    await runAccount(["delegations", "revoke", "bafy-granted", "--space", "applications"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.revoked).toEqual([{ cid: "bafy-granted", space: "applications" }]);
    expect(recorded.outputs[0]).toEqual({
      cid: "bafy-granted",
      space: "applications",
      revoked: true,
    });
  });

  test("prints the account dashboard billing URL", async () => {
    await runAccount(["billing", "status"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toEqual({
      url: "https://account.tinycloud.xyz/billing",
      opened: false,
    });
  });

  test("rebuilds the materialized account index", async () => {
    await runAccount(["index", "rebuild"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toEqual({
      database: "account",
      applications: 1,
      spaces: 1,
      delegations: 1,
      syncedAt: "2026-06-20T00:00:00.000Z",
    });
  });

  test("prints the materialized account index status", async () => {
    await runAccount(["index", "status"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toMatchObject({
      database: "account",
      sources: expect.arrayContaining([{ source: "applications", syncedAt: "2026-06-20T00:00:00.000Z", count: 1 }]),
    });
  });

  test("queries the materialized account index", async () => {
    await runAccount(["index", "query", "SELECT count(*) AS n FROM applications", "--params", "[]"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.outputs[0]).toEqual({
      columns: ["n"],
      rows: [[1]],
      rowCount: 1,
    });
  });

  test("can open the account dashboard billing URL", async () => {
    await runAccount(["billing", "portal", "--open"]);

    expect(recorded.errors).toEqual([]);
    expect(recorded.opened).toEqual(["https://account.tinycloud.xyz/billing"]);
    expect(recorded.outputs[0]).toEqual({
      url: "https://account.tinycloud.xyz/billing",
      opened: true,
    });
  });
});

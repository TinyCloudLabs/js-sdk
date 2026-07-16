import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";

const PRIVATE_KEY = "1".repeat(64);
let home: string | undefined;
let configuredHome: string | undefined;

afterEach(async () => {
  delete process.env.TC_PRIVATE_KEY;
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true });
    home = undefined;
  }
});

test("production secrets get accepts flag and environment private-key overrides without an OpenKey session", async () => {
  for (const flag of [true, false]) {
    const result = await runWithPrivateKey({ flag });
    expect(result.signInCalls).toBe(1);
    expect(result.output).not.toContain(PRIVATE_KEY);
    expect(result.output).not.toContain("SESSION_NOT_FOUND");
    expect(result.output).toContain("NODE_ERROR");
  }
});

test("production private-key planning and execution use the authenticated key owner for flag and env", async () => {
  const ownerB = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:secrets";
  const capabilities: Array<Record<string, unknown>> = [];
  const signIn = spyOn(TinyCloudNode.prototype, "signIn").mockImplementation(async function(this: TinyCloudNode) {
    const node = this as unknown as { _address?: string; _chainId: number };
    node._address = "0x0000000000000000000000000000000000000002";
    node._chainId = 1;
  });
  const getCapabilities = spyOn(TinyCloudNode.prototype, "getVerifiedSessionCapabilities")
    .mockImplementation(() => capabilities as never);
  const network = spyOn(TinyCloudNode.prototype, "getEncryptionNetworkIdForSpace")
    .mockImplementation(() => "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000002:default");
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret")
    .mockResolvedValue({ status: "ok", value: "owner-b-proof" });

  try {
    for (const flag of [true, false]) {
      const firstRun = home === undefined;
      if (firstRun) home = await mkdtemp(`${tmpdir()}/tinycloud-cli-private-key-owner-`);
      process.env.TC_HOME = home;
      if (flag) delete process.env.TC_PRIVATE_KEY;
      else process.env.TC_PRIVATE_KEY = PRIVATE_KEY;

      const { profileConfigPath, readJson, writeJsonAtomic } = await import("@tinycloud/operations/state");
      if (firstRun) {
        await writeJsonAtomic(profileConfigPath("openkey"), {
          name: "openkey",
          host: "https://node.invalid",
          chainId: 1,
          spaceName: "secrets",
          spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
          did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
          posture: "owner-openkey",
          operatorType: "human",
          authMethod: "openkey",
          createdAt: "2026-07-15T00:00:00.000Z",
        });
      }

      capabilities.length = 0;
      readSecret.mockClear();
      const first = await invokeOperation(
        "tinycloud.secrets.get",
        1,
        {
          profile: "openkey",
          host: "https://node.invalid",
          allowOwnerProfile: true,
          privateKey: flag ? PRIVATE_KEY : process.env.TC_PRIVATE_KEY,
        },
        { name: "HERMETIC_PRIVATE_KEY_OWNER_CANARY" },
      );
      expect(first.status).toBe("authority_required");
      if (first.status !== "authority_required") throw new Error("expected owner-B authority");
      expect(first.context.space).toBe(ownerB);
      expect(first.missing.every((permission) => permission.space === undefined || permission.space === ownerB)).toBe(true);
      expect(first.request.requested).toEqual(first.missing);
      expect(readSecret).not.toHaveBeenCalled();

      capabilities.push(...first.missing as Array<Record<string, unknown>>);
      const second = await invokeOperation(
        "tinycloud.secrets.get",
        1,
        {
          profile: "openkey",
          host: "https://node.invalid",
          allowOwnerProfile: true,
          privateKey: flag ? PRIVATE_KEY : process.env.TC_PRIVATE_KEY,
        },
        { name: "HERMETIC_PRIVATE_KEY_OWNER_CANARY" },
      );
      expect(second.status).toBe("ok");
      expect(readSecret).toHaveBeenCalledWith(expect.objectContaining({ space: ownerB }));
      expect((await readJson(profileConfigPath("openkey")))?.spaceId).toContain(":0x0000000000000000000000000000000000000001:");
    }
    expect(signIn).toHaveBeenCalledTimes(4);
  } finally {
    signIn.mockRestore();
    getCapabilities.mockRestore();
    network.mockRestore();
    readSecret.mockRestore();
  }
});

test("CLI explicit-key acquisition uses one live local-owner runtime for OpenKey and delegate profiles", async () => {
  const ownerA = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets";
  const ownerB = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:secrets";
  const networkB = "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000002:default";
  const runtimeGrants = new WeakMap<object, Array<Record<string, unknown>>>();
  const readNodes: object[] = [];
  const acquisitions: Array<{ node: object; sessionDid: string; requested: unknown }> = [];
  let openKeyCalls = 0;
  let reads = 0;
  let signIns = 0;

  const signIn = spyOn(TinyCloudNode.prototype, "signIn").mockImplementation(async function(this: TinyCloudNode) {
    signIns += 1;
    const node = this as unknown as { _address?: string; _chainId: number };
    node._address = "0x0000000000000000000000000000000000000002";
    node._chainId = 1;
    runtimeGrants.set(this, []);
  });
  const getCapabilities = spyOn(TinyCloudNode.prototype, "getVerifiedSessionCapabilities")
    .mockImplementation(function(this: TinyCloudNode) {
      return [...(runtimeGrants.get(this) ?? [])] as never;
    });
  const grant = spyOn(TinyCloudNode.prototype, "grantRuntimePermissions")
    .mockImplementation(async function(this: TinyCloudNode, requested) {
      const grants = runtimeGrants.get(this) ?? [];
      grants.push(...requested as Array<Record<string, unknown>>);
      runtimeGrants.set(this, grants);
      acquisitions.push({ node: this, sessionDid: this.sessionDid, requested });
      return [];
    });
  const network = spyOn(TinyCloudNode.prototype, "getEncryptionNetworkIdForSpace")
    .mockImplementation(() => networkB);
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret")
    .mockImplementation(async function(this: TinyCloudNode) {
      reads += 1;
      readNodes.push(this);
      if (readNodes.filter((node) => node === this).length > 1) {
        throw new Error("explicit-key retry happened more than once");
      }
      return { status: "ok", value: "owner-b-secret" };
    });

  try {
    for (const posture of ["owner-openkey", "delegate-session"] as const) {
      for (const useFlag of [true, false]) {
        for (const space of [undefined, "custom", ownerA] as const) {
          home = configuredHome ?? home ?? await mkdtemp(`${tmpdir()}/tinycloud-cli-live-owner-`);
          configuredHome = home;
          process.env.TC_HOME = home;
          if (useFlag) delete process.env.TC_PRIVATE_KEY;
          else process.env.TC_PRIVATE_KEY = PRIVATE_KEY;

          const profileName = `stale-${posture}`;
          const { authRequestsPath, additionalDelegationsPath, profileConfigPath, profilePath, sessionPath, writeJsonAtomic } =
            await import("@tinycloud/operations/state");
          await mkdir(profilePath(profileName), { recursive: true });
          await writeJsonAtomic(profileConfigPath(profileName), {
            name: profileName,
            host: "https://node.invalid",
            chainId: 1,
            spaceName: "secrets",
            spaceId: ownerA,
            did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
            ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
            posture,
            operatorType: "agent",
            // Deliberately stale on the delegate profile: the explicit key
            // must establish local-owner posture without consulting it.
            authMethod: posture === "delegate-session" ? "local" : "openkey",
            createdAt: "2026-07-15T00:00:00.000Z",
          });

          const stdout = process.stdout as unknown as { write(chunk: unknown): boolean };
          const stderr = process.stderr as unknown as { write(chunk: unknown): boolean };
          const readsBefore = reads;
          const acquisitionsBefore = acquisitions.length;
          const originalStdout = stdout.write;
          const originalStderr = stderr.write;
          const originalExit = process.exit;
          const output: string[] = [];
          stdout.write = (chunk: unknown) => { output.push(String(chunk)); return true; };
          stderr.write = (chunk: unknown) => { output.push(String(chunk)); return true; };
          process.exit = ((code?: number): never => {
            throw new Error(`process exit ${code ?? 0}`);
          }) as typeof process.exit;

          try {
            const { registerSecretsCommand } = await import("./secrets.js");
            const program = new Command();
            program.option("-p, --profile <name>");
            program.option("-H, --host <url>");
            program.option("--json");
            registerSecretsCommand(program, async () => {
              openKeyCalls += 1;
              throw new Error("explicit-key acquisition must not use OpenKey");
            });
            const args = [
              "node", "tc", "--profile", profileName, "--json", "secrets", "get",
              "LIVE_OWNER_KEY_CANARY",
              ...(space === undefined ? [] : ["--space", space]),
              ...(useFlag ? ["--private-key", PRIVATE_KEY] : []),
            ];
            await program.parseAsync(args, { from: "node" }).catch((error: unknown) => {
              if (!(error instanceof Error) || !error.message.startsWith("process exit")) throw error;
            });
          } finally {
            stdout.write = originalStdout;
            stderr.write = originalStderr;
            process.exit = originalExit;
          }

          const requestsText = await readFile(authRequestsPath(profileName), "utf8");
          const requests = JSON.parse(requestsText) as Array<Record<string, any>>;
          expect(requests).toHaveLength(1);
          const request = requests[0]!;
          const ownerBPrefix = ownerB.slice(0, ownerB.lastIndexOf(":"));
          const expectedSpace = space === ownerA
            ? ownerA
            : space === undefined
            ? ownerB
            : `${ownerBPrefix}:${space}`;
          const { requestId: _requestId, createdAt: _createdAt, sessionDid: _sessionDid, requested, ...stableRequest } = request;
          expect(stableRequest).toEqual({
            kind: "tinycloud.auth.request",
            version: 1,
            profile: profileName,
            posture: "local-owner-key",
            operatorType: "agent",
            host: "https://node.invalid",
            ownerDid: ownerBPrefix.replace("tinycloud:pkh", "did:pkh"),
            spaceId: ownerB,
          });
          expect(requested).toEqual([
            {
              service: "tinycloud.encryption",
              path: networkB,
              actions: ["tinycloud.encryption/decrypt"],
            },
            {
              service: "tinycloud.kv",
              space: expectedSpace,
              path: "vault/secrets/LIVE_OWNER_KEY_CANARY",
              actions: ["tinycloud.kv/get"],
            },
          ]);
          expect(JSON.stringify(requests)).not.toContain(PRIVATE_KEY);
          if (space === ownerA) {
            expect(acquisitions).toHaveLength(acquisitionsBefore);
            expect(reads).toBe(readsBefore);
          } else {
            expect(requests[0]?.sessionDid).toBe(acquisitions.at(-1)?.sessionDid.split("#", 1)[0]);
            expect(acquisitions.at(-1)?.node).toBe(readNodes.at(-1));
          }

          await expect(access(sessionPath(profileName))).rejects.toMatchObject({ code: "ENOENT" });
          await expect(access(additionalDelegationsPath(profileName))).rejects.toMatchObject({ code: "ENOENT" });
          expect(JSON.stringify(await readFile(profileConfigPath(profileName), "utf8"))).not.toContain(PRIVATE_KEY);
          expect(output.join("")).not.toContain(PRIVATE_KEY);
          await rm(profilePath(profileName), { recursive: true, force: true });
        }
      }
    }
  } finally {
    signIn.mockRestore();
    getCapabilities.mockRestore();
    grant.mockRestore();
    network.mockRestore();
    readSecret.mockRestore();
  }

  expect(openKeyCalls).toBe(0);
  expect(reads).toBe(8);
  expect(acquisitions).toHaveLength(8);
  expect(signIns).toBe(12);
});

async function runWithPrivateKey(options: Readonly<{ flag: boolean }>): Promise<{
  signInCalls: number;
  output: string;
}> {
  const firstRun = home === undefined;
  if (firstRun) {
    home = await mkdtemp(`${tmpdir()}/tinycloud-cli-private-key-`);
    configuredHome = home;
  }
  process.env.TC_HOME = home;
  if (!options.flag) process.env.TC_PRIVATE_KEY = PRIVATE_KEY;

  const { profileConfigPath, writeJsonAtomic } = await import("@tinycloud/operations/state");
  if (firstRun) {
    await writeJsonAtomic(profileConfigPath("openkey"), {
      name: "openkey",
      host: "https://node.invalid",
      chainId: 1,
      spaceName: "secrets",
      spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
      did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      posture: "owner-openkey",
      operatorType: "human",
      authMethod: "openkey",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
  }

  let signInCalls = 0;
  const signIn = spyOn(TinyCloudNode.prototype, "signIn").mockImplementation(async () => {
    signInCalls += 1;
    throw new Error(`private-key canary ${PRIVATE_KEY}`);
  });
  const writes: string[] = [];
  const stdout = process.stdout as unknown as { write(chunk: unknown): boolean };
  const stderr = process.stderr as unknown as { write(chunk: unknown): boolean };
  const originalStdout = stdout.write;
  const originalStderr = stderr.write;
  const originalExit = process.exit;
  stdout.write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  stderr.write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  process.exit = ((code?: number): never => {
    throw new Error(`process exit ${code ?? 0}`);
  }) as typeof process.exit;

  try {
    const { registerSecretsCommand } = await import("./secrets.js");
    const program = new Command();
    program.option("-p, --profile <name>");
    program.option("-H, --host <url>");
    program.option("--json");
    registerSecretsCommand(program);
    const args = [
      "node",
      "tc",
      "--profile",
      "openkey",
      "--json",
      "secrets",
      "get",
      "HERMETIC_PRIVATE_KEY_CANARY",
      ...(options.flag ? ["--private-key", PRIVATE_KEY] : []),
    ];
    await program.parseAsync(args, { from: "node" }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith("process exit")) throw error;
    });
  } finally {
    stdout.write = originalStdout;
    stderr.write = originalStderr;
    process.exit = originalExit;
    signIn.mockRestore();
  }

  return { signInCalls, output: writes.join("") };
}

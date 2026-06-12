import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkServerHealth, PROFILE_NAME, setupCliProfile, tc, tcWithInput } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

const RUN_ID = Date.now();
const SECRET_NAME = `CLI_E2E_SECRET_${RUN_ID}`;
const FILE_SECRET_NAME = `CLI_E2E_FILE_SECRET_${RUN_ID}`;
const STDIN_SECRET_NAME = `CLI_E2E_STDIN_SECRET_${RUN_ID}`;
const SCOPED_SECRET_NAME = `CLI_E2E_SCOPED_SECRET_${RUN_ID}`;
const SECRET_VALUE = `secret value ${RUN_ID} :: round trip`;
const FILE_SECRET_VALUE = `file secret ${RUN_ID}\nwith newline`;
const STDIN_SECRET_VALUE = `stdin secret ${RUN_ID}\nwith newline`;
const SCOPED_SECRET_VALUE = `scoped secret ${RUN_ID}`;
const SECRET_SCOPE = `cli e2e scope ${RUN_ID}`;
const E2E_TIMEOUT_MS = 180_000;

describe("tc secrets e2e", () => {
  let node: TinyCloudNode | undefined;
  let tempDir: string | undefined;

  beforeAll(async () => {
    await checkServerHealth();
    node = await setupCliProfile();
    tempDir = await mkdtemp(join(tmpdir(), "tc-secrets-e2e-"));
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    if (node) {
      await Promise.allSettled([
        node.secrets.delete(SECRET_NAME),
        node.secrets.delete(FILE_SECRET_NAME),
        node.secrets.delete(STDIN_SECRET_NAME),
        node.secrets.delete(SCOPED_SECRET_NAME, { scope: SECRET_SCOPE }),
      ]);
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, E2E_TIMEOUT_MS);

  test("uses a local-key profile for CLI status and profile commands", async () => {
    const authStatus = await tc("auth", "status");
    expect(authStatus.exitCode).toBe(0);
    expect(authStatus.json).toMatchObject({
      authenticated: true,
      profile: PROFILE_NAME,
      authMethod: "local",
      posture: "local-owner-key",
      hasKey: true,
    });
    expect(authStatus.json.hasPrivateKey ?? true).toBe(true);

    const profileShow = await tc("profile", "show");
    expect(profileShow.exitCode).toBe(0);
    expect(profileShow.json).toMatchObject({
      name: PROFILE_NAME,
      authMethod: "local",
      posture: "local-owner-key",
      hasKey: true,
      hasSession: true,
      isDefault: true,
    });

    const profileList = await tc("profile", "list");
    expect(profileList.exitCode).toBe(0);
    expect(profileList.json.defaultProfile).toBe(PROFILE_NAME);
    expect(profileList.json.profiles).toContainEqual(expect.objectContaining({
      name: PROFILE_NAME,
      posture: "local-owner-key",
      active: true,
    }));

    const status = await tc("status");
    expect(status.exitCode).toBe(0);
    expect(status.json).toMatchObject({
      activeProfile: PROFILE_NAME,
      defaultProfile: PROFILE_NAME,
    });
    expect(status.json.authenticatedProfileCount).toBeGreaterThanOrEqual(1);
    const activeProfile = status.json.profiles.find((profile: { name: string }) => profile.name === PROFILE_NAME);
    expect(activeProfile).toMatchObject({
      status: "local-key",
      authMethod: "local",
      posture: "local-owner-key",
      hasPrivateKey: true,
      authenticated: true,
    });
  }, E2E_TIMEOUT_MS);

  test("creates, reads, lists, and deletes network-encrypted secrets through the CLI", async () => {
    const network = await tc("secrets", "network", "init");
    expect(network.exitCode).toBe(0);
    expect(network.json).toMatchObject({
      state: "active",
    });
    expect(network.json.networkId).toMatch(/^urn:tinycloud:encryption:/);

    const networkShow = await tc("secrets", "network", "show");
    expect(networkShow.exitCode).toBe(0);
    expect(networkShow.json).toMatchObject({
      networkId: network.json.networkId,
      exists: true,
    });

    const put = await tc("secrets", "put", SECRET_NAME, SECRET_VALUE);
    expect(put.exitCode).toBe(0);
    expect(put.json).toEqual({
      name: SECRET_NAME,
      written: true,
    });

    const get = await tc("secrets", "get", SECRET_NAME);
    expect(get.exitCode).toBe(0);
    expect(get.json).toEqual({
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });

    const raw = await tc("secrets", "get", SECRET_NAME, "--raw");
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout).toBe(SECRET_VALUE);

    const outputPath = join(tempDir, "secret-output.txt");
    const output = await tc("secrets", "get", SECRET_NAME, "--output", outputPath);
    expect(output.exitCode).toBe(0);
    expect(output.json).toEqual({
      name: SECRET_NAME,
      written: outputPath,
    });
    expect(await readFile(outputPath, "utf8")).toBe(SECRET_VALUE);

    const inputPath = join(tempDir, "secret-input.txt");
    await writeFile(inputPath, FILE_SECRET_VALUE);
    const putFile = await tc("secrets", "put", FILE_SECRET_NAME, "--file", inputPath);
    expect(putFile.exitCode).toBe(0);
    expect(putFile.json).toEqual({
      name: FILE_SECRET_NAME,
      written: true,
    });
    const getFile = await tc("secrets", "get", FILE_SECRET_NAME);
    expect(getFile.exitCode).toBe(0);
    expect(getFile.json).toEqual({
      name: FILE_SECRET_NAME,
      value: FILE_SECRET_VALUE,
    });

    const putStdin = await tcWithInput(STDIN_SECRET_VALUE, "secrets", "put", STDIN_SECRET_NAME, "--stdin");
    expect(putStdin.exitCode).toBe(0);
    expect(putStdin.json).toEqual({
      name: STDIN_SECRET_NAME,
      written: true,
    });
    const getStdin = await tc("secrets", "get", STDIN_SECRET_NAME);
    expect(getStdin.exitCode).toBe(0);
    expect(getStdin.json).toEqual({
      name: STDIN_SECRET_NAME,
      value: STDIN_SECRET_VALUE,
    });

    const scopedPut = await tc("secrets", "put", SCOPED_SECRET_NAME, SCOPED_SECRET_VALUE, "--scope", SECRET_SCOPE);
    expect(scopedPut.exitCode).toBe(0);
    expect(scopedPut.json).toEqual({
      name: SCOPED_SECRET_NAME,
      written: true,
    });
    const scopedGet = await tc("secrets", "get", SCOPED_SECRET_NAME, "--scope", SECRET_SCOPE);
    expect(scopedGet.exitCode).toBe(0);
    expect(scopedGet.json).toEqual({
      name: SCOPED_SECRET_NAME,
      value: SCOPED_SECRET_VALUE,
    });
    const scopedAliasGet = await tc("secrets", "get", SCOPED_SECRET_NAME, "--space", SECRET_SCOPE);
    expect(scopedAliasGet.exitCode).toBe(0);
    expect(scopedAliasGet.json.value).toBe(SCOPED_SECRET_VALUE);

    const list = await tc("secrets", "list");
    expect(list.exitCode).toBe(0);
    expect(list.json.secrets).toContain(SECRET_NAME);
    expect(list.json.secrets).toContain(FILE_SECRET_NAME);
    expect(list.json.secrets).toContain(STDIN_SECRET_NAME);
    expect(list.json.count).toBeGreaterThanOrEqual(1);

    const scopedList = await tc("secrets", "list", "--scope", SECRET_SCOPE);
    expect(scopedList.exitCode).toBe(0);
    expect(scopedList.json).toMatchObject({
      scope: SECRET_SCOPE,
    });
    expect(scopedList.json.secrets).toContain(SCOPED_SECRET_NAME);

    const scopedDel = await tc("secrets", "delete", SCOPED_SECRET_NAME, "--scope", SECRET_SCOPE);
    expect(scopedDel.exitCode).toBe(0);
    expect(scopedDel.json).toEqual({
      name: SCOPED_SECRET_NAME,
      deleted: true,
    });
    const scopedMissing = await tc("secrets", "get", SCOPED_SECRET_NAME, "--scope", SECRET_SCOPE);
    expect(scopedMissing.exitCode).toBe(4);

    const del = await tc("secrets", "delete", SECRET_NAME);
    expect(del.exitCode).toBe(0);
    expect(del.json).toEqual({
      name: SECRET_NAME,
      deleted: true,
    });

    const missing = await tc("secrets", "get", SECRET_NAME);
    expect(missing.exitCode).toBe(4);

    for (const name of [FILE_SECRET_NAME, STDIN_SECRET_NAME]) {
      const result = await tc("secrets", "delete", name);
      expect(result.exitCode).toBe(0);
      expect(result.json).toEqual({ name, deleted: true });
    }
  }, E2E_TIMEOUT_MS);

  test("rejects ambiguous secret value sources", async () => {
    const inputPath = join(tempDir, "ambiguous-input.txt");
    await writeFile(inputPath, "file value");

    const result = await tc("secrets", "put", `CLI_E2E_AMBIGUOUS_${RUN_ID}`, "argument value", "--file", inputPath);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Provide only one of");
  }, E2E_TIMEOUT_MS);
});

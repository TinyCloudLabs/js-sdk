import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkServerHealth, SERVER_URL, setupCliProfile, tc } from "../setup";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

// TC-3801: the node under test is a tinycloud-node 1.20.6 (no encryption-named-keys-v1), started by
// .github/scripts/run-cli-node-suite.sh. `tc secrets put` must refuse with its own code and exit code, say
// that nothing was saved, and never prompt; what is already stored must still read, list and delete.

const LEGACY_VERSION = "1.20.6";
const E2E_TIMEOUT_MS = 180_000;
const LEGACY_NAME = `CLI_LEGACY_${Date.now()}`;
const LEGACY_VALUE = "legacy secret value";
const NAMED_KEYS_UNSUPPORTED_EXIT = 11;
/** The error object the CLI prints (pretty JSON), whichever of stdout or stderr carried it. */
function errorOf(result: { stdout: string; stderr: string }): { code: string; message: string } {
  for (const text of [result.stderr, result.stdout]) {
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed?.error?.code) return parsed.error;
    } catch {
      // not JSON
    }
  }
  throw new Error(`no CLI error object in: ${result.stderr || result.stdout}`);
}

describe("tc secrets against a node without per-secret keys", () => {
  let node: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    // A run against the wrong binary must fail here, not pass by accident.
    const info = await (await fetch(`${SERVER_URL}/version`)).json() as { version?: string; features?: string[] };
    expect(info.version).toBe(LEGACY_VERSION);
    expect(info.features).not.toContain("encryption-named-keys-v1");
    node = await setupCliProfile();
    const secretsSpace = await node.ensureOwnedSpaceHosted("secrets");
    const vaults = node as unknown as {
      getBaseVault(space: string): { put(key: string, value: unknown): Promise<{ ok: boolean }> };
    };
    const planted = await vaults.getBaseVault(secretsSpace).put(`secrets/${LEGACY_NAME}`, {
      value: LEGACY_VALUE, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(planted.ok).toBe(true);
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.allSettled([node?.secrets.delete(LEGACY_NAME)]);
  }, E2E_TIMEOUT_MS);

  test("put is refused with NAMED_KEYS_UNSUPPORTED, exit 11, and nothing is saved", async () => {
    const put = await tc("secrets", "put", "CLI_LEGACY_NEW", "new value");
    expect(put.exitCode).toBe(NAMED_KEYS_UNSUPPORTED_EXIT);
    const error = errorOf(put);
    expect(error.code).toBe("NAMED_KEYS_UNSUPPORTED");
    expect(error.message).toContain("Nothing was saved.");
    expect(error.message).toContain("encryption-named-keys-v1");
    expect(error.message).toContain("whoever runs the node needs to upgrade it");

    const listed = await tc("secrets", "list");
    expect(listed.exitCode).toBe(0);
    expect(listed.json.secrets).not.toContain("CLI_LEGACY_NEW");
  }, E2E_TIMEOUT_MS);

  // The length check comes before the node is asked, so it answers the same on any node.
  test("put of a name over 64 characters says so in Monica's words (exit 2), not NAMED_KEYS_UNSUPPORTED", async () => {
    const long = `A${"B".repeat(64)}`;
    const tooLong = await tc("secrets", "put", long, "v");
    expect(tooLong.exitCode).toBe(2);
    expect(errorOf(tooLong).message).toBe("This secret wasn't saved: its name is 65 characters, and names can be at most 64. Choose a shorter name.");
  }, E2E_TIMEOUT_MS);

  test("a secret already on the node reads, lists and deletes", async () => {
    const get = await tc("secrets", "get", LEGACY_NAME);
    expect(get.exitCode).toBe(0);
    expect(get.json).toEqual({ name: LEGACY_NAME, value: LEGACY_VALUE });

    const listed = await tc("secrets", "list");
    expect(listed.exitCode).toBe(0);
    expect(listed.json.secrets).toContain(LEGACY_NAME);

    const deleted = await tc("secrets", "delete", LEGACY_NAME);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.json).toEqual({ name: LEGACY_NAME, deleted: true });

    const missing = await tc("secrets", "get", LEGACY_NAME);
    expect(missing.exitCode).toBe(4);
  }, E2E_TIMEOUT_MS);
});

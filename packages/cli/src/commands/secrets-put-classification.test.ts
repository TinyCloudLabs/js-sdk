import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// TC-834 S1-T5: a refused `secrets.put` classified by the real consumer
// chain (KVService → network DataVaultService → SecretsService →
// cliErrorFromService → handleError). `handleError` exits, so each scenario
// runs in its own process.

const HARNESS = join(import.meta.dir, "../../test-support/secrets-put-classification.ts");
const RESOURCE =
  "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000abc:default/kv/vault/secrets/API_KEY";

async function run(scenario: string): Promise<{ exitCode: number; error: Record<string, unknown> }> {
  const child = Bun.spawn([process.execPath, HARNESS, scenario], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout).toBe("");
  return { exitCode, error: JSON.parse(stderr).error };
}

describe("refused secrets put classification (real consumer)", () => {
  test("a capability 401 is PERMISSION_DENIED (exit 5) with the grant hint", async () => {
    const { exitCode, error } = await run("capability-401");
    expect(exitCode).toBe(5);
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.meta).toEqual({ status: 401, resource: RESOURCE, requiredAction: "tinycloud.kv/put" });
    expect(error.hint).toContain("tc auth request --cap 'tinycloud.kv:default:vault/secrets/API_KEY:put'");
  });

  test("a plain 401 is AUTH_REQUIRED (exit 3)", async () => {
    const { exitCode, error } = await run("plain-401");
    expect(exitCode).toBe(3);
    expect(error.code).toBe("AUTH_REQUIRED");
  });

  test("a 403 is PERMISSION_DENIED (exit 5)", async () => {
    const { exitCode, error } = await run("403");
    expect(exitCode).toBe(5);
    expect(error.code).toBe("PERMISSION_DENIED");
  });

  test("a 500 stays STORAGE_ERROR (exit 1)", async () => {
    const { exitCode, error } = await run("500");
    expect(exitCode).toBe(1);
    expect(error.code).toBe("STORAGE_ERROR");
  });
});

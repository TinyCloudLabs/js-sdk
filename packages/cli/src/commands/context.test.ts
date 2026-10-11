import { afterAll, beforeEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { mintCompactDelegation } = await import(new URL("../../../node-sdk/src/test-support/compact-delegation.ts", import.meta.url).href) as {
  mintCompactDelegation(options: { audience: string; expSecs: number }): Promise<{
    delegation: { delegationHeader: { Authorization: string }; cid: string };
    spaceId: string;
  }>;
};
const home = await mkdtemp(join(tmpdir(), "tc-context-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { registerTinyCloudCommands } = await import("../command-registry.js");
const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

beforeEach(async () => {
  await ProfileManager.setProfile("chosen", { name: "chosen", did: "did:key:test", ownerDid, host: "https://stored.example", chainId: 1, spaceName: "default", createdAt: "2026-01-01T00:00:00.000Z", privateKey: "never-output-private-key", authMethod: "openkey" });
  const expSecs = Math.floor(Date.now() / 1000) - 60;
  const imported = await mintCompactDelegation({ audience: "did:key:test", expSecs });
  await ProfileManager.setSession("chosen", {
    spaceId: imported.spaceId,
    expiresAt: new Date((expSecs + 3600) * 1000).toISOString(),
    delegationHeader: imported.delegation.delegationHeader,
    delegationCid: imported.delegation.cid,
    jwk: { d: "never-output-jwk" },
  });
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

// TC-674 regression: fails before the fix
test("reports signed compact expiry over future unsigned metadata without exposing authority", async () => {
  const program = new Command("tc").version("9.9.9-test").option("--profile <name>").option("--host <url>").option("--json");
  registerTinyCloudCommands(program);
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof original;
  try { await program.parseAsync(["--profile", "chosen", "--host", "https://selected.example", "--json", "context", "--space", "applications"], { from: "user" }); }
  finally { process.stdout.write = original; }
  const result = JSON.parse(output);
  expect(result).toMatchObject({ schemaVersion: 1, profile: "chosen", ownerDid, host: "https://selected.example", spaceId: `tinycloud:${ownerDid.slice(4)}:applications`, session: { state: "expired" }, access: "not-tested" });
  expect(output).not.toContain("never-output");
  expect(result.cliVersion).toBe("9.9.9-test");
});

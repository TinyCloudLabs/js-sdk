import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import { profileConfigPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

// TinyChat's bot-history key is reserved (TC-3823): an agent request naming it, or anything under its scope, is refused
// by `tc auth grant` for a local-key owner (whose wallet signs the grant) and an OpenKey owner, in every spelling, before
// the scope is printed, any request is made, anything is signed or anything is stored.
const BOT_HISTORY_SCOPE = BOT_HISTORY_KEY_PATH.split("/")[2]!;
const OWNER = "did:pkh:eip155:1:0xe8c2ab8468210C4b507C0563A10da60990eaa792";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const SPACE = "tinycloud:pkh:eip155:1:0xe8c2ab8468210C4b507C0563A10da60990eaa792:secrets";
const DECRYPT = "tinycloud.encryption/decrypt";
const KEY_CREATE = "tinycloud.encryption/key.create";
const PROFILE = "owner";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const record: PermissionEntry = {
  service: "tinycloud.kv", space: SPACE, path: "vault/secrets/API_KEY", skipPrefix: true, actions: ["tinycloud.kv/get"],
};
const encryption = (path: string, actions: string[]) => ({ service: "tinycloud.encryption", path, actions });

const OWNERS = {
  "an OpenKey owner": { authMethod: "openkey", posture: "owner-openkey" },
  "a local-key owner": { authMethod: "local", posture: "local-owner-key" },
} as const;

/** Runs `tc auth grant` against a stand-in node that records every request; a request kills the CLI at once. */
async function grant(owner: keyof typeof OWNERS, requested: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), "tc-grant-bot-history-"));
  homes.push(home);
  await writeFile(join(home, "request.json"), JSON.stringify({
    kind: "tinycloud.auth.request", version: 1, requestId: "bot-history-request",
    sessionDid: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH", requested,
  }));
  const requests: string[] = [];
  let kill = () => {};
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    kill();
    return new Response("unexpected request", { status: 500 });
  } });
  try {
    await withTinyCloudStateRoot(home, () => writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: server.url.origin, chainId: 1, spaceName: "default", did: "did:key:prior",
      ownerDid: OWNER, createdAt: "2026-10-01T00:00:00.000Z", ...OWNERS[owner],
    }));
    const listing = async () => (await readdir(home, { recursive: true })).filter((name) => !name.startsWith(".bun") && name !== ".tinycloud" && name !== ".tinycloud/cli-diagnostics.jsonl").sort();
    const before = await listing();
    const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, "auth", "grant", join(home, "request.json")], {
      env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: server.url.origin, TC_OPENKEY_API_HOST: server.url.origin },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    kill = () => child.kill("SIGKILL");
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const after = await listing();
    return { requests, output: `${stdout}\n${stderr}`, exitCode, stored: after.filter((name) => !before.includes(name)) };
  } finally {
    server.stop(true);
  }
}

// The key itself is refused as a reserved scope; another key in the scope and the scope as a prefix are refused earlier
// still, as an encryption entry that is not one secret's exact key.
const SPELLINGS: Array<[string, string, RegExp]> = [
  ["its exact key", `${NETWORK}/${BOT_HISTORY_KEY_PATH}`, /INVALID_SECRET_SCOPE[\s\S]*is reserved/],
  ["its exact key in upper case", `${NETWORK}/${BOT_HISTORY_KEY_PATH.toUpperCase()}`, /INVALID_SECRET_SCOPE[\s\S]*is reserved/],
  ["another key in the scope", `${NETWORK}/secrets/scoped/${BOT_HISTORY_SCOPE}/other`, /INVALID_SECRET_SCOPE|INVALID_MANIFEST/],
  ["the scope as a prefix", `${NETWORK}/secrets/scoped/${BOT_HISTORY_SCOPE}/`, /INVALID_SECRET_SCOPE|INVALID_MANIFEST/],
];

describe("auth grant refuses TinyChat's bot-history key", () => {
  for (const owner of Object.keys(OWNERS) as Array<keyof typeof OWNERS>) {
    for (const [label, path, refusal] of SPELLINGS) {
      test(`${owner}: ${label} is refused before any request, signature or stored grant`, async () => {
        const result = await grant(owner, [record, encryption(path, [DECRYPT, KEY_CREATE])]);
        expect(result.exitCode).toBe(2);
        expect(result.output).toMatch(refusal);
        expect(result.requests).toEqual([]);
        expect(result.stored).toEqual([]);
      }, 30_000);
    }
  }

  test("a local-key owner's request for decrypt alone on the key is refused the same way", async () => {
    const result = await grant("a local-key owner", [record, encryption(`${NETWORK}/${BOT_HISTORY_KEY_PATH}`, [DECRYPT])]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("INVALID_SECRET_SCOPE");
    expect(result.requests).toEqual([]);
    expect(result.stored).toEqual([]);
  }, 30_000);
});

describe("the exact-key matcher", () => {
  test("never admits the bot-history key, and still admits another scoped secret's key", async () => {
    const { isExactSecretKeyPermission } = await import("../lib/raw-encryption.js");
    const entry = (path: string) => encryption(path, [DECRYPT, KEY_CREATE]) as PermissionEntry;
    expect(isExactSecretKeyPermission(entry(`${NETWORK}/${BOT_HISTORY_KEY_PATH}`))).toBe(false);
    expect(isExactSecretKeyPermission(entry(`${NETWORK}/secrets/scoped/${BOT_HISTORY_SCOPE}/other`))).toBe(false);
    expect(isExactSecretKeyPermission(entry(`${NETWORK}/secrets/scoped/my-app/bot-history`))).toBe(true);
  });
});

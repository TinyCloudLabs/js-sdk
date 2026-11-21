import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profilePath, withTinyCloudStateRoot } from "@tinycloud/operations/state";
import { openProfileShareHistory } from "@tinycloud/operations/share-history";
import type { SenderShareRecord } from "@tinycloud/share-sdk";
import { ProfileManager } from "../config/profiles.js";
import { createEncryptedProfileHistory } from "./adapters.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const record = (shareId: string, extra: Partial<SenderShareRecord> = {}): SenderShareRecord => ({
  shareId,
  target: { origin: "https://node.example", nodeAudience: "did:key:node", spaceId: "tinycloud:test-space" },
  resource: { kind: "exact", path: `shares/${shareId}/note.md` },
  actions: ["tinycloud.kv/get"],
  recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
  registeredAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:00:00.000Z",
  ...extra,
});

const sessionSecret = new TextEncoder().encode("session-signature");
const signSessionBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
  expect(new TextDecoder().decode(bytes)).toBe("xyz.tinycloud.share/history-key/v1");
  return sessionSecret;
};

/**
 * Runs `body` against a private state root holding a profile with the given settings. The operations history ships as its
 * own bundle with its own copy of the state module, which only sees TC_HOME; the CLI's copy follows the state root.
 */
async function withProfile(config: Record<string, unknown>, body: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tc-share-history-compat-"));
  roots.push(root);
  const savedHome = process.env.TC_HOME;
  process.env.TC_HOME = root;
  try {
    await withTinyCloudStateRoot(root, async () => {
      await mkdir(profilePath("compat"), { recursive: true });
      await writeFile(join(profilePath("compat"), "profile.json"), JSON.stringify(config));
      await body();
    });
  } finally {
    if (savedHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = savedHome;
  }
}

const localProfile = { authMethod: "local", privateKey: "compat-private-key" };

test("the CLI reads what the operations history wrote, and sees its updates", async () => {
  await withProfile(localProfile, async () => {
    const operations = openProfileShareHistory({ profile: "compat", signSessionBytes });
    const cli = createEncryptedProfileHistory(async () => "compat", async () => { throw new Error("a local-key profile never signs"); });
    await operations.put(record("from-operations"));
    expect(await cli.list()).toEqual([record("from-operations")]);

    await operations.update!("from-operations", (current) => ({ ...current, revokedAt: "2026-02-01T00:00:00.000Z" }));
    expect(await cli.get("from-operations")).toMatchObject({ revokedAt: "2026-02-01T00:00:00.000Z" });
  });
});

test("the operations history reads what the CLI wrote, updates it, and the CLI sees the update", async () => {
  await withProfile(localProfile, async () => {
    const operations = openProfileShareHistory({ profile: "compat", signSessionBytes });
    const cli = createEncryptedProfileHistory(async () => "compat");
    await cli.put(record("from-cli"));
    expect(await operations.list()).toEqual([record("from-cli")]);

    await operations.update!("from-cli", (current) => ({ ...current, revokedAt: "2026-03-01T00:00:00.000Z" }));
    await operations.put(record("second"));
    expect(await cli.get("from-cli")).toMatchObject({ revokedAt: "2026-03-01T00:00:00.000Z" });
    expect((await cli.list()).map((value) => value.shareId)).toEqual(["from-cli", "second"]);
  });
});

test("the two stores agree on the file, its modes and the session-signature key", async () => {
  await withProfile({ authMethod: "openkey" }, async () => {
    // The CLI needs the profile's key and session to fingerprint its identity; the signer supplies the history secret.
    await writeFile(join(profilePath("compat"), "key.json"), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "x" }));
    await writeFile(join(profilePath("compat"), "session.json"), JSON.stringify({ id: "session-1" }));
    const operations = openProfileShareHistory({ profile: "compat", signSessionBytes });
    const cli = createEncryptedProfileHistory(async () => "compat", async () => sessionSecret);
    await operations.put(record("signed"));
    expect(await cli.list()).toEqual([record("signed")]);

    const file = join(profilePath("compat"), "cache", "share-history-v2.json");
    const operationsMode = (await stat(file)).mode & 0o777;
    const directoryMode = (await stat(join(file, ".."))).mode & 0o777;
    await cli.put(record("also-signed"));
    expect((await stat(file)).mode & 0o777).toBe(operationsMode);
    expect(operationsMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
    expect((await operations.list()).map((value) => value.shareId)).toEqual(["signed", "also-signed"]);
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")) as object).sort()).toEqual(["ciphertext", "iv", "kdfSalt", "version"]);
  });
});

test("an operations history write waits for a profile lock the CLI holds", async () => {
  await withProfile(localProfile, async () => {
    const operations = openProfileShareHistory({ profile: "compat", signSessionBytes });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = ProfileManager.withLock("compat", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let written = false;
    const write = operations.put(record("waited")).then(() => { written = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(written).toBe(false);
    release.resolve();
    await Promise.all([held, write]);
    expect(await createEncryptedProfileHistory(async () => "compat").get("waited")).toMatchObject({ shareId: "waited" });
  });
});

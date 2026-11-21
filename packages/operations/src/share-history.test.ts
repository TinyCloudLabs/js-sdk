import "../test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SenderShareRecord } from "@tinycloud/share-sdk";
import { ShareHistoryUnreadableError, openProfileShareHistory } from "./share-history.js";
import { profilePath, withTinyCloudStateRoot } from "./state.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const record = (shareId: string, extra: Partial<SenderShareRecord> = {}): SenderShareRecord => ({
  shareId,
  target: { origin: "https://node.example", nodeAudience: "did:key:node", spaceId: "tinycloud:test-space" },
  resource: { kind: "exact", path: `shares/${shareId}/note.md` },
  actions: ["tinycloud.kv/get"],
  recipientMatcher: { kind: "emailDomain", value: "example.com" },
  registeredAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:00:00.000Z",
  ...extra,
});

const noSigner = async (): Promise<Uint8Array> => {
  throw new Error("a local-key profile never signs");
};

/** Runs `body` against a private state root holding a local-key profile. */
async function withProfile(privateKey: string, body: (file: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tc-share-history-"));
  homes.push(home);
  await withTinyCloudStateRoot(home, async () => {
    await mkdir(profilePath("history"), { recursive: true });
    await writeFile(join(profilePath("history"), "profile.json"), JSON.stringify({ authMethod: "local", privateKey }));
    await body(join(profilePath("history"), "cache", "share-history-v2.json"));
  });
}

test("put, get, list, update and delete round-trip through the encrypted file", async () => {
  await withProfile("local-key", async (file) => {
    const history = openProfileShareHistory({ profile: "history", signSessionBytes: noSigner });
    expect(await history.list()).toEqual([]);
    await history.put(record("a"));
    await history.put(record("b"));
    await history.put(record("a", { filename: "replaced.md" }));
    expect(await history.get("a")).toMatchObject({ filename: "replaced.md" });
    expect((await history.list()).map((value) => value.shareId)).toEqual(["a", "b"]);
    expect(await history.update!("b", (current) => ({ ...current, revokedAt: "2026-02-01T00:00:00.000Z" }))).toMatchObject({ revokedAt: "2026-02-01T00:00:00.000Z" });
    expect(await history.update!("missing", (current) => current)).toBeUndefined();
    expect(await history.get("b")).toMatchObject({ revokedAt: "2026-02-01T00:00:00.000Z" });
    await history.delete("a");
    expect((await history.list()).map((value) => value.shareId)).toEqual(["b"]);

    const envelope = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "iv", "kdfSalt", "version"]);
    expect(envelope.version).toBe(2);
    expect(await readFile(file, "utf8")).not.toContain("shares/b");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700);
  });
});

test("a profile without a local key derives its secret from the signed history-key bytes, before taking the lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc-share-history-"));
  homes.push(home);
  await withTinyCloudStateRoot(home, async () => {
    await mkdir(profilePath("history"), { recursive: true });
    await writeFile(join(profilePath("history"), "profile.json"), JSON.stringify({ authMethod: "openkey" }));
    const signed: string[] = [];
    const signSessionBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
      signed.push(new TextDecoder().decode(bytes));
      return new TextEncoder().encode("signature-of-the-session-key");
    };
    const history = openProfileShareHistory({ profile: "history", signSessionBytes });
    await history.put(record("a"));
    expect(signed).toEqual(["xyz.tinycloud.share/history-key/v1"]);
    expect(await openProfileShareHistory({ profile: "history", signSessionBytes }).get("a")).toMatchObject({ shareId: "a" });
  });
});

test("two concurrent puts both persist", async () => {
  await withProfile("local-key", async () => {
    const first = openProfileShareHistory({ profile: "history", signSessionBytes: noSigner });
    const second = openProfileShareHistory({ profile: "history", signSessionBytes: noSigner });
    await Promise.all([first.put(record("one")), second.put(record("two"))]);
    expect((await first.list()).map((value) => value.shareId).sort()).toEqual(["one", "two"]);
  });
});

test("a file written under another key is refused and left byte-identical", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc-share-history-"));
  homes.push(home);
  await withTinyCloudStateRoot(home, async () => {
    await mkdir(profilePath("history"), { recursive: true });
    const profileFile = join(profilePath("history"), "profile.json");
    await writeFile(profileFile, JSON.stringify({ authMethod: "local", privateKey: "first-key" }));
    await openProfileShareHistory({ profile: "history", signSessionBytes: noSigner }).put(record("kept"));
    const historyFile = join(profilePath("history"), "cache", "share-history-v2.json");
    const before = await readFile(historyFile);

    await writeFile(profileFile, JSON.stringify({ authMethod: "local", privateKey: "second-key" }));
    const wrongKey = openProfileShareHistory({ profile: "history", signSessionBytes: noSigner });
    for (const attempt of [() => wrongKey.put(record("new")), () => wrongKey.list(), () => wrongKey.update!("kept", (current) => current), () => wrongKey.delete("kept")]) {
      expect(await attempt().catch((error: unknown) => error)).toBeInstanceOf(ShareHistoryUnreadableError);
    }
    expect((await readFile(historyFile)).equals(before)).toBe(true);

    await writeFile(historyFile, "not json");
    expect(await wrongKey.put(record("new")).catch((error: unknown) => error)).toBeInstanceOf(ShareHistoryUnreadableError);
    expect(await readFile(historyFile, "utf8")).toBe("not json");
  });
});

test("a profile that does not exist is refused without creating it", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc-share-history-"));
  homes.push(home);
  await withTinyCloudStateRoot(home, async () => {
    const history = openProfileShareHistory({ profile: "absent", signSessionBytes: noSigner });
    await expect(history.list()).rejects.toThrow("does not exist");
    expect(await stat(profilePath("absent")).catch(() => null)).toBeNull();
  });
});

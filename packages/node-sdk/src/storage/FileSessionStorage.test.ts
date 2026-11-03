import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedSessionData } from "@tinycloud/sdk-core";
import { FileSessionStorage } from "./FileSessionStorage";

const ADDRESS = "0x1111111111111111111111111111111111111111";
// chmod does not bind root, so the permission-based failures below cannot be produced there.
const itUnprivileged = process.getuid?.() === 0 ? test.skip : test;

function session(marker: string): PersistedSessionData {
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: marker }),
    siwe: "siwe",
    signature: `sig-${marker}`,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    version: "1.0",
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "file-session-storage-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FileSessionStorage", () => {
  itUnprivileged("a save that cannot complete leaves the previous session intact", async () => {
    const dir = tempDir();
    const storage = new FileSessionStorage(dir);
    await storage.save(ADDRESS, session("old"));
    const file = join(dir, readdirSync(dir)[0]!);
    const before = readFileSync(file, "utf-8");
    // A directory that refuses new entries: an in-place overwrite would still succeed, a temp-file write cannot.
    chmodSync(dir, 0o555);

    await expect(storage.save(ADDRESS, session("new"))).rejects.toThrow();

    expect(readFileSync(file, "utf-8")).toBe(before);
    chmodSync(dir, 0o755);
    expect((await storage.load(ADDRESS))?.signature).toBe("sig-old");
  });

  test("a completed save leaves exactly one file and the new session", async () => {
    const dir = tempDir();
    const storage = new FileSessionStorage(dir);
    await storage.save(ADDRESS, session("old"));
    await storage.save(ADDRESS, session("new"));

    expect(readdirSync(dir)).toHaveLength(1);
    expect((await storage.load(ADDRESS))?.signature).toBe("sig-new");
  });

  itUnprivileged("a read error keeps the file and surfaces the error", async () => {
    const dir = tempDir();
    const storage = new FileSessionStorage(dir);
    await storage.save(ADDRESS, session("kept"));
    const file = join(dir, readdirSync(dir)[0]!);
    chmodSync(file, 0o000);

    await expect(storage.load(ADDRESS)).rejects.toThrow();

    expect(existsSync(file)).toBe(true);
    chmodSync(file, 0o644);
    expect((await storage.load(ADDRESS))?.signature).toBe("sig-kept");
  });

  test("a file that is not valid JSON is kept and surfaced, not deleted", async () => {
    const dir = tempDir();
    const storage = new FileSessionStorage(dir);
    await storage.save(ADDRESS, session("x"));
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, "{ not json");

    await expect(storage.load(ADDRESS)).rejects.toThrow();

    expect(readFileSync(file, "utf-8")).toBe("{ not json");
  });

  test("an expired session is still cleaned up and loads as absent", async () => {
    const dir = tempDir();
    const storage = new FileSessionStorage(dir);
    await storage.save(ADDRESS, { ...session("old"), expiresAt: new Date(Date.now() - 1000).toISOString() });

    expect(await storage.load(ADDRESS)).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

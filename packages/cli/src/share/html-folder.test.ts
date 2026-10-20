import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithinFolder, readHtmlFolder, readRegularFile } from "./html-folder.js";

const OUTSIDE = "OUTSIDE-SECRET-CONTENT";
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("folder reading stays inside the folder", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "tc-html-folder-")));
    root = join(base, "site");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), OUTSIDE);
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  test("isWithinFolder accepts only strict descendants", () => {
    expect(isWithinFolder("/a/site", "/a/site/x.html")).toBe(true);
    expect(isWithinFolder("/a/site", "/a/site/sub/x.html")).toBe(true);
    for (const candidate of ["/a/site", "/a/site/", "/a/sitemap/x.html", "/a/outside/x.html", "/a/site/../outside/x", "/a", "/", "/b/site/x.html"]) {
      expect(isWithinFolder("/a/site", candidate), candidate).toBe(false);
    }
  });

  test("a file in the folder is read", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.txt"), "inside");
    const bytes = await readRegularFile(root, join(root, "sub", "a.txt"), "sub/a.txt", 1000, 1000);
    expect(bytes instanceof Uint8Array && decode(bytes)).toBe("inside");
  });

  // Survivor for O_NOFOLLOW: a link to a directory opens fine without it and then fails as "not a regular file".
  test("a symbolic link as the last component is refused when it is opened, whatever it points at", async () => {
    await symlink(outside, join(root, "dir-link"));
    await symlink(join(outside, "secret.txt"), join(root, "file-link"));
    expect(await readRegularFile(root, join(root, "dir-link"), "dir-link", 1000, 1000)).toMatchObject({ reason: "symbolic link" });
    expect(await readRegularFile(root, join(root, "file-link"), "file-link", 1000, 1000)).toMatchObject({ reason: "symbolic link" });
  });

  // The state the race produces: a parent directory is a link by the time the file is opened. O_NOFOLLOW alone reads it.
  test("a file reached through a symbolic link in a parent directory is refused and never read", async () => {
    await symlink(outside, join(root, "sub"));
    const result = await readRegularFile(root, join(root, "sub", "secret.txt"), "sub/secret.txt", 1000, 1000);
    expect(result instanceof Uint8Array).toBe(false);
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", reason: "symbolic link" });
    await mkdir(join(root, "real"));
    await symlink(outside, join(root, "real", "deeper"));
    expect(await readRegularFile(root, join(root, "real", "deeper", "secret.txt"), "real/deeper/secret.txt", 1000, 1000)).toMatchObject({ reason: "symbolic link" });
  });

  test("a file whose name no longer leads to the opened file is refused", async () => {
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(base, "elsewhere.txt"), "x");
    // A path that is inside the folder textually but is not the file at that path: the root differs.
    expect(await readRegularFile(join(base, "outside"), join(root, "a.txt"), "a.txt", 1000, 1000)).toMatchObject({ reason: "symbolic link" });
  });

  test("a directory that is a link is refused by the walk, listing nothing from it", async () => {
    await symlink(outside, join(root, "sub"));
    await expect(readHtmlFolder(root, 10_000)).rejects.toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", message: expect.stringContaining('"sub" (symbolic link)') });
  });

  // A second process swaps a subfolder for a link to the outside folder while the folder is read.
  test("a subfolder swapped for a link during the walk never gets an outside file read (200 walks)", async () => {
    await mkdir(join(root, ".real"));
    await writeFile(join(root, ".real", "secret.txt"), "inside");
    await writeFile(join(root, "index.html"), "<p>x</p>");
    await symlink(outside, join(root, ".link"));
    const swapper = spawn(process.execPath, ["-e", `
      const { renameSync } = require("node:fs");
      process.chdir(${JSON.stringify(root)});
      process.stdout.write("ready\\n");
      for (;;) {
        try { renameSync(".real", "sub"); renameSync("sub", ".real"); renameSync(".link", "sub"); renameSync("sub", ".link"); } catch {}
      }
    `], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolveReady) => swapper.stdout!.once("data", () => resolveReady()));
      let leaked = 0;
      for (let index = 0; index < 200; index += 1) {
        try {
          const { files } = await readHtmlFolder(root, 10_000);
          for (const file of files) if (decode(file.bytes) === OUTSIDE) leaked += 1;
        } catch { /* refused or changed: fine */ }
      }
      expect(leaked).toBe(0);
    } finally {
      swapper.kill("SIGKILL");
      await new Promise((resolveExit) => swapper.once("exit", resolveExit));
    }
  }, 60_000);
});

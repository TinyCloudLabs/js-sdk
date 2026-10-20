import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactBundleError } from "@tinycloud/share-sdk/html-bundle";
import { htmlFolderError, isWithinFolder, linuxDescriptorPath, listFolderDirectory, readHtmlFolder, readRegularFile, type FolderReadHooks } from "./html-folder.js";

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

  // The checks, each run with the descriptor's real path (Linux) and without it (the checks used where the platform cannot
  // name an open file). A hook models another process changing the folder at an exact point.
  const MODES: [string, FolderReadHooks][] = [
    ["by descriptor path", {}],
    ["without a descriptor path", { descriptorPath: async () => undefined }],
  ];
  const linuxOnly = process.platform === "linux";

  /** `sub/` is a real directory holding secret.txt; swap it for a link to `outside/`, keeping the real one as `.sub-real`. */
  async function swapSubForLink(): Promise<void> {
    await rename(join(root, "sub"), join(root, ".sub-real"));
    await symlink(outside, join(root, "sub"));
  }
  async function swapSubBack(): Promise<void> {
    await rm(join(root, "sub"));
    await rename(join(root, ".sub-real"), join(root, "sub"));
  }

  test.each(MODES)("a parent directory swapped for a link just before the open: the outside file is refused (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "secret.txt"), "inside");
    const result = await readRegularFile(root, join(root, "sub", "secret.txt"), "sub/secret.txt", 1000, 1000, { ...hooks, beforeOpen: swapSubForLink });
    expect(result instanceof Uint8Array).toBe(false);
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", reason: "symbolic link" });
  });

  // The window the path-based checks left: the open went through the link, then the link was put back to the real directory.
  test.each(MODES)("the link is put back after the open: the outside file is still refused (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "secret.txt"), "inside");
    const result = await readRegularFile(root, join(root, "sub", "secret.txt"), "sub/secret.txt", 1000, 1000, { ...hooks, beforeOpen: swapSubForLink, afterOpen: swapSubBack });
    expect(result instanceof Uint8Array).toBe(false);
  });

  test.each(MODES)("a file replaced by another file after the open is refused (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await writeFile(join(root, "a.txt"), "original");
    const result = await readRegularFile(root, join(root, "a.txt"), "a.txt", 1000, 1000, {
      ...hooks,
      afterOpen: async () => { await writeFile(join(root, "a.new"), "replacement"); await rename(join(root, "a.new"), join(root, "a.txt")); },
    });
    // The descriptor path of a replaced file names a deleted file ("...(deleted)"); without it the inode differs.
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY" });
    if (hooks.descriptorPath !== undefined) expect(result).toMatchObject({ reason: "changed while it was read" });
  });

  test("without a descriptor path a parent that became a link to the same folder after the read is refused", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.txt"), "inside");
    const result = await readRegularFile(root, join(root, "sub", "a.txt"), "sub/a.txt", 1000, 1000, {
      descriptorPath: async () => undefined,
      // The path still reaches the very same file, so only the check on each parent directory can see the link.
      afterRead: async () => { await rename(join(root, "sub"), join(root, ".sub-real")); await symlink(join(root, ".sub-real"), join(root, "sub")); },
    });
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", reason: "changed while it was read" });
  });

  test.each(MODES)("a file replaced between its lstat and its open is refused (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await writeFile(join(root, "a.txt"), "original");
    const result = await readRegularFile(root, join(root, "a.txt"), "a.txt", 1000, 1000, {
      ...hooks,
      afterLstat: async () => { await writeFile(join(root, "a.new"), "replacement"); await rename(join(root, "a.new"), join(root, "a.txt")); },
    });
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", reason: "changed while it was read" });
  });

  test.each(MODES)("a directory replaced between its lstat and its open is refused (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.txt"), "inside");
    const result = await listFolderDirectory(root, join(root, "sub"), "sub", {
      ...hooks,
      afterLstat: async () => {
        await mkdir(join(root, ".other"));
        await rename(join(root, "sub"), join(root, ".old"));
        await rename(join(root, ".other"), join(root, "sub"));
      },
    });
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", reason: "changed while it was read" });
  });

  test("without a descriptor path a parent swapped for a link after the read is refused", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.txt"), "inside");
    await writeFile(join(outside, "a.txt"), "outside a file with the same name");
    const result = await readRegularFile(root, join(root, "sub", "a.txt"), "sub/a.txt", 1000, 1000, {
      descriptorPath: async () => undefined,
      afterRead: swapSubForLink,
    });
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", reason: "changed while it was read" });
  });

  test.each(MODES)("a directory swapped for a link after it is opened is refused (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.txt"), "inside");
    const result = await listFolderDirectory(root, join(root, "sub"), "sub", { ...hooks, afterOpen: swapSubForLink });
    expect("entries" in result).toBe(false);
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY", reason: "symbolic link" });
  });

  test.each(MODES)("a directory replaced by another directory after it is opened is refused (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.txt"), "inside");
    const result = await listFolderDirectory(root, join(root, "sub"), "sub", {
      ...hooks,
      afterOpen: async () => {
        await mkdir(join(root, ".other"));
        await rename(join(root, "sub"), join(root, ".old"));
        await rename(join(root, ".other"), join(root, "sub"));
      },
    });
    expect("entries" in result).toBe(false);
    expect(result).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY" });
  });

  test.each(MODES)("an unchanged directory lists (%s)", async (_mode, hooks) => {
    if (hooks.descriptorPath === undefined && !linuxOnly) return;
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.txt"), "inside");
    const result = await listFolderDirectory(root, join(root, "sub"), "sub", hooks);
    expect("entries" in result && result.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  // A directory is listed from the descriptor it was opened as, so a swap after the check cannot change what is listed (a listing
  // by path would return the names in the outside folder).
  test("a directory is listed from its descriptor, not from its path", async () => {
    if (!linuxOnly) return;
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "inside.txt"), "x");
    await writeFile(join(outside, "outside-name.txt"), "y");
    const result = await listFolderDirectory(root, join(root, "sub"), "sub", { beforeList: swapSubForLink });
    expect("entries" in result && result.entries.map((entry) => entry.name)).toEqual(["inside.txt"]);
  });

  test("on Linux the descriptor's real path is the file's path", async () => {
    if (!linuxOnly) return;
    await writeFile(join(root, "a.txt"), "x");
    const { open } = await import("node:fs/promises");
    const handle = await open(join(root, "a.txt"), "r");
    try {
      expect(await linuxDescriptorPath(handle.fd)).toBe(join(root, "a.txt"));
    } finally { await handle.close(); }
  });

  // A SMOKE test, not the proof. A second process swaps a subfolder between a real directory and a link to the outside folder
  // as fast as it can while the folder is read, and no walk may return the outside file. The window is too narrow for 5,000
  // walks to find it: the earlier path-based check (which did leak) also passes this test. What proves each check is the
  // hook tests above, which put the swap at an exact step. Elsewhere than Linux the checks are best effort, so it is skipped.
  test("smoke: a subfolder swapped for a link by a running process never gets an outside file read (5,000 walks)", async () => {
    if (!linuxOnly) return;
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
      let accepted = 0;
      const walks = 5_000;
      for (let index = 0; index < walks; index += 1) {
        try {
          const { files } = await readHtmlFolder(root, 10_000);
          accepted += 1;
          for (const file of files) if (decode(file.bytes) === OUTSIDE) leaked += 1;
        } catch { /* refused or changed: fine */ }
      }
      expect(leaked).toBe(0);
      // Not a measurement of the window, only of how the run went (it varies from run to run).
      console.log(`html-folder race smoke: ${walks} walks, ${accepted} read, ${leaked} outside files returned`);
    } finally {
      swapper.kill("SIGKILL");
      await new Promise((resolveExit) => swapper.once("exit", resolveExit));
    }
  }, 120_000);
});

describe("refusals from the rewriter are echoed escaped", () => {
  test("the file path of a bundle error is escaped and clipped", () => {
    const hostile = "dir\u001b[2J\u001b]0;owned\u0007\u202e/a\u2028.css";
    const error = htmlFolderError(new ArtifactBundleError("unsupported", "artifact contains a blocked html feature", hostile));
    expect(error.message).toContain("\\u{1b}[2J");
    expect(error.message).toContain("\\u{202e}");
    expect(error.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u202e]/);
    const missing = htmlFolderError(new ArtifactBundleError("missing", "artifact resource is missing", hostile, hostile));
    expect(missing.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u202e]/);
    const limit = htmlFolderError(new ArtifactBundleError("limit", "artifact source exceeds limit", hostile));
    expect(limit.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u202e]/);
  });
});

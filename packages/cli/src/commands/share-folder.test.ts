import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PublishedShare, TargetPublishInput } from "@tinycloud/share-sdk";
import { configureShareCommandServices } from "./share.js";
import { runShareCaptured } from "./share.integration-harness.js";

const viewerOrigin = "https://share-dev.tinycloud.link";
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const descriptorFixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as {
  vectors: { name: string; descriptor: unknown }[];
};
const emailDescriptor = descriptorFixture.vectors.find((vector) => vector.name === "email")?.descriptor;
if (emailDescriptor === undefined) throw new Error("golden email descriptor is missing");

function publishedFor(request: TargetPublishInput): PublishedShare {
  return {
    protocol: "tinycloud-share", version: 1, url: `${viewerOrigin}/viewer#tc1=opaque`,
    link: { kind: "native", cid: "bafy-native" },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId: "bafy-native", origin: viewerOrigin,
      target: { kind: "bearer", origin: "https://node.example", nodeAudience: "did:web:node.example", spaceId: "owner-space" },
      resource: { kind: "exact", path: `shares/bafy-native/${request.filename}` }, actions: ["read"],
      expiresAt: request.expiresAt.toISOString(), display: { filename: request.filename }, recipientMatcher: { kind: "bearer" },
      enforcementDelegationCid: "bafy-native",
    },
  };
}

/** handleError ends the process; record its exit code and let the action return instead. */
async function run(args: readonly string[]): Promise<{ exitCode: number | undefined; stderr: string; stdout: string }> {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    const result = await runShareCaptured(["share", "publish", ...args, "--viewer-origin", viewerOrigin, "--json"]);
    return { exitCode: exitCode ?? result.exitCode, stderr: result.stderr, stdout: result.stdout };
  } finally { process.exit = originalExit; }
}

function errorOf(stderr: string): { code: string; message: string; hint?: string } {
  const start = stderr.lastIndexOf('{\n  "error"');
  return JSON.parse(stderr.slice(start)).error;
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("tc share publish ./site/", () => {
  let root: string;
  let published: TargetPublishInput[];
  let site: string;

  async function put(path: string, content: string | Uint8Array): Promise<void> {
    const target = join(site, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  async function basicSite(index = '<!doctype html><title>t</title><link rel="stylesheet" href="css/site.css"><h1>Hello</h1><img src="img/dot.png" alt=""><script src="js/app.js"></script>'): Promise<void> {
    await put("index.html", index);
    await put("css/site.css", "h1{color:teal}");
    await put("js/app.js", "document.title = 'inlined';");
    await put("img/dot.png", PNG);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-share-folder-"));
    site = join(root, "site");
    await mkdir(site);
    published = [];
    configureShareCommandServices({ targetAdapter: { publish: async (request) => { published.push(request); return publishedFor(request); } } });
  });
  afterEach(async () => {
    configureShareCommandServices({});
    await rm(root, { recursive: true, force: true });
  });

  test("publishes a multi-file site (html, css, js, png) as one self-contained html file over the bearer path", async () => {
    await basicSite();
    const result = await run([site]);
    expect(result.exitCode).toBe(0);
    expect(published).toHaveLength(1);
    const request = published[0]!;
    expect(request.target).toEqual({ kind: "bearer" });
    expect(request.filename).toBe("site.html");
    expect(request.mediaType).toBe("text/html");
    expect(request.files).toHaveLength(1);
    const page = decode(request.source as Uint8Array);
    expect(page).toContain("<style>h1{color:teal}</style>");
    expect(page).toContain("document.title = 'inlined';");
    expect(page).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(page).not.toMatch(/\b(?:src|href)="(?:css|js|img)\//);
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).toContain("connect-src 'none'");
  });

  test("--name sets the published name; it must stay an .html file, and --media-type must be text/html", async () => {
    await basicSite();
    expect((await run([site, "--name", "landing.html"])).exitCode).toBe(0);
    expect(published[0]!.filename).toBe("landing.html");
    for (const args of [["--name", "landing.md"], ["--name", "../x.html"], ["--media-type", "text/plain"]]) {
      published = [];
      const result = await run([site, ...args]);
      expect(result.exitCode).not.toBe(0);
      expect(published).toHaveLength(0);
    }
  });

  test("addressed and --prefix publication of a folder stay unavailable, exactly as before", async () => {
    await basicSite();
    const descriptorPath = join(root, "email-descriptor.json");
    await writeFile(descriptorPath, JSON.stringify(emailDescriptor));
    const emailArgs = ["--credential-descriptor", descriptorPath, "--issuer-did", "did:web:issuer.credentials.org", "--issuer-kid", "did:web:issuer.credentials.org#controller"];
    for (const args of [["--to", "email:alice@example.com"], ["--to", "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav"], ["--prefix", "--to", "email:alice@example.com"], ["--prefix"]]) {
      const result = await run([site, ...args, ...(args.includes("email:alice@example.com") ? emailArgs : [])]);
      expect(result.exitCode, args.join(" ")).toBeGreaterThan(0);
    }
    for (const args of [["--to", "email:alice@example.com"], ["--prefix", "--to", "email:alice@example.com"], ["--prefix"], ["--to", "domain:example.com"]]) {
      const refused = await run([site, ...args, ...(args.includes("email:alice@example.com") ? emailArgs : [])]);
      const exactEmail = args.includes("email:alice@example.com");
      expect(errorOf(refused.stderr).code, args.join(" ")).toBe(exactEmail ? "UNAVAILABLE" : "MAX_BYTES_EXCEEDED");
      expect(refused.exitCode).toBe(exactEmail ? 4 : 7);
    }
    expect(published).toHaveLength(0);
  });

  test("a folder next to other inputs is not a folder publish", async () => {
    await basicSite();
    await writeFile(join(root, "note.md"), "# n\n");
    const result = await run([site, join(root, "note.md")]);
    expect(result.exitCode).toBe(7);
    expect(errorOf(result.stderr).message).toContain("Folders can only be published as a single page");
    expect(published).toHaveLength(0);
    // Two folders: the same refusal.
    const second = await run([site, site]);
    expect(second.exitCode).toBe(7);
    expect(errorOf(second.stderr).message).toContain("Folders can only be published as a single page");
  });

  describe("refusals are typed, and name the file and reference", () => {
    const cases: [string, string, string, number, string[]][] = [
      ["an external script", '<script src="https://cdn.example/lib.js"></script>', "UNSUPPORTED_HTML", 2, ["index.html", "https://cdn.example/lib.js"]],
      ["@import url(http) in a style element", "<style>@import url(http://other.example/a.css);</style>", "UNSUPPORTED_HTML", 2, ["http://other.example/a.css"]],
      ["link rel=preload", '<link rel="preload" href="js/app.js" as="script">', "UNSUPPORTED_HTML", 2, ["link relation"]],
      ["<base>", '<base href="https://other.example/">', "UNSUPPORTED_HTML", 2, ["blocked html feature"]],
      ["<iframe>", '<iframe src="other.html"></iframe>', "UNSUPPORTED_HTML", 2, ["blocked html feature"]],
      ["<object>", '<object data="x.swf"></object>', "UNSUPPORTED_HTML", 2, ["blocked html feature"]],
      ["inline svg with an external image", '<svg><image href="https://other.example/p.png"/></svg>', "UNSUPPORTED_HTML", 2, ["svg references a resource"]],
      ["inline svg with a script", '<svg><script>fetch("/x")</script></svg>', "UNSUPPORTED_HTML", 2, ["svg contains a script"]],
      ["<noscript>", "<noscript>Enable JavaScript</noscript>", "UNSUPPORTED_HTML", 2, ["blocked html feature"]],
      ["<area href>", '<map name="m"><area href="https://other.example/" shape="rect" coords="0,0,1,1"></map>', "UNSUPPORTED_HTML", 2, ["blocked html feature"]],
      ["an escaped url()", '<p style="background:u\\72l(https://other.example/p.png)">x</p>', "UNSUPPORTED_HTML", 2, ["https://other.example/p.png"]],
      ["a link to another page", '<a href="about.html">About</a>', "UNSUPPORTED_HTML", 2, ["links to another page", "about.html"]],
      ["a traversal reference", '<img src="../secret.png">', "UNSAFE_PATH", 8, ["../secret.png"]],
      ["a missing file", '<img src="img/nope.png">', "HTML_RESOURCE_MISSING", 2, ["img/nope.png", "not in the folder"]],
      ["a wrong-case reference", '<img src="img/DOT.png">', "HTML_RESOURCE_MISSING", 2, ["img/DOT.png"]],
    ];
    test.each(cases)("%s", async (_name, body, code, exit, mentions) => {
      await basicSite();
      await put("index.html", `<!doctype html><html><head>${body.startsWith("<style") || body.startsWith("<link") || body.startsWith("<base") ? body : ""}</head><body>${body.startsWith("<style") || body.startsWith("<link") || body.startsWith("<base") ? "" : body}</body></html>`);
      const result = await run([site]);
      const error = errorOf(result.stderr);
      expect(error.code).toBe(code);
      expect(result.exitCode).toBe(exit);
      for (const text of mentions) expect(error.message).toContain(text);
      expect(published).toHaveLength(0);
    });

    test("a meta refresh is dropped from the page, not published", async () => {
      await basicSite('<!doctype html><meta http-equiv="refresh" content="0;url=https://other.example/"><p>ok</p>');
      expect((await run([site])).exitCode).toBe(0);
      expect(decode(published[0]!.source as Uint8Array)).not.toMatch(/refresh|other\.example/i);
    });

    test("no index.html at the top level, including one in a subfolder only", async () => {
      await put("pages/index.html", "<p>x</p>");
      const result = await run([site]);
      expect(errorOf(result.stderr).code).toBe("INVALID_ARGUMENT");
      expect(errorOf(result.stderr).message).toContain("index.html at its top level");
      expect(result.exitCode).toBe(2);
    });

    test("an oversize image is MAX_BYTES_EXCEEDED, and so is a folder over --max-bytes", async () => {
      await basicSite();
      await put("img/dot.png", new Uint8Array(10 * 1024 * 1024 + 1));
      const big = await run([site]);
      expect(errorOf(big.stderr).code).toBe("MAX_BYTES_EXCEEDED");
      expect(big.exitCode).toBe(7);
      await put("img/dot.png", PNG);
      await put("img/unused.bin", new Uint8Array(4096));
      const small = await run([site, "--max-bytes", "1024"]);
      expect(errorOf(small.stderr).code).toBe("MAX_BYTES_EXCEEDED");
      // The message names the limit asked for, not what was left of it when the file was reached.
      expect(errorOf(small.stderr).message).toContain("larger than the 1024 byte limit");
      expect(published).toHaveLength(0);
    });

    test("one large file referenced many times is refused at the cap, fast", async () => {
      await basicSite(`<!doctype html>${"<img src='img/big.png'>".repeat(120)}`);
      await put("img/big.png", new Uint8Array(6 * 1024 * 1024));
      const started = performance.now();
      const result = await run([site]);
      expect(errorOf(result.stderr).code).toBe("MAX_BYTES_EXCEEDED");
      expect(result.exitCode).toBe(7);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(published).toHaveLength(0);
    });

    test("more than 1000 files", async () => {
      await basicSite();
      await Promise.all(Array.from({ length: 1001 }, (_, index) => put(`files/${index}.txt`, "x")));
      const result = await run([site]);
      expect(errorOf(result.stderr).code).toBe("MAX_BYTES_EXCEEDED");
      expect(errorOf(result.stderr).message).toContain("more than 1000 files");
    });
  });

  describe("what is on disk", () => {
    test("symbolic links are refused, never followed, and the target is never read", async () => {
      await basicSite();
      const secret = join(root, "secret.txt");
      await writeFile(secret, "TOP-SECRET-CONTENT");
      await symlink(secret, join(site, "notes.txt"));
      await symlink(root, join(site, "up"));
      const result = await run([site]);
      const error = errorOf(result.stderr);
      expect(error.code).toBe("UNSUPPORTED_FOLDER_ENTRY");
      expect(result.exitCode).toBe(2);
      expect(error.message).toContain('"notes.txt" (symbolic link)');
      expect(error.message).toContain('"up" (symbolic link)');
      expect(result.stderr + result.stdout).not.toContain("TOP-SECRET-CONTENT");
      expect(published).toHaveLength(0);
    });

    test("a symlinked index.html is refused even when the target is a perfectly good page", async () => {
      await basicSite();
      await rm(join(site, "index.html"));
      await writeFile(join(root, "real.html"), "<p>real</p>");
      await symlink(join(root, "real.html"), join(site, "index.html"));
      expect(errorOf((await run([site])).stderr).code).toBe("UNSUPPORTED_FOLDER_ENTRY");
    });

    test("the folder argument itself may be a symlink the user typed", async () => {
      await basicSite();
      const alias = join(root, "alias");
      await symlink(site, alias);
      expect((await run([alias])).exitCode).toBe(0);
      expect(published[0]!.filename).toBe("alias.html");
    });

    test("a named pipe is refused instead of blocking the read", async () => {
      await basicSite();
      try { execFileSync("mkfifo", [join(site, "pipe")]); } catch { return; }
      const result = await run([site]);
      expect(errorOf(result.stderr)).toMatchObject({ code: "UNSUPPORTED_FOLDER_ENTRY" });
      expect(errorOf(result.stderr).message).toContain('"pipe" (not a regular file)');
    });

    test("hidden entries are skipped, never read or published, and reported", async () => {
      await basicSite();
      await put(".env", "API_KEY=hunter2");
      await put(".git/config", "[core]");
      await symlink(root, join(site, ".link"));
      const result = await run([site]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Skipped 3 hidden entries");
      expect(decode(published[0]!.source as Uint8Array)).not.toContain("hunter2");
    });

    test("a file the page references that is hidden is a missing file", async () => {
      await basicSite('<!doctype html><img src=".hidden/p.png">');
      await put(".hidden/p.png", PNG);
      expect(errorOf((await run([site])).stderr).code).toBe("HTML_RESOURCE_MISSING");
    });

    test("nesting deeper than the limit is refused", async () => {
      await basicSite();
      await put(`${Array.from({ length: 18 }, (_, index) => `d${index}`).join("/")}/f.txt`, "x");
      const error = errorOf((await run([site])).stderr);
      expect(error.code).toBe("UNSUPPORTED_FOLDER_ENTRY");
      expect(error.message).toContain("nested deeper than 16 folders");
    });

    test("case-colliding names are refused; unicode names match across normalization forms", async () => {
      await basicSite();
      await put("css/Site.css", "x");
      const collision = await run([site]);
      expect(errorOf(collision.stderr).code).toBe("UNSAFE_PATH");
      expect(collision.exitCode).toBe(8);
      await rm(join(site, "css/Site.css"));
      await put("img/cafe\u0301.png", PNG);
      await put("index.html", '<!doctype html><img src="img/caf\u00e9.png">');
      expect((await run([site])).exitCode).toBe(0);
      expect(decode(published[0]!.source as Uint8Array)).toContain("data:image/png;base64,");
    });
  });

  describe("echoed names are escaped for the terminal and clipped", () => {
    const CONTROLS = "\u001b[2J\u001b]0;owned\u0007\u202e\u2028\u200b";
    const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

    test("an unsafe file name is escaped and the refusal lists at most 5", async () => {
      await basicSite();
      for (let index = 0; index < 8; index += 1) await put(`bad${index}${CONTROLS}.txt`, "x");
      const result = await run([site]);
      const error = errorOf(result.stderr);
      expect(error.code).toBe("UNSAFE_PATH");
      expect(error.message).toContain("8 paths");
      expect(error.message).toContain("\\u{1b}[2J");
      expect(error.message).toContain("\\u{202e}");
      expect(error.message.match(/\(unsafe name\)/g)).toHaveLength(5);
      expect(error.message).toContain("and 3 more");
      expect(error.message).not.toMatch(RAW);
      expect(result.stderr).not.toMatch(RAW);
    });

    test("an odd reference text in the page is escaped", async () => {
      await basicSite(`<!doctype html><script src="https://x.example/${CONTROLS}${"a".repeat(300)}.js"></script>`);
      const error = errorOf((await run([site])).stderr);
      expect(error.code).toBe("UNSUPPORTED_HTML");
      expect(error.message).toContain("\\u{1b}[2J");
      expect(error.message).not.toMatch(RAW);
      expect(error.message.length).toBeLessThan(400);
    });

    test("an odd symlink name is escaped", async () => {
      await basicSite();
      await symlink(root, join(site, `link${CONTROLS}`));
      const error = errorOf((await run([site])).stderr);
      expect(error.code).toBe("UNSUPPORTED_FOLDER_ENTRY");
      expect(error.message).toContain("\\u{1b}[2J");
      expect(error.message).not.toMatch(RAW);
    });
  });

  describe("passive files (the T8 hook)", () => {
    test("manifest.json and knowledge/** are not inlined, are named on stderr, and the page cannot reference them", async () => {
      await basicSite();
      await put("manifest.json", '{"app_id":"xyz.example.app"}');
      await put("knowledge/index.md", "# KNOWLEDGE-SECRET");
      const result = await run([site]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Left out of the page and not published");
      expect(result.stderr).toContain('"manifest.json"');
      expect(result.stderr).toContain('"knowledge/index.md"');
      const page = decode(published[0]!.source as Uint8Array);
      expect(page).not.toContain("KNOWLEDGE-SECRET");
      expect(page).not.toContain("xyz.example.app");
      await put("index.html", '<!doctype html><script src="manifest.json"></script>');
      expect(errorOf((await run([site])).stderr).code).toBe("HTML_RESOURCE_MISSING");
    });
  });

  test("folder contents are data: a script in the folder is never executed while bundling", async () => {
    await basicSite('<!doctype html><script>globalThis.__tcFolderPublishRan = true; document.title = "x";</script>');
    expect((await run([site])).exitCode).toBe(0);
    expect((globalThis as Record<string, unknown>).__tcFolderPublishRan).toBeUndefined();
  });

  test("warns when the inlined page is above the viewer's preview budget", async () => {
    await basicSite('<!doctype html><img src="img/big.png">');
    await put("img/big.png", new Uint8Array(1_200_000));
    const result = await run([site]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("previews pages up to 1 MiB");
  });

  test("an unreadable or missing path is still the usual refusal", async () => {
    const result = await run([join(root, "nope")]);
    expect(result.exitCode).not.toBe(0);
    expect(published).toHaveLength(0);
  });
});

import { describe, expect, it } from "bun:test";
import { ArtifactBundleError, inlineHtmlFolder, isPassiveArtifactPath } from "../../src/html-bundle/index.js";
import { binary, fixtureFiles, parseHtml, utf8 } from "./support.js";

const inline = (files: Parameters<typeof inlineHtmlFolder>[0]) => inlineHtmlFolder(files, { parseHtml });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("inlineHtmlFolder", () => {
  it("turns a small multi-file site into one self-contained document", async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const result = await inline([
      utf8("index.html", '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><h1>Hi</h1><img src="img/dot.png" alt=""><script src="js/app.js"></script></body></html>'),
      utf8("css/site.css", "h1{color:teal}"),
      utf8("js/app.js", "document.title = 'ok';"),
      binary("img/dot.png", png, "image/png"),
      utf8("notes/unused.txt", "never published"),
    ]);
    const page = decode(result.html);
    expect(result.entry).toBe("index.html");
    expect(page).toContain("<style>h1{color:teal}</style>");
    expect(page).toContain("document.title = 'ok';");
    expect(page).toContain(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(page).not.toMatch(/(?:src|href)="(?:css|js|img)\//);
    expect(page).not.toContain("never published");
    expect(page).not.toMatch(/https?:\/\//);
    expect(result).toMatchObject({ fileCount: 5, passive: [] });
  });

  it("inlines the realistic fixture", async () => {
    const page = decode((await inline(fixtureFiles())).html);
    expect(page).toContain("data:image/svg+xml;base64,");
    expect(page).toContain("Sandbox isolation confirmed.");
    expect(page).not.toContain("https://");
  });

  it("transforms only the entry page and refuses a link to another page", async () => {
    // A broken second page is not part of the published document, so it is not examined.
    const ok = await inline([utf8("index.html", "<p>one page</p>"), utf8("old/index.html", '<iframe src="x"></iframe>')]);
    expect(decode(ok.html)).toContain("one page");
    const error = await inline([utf8("index.html", '<a href="about.html">About</a>'), utf8("about.html", "<p>x</p>")]).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ArtifactBundleError);
    expect(error).toMatchObject({ kind: "unsupported", path: "index.html", reference: "about.html" });
    // A same-page fragment is fine.
    expect(decode((await inline([utf8("index.html", '<a href="#top">Top</a><h1 id="top">x</h1>')])).html)).toContain('href="#top"');
  });

  it("requires a root index.html", async () => {
    await expect(inline([utf8("site/index.html", "<p>x</p>")])).rejects.toMatchObject({ kind: "missing" });
    await expect(inline([utf8("Index.html", "<p>x</p>")])).rejects.toMatchObject({ kind: "missing" });
    await expect(inline([])).rejects.toMatchObject({ kind: "malformed" });
  });

  it("refuses colliding paths even when one of them is a passive file", async () => {
    await expect(inline([utf8("index.html", "<p>x</p>"), utf8("manifest.json", "{}"), utf8("MANIFEST.json", "{}")])).rejects.toMatchObject({ kind: "malformed", path: "MANIFEST.json" });
    await expect(inline([utf8("index.html", "<p>x</p>"), utf8("knowledge/../a.md", "x")])).rejects.toMatchObject({ kind: "malformed", path: "knowledge/../a.md" });
  });

  it("counts the whole folder, passive files included, against the source cap", async () => {
    const chunk = new Uint8Array(40 * 1024 * 1024);
    await expect(inline([utf8("index.html", "<p>x</p>"), binary("knowledge/a.bin", chunk), binary("knowledge/b.bin", chunk), binary("knowledge/c.bin", chunk)])).rejects.toMatchObject({ kind: "limit" });
  });
});

describe("passive files (the T8 extension point)", () => {
  it.each([
    ["manifest.json", true],
    ["MANIFEST.JSON", true],
    ["knowledge/index.md", true],
    ["Knowledge/tables/a.md", true],
    ["knowledge/deep/er/a.json", true],
    ["knowledge", false],
    ["knowledge.md", false],
    ["docs/manifest.json", false],
    ["docs/knowledge/a.md", false],
    ["manifest.json.bak", false],
    ["index.html", false],
  ])("isPassiveArtifactPath(%p) is %p", (path, passive) => {
    expect(isPassiveArtifactPath(path)).toBe(passive);
  });

  it("returns manifest.json and knowledge/** untouched, in path order, and keeps them out of the page", async () => {
    const manifest = '{"app_id":"xyz.example.app","knowledge":"knowledge/index.md"}';
    const result = await inline([
      utf8("index.html", "<h1>App</h1>"),
      utf8("knowledge/tables/notes.md", "# notes SECRET-NOTES"),
      utf8("manifest.json", manifest, "application/json"),
      utf8("knowledge/index.md", "# index SECRET-INDEX"),
    ]);
    const page = decode(result.html);
    expect(page).not.toContain("SECRET-");
    expect(page).not.toContain("xyz.example.app");
    expect(result.passive.map((file) => file.path)).toEqual(["knowledge/index.md", "knowledge/tables/notes.md", "manifest.json"]);
    expect(decode(result.passive.find((file) => file.path === "manifest.json")!.bytes)).toBe(manifest);
    expect(result.passive.find((file) => file.path === "manifest.json")!.mediaType).toBe("application/json");
    expect(result.fileCount).toBe(4);
  });

  it("does not examine a passive file's contents", async () => {
    // Not valid utf-8, not html, not json: it is carried, not parsed.
    const result = await inline([utf8("index.html", "<p>x</p>"), binary("knowledge/blob.bin", [0xff, 0xfe, 0x00]), utf8("knowledge/page.html", '<iframe src="https://other.example"></iframe>')]);
    expect(result.passive).toHaveLength(2);
    expect(decode(result.html)).not.toContain("other.example");
  });

  it("does not let the page reference a passive file: the reference is refused like a missing file", async () => {
    for (const body of ['<script src="manifest.json"></script>', '<img src="knowledge/a.png">', '<link rel="stylesheet" href="knowledge/a.css">']) {
      await expect(inline([utf8("index.html", body), utf8("manifest.json", "{}"), utf8("knowledge/a.png", "x"), utf8("knowledge/a.css", "p{}")])).rejects.toMatchObject({ kind: "missing", path: "index.html" });
    }
  });
});

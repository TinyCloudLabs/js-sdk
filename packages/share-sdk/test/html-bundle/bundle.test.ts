// The rewriter's original tests (moved from the share viewer with the code), run under jsdom's HTML5 parser.
import { describe, expect, it } from "bun:test";
import {
  ArtifactBundleError,
  artifactMediaType,
  canonicalArtifactPath,
  detectHtmlArtifact,
  prepareHtmlArtifact,
  resolveArtifactReference,
} from "../../src/html-bundle/index.js";
import { binary, fixtureFiles, parseHtml, utf8 } from "./support.js";

const prepare = (files: Parameters<typeof prepareHtmlArtifact>[0]) => prepareHtmlArtifact(files, { parseHtml });

describe("HTML artifact bundle paths and detection", () => {
  it("detects exactly one canonical root index while ordinary folders stay compatible", () => {
    expect(detectHtmlArtifact(["index.html", "styles/site.css"])).toEqual({ kind: "html", entry: "index.html" });
    expect(detectHtmlArtifact(["site/index.html", "styles/site.css"])).toEqual({ kind: "folder", reason: "missing-root-index" });
    expect(() => detectHtmlArtifact(["index.html", "INDEX.HTML"])).toThrow(ArtifactBundleError);
  });

  it.each(["../secret", "/absolute", "a\\b", "a/%2e%2e/b", "a//b", "a/./b"])(
    "rejects unsafe canonical path %s",
    (path) => expect(() => canonicalArtifactPath(path)).toThrow(ArtifactBundleError),
  );

  it("resolves nested relatives and ignores lookup query/hash suffixes without allowing escape", () => {
    expect(resolveArtifactReference("pages/about/index.html", "../../assets/cloud.svg?v=2#mark")).toEqual({
      path: "assets/cloud.svg",
      fragment: "#mark",
      fragmentOnly: false,
    });
    expect(() => resolveArtifactReference("index.html", "../secret.txt")).toThrow(ArtifactBundleError);
    expect(() => resolveArtifactReference("index.html", "https://example.com/a.png")).toThrow(ArtifactBundleError);
    expect(artifactMediaType("assets/type.woff2")).toBe("font/woff2");
  });
});

describe("HTML artifact resource preparation", () => {
  it("rewrites the realistic fixture into a self-contained page with classic script intact", async () => {
    const artifact = await prepare(fixtureFiles());
    const page = artifact.pages["index.html"]!;
    expect(artifact).toMatchObject({ entry: "index.html", fileCount: 4 });
    expect(page).toContain("data:image/svg+xml;base64,");
    expect(page).toContain("<style>");
    expect(page).toContain("Send a signal");
    expect(page).toContain("Sandbox isolation confirmed.");
    expect(page).not.toContain('src="scripts/app.js"');
    expect(page).not.toContain('href="styles/site.css');
    expect(page).not.toContain("https://");
    expect(page).toContain("connect-src 'none'");
    expect(page).toContain("window.parent.postMessage");
  });

  it("allows benign local classic-script helpers named open", async () => {
    const artifact = await prepare([
      utf8("index.html", "<script>function open(){ return 1; } open();</script>"),
    ]);
    const page = artifact.pages["index.html"]!;
    expect(page).toContain("function open()");
    expect(page).toContain("open();");
  });

  it("supports bounded CSS imports, URLs, srcset, and internal HTML navigation", async () => {
    const artifact = await prepare([
      utf8("index.html", '<link rel="stylesheet" href="css/a.css"><img style="background:url(img/a.png)" srcset="img/a.png 1x, img/b.png?x=1 2x"><a href="pages/about.html#team">About</a>'),
      utf8("css/a.css", '@import url(./b.css) screen; body{background:url("../img/a.png#x")}'),
      utf8("css/b.css", "p{color:navy}"),
      { path: "img/a.png", bytes: new Uint8Array([1]), mediaType: "image/png" },
      { path: "img/b.png", bytes: new Uint8Array([2]), mediaType: "image/png" },
      utf8("pages/about.html", "<h1 id=team>Team</h1>"),
    ]);
    const page = artifact.pages["index.html"]!;
    expect(page).toContain("@media screen");
    expect(page.match(/data:image\/png;base64,/g)).toHaveLength(4);
    expect(page).toContain('data-tc-artifact-path="pages/about.html"');
    expect(page).toContain('data-tc-artifact-fragment="#team"');
    expect(artifact.pages["pages/about.html"]).toContain("Team");
  });

  it("preserves stylesheet media guards when inlining linked and embedded CSS", async () => {
    const artifact = await prepare([
      utf8("index.html", '<link rel="stylesheet" href="css/a.css" media="print"><style media="screen">body{color:teal}</style>'),
      utf8("css/a.css", "body{background:papayawhip}"),
    ]);
    const page = artifact.pages["index.html"]!;
    expect(page).toContain("@media print");
    expect(page).toContain("@media screen");
  });

  it.each([
    [fixtureFiles().filter((file) => file.path !== "assets/cloud.svg"), "missing"],
    [[utf8("index.html", '<img src="https://tracker.example/pixel">')], "unsupported"],
    [[utf8("index.html", '<link rel="preload" href="bundle.js">')], "unsupported"],
    [[utf8("index.html", '<script>window.open("https://example.com")</script>')], "unsupported"],
    [[utf8("index.html", '<link rel="stylesheet" href="a.css" media="screen}</style><script>bad()</script>">'), utf8("a.css", "body{color:red}")], "unsupported"],
    [[utf8("index.html", '<style media="print}</style><script>bad()</script>">body{color:red}</style>')], "unsupported"],
    [[utf8("index.html", '<button onclick="alert(1)">Hi</button>')], "unsupported"],
    [[utf8("index.html", '<script>fetch("/private")</script>')], "unsupported"],
    [[utf8("index.html", '<script>location.href="/private"</script>')], "unsupported"],
    [[utf8("index.html", '<script type="module">export default 1</script>')], "unsupported"],
    [[utf8("index.html", '<form action="/send"></form>')], "unsupported"],
    [[utf8("index.html", '<link rel="stylesheet" href="a.css">'), utf8("a.css", '@import "b.css";'), utf8("b.css", '@import "a.css";')], "unsupported"],
  ] as const)("fails closed for missing, external, rel/media, dynamic, module, form, or cyclic input", async (files, kind) => {
    await expect(prepare(files)).rejects.toMatchObject({ kind });
  });

  it("fails closed at file-count and rendered-resource limits", async () => {
    const tooMany = Array.from({ length: 1_001 }, (_, index) => utf8(index === 0 ? "index.html" : `files/${index}.txt`, "x"));
    await expect(prepare(tooMany)).rejects.toMatchObject({ kind: "limit" });
    await expect(prepare([
      utf8("index.html", '<img src="large.png">'),
      binary("large.png", new Uint8Array(10 * 1024 * 1024 + 1), "image/png"),
    ])).rejects.toMatchObject({ kind: "limit" });
  });
});

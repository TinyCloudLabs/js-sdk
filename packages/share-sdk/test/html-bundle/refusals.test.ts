// Every class the rewriter refuses, with a small benign-looking site per class. A refusal names the file and the
// reference text that caused it.
import { describe, expect, it } from "bun:test";
import { ArtifactBundleError, prepareHtmlArtifact, type ArtifactFile, type ArtifactFailureKind } from "../../src/html-bundle/index.js";
import { binary, parseHtml, utf8 } from "./support.js";

const prepare = (files: readonly ArtifactFile[]) => prepareHtmlArtifact(files, { parseHtml });
const page = (body: string, head = ""): ArtifactFile => utf8("index.html", `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`);

async function refusal(files: readonly ArtifactFile[]): Promise<ArtifactBundleError> {
  try {
    await prepare(files);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactBundleError);
    return error as ArtifactBundleError;
  }
  throw new Error("the bundle was accepted");
}

describe("network references and external URLs", () => {
  it.each<[string, ArtifactFile[], ArtifactFailureKind, string]>([
    ["external script src", [page('<script src="https://cdn.example/lib.js"></script>')], "unsupported", "https://cdn.example/lib.js"],
    ["protocol-relative script src", [page('<script src="//cdn.example/lib.js"></script>')], "unsupported", "//cdn.example/lib.js"],
    ["external stylesheet", [page("", '<link rel="stylesheet" href="https://fonts.example/css?family=x">')], "unsupported", "https://fonts.example/css?family=x"],
    ["external image", [page('<img src="http://tracker.example/p.gif">')], "unsupported", "http://tracker.example/p.gif"],
    ["external srcset candidate", [page('<img srcset="a.png 1x, https://x.example/b.png 2x">'), binary("a.png", [1], "image/png")], "unsupported", "https://x.example/b.png"],
    ["external video poster", [page('<video poster="//x.example/p.png"></video>')], "unsupported", "//x.example/p.png"],
    ["external favicon", [page("", '<link rel="icon" href="https://x.example/f.ico">')], "unsupported", "https://x.example/f.ico"],
    ["external link in an anchor", [page('<a href="https://example.com/">out</a>')], "unsupported", "https://example.com/"],
    ["mailto anchor", [page('<a href="mailto:a@example.com">mail</a>')], "unsupported", "mailto:a@example.com"],
    ["javascript: anchor", [page('<a href="javascript:alert(1)">x</a>')], "unsupported", "javascript:alert(1)"],
    ["data: image (not inlined by the author)", [page('<img src="data:image/png;base64,AAAA">')], "unsupported", "data:image/png;base64,AAAA"],
    ["root-relative image", [page('<img src="/img/a.png">')], "unsupported", "/img/a.png"],
    ["@import url(http) in a linked stylesheet", [page("", '<link rel="stylesheet" href="a.css">'), utf8("a.css", '@import url("http://evil.example/x.css");')], "unsupported", "http://evil.example/x.css"],
    ["@import url(http) unquoted in a style element", [page("", "<style>@import url(https://evil.example/x.css);</style>")], "unsupported", "https://evil.example/x.css"],
    ["@import string form with an external url", [page("", "<style>@import 'https://evil.example/x.css';</style>")], "unsupported", "https://evil.example/x.css"],
    ["css url() with an external host", [page("", '<link rel="stylesheet" href="a.css">'), utf8("a.css", "body{background:url(https://evil.example/p.png)}")], "unsupported", "https://evil.example/p.png"],
    ["css url() in a style attribute", [page('<p style="background:url(//evil.example/p.png)">x</p>')], "unsupported", "//evil.example/p.png"],
    ["@font-face src url() with an external host", [page("", "<style>@font-face{font-family:x;src:url(https://fonts.example/x.woff2)}</style>")], "unsupported", "https://fonts.example/x.woff2"],
    ["@import layer() condition", [page("", '<link rel="stylesheet" href="a.css">'), utf8("a.css", '@import url(b.css) layer(x);'), utf8("b.css", "p{}")], "unsupported", ""],
  ])("refuses %s", async (_name, files, kind, reference) => {
    const error = await refusal(files);
    expect(error.kind).toBe(kind);
    if (reference !== "") expect(error.reference).toBe(reference);
    expect(error.path).toBeDefined();
  });

  it("refuses an inline svg that points at a resource, and one that carries a script or handler", async () => {
    const cases: [string, ArtifactBundleError["kind"]][] = [
      ['<svg><image href="https://x.example/p.png"/></svg>', "unsupported"],
      ['<svg><image xlink:href="https://x.example/p.png"/></svg>', "unsupported"],
      ['<svg><image href="local.png"/></svg>', "unsupported"],
      ['<svg><use href="sprite.svg#a"/></svg>', "unsupported"],
      ['<svg><script href="https://x.example/a.js"/></svg>', "unsupported"],
      ['<svg><feImage href="//x.example/p.png"/></svg>', "unsupported"],
      ['<svg><a xlink:href="https://x.example/"><text>x</text></a></svg>', "unsupported"],
      ['<svg><a href="https://x.example/"><text>x</text></a></svg>', "unsupported"],
      ['<svg onload="alert(1)"></svg>', "unsupported"],
      ['<svg><script>fetch("/x")</script></svg>', "unsupported"],
      ['<svg><script type="module">1</script></svg>', "unsupported"],
      ['<svg><style>@import url(https://x.example/a.css);</style></svg>', "unsupported"],
      ['<svg><foreignObject><iframe src="a.html"></iframe></foreignObject></svg>', "unsupported"],
    ];
    for (const [body, kind] of cases) expect((await refusal([page(body)])).kind, body).toBe(kind);
  });

  it("allows a same-document svg reference and inlines a referenced svg file as an inert image", async () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example")</script><image href="https://evil.example/p.png"/></svg>';
    const prepared = await prepare([
      page('<svg><defs><symbol id="a"><path d="M0 0"/></symbol></defs><use href="#a"/></svg><img src="art/hostile.svg" alt="">'),
      utf8("art/hostile.svg", hostile, "image/svg+xml"),
    ]);
    const output = prepared.pages["index.html"]!;
    const encoded = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(output)?.[1];
    expect(encoded).toBeDefined();
    // The file's bytes only travel inside an image data URL; none of its markup reaches the page as markup.
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(hostile);
    expect(output).not.toContain("evil.example");
    expect(output).not.toContain("fetch(");
  });
});

describe("html features that are always refused", () => {
  it.each([
    ["<base>", page("", '<base href="https://evil.example/">')],
    ["<base> without a url", page("", '<base target="_blank">')],
    ["<iframe src>", page('<iframe src="other.html"></iframe>')],
    ["<iframe srcdoc>", page('<iframe srcdoc="<p>x</p>"></iframe>')],
    ["<frameset>", utf8("index.html", '<!doctype html><frameset><frame src="a.html"></frameset>')],
    ["<object>", page('<object data="movie.swf"></object>')],
    ["<embed>", page('<embed src="movie.swf">')],
    ["<form>", page('<form action="https://evil.example/"><input name=q></form>')],
    ["event handler attribute", page('<img src="a.png" onerror="alert(1)">')],
    ["event handler attribute in capitals", page('<p ONCLICK="x()">x</p>')],
    ["module script", page('<script type="module">import "./a.js"</script>')],
    ["async script", page("<script async>1</script>")],
    ["defer script", page("<script defer>1</script>")],
  ])("refuses %s", async (_name, file) => {
    const error = await refusal([file, binary("a.png", [1], "image/png")]);
    expect(error.kind).toBe("unsupported");
    expect(error.path).toBe("index.html");
  });

  it.each([
    "fetch('/x')", "new XMLHttpRequest()", "new WebSocket('wss://x')", "new EventSource('/x')", "new Worker('w.js')",
    "navigator.sendBeacon('/x')", "window.open('/x')", "top.location = '/x'", "location.assign('/x')", "import('./a.js')",
    "eval('1')", "WebAssembly.instantiate(x)",
  ])("refuses a script that uses %s", async (code) => {
    expect((await refusal([page(`<script>${code}</script>`)])).kind).toBe("unsupported");
  });

  it.each([
    ["preload", "script"], ["prefetch", "script"], ["preconnect", ""], ["dns-prefetch", ""], ["prerender", ""], ["modulepreload", "script"],
    ["manifest", ""], ["import", ""], ["canonical", ""], ["alternate", ""], ["stylesheet preload", ""], ["icon stylesheet", ""], ["", ""],
  ])("refuses a link with rel=%p", async (rel) => {
    const link = rel === "" ? '<link href="a.css">' : `<link rel="${rel}" href="a.css">`;
    const error = await refusal([page("", link), utf8("a.css", "p{}")]);
    expect(error.kind).toBe("unsupported");
  });

  it("drops meta refresh and author CSP metas instead of passing them through", async () => {
    const prepared = await prepare([page("<p>hi</p>", '<meta http-equiv="refresh" content="0;url=https://evil.example/"><meta http-equiv="Content-Security-Policy" content="default-src *">')]);
    const output = prepared.pages["index.html"]!;
    expect(output).not.toMatch(/refresh/i);
    expect(output).not.toContain("evil.example");
    expect(output).not.toContain("default-src *");
    expect(output).toContain("default-src 'none'");
  });

  it("refuses stylesheet media that could break out of the media wrapper", async () => {
    const error = await refusal([page("", '<link rel="stylesheet" href="a.css" media="print}p{display:none">'), utf8("a.css", "p{}")]);
    expect(error.kind).toBe("unsupported");
  });
});

describe("paths, traversal, case and unicode", () => {
  it.each([
    ["parent directory from the root", '<img src="../secret.png">'],
    ["parent directory past the root, from nested", '<img src="a/../../secret.png">'],
    ["percent-encoded dot-dot", '<img src="%2e%2e/secret.png">'],
    ["percent-encoded slash", '<img src="a%2fb.png">'],
    ["percent-encoded backslash", '<img src="a%5cb.png">'],
    ["backslash", '<img src="a\\b.png">'],
    ["bidi override in the reference", '<img src="a\u202e.png">'],
    ["zero-width character in the reference", '<img src="a\u200b.png">'],
  ])("refuses %s", async (_name, body) => {
    const error = await refusal([page(body)]);
    expect(error.kind).toBe("malformed");
    expect(error.path).toBe("index.html");
    expect(error.reference).toBeDefined();
  });

  it("refuses a reference with a null byte (the HTML parser turns it into U+FFFD, which names no file)", async () => {
    expect((await refusal([page('<img src="a\u0000.png">')])).kind).toBe("missing");
  });

  it("refuses a traversal inside a stylesheet and names the stylesheet's reference", async () => {
    const error = await refusal([page("", '<link rel="stylesheet" href="css/a.css">'), utf8("css/a.css", "body{background:url(../../secret.png)}")]);
    expect(error.kind).toBe("malformed");
    expect(error.reference).toBe("../../secret.png");
  });

  it.each([
    ["a parent segment", "../a.txt"],
    ["an absolute path", "/a.txt"],
    ["a backslash", "a\\b.txt"],
    ["an empty segment", "a//b.txt"],
    ["a dot segment", "./a.txt"],
    ["a bidi override", "a\u202e.txt"],
    ["a zero-width character", "a\u200b.txt"],
    ["a control character", "a\u0007.txt"],
    ["a lone surrogate", "a\ud800.txt"],
    ["an encoded dot", "%2e/a.txt"],
  ])("refuses a file path with %s", async (_name, path) => {
    const error = await refusal([page("<p>x</p>"), utf8(path, "x")]);
    expect(error.kind).toBe("malformed");
    expect(error.path).toBe(path);
  });

  it("treats paths case-insensitively for collisions and case-sensitively for lookups", async () => {
    expect((await refusal([page("<p>x</p>"), utf8("A.css", "a"), utf8("a.css", "b")])).kind).toBe("malformed");
    expect((await refusal([page("<p>x</p>"), utf8("img/Logo.png", "a"), utf8("img/logo.PNG", "b")])).kind).toBe("malformed");
    // `Index.html` is not the root index, and a differently-cased reference does not reach `logo.png`.
    expect((await refusal([utf8("Index.html", "<p>x</p>")])).kind).toBe("malformed");
    const missing = await refusal([page('<img src="Logo.PNG">'), binary("logo.png", [1], "image/png")]);
    expect(missing.kind).toBe("missing");
    expect(missing.reference).toBe("Logo.PNG");
  });

  it("matches a decomposed file name to a composed reference and back (NFC)", async () => {
    const decomposed = "cafe\u0301.png";
    const composed = "caf\u00e9.png";
    for (const [fileName, reference] of [[decomposed, composed], [composed, decomposed]] as const) {
      const prepared = await prepare([page(`<img src="${reference}">`), binary(fileName, [1], "image/png")]);
      expect(prepared.pages["index.html"]).toContain("data:image/png;base64,AQ==");
    }
    // Two names that are one name after NFC collide.
    expect((await refusal([page("<p>x</p>"), binary(decomposed, [1]), binary(composed, [2])])).kind).toBe("malformed");
  });

  it("resolves nested folders, query strings and fragments", async () => {
    const prepared = await prepare([
      page('<link rel="stylesheet" href="a/b/site.css?v=3"><img src="a/b/../img/p.png?x=1#frag">'),
      utf8("a/b/site.css", "body{background:url(../img/p.png?cache=1)}"),
      binary("a/img/p.png", [9], "image/png"),
    ]);
    expect(prepared.pages["index.html"]!.match(/data:image\/png;base64,CQ==/g)).toHaveLength(2);
  });

  it("refuses a reference to a missing file, naming file and reference", async () => {
    const error = await refusal([page('<script src="js/app.js"></script>')]);
    expect(error).toMatchObject({ kind: "missing", path: "index.html", reference: "js/app.js" });
  });
});

describe("size and count caps", () => {
  it("refuses an image over the render cap, an aggregate of text over the cap, and too many files", async () => {
    expect((await refusal([page('<img src="big.png">'), binary("big.png", new Uint8Array(10 * 1024 * 1024 + 1), "image/png")])).kind).toBe("limit");
    expect((await refusal([page('<link rel="stylesheet" href="big.css">'), utf8("big.css", `/*${"x".repeat(5 * 1024 * 1024 + 1)}*/`)])).kind).toBe("limit");
    expect((await refusal([page("<p>x</p>"), utf8("a.txt", "x".repeat(6 * 1024 * 1024)), utf8("b.txt", "x".repeat(6 * 1024 * 1024))])).kind).toBe("limit");
    const many = Array.from({ length: 1_000 }, (_, index) => utf8(`f/${index}.txt`, "x"));
    expect((await refusal([page("<p>x</p>"), ...many])).kind).toBe("limit");
  });

  it("refuses a source over 100 MiB without rendering it", async () => {
    const chunk = new Uint8Array(40 * 1024 * 1024);
    const error = await refusal([page("<p>x</p>"), binary("a.bin", chunk), binary("b.bin", chunk), binary("c.bin", chunk)]);
    expect(error.kind).toBe("limit");
  });

  it("refuses an expansion past the rendered cap when many references repeat one image", async () => {
    const image = new Uint8Array(1024 * 1024);
    const body = Array.from({ length: 12 }, () => '<img src="p.png">').join("");
    expect((await refusal([page(body), binary("p.png", image, "image/png")])).kind).toBe("limit");
  });

  it("refuses a stylesheet import chain that is too deep", async () => {
    const files = [page("", '<link rel="stylesheet" href="s0.css">')];
    for (let index = 0; index < 20; index += 1) files.push(utf8(`s${index}.css`, `@import "s${index + 1}.css";`));
    files.push(utf8("s20.css", "p{}"));
    expect((await refusal(files)).kind).toBe("limit");
  });
});

describe("malformed input", () => {
  it("refuses a stylesheet that is not utf-8", async () => {
    expect((await refusal([page("", '<link rel="stylesheet" href="a.css">'), binary("a.css", [0xff, 0xfe, 0xfd], "text/css")])).kind).toBe("malformed");
  });

  it("refuses an empty bundle and a bundle without a root index", async () => {
    expect((await refusal([])).kind).toBe("malformed");
    expect((await refusal([utf8("site/index.html", "<p>x</p>")])).kind).toBe("malformed");
  });
});

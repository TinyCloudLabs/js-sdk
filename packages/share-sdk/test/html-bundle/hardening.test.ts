// What the rewriter and its final verification refuse beyond the plain forms: CSS escapes, image-set(), area/ping,
// template and noscript content, SVG presentation attributes, and output amplification.
import { describe, expect, it } from "bun:test";
import { ArtifactBundleError, MAX_ARTIFACT_REFERENCES, normalizeCssEscapes, prepareHtmlArtifact, type ArtifactFile } from "../../src/html-bundle/index.js";
import { binary, parseHtml, utf8 } from "./support.js";

const prepare = (files: readonly ArtifactFile[]) => prepareHtmlArtifact(files, { parseHtml });
const page = (body: string, head = ""): ArtifactFile => utf8("index.html", `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`);
const PNG = binary("img/a.png", [0x89, 0x50, 0x4e, 0x47], "image/png");

async function refusal(files: readonly ArtifactFile[]): Promise<ArtifactBundleError> {
  try {
    await prepare(files);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactBundleError);
    return error as ArtifactBundleError;
  }
  throw new Error("the bundle was accepted");
}

describe("CSS escapes cannot hide a reference", () => {
  it("decodes the escapes of reference names and leaves every other identifier, string and comment alone", () => {
    expect(normalizeCssEscapes("a{background:u\\72l(x.png)}")).toBe("a{background:url(x.png)}");
    expect(normalizeCssEscapes("a{background:\\75rl(x.png)}")).toBe("a{background:url(x.png)}");
    expect(normalizeCssEscapes("a{background:\\75 rl(x.png)}")).toBe("a{background:url(x.png)}");
    expect(normalizeCssEscapes("a{background:\\000075\\000072\\00006c(x.png)}")).toBe("a{background:url(x.png)}");
    expect(normalizeCssEscapes("@\\69mport 'a.css';")).toBe("@import 'a.css';");
    expect(normalizeCssEscapes("a{b:-webkit-\\69mage-set(x)}")).toBe("a{b:-webkit-image-set(x)}");
    // Not references: selectors, strings, comments, other functions.
    const untouched = '.sm\\:flex>.a\\2f b{content:"u\\72l(x)";width:calc(1px)} /* \\75rl(x) */ b{color:\\72gb(1,2,3)}';
    expect(normalizeCssEscapes(untouched)).toBe(untouched);
  });

  it.each([
    ["u\\72l( in a style attribute", page('<p style="background:u\\72l(https://x.example/p.png)">x</p>')],
    ["\\75rl( in a style attribute", page('<p style="background:\\75rl(https://x.example/p.png)">x</p>')],
    ["hex escape with a terminating space", page('<p style="background:\\75 rl(//x.example/p.png)">x</p>')],
    ["u\\72l( in a style element", page("", "<style>a{background:u\\72l(https://x.example/p.png)}</style>")],
    ["an escaped @import", page("", '<style>@\\69mport url(https://x.example/a.css);</style>')],
    ["an escaped scheme inside url()", page('<p style="background:url(https\\3a //x.example/p.png)">x</p>')],
    ["an escaped scheme inside a string url()", page('<p style="background:url(\'https\\3a //x.example/p.png\')">x</p>')],
    ["an unterminated @import at the end", page("", '<style>p{}@import "https://x.example/a.css"</style>')],
    ["an unterminated @import url() at the end", page("", "<style>@import url(https://x.example/a.css)</style>")],
    ["image-set() with a string url", page('<p style="background:image-set(\'https://x.example/p.png\' 1x)">x</p>')],
    ["-webkit-image-set()", page('<p style="background:-webkit-image-set(url(https://x.example/p.png) 1x)">x</p>')],
    ["an escaped image-set()", page('<p style="background:image\\2d set(\'https://x.example/p.png\' 1x)">x</p>')],
    ["src()", page('<p style="background:src(\'https://x.example/p.png\')">x</p>')],
  ])("refuses %s", async (_name, file) => {
    // A backslash in a reference is a malformed path; every other form is an unsupported reference.
    expect(["unsupported", "malformed"]).toContain((await refusal([file])).kind);
  });

  it("still inlines a local file named through an escaped url()", async () => {
    const prepared = await prepare([page('<p style="background:u\\72l(img/a.png)">x</p>'), PNG]);
    const output = prepared.pages["index.html"]!;
    expect(output).toContain("data:image/png;base64,");
    expect(output).not.toContain("img/a.png");
  });

  it("keeps escaped selectors working in an inlined stylesheet", async () => {
    const prepared = await prepare([page("<p>x</p>", '<link rel="stylesheet" href="a.css">'), utf8("a.css", ".sm\\:flex{display:flex}")]);
    expect(prepared.pages["index.html"]).toContain(".sm\\:flex{display:flex}");
  });
});

describe("html that carries a URL outside the attributes the rewriter inlines", () => {
  it.each([
    ["<area href>", '<map name="m"><area href="https://x.example/" shape="rect" coords="0,0,1,1"></map>'],
    ["<area href> to a fragment", '<map name="m"><area href="#a" shape="rect" coords="0,0,1,1"></map>'],
    ["<a ping>", '<a href="#x" ping="https://x.example/beacon">x</a>'],
    ["an empty ping", '<a href="#x" ping>x</a>'],
    ["<link imagesrcset> without href", '<link rel="preload" as="image" imagesrcset="https://x.example/a.png 1x">'],
    ["<link> without href", '<link rel="stylesheet">'],
    ["<button formaction>", '<button formaction="https://x.example/">x</button>'],
    ["<blockquote cite>", '<blockquote cite="https://x.example/">x</blockquote>'],
    ["<img longdesc>", '<img longdesc="https://x.example/">'],
    ["<body background> as a scheme", '<table background="https://x.example/p.png"><tr><td>x</td></tr></table>'],
    ["a mathml href", '<math><mi href="https://x.example/">x</mi></math>'],
    ["<fencedframe>-like src on an unknown element", '<fencedframe src="https://x.example/"></fencedframe>'],
  ])("refuses %s", async (_name, body) => {
    expect((await refusal([page(body)])).kind).toBe("unsupported");
  });

  it("refuses a local image reference on an attribute that is not inlined, and an external srcset on any element", async () => {
    expect((await refusal([page('<img longdesc="img/a.png">'), PNG])).kind).toBe("unsupported");
    expect((await refusal([page('<div imagesrcset="https://x.example/a.png 1x"></div>')])).kind).toBe("unsupported");
  });
});

describe("template and noscript content", () => {
  it("refuses external references inside template content, nested templates and declarative shadow roots", async () => {
    for (const body of [
      '<template><img src="https://x.example/p.png"></template>',
      '<template><template><img src="https://x.example/p.png"></template></template>',
      '<template shadowrootmode="open"><style>@import url(https://x.example/a.css);</style></template>',
      '<template><a href="https://x.example/">x</a></template>',
      '<template><p onclick="x()">x</p></template>',
      '<template><iframe src="a.html"></iframe></template>',
      '<template><script src="https://x.example/a.js"></script></template>',
      '<template><div style="background:url(https://x.example/p.png)"></div></template>',
    ]) expect((await refusal([page(body)])).kind, body).toBe("unsupported");
  });

  it("rewrites local resources inside template content like the rest of the page", async () => {
    const prepared = await prepare([page('<template id="t"><img src="img/a.png"><style>p{background:url(img/a.png)}</style></template>'), PNG]);
    const output = prepared.pages["index.html"]!;
    expect(output).not.toContain("img/a.png");
    expect(output.match(/data:image\/png;base64,/g)).toHaveLength(2);
  });

  it("refuses noscript, whatever it holds, including one that closes itself through an attribute", async () => {
    for (const body of [
      "<noscript>Enable JavaScript</noscript>",
      '<noscript><p title="</noscript><img src=https://x.example/p.png>">x</p></noscript>',
      '<noscript><meta http-equiv="refresh" content="0;url=https://x.example/"></noscript>',
    ]) expect((await refusal([page(body)])).kind, body).toBe("unsupported");
    expect((await refusal([page("<p>x</p>", "<noscript><style>p{}</style></noscript>")])).kind).toBe("unsupported");
  });
});

describe("svg presentation attributes and animation", () => {
  it.each([
    ['fill', '<svg><rect fill="url(https://x.example/a.svg#g)"/></svg>'],
    ['filter', '<svg><rect filter="url(f.svg#x)"/></svg>'],
    ['mask', '<svg><rect mask="url(//x.example/m.svg#m)"/></svg>'],
    ['an escaped url()', '<svg><rect fill="u\\72l(https://x.example/a.svg#g)"/></svg>'],
    ['a style attribute', '<svg><rect style="fill:url(https://x.example/a.svg#g)"/></svg>'],
    ['animate to', '<svg><rect><set attributeName="fill" to="url(https://x.example/a.svg#g)"/></rect></svg>'],
    ['animate href', '<svg><a href="#x"><set attributeName="href" to="https://x.example/"/><text>x</text></a></svg>'],
    ['animate xlink:href', '<svg><a href="#x"><animate attributeName="xlink:href" values="https://x.example/"/><text>x</text></a></svg>'],
    ['mpath href', '<svg><animateMotion><mpath href="https://x.example/p.svg#p"/></animateMotion></svg>'],
  ])("refuses %s", async (_name, body) => {
    expect((await refusal([page(body)])).kind).toBe("unsupported");
  });

  it("allows same-document paint servers and filters", async () => {
    const prepared = await prepare([page('<svg><defs><linearGradient id="g"/><filter id="f"/></defs><rect fill="url(#g)" filter="url(#f)" style="stroke:url(#g)"/></svg>')]);
    expect(prepared.pages["index.html"]).toContain('fill="url(#g)"');
  });
});

describe("the finished page is verified", () => {
  it("accepts the page the rewriter wrote: only data: URLs and fragments are left", async () => {
    const prepared = await prepare([
      page('<img src="img/a.png" srcset="img/a.png 1x, img/a.png 2x"><a href="#top">t</a><p style="background:url(img/a.png)">x</p>', '<link rel="icon" href="img/a.png"><link rel="stylesheet" href="a.css">'),
      PNG,
      utf8("a.css", "@font-face{font-family:x;src:local(Arial)} p{background:url(img/a.png)}"),
    ]);
    const output = prepared.pages["index.html"]!;
    expect(output).not.toMatch(/(?:src|href)="(?!data:|#)/);
    expect(output).not.toContain("img/a.png");
  });
});

describe("output amplification is refused as it grows", () => {
  const big = (megabytes: number): ArtifactFile => binary("big.png", new Uint8Array(megabytes * 1024 * 1024), "image/png");

  it("refuses 120 references to one large file at the reference that passes the cap, fast and in bounded memory", async () => {
    for (const files of [
      [page("<img src='big.png'>".repeat(120)), big(6)],
      [page("<p>x</p>", "<style>" + "a{background:url(big.png)}".repeat(120) + "</style>"), big(6)],
      [page("<img src='big.png'>".repeat(120)), big(9)],
    ]) {
      const before = process.memoryUsage().rss;
      const started = performance.now();
      const error = await refusal(files);
      expect(error.kind).toBe("limit");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
    }
  });

  it("counts every use of a stylesheet that is imported repeatedly", async () => {
    const css = utf8("a.css", `/*${"x".repeat(4 * 1024 * 1024)}*/`);
    const error = await refusal([page("", '<link rel="stylesheet" href="b.css">'), utf8("b.css", '@import "a.css"; @import "a.css"; @import "a.css";'), css]);
    expect(error.kind).toBe("limit");
  });

  it("caps the number of references", async () => {
    expect(MAX_ARTIFACT_REFERENCES).toBe(2_000);
    const tiny = binary("img/a.png", [1], "image/png");
    const body = (count: number): string => "<img src='img/a.png'>".repeat(count);
    expect((await prepare([page(body(MAX_ARTIFACT_REFERENCES)), tiny])).fileCount).toBe(2);
    expect((await refusal([page(body(MAX_ARTIFACT_REFERENCES + 1)), tiny])).kind).toBe("limit");
  });
});

describe("the byte-level scan of the finished page", () => {
  it.each([
    ["attributionsrc on an image", '<img attributionsrc="https://x.example/r" src="img/a.png">'],
    ["attributionsrc on a link", '<a href="#x" attributionsrc="https://x.example/r">x</a>'],
    ["attributionsrc with a //host", '<a href="#x" attributionsrc="//x.example/r">x</a>'],
    ["attributionsrc with a path", '<a href="#x" attributionsrc="/r?x=1">x</a>'],
    ["an unknown attribute with a scheme", '<p foo="javascript:alert(1)">x</p>'],
    ["an unknown attribute with an entity-encoded scheme", '<p foo="&#104;ttps://x.example/">x</p>'],
    ["an unknown attribute with tabs inside the scheme", '<p foo="ht\ttps://x.example/">x</p>'],
    ["an unknown attribute with url()", '<svg><rect foo="url(https://x.example/a.svg#g)"/></svg>'],
    ["xml:base", '<svg xml:base="https://x.example/"><rect/></svg>'],
    ["<xmp>", "<xmp>text</xmp>"],
    ["<plaintext>", "<plaintext>text"],
    ["<noembed>", "<noembed>text</noembed>"],
    ["<svg> script, even a plain one", "<svg><script>var a = 1;</script></svg>"],
  ])("refuses %s", async (_name, body) => {
    expect((await refusal([page(body), PNG])).kind).toBe("unsupported");
  });

  it("allows attributes that carry text, even text that contains a URL", async () => {
    const prepared = await prepare([page('<p title="see https://x.example/ and //y.example" data-url="https://x.example/" aria-label="https://x.example/" id="a/b" class="https://x.example">x</p><img alt="https://x.example/" src="img/a.png"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect/></svg><div itemscope itemtype="https://schema.org/Thing">x</div>', '<meta property="og:image" content="https://x.example/p.png"><meta name="viewport" content="width=device-width">'), PNG]);
    expect(prepared.pages["index.html"]).toContain('title="see https://x.example/ and //y.example"');
  });

  it("allows a script that holds a URL as data, and a comment that holds a tag", async () => {
    const prepared = await prepare([page('<script>var homepage = "https://x.example/"; var html = \'<a href="https://x.example/">x</a>\';</script><!-- <img src="https://x.example/p.png"> --><p>x</p>')]);
    expect(prepared.pages["index.html"]).toContain('var homepage = "https://x.example/"');
  });

  // The DOM pass is blinded (the second parse of a page returns an empty document); the scan has to refuse on its own.
  it("refuses on its own, with the DOM pass reading an empty page", async () => {
    const blindedParser = (): ((html: string) => Document) => {
      let parses = 0;
      return (html) => { parses += 1; return parses % 2 === 1 ? parseHtml(html) : parseHtml("<!doctype html><p>empty</p>"); };
    };
    for (const body of ['<img attributionsrc="https://x.example/r">', '<p foo="//x.example/">x</p>', '<p style="background:u\\72l(https://x.example/p.png)">x</p>', "<xmp>t</xmp>"]) {
      await expect(prepareHtmlArtifact([page(body)], { parseHtml: blindedParser() })).rejects.toMatchObject({ kind: "unsupported" });
    }
    // And a clean page is accepted through the same wrapper.
    await expect(prepareHtmlArtifact([page("<p>clean</p>")], { parseHtml: blindedParser() })).resolves.toBeDefined();
  });
});

describe("large inlined images in style attributes", () => {
  it("are put back exactly, once, with no placeholder left", async () => {
    const image = new Uint8Array(300_000).map((_, index) => index % 251);
    const prepared = await prepare([page('<p style="background:url(img/big.png)">x</p><p style="background:url(img/big.png#a)">y</p>'), binary("img/big.png", image, "image/png")]);
    const output = prepared.pages["index.html"]!;
    const encoded = Buffer.from(image).toString("base64");
    expect(output.split(`data:image/png;base64,${encoded}`).length - 1).toBe(2);
    expect(output).not.toContain("TCPH");
    expect(output).toContain(`data:image/png;base64,${encoded}#a`);
  });

  it("are refused fast when many of them pass the cap: 120 references to a 6 MiB image", async () => {
    const before = process.memoryUsage().rss;
    const started = performance.now();
    const error = await refusal([page('<p style="background:url(big.png)">x</p>'.repeat(120)), binary("big.png", new Uint8Array(6 * 1024 * 1024), "image/png")]);
    expect(error.kind).toBe("limit");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
  });

  it("one large image in a style attribute is accepted quickly", async () => {
    const before = process.memoryUsage().rss;
    const started = performance.now();
    const prepared = await prepare([page('<p style="background:url(big.png)">x</p>'), binary("big.png", new Uint8Array(6 * 1024 * 1024), "image/png")]);
    expect(prepared.pages["index.html"]!.length).toBeGreaterThan(8 * 1024 * 1024);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
  });
});

describe("an imported stylesheet cannot reference other resources", () => {
  it("is refused, as in the Share viewer's rewriter: inline them in the page's own stylesheet instead", async () => {
    const error = await refusal([page("", '<style>@import "x.css";</style>'), utf8("x.css", "p{background:url(img/a.png)}"), PNG]);
    expect(error.kind).toBe("unsupported");
    // An import that holds only rules is fine.
    expect((await prepare([page("", '<style>@import "x.css";</style>'), utf8("x.css", "p{color:red}")])).pages["index.html"]).toContain("p{color:red}");
  });
});

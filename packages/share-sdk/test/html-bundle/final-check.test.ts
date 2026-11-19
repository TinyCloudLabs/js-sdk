// The final check on a finished page (`assertSelfContainedPage`): each class it enforces, with a fixture that must be refused
// and, where it matters, a neighbour that must pass. The matrix runs with the DOM parser blinded (it reads an empty page), so
// the byte-level scan has to refuse on its own; the rows that a DOM parser also sees run with the real parser too.
import { describe, expect, it } from "bun:test";
import { ArtifactBundleError, assertSelfContainedPage, prepareHtmlArtifact } from "../../src/html-bundle/index.js";
import { parseHtml, utf8 } from "./support.js";

const wrap = (body: string, head = ""): string => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const blind = (): Document => parseHtml("<!doctype html><p>empty</p>");

function refused(page: string, options: { blinded?: boolean } = {}): boolean {
  try {
    assertSelfContainedPage(page, { parseHtml: options.blinded === true ? blind : parseHtml });
    return false;
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactBundleError);
    expect((error as ArtifactBundleError).kind).toBe("unsupported");
    return true;
  }
}

const URL_ATTRIBUTES = [
  "attributionsrc", "ping", "background", "poster", "longdesc", "manifest", "formaction", "data", "codebase", "archive", "cite",
  "profile", "usemap", "itemtype", "itemid", "lowsrc", "dynsrc", "classid", "icon", "src", "href", "action",
];

// What a browser reads as something other than a fragment of this page.
const NOT_A_FRAGMENT: ReadonlyArray<readonly [string, string]> = [
  ["a bare relative path", "other.png"],
  ["a relative path with a query", "a/b.png?x=1"],
  ["an absolute path", "/other.png"],
  ["an https URL", "https://x.example/p.png"],
  ["a protocol-relative URL", "//x.example/p.png"],
  ["a backslash host", "\\\\x.example\\p.png"],
  ["a single backslash host form", "\\x.example/p.png"],
  ["a mixed slash host", "/\\x.example/p.png"],
  ["javascript:", "javascript:alert(1)"],
  ["an empty value", ""],
  ["a no-break space before the fragment", "&nbsp;#c"],
  ["a numeric no-break space before the fragment", "&#160;#c"],
  ["a hex no-break space before the fragment", "&#xA0;#c"],
  ["a line separator before the fragment", "&#x2028;#c"],
  ["an em space before the fragment", "&#x2003;#c"],
  ["a scheme split by a tab", "ht&Tab;tps://x.example/"],
  ["a scheme split by a newline", "ht&NewLine;tps://x.example/"],
  ["a scheme in numeric entities", "&#104;ttps://x.example/"],
  ["a data: URL that is not one the rewriter writes", "data:text/html,<p>x</p>"],
  ["a base64 data: URL without a media-type slot filled in the canonical way", "data:image/png,AAAA"],
];

describe("each pass refuses on its own", () => {
  const rows: ReadonlyArray<string> = [
    ...["src", "href", "poster", "action", "formaction", "cite", "data", "codebase", "longdesc", "usemap", "background", "manifest", "icon", "archive", "classid", "profile", "lowsrc", "dynsrc", "attributionsrc", "itemtype", "itemid"].flatMap((attribute) =>
      ["other.png", "https://x.example/p.png", "&nbsp;#c", ""].map((value) => `<img ${attribute}="${value}">`)),
    '<img srcset="other.png 1x">', '<img srcset="data:image/png;base64,AA 1x, other.png 2x">', '<link rel="preload" as="image" imagesrcset="other.png 1x">',
    '<svg><use href="&nbsp;#c"/></svg>', '<svg><use xlink:href="other.svg#a"/></svg>', '<svg><image href="other.png"/></svg>',
    '<a href="#c" ping="#c">x</a>', '<map name="m"><area href="#c" shape="rect" coords="0,0,1,1"></map>', "<noscript>x</noscript>", "<xmp>x</xmp>",
    '<p style="background:url(other.png)">x</p>', "<style>@import 'other.css';</style>",
    '<meta http-equiv="refresh" content="0;url=#c">', '<meta http-equiv="Link" content="<other.css>; rel=preload">',
  ].map((row) => (row.startsWith("<meta") ? wrap("<p>x</p>", row) : wrap(row)));

  // The byte scan cannot tell an SVG `<script>` from a page script (it skips script source); the DOM pass knows the namespace.
  it("the DOM pass refuses an SVG script", () => {
    expect(() => assertSelfContainedPage(wrap("<svg><script>1</script></svg>"), { parseHtml, only: "dom" })).toThrow(ArtifactBundleError);
  });

  it.each([["the byte scan", "bytes"], ["the DOM pass", "dom"]] as const)("%s refuses every row, with the other pass switched off", (_name, only) => {
    for (const page of rows) {
      let refusedPage = false;
      try { assertSelfContainedPage(page, { parseHtml, only }); } catch (error) { refusedPage = error instanceof ArtifactBundleError; }
      expect(refusedPage, `${only}: ${page}`).toBe(true);
    }
  });
});

describe("every URL-bearing attribute holds only data: or a fragment", () => {
  for (const attribute of URL_ATTRIBUTES) {
    it(`${attribute}: ${NOT_A_FRAGMENT.length} values that are not a fragment are refused by the byte scan alone`, () => {
      for (const [what, value] of NOT_A_FRAGMENT) {
        expect(refused(wrap(`<img ${attribute}="${value}">`), { blinded: true }), `${attribute}=${what}`).toBe(true);
      }
    });
  }

  // `ping` is refused whatever it holds (it is a beacon, not a reference).
  it.each(URL_ATTRIBUTES.filter((name) => name !== "ping"))("%s: a fragment, or the rewriter's own data: URL, passes", (attribute) => {
    for (const value of ["#c", "#", "&Tab;#c", "&NewLine;#c", " #c", "data:image/png;base64,AAAA", "data:text/css;charset=utf-8;base64,AAAA#c"]) {
      expect(refused(wrap(`<img ${attribute}="${value}">`), { blinded: true }), `${attribute}=${value}`).toBe(false);
    }
  });

  it("refuses ping with any value", () => {
    for (const value of ["#c", "data:;base64,AA", "", "https://x.example/"]) expect(refused(wrap(`<a href="#c" ping="${value}">x</a>`), { blinded: true }), value).toBe(true);
  });

  it.each([
    ["href on a link", '<a href="other.png">x</a>'],
    ["an empty href on a link", '<a href="">x</a>'],
    ["a valueless href", "<a href>x</a>"],
    ["href on svg <use>, with a no-break space", '<svg><use href="&nbsp;#c"/></svg>'],
    ["xlink:href on svg <use>, with a numeric no-break space", '<svg><use xlink:href="&#160;#c"/></svg>'],
    ["href on svg <use>, relative", '<svg><use href="other.svg#a"/></svg>'],
    ["href on svg <image>", '<svg><image href="other.png"/></svg>'],
    ["xlink:href on svg <image>", '<svg><image xlink:href="other.png"/></svg>'],
    ["href on svg <feImage>", '<svg><filter id="f"><feImage href="other.png"/></filter></svg>'],
    ["href on svg <mpath>", '<svg><animateMotion><mpath href="other.svg#p"/></animateMotion></svg>'],
    ["href on a mathml element", '<math><mi href="other.png">x</mi></math>'],
    ["srcset with a relative candidate", '<img srcset="other.png 1x">'],
    ["srcset with one good and one relative candidate", '<img srcset="data:image/png;base64,AA 1x, other.png 2x">'],
    ["imagesrcset on a link", '<link rel="preload" as="image" imagesrcset="other.png 1x">'],
    ["ping", '<a href="#c" ping="other">x</a>'],
    ["area href", '<map name="m"><area href="#c" shape="rect" coords="0,0,1,1"></map>'],
  ])("refuses %s", (_name, body) => {
    expect(refused(wrap(body), { blinded: true })).toBe(true);
    // The DOM pass reads the same fixtures.
    expect(refused(wrap(body))).toBe(true);
  });

  it("passes fragments that a browser does read as fragments, whitespace and entities included", () => {
    for (const body of ['<svg><use href="#c"/></svg>', '<svg><use href="&Tab;#c"/></svg>', '<svg><use href="&NewLine;#c"/></svg>', '<svg><use xlink:href=" #c"/></svg>', '<a href="#top">t</a>', '<a href="#">t</a>', '<a href="#/route">r</a>']) {
      expect(refused(wrap(body), { blinded: true }), body).toBe(false);
      expect(refused(wrap(body)), body).toBe(false);
    }
  });
});

describe("attributes outside the allow-list that read as URLs", () => {
  it.each([
    ["attributionsrc with a backslash host", '<a href="#c" attributionsrc="\\\\x.example/r">x</a>'],
    ["an unknown attribute with a backslash host", '<p foo="\\\\x.example/r">x</p>'],
    ["an unknown attribute with a scheme", '<p foo="https://x.example/">x</p>'],
    ["an unknown attribute with //host", '<p foo="//x.example/">x</p>'],
    ["an unknown attribute with a path", '<p foo="/x/y">x</p>'],
    ["an unknown attribute with an entity-encoded scheme", '<p foo="&#x68;ttps://x.example/">x</p>'],
  ])("refuses %s", (_name, body) => {
    expect(refused(wrap(body), { blinded: true })).toBe(true);
  });

  it("allows the text attributes to hold anything", () => {
    expect(refused(wrap('<p title="https://x.example/" alt="//y" data-u="\\\\z" aria-label="javascript:1">x</p>'), { blinded: true })).toBe(false);
  });
});

describe("CSS in the finished page", () => {
  it.each([
    ["url() with a relative path in style=", '<p style="background:url(other.png)">x</p>'],
    ["url() with a no-break space before a fragment in style=", '<p style="background:url(&nbsp;#c)">x</p>'],
    ["url() with a no-break space before a fragment in <style>", "<style>p{background:url(\u00a0#c)}</style>"],
    ["url() with a quoted no-break space fragment", '<style>p{background:url("\u00a0#c")}</style>'],
    ["image-set() in <style>", '<style>p{background:image-set("other.png" 1x)}</style>'],
    ["-webkit-image-set() in style=", '<p style="background:-webkit-image-set(url(#c) 1x)">x</p>'],
    ["src() in <style>", '<style>p{background:src("other.png")}</style>'],
    ["@import in <style>", '<style>@import "other.css";</style>'],
    ["@import url() in <style>", "<style>@import url(other.css);</style>"],
    ["an escaped url()", '<style>p{background:u\\72l(other.png)}</style>'],
    ["svg fill with a relative url()", '<svg><rect fill="url(other.svg#g)"/></svg>'],
  ])("refuses %s", (_name, body) => {
    expect(refused(wrap(body), { blinded: true })).toBe(true);
  });

  it("passes url() of a fragment or of the rewriter's data: URL", () => {
    expect(refused(wrap('<style>p{background:url("data:image/png;base64,AAAA")} q{fill:url(#g)}</style><svg><rect fill="url(#g)"/></svg>'), { blinded: true })).toBe(false);
  });
});

describe("<meta http-equiv>", () => {
  const OWN = (page: string): string => page; // the rewriter's own policy comes out of prepareHtmlArtifact below
  it.each([
    ["refresh", '<meta http-equiv="refresh" content="0;url=https://x.example/">'],
    ["refresh to a relative path", '<meta http-equiv="Refresh" content="0;url=other.html">'],
    ["Link, which acts as a Link header", '<meta http-equiv="Link" content="<https://x.example/p.css>; rel=preload; as=style">'],
    ["Link to a relative preload", '<meta http-equiv="link" content="<other.css>; rel=preload">'],
    ["an author Content-Security-Policy", '<meta http-equiv="Content-Security-Policy" content="default-src *">'],
    ["Set-Cookie", '<meta http-equiv="set-cookie" content="a=b">'],
    ["Default-Style", '<meta http-equiv="default-style" content="x">'],
    ["X-UA-Compatible", '<meta http-equiv="X-UA-Compatible" content="IE=edge">'],
    ["Content-Type", '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'],
    ["a valueless http-equiv", "<meta http-equiv>"],
    ["an entity-encoded name", '<meta http-equiv="&#114;efresh" content="0;url=https://x.example/">'],
  ])("refuses %s", (_name, meta) => {
    expect(refused(wrap("<p>x</p>", meta), { blinded: true })).toBe(true);
    expect(refused(wrap("<p>x</p>", meta))).toBe(true);
    expect(refused(wrap("<p>x</p>", OWN(meta)), { blinded: true })).toBe(true);
  });

  it("drops every author http-equiv meta when it rewrites, and keeps only its own policy", async () => {
    const source = wrap("<p>x</p>", [
      '<meta http-equiv="refresh" content="0;url=https://x.example/">',
      '<meta http-equiv="Link" content="<https://x.example/p.css>; rel=preload">',
      '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
      '<meta http-equiv="Content-Security-Policy" content="default-src *">',
      '<meta name="viewport" content="width=device-width">',
    ].join(""));
    const prepared = await prepareHtmlArtifact([utf8("index.html", source)], { parseHtml });
    const output = prepared.pages["index.html"]!;
    expect(output.match(/http-equiv/gi)).toHaveLength(1);
    expect(output).toContain("default-src 'none'");
    expect(output).toContain('name="viewport"');
    expect(output).not.toMatch(/refresh|rel=preload|IE=edge|default-src \*/);
    // The page it wrote passes the final check, and its own policy is the one meta that does.
    expect(() => assertSelfContainedPage(output, { parseHtml })).not.toThrow();
    // Any change to that policy does not.
    expect(refused(output.replace("default-src 'none'", "default-src *"), { blinded: true })).toBe(true);
    expect(refused(output.replace("<meta ", '<meta http-equiv="refresh" content="0;url=#c"><meta '), { blinded: true })).toBe(true);
  });
});

describe("the check reads a page the way a browser does", () => {
  it("does not trust a parser: refusals come from the byte scan when the DOM pass is blinded", () => {
    expect(refused(wrap('<img attributionsrc="other.png">'), { blinded: true })).toBe(true);
    expect(refused(wrap('<img attributionsrc="other.png">'))).toBe(true);
  });

  it("passes a plain finished page", () => {
    expect(refused(wrap('<h1 id="t">Hi</h1><img alt="x" src="data:image/png;base64,AAAA"><a href="#t">top</a>', "<title>t</title>"), { blinded: true })).toBe(false);
  });
});

describe("a reference that starts with Unicode whitespace is a path, not a fragment, when the page is rewritten", () => {
  it.each(["&nbsp;#x", "&#xA0;#x", "&#x2003;#x"])("%s", async (value) => {
    const page = wrap(`<img src="${value}">`);
    await expect(prepareHtmlArtifact([utf8("index.html", page)], { parseHtml })).rejects.toMatchObject({ kind: "missing" });
    await expect(prepareHtmlArtifact([utf8("index.html", wrap(`<svg><use href="${value}"/></svg>`))], { parseHtml })).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("while a tab or a newline before the fragment is only stripped, as a browser strips it", async () => {
    const prepared = await prepareHtmlArtifact([utf8("index.html", wrap('<svg><use href="&Tab;#c"/></svg><a href="#c">x</a>'))], { parseHtml });
    expect(prepared.fileCount).toBe(1);
  });
});

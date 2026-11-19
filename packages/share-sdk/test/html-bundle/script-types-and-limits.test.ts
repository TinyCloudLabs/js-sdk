// Script types that are data blocks, the comment and attribute limits, and names that end only at HTML whitespace.
import { describe, expect, it } from "bun:test";
import {
  ArtifactBundleError,
  MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT,
  MAX_ARTIFACT_COMMENTS,
  assertSelfContainedPage,
  prepareHtmlArtifact,
  type ArtifactFile,
} from "../../src/html-bundle/index.js";
import { parseHtml, utf8 } from "./support.js";

const wrap = (body: string, head = ""): string => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const prepare = (files: readonly ArtifactFile[]) => prepareHtmlArtifact(files, { parseHtml });

async function rewriterRefusal(page: string): Promise<ArtifactBundleError> {
  try {
    await prepare([utf8("index.html", page)]);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactBundleError);
    return error as ArtifactBundleError;
  }
  throw new Error("the page was accepted");
}

function finalRefusal(page: string, only?: "bytes" | "dom"): ArtifactBundleError | undefined {
  try {
    assertSelfContainedPage(page, { parseHtml, ...(only === undefined ? {} : { only }) });
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactBundleError);
    return error as ArtifactBundleError;
  }
  return undefined;
}

describe("script types that are not JavaScript", () => {
  const SPECULATION = '<script type="speculationrules">{"prefetch":[{"source":"list","urls":["https://x.example/top"]}],"prerender":[{"source":"list","urls":["https://x.example/top-pr"]}]}</script>';
  it.each([
    ["speculationrules", SPECULATION],
    ["speculationrules in capitals", SPECULATION.replace("speculationrules", "SpeculationRules")],
    ["importmap", '<script type="importmap">{"imports":{"a":"https://x.example/a.js"}}</script>'],
    ["webbundle", '<script type="webbundle">{"source":"https://x.example/b.wbn"}</script>'],
    ["JSON", '<script type="application/json">{"a":1}</script>'],
    ["a template", '<script type="text/template"><p>{{x}}</p></script>'],
    ["plain text", '<script type="text/plain">x</script>'],
    ["a JavaScript name with another suffix", '<script type="text/javascriptx">1</script>'],
  ])("the rewriter refuses %s", async (_name, body) => {
    const error = await rewriterRefusal(wrap(body));
    expect(error.kind).toBe("unsupported");
    // The rewriter's own refusal, not the final check's (`output holds`).
    expect(error.message).toBe("artifact uses a script type that is not JavaScript");
  });

  it.each([
    ["speculationrules", SPECULATION],
    ["importmap", '<script type="importmap">{"imports":{}}</script>'],
    ["JSON", '<script type="application/json">{}</script>'],
  ])("the final check refuses %s in each pass alone", (_name, body) => {
    for (const only of [undefined, "bytes", "dom"] as const) {
      expect(finalRefusal(wrap(body), only)?.kind, String(only)).toBe("unsupported");
    }
    // In the head too.
    expect(finalRefusal(wrap("<p>x</p>", body), "bytes")?.kind).toBe("unsupported");
    expect(finalRefusal(wrap("<p>x</p>", body), "dom")?.kind).toBe("unsupported");
  });

  it("accepts a script with no type, an empty type or a JavaScript type", async () => {
    for (const attribute of ["", ' type=""', ' type="text/javascript"', ' type="TEXT/JavaScript; charset=utf-8"', ' type="application/javascript"', ' type=" text/ecmascript "']) {
      const prepared = await prepare([utf8("index.html", wrap(`<script${attribute}>var a = 1;</script>`))]);
      expect(prepared.pages["index.html"], attribute).toContain("var a = 1;");
    }
  });
});

describe("comment and attribute limits", () => {
  const comments = (count: number): string => "<!--x-->".repeat(count);
  const attributes = (count: number): string => Array.from({ length: count }, (_, index) => `data-a${index}="1"`).join(" ");

  it("accepts the largest page it takes and refuses one more comment, without parsing it", async () => {
    expect(MAX_ARTIFACT_COMMENTS).toBe(20_000);
    const accepted = await prepare([utf8("index.html", wrap(`${comments(MAX_ARTIFACT_COMMENTS)}<p>x</p>`))]);
    expect(accepted.fileCount).toBe(1);
    const started = performance.now();
    const error = await rewriterRefusal(wrap(`${comments(MAX_ARTIFACT_COMMENTS + 1)}<p>x</p>`));
    expect(error).toMatchObject({ kind: "limit" });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses a page of very many comments quickly", async () => {
    const started = performance.now();
    const error = await rewriterRefusal(wrap(comments(200_000)));
    expect(error.kind).toBe("limit");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("counts doctypes and bogus comments as comments", async () => {
    expect((await rewriterRefusal(wrap("<?x>".repeat(MAX_ARTIFACT_COMMENTS + 1)))).kind).toBe("limit");
    expect((await rewriterRefusal(wrap("<!x>".repeat(MAX_ARTIFACT_COMMENTS + 1)))).kind).toBe("limit");
  });

  it("scans the comments of a finished page in one pass", () => {
    const started = performance.now();
    expect(finalRefusal(wrap(comments(MAX_ARTIFACT_COMMENTS)), "bytes")).toBeUndefined();
    expect(finalRefusal(wrap(comments(MAX_ARTIFACT_COMMENTS + 1)), "bytes")?.kind).toBe("limit");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("accepts the most attributes on an element it takes and refuses one more", async () => {
    expect(MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT).toBe(5_000);
    const accepted = await prepare([utf8("index.html", wrap(`<p ${attributes(MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT)}>x</p>`))]);
    expect(accepted.fileCount).toBe(1);
    const started = performance.now();
    const error = await rewriterRefusal(wrap(`<p ${attributes(MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT + 1)}>x</p>`));
    expect(error.kind).toBe("limit");
    expect(performance.now() - started).toBeLessThan(500);
    expect(finalRefusal(wrap(`<p ${attributes(MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT + 1)}>x</p>`), "bytes")?.kind).toBe("limit");
  });

  it("refuses a page of 200,000 attributes before the DOM parser sees it", async () => {
    const started = performance.now();
    const error = await rewriterRefusal(wrap(`<p ${attributes(200_000)}>x</p>`));
    expect(error.kind).toBe("limit");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("counts per element: many elements with few attributes pass", async () => {
    const prepared = await prepare([utf8("index.html", wrap(Array.from({ length: 2_000 }, () => '<p class="a" id="b" title="c">x</p>').join("")))]);
    expect(prepared.fileCount).toBe(1);
  });
});

describe("names end only at HTML whitespace", () => {
  // The fixture from the review: a browser reads one element named `p<nbsp>a<nbsp>=` with attributes `"q="k="` and `foo`.
  const DESYNC = '<p\u00a0a\u00a0= "q="k=" foo="https://other.example/x">x</p>';

  it("refuses a tag name with U+00A0 in the rewriter and in each pass of the final check", async () => {
    expect((await rewriterRefusal(wrap(DESYNC))).kind).toBe("unsupported");
    expect(finalRefusal(wrap(DESYNC), "bytes")?.kind).toBe("unsupported");
    expect(finalRefusal(wrap(DESYNC), "dom")?.kind).toBe("unsupported");
  });

  it("the byte scan reads the attribute after a U+00A0 as a browser does, and so refuses its URL", () => {
    // No odd character in the tag name: the attribute value that holds a URL is the only thing to find.
    expect(finalRefusal(wrap('<p a\u00a0b foo="https://other.example/x">x</p>'), "bytes")?.kind).toBe("unsupported");
    expect(finalRefusal(wrap('<p a="1"\u00a0foo="https://other.example/x">x</p>'), "bytes")?.kind).toBe("unsupported");
    expect(finalRefusal(wrap('<p a=\u00a0"q" foo="https://other.example/x">x</p>'), "bytes")?.kind).toBe("unsupported");
  });

  it.each(["\u00a0", "\u2003", "\u200b", "\u2028", "\ufeff", "\u3000"])("refuses a tag name that contains U+%s", (character) => {
    expect(finalRefusal(wrap(`<p${character}x>y</p>`), "bytes")?.kind).toBe("unsupported");
  });

  it("the DOM pass applies the URL-shape check to attributes it does not know", () => {
    for (const page of [wrap('<p foo="https://x.example/">x</p>'), wrap('<p foo="//x.example/">x</p>'), wrap('<p foo="\\\\x.example/x">x</p>')]) {
      expect(finalRefusal(page, "dom")?.kind).toBe("unsupported");
    }
    expect(finalRefusal(wrap('<p title="https://x.example/" data-u="//x" aria-label="/a/b">x</p>'), "dom")).toBeUndefined();
  });

  it("a page whose names are all ASCII passes as before", async () => {
    const prepared = await prepare([utf8("index.html", wrap('<main class="a"><h1 id="t">Hi</h1><custom-element data-x="1">y</custom-element></main>'))]);
    expect(prepared.pages["index.html"]).toContain("custom-element");
  });
});

describe("SVG animation of a link", () => {
  it("the final check refuses a <set> or <animate> that writes href, in each pass", () => {
    for (const body of [
      '<svg><a href="#x"><set attributeName="href" to="other.svg#x"/><text>x</text></a></svg>',
      '<svg><a href="#x"><animate attributeName="xlink:href" values="other.svg#x"/><text>x</text></a></svg>',
    ]) {
      expect(finalRefusal(wrap(body), "bytes")?.kind, body).toBe("unsupported");
      expect(finalRefusal(wrap(body), "dom")?.kind, body).toBe("unsupported");
    }
    expect(finalRefusal(wrap('<svg><rect><set attributeName="fill" to="red"/></rect></svg>'))).toBeUndefined();
  });
});

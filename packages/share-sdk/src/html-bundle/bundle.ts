import { hasUnsafeFilenameCodePoint } from "../filename-policy.js";

export const ARTIFACT_ENTRY = "index.html";
export const MAX_ARTIFACT_FILES = 1_000;
export const MAX_ARTIFACT_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_ARTIFACT_RENDER_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACT_REFERENCES = 2_000;
export const MAX_ARTIFACT_CSS_IMPORT_DEPTH = 16;
/** Comments in one page, and attributes on one element: a page over either is refused before it is parsed (`limit`). */
export const MAX_ARTIFACT_COMMENTS = 20_000;
export const MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT = 5_000;

export type ArtifactFailureKind = "malformed" | "missing" | "unsupported" | "limit";

export class ArtifactBundleError extends Error {
  /**
   * `path` is the bundle file being processed when the refusal happened; `reference` is the reference text inside it
   * that was refused, when there is one. Both are the folder's own text: print them through a terminal-safe printer.
   */
  constructor(readonly kind: ArtifactFailureKind, message: string, readonly path?: string, readonly reference?: string) {
    super(message);
    this.name = "ArtifactBundleError";
  }
}

/** Options of `prepareHtmlArtifact`. */
export interface PrepareHtmlArtifactOptions {
  /**
   * Parses one HTML document with the HTML5 tree-building algorithm. Defaults to the browser's `DOMParser`; a Node
   * caller passes a spec-compliant parser (the CLI uses jsdom, which is built on parse5), so the rewriter sees the same
   * tree a browser builds.
   */
  readonly parseHtml?: (html: string) => Document;
  /**
   * Transform only the root `index.html` and refuse a link that points at another page. The result is one
   * self-contained document with no pages to navigate between.
   */
  readonly singlePage?: boolean;
}

export interface ArtifactFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface PreparedArtifact {
  readonly entry: string;
  readonly pages: Readonly<Record<string, string>>;
  readonly fileCount: number;
  readonly sourceBytes: number;
}

export type ArtifactDetection =
  | { readonly kind: "html"; readonly entry: typeof ARTIFACT_ENTRY }
  | { readonly kind: "folder"; readonly reason: "missing-root-index" };

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html;charset=utf-8",
  htm: "text/html;charset=utf-8",
  css: "text/css;charset=utf-8",
  js: "text/javascript;charset=utf-8",
  json: "application/json;charset=utf-8",
  txt: "text/plain;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
});

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ENCODED_PATH_ALIAS = /%2f|%5c|%2e/i;
const SAFE_MEDIA_QUERY = /^[a-z0-9\s,().:%\-+/]+$/i;
const UNSAFE_CLASSIC_SCRIPT =
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|importScripts|sendBeacon)\s*\(|\b(?:window|self|globalThis|top|parent|opener)\s*\.\s*open\s*\(|\b(?:window|document|globalThis|self|top|parent|opener)\s*(?:\.\s*location|\[\s*["']location["']\s*\])|\blocation\s*(?:=|(?:\.\s*|\[\s*["'])href(?:["']\s*\])?|\.assign\s*\(|\.replace\s*\(|\.reload\s*\()|\bimport\s*\(|\beval\s*\(|\bWebAssembly\b/;

function fail(kind: ArtifactFailureKind, detail: string): never {
  throw new ArtifactBundleError(kind, detail);
}

function defaultParseHtml(html: string): Document {
  if (typeof DOMParser === "undefined") {
    throw new TypeError("html-bundle needs a DOM parser: pass parseHtml outside a browser");
  }
  return new DOMParser().parseFromString(html, "text/html");
}

export function canonicalArtifactPath(input: string): string {
  const value = input.normalize("NFC");
  const encodedLength = new TextEncoder().encode(value).byteLength;
  if (
    value.length === 0
    || encodedLength > 4_096
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || hasUnsafeFilenameCodePoint(value)
    || ENCODED_PATH_ALIAS.test(value)
  ) {
    fail("malformed", "artifact path is not canonical");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || new TextEncoder().encode(segment).byteLength > 255)) {
    fail("malformed", "artifact path is not canonical");
  }
  return segments.join("/");
}

export function artifactMediaType(path: string, supplied?: string): string {
  const normalized = supplied?.split(";")[0]?.trim().toLowerCase();
  if (normalized !== undefined && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    return supplied!.trim();
  }
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

interface ResolvedReference {
  readonly path: string;
  readonly fragment: string;
  readonly fragmentOnly: boolean;
}

export function resolveArtifactReference(basePath: string, reference: string): ResolvedReference {
  // As a URL parser trims: controls and space only. `String.trim` also strips U+00A0 and other Unicode whitespace, which a
  // browser keeps as part of a relative URL (so `&nbsp;#c` is a path, not a fragment).
  const raw = trimUrl(reference);
  if (raw.length === 0) return { path: canonicalArtifactPath(basePath), fragment: "", fragmentOnly: true };
  if (raw.startsWith("#")) {
    return { path: canonicalArtifactPath(basePath), fragment: raw, fragmentOnly: true };
  }
  if (raw.startsWith("//") || raw.startsWith("/") || SCHEME.test(raw)) {
    fail("unsupported", "external artifact reference");
  }
  const hashAt = raw.indexOf("#");
  const queryAt = raw.indexOf("?");
  const end = [hashAt, queryAt].filter((value) => value >= 0).reduce((min, value) => Math.min(min, value), raw.length);
  const pathname = raw.slice(0, end);
  const fragment = hashAt >= 0 ? raw.slice(hashAt) : "";
  if (pathname.length === 0) return { path: canonicalArtifactPath(basePath), fragment, fragmentOnly: true };
  if (pathname.includes("\\") || hasUnsafeFilenameCodePoint(pathname) || ENCODED_PATH_ALIAS.test(pathname)) {
    fail("malformed", "artifact reference is not canonical");
  }
  const output = basePath.split("/").slice(0, -1);
  for (const segment of pathname.normalize("NFC").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (output.length === 0) fail("malformed", "artifact reference escapes its bundle");
      output.pop();
      continue;
    }
    output.push(segment);
  }
  return { path: canonicalArtifactPath(output.join("/")), fragment, fragmentOnly: false };
}

export function detectHtmlArtifact(paths: readonly string[]): ArtifactDetection {
  const seen = new Set<string>();
  let rootCount = 0;
  for (const rawPath of paths) {
    const path = canonicalArtifactPath(rawPath);
    const key = path.toLowerCase();
    if (seen.has(key)) fail("malformed", "artifact paths collide after canonicalization");
    seen.add(key);
    if (path === ARTIFACT_ENTRY) rootCount += 1;
  }
  if (rootCount === 1) return { kind: "html", entry: ARTIFACT_ENTRY };
  return { kind: "folder", reason: "missing-root-index" };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * Every use of a resource adds to one running total, checked BEFORE the encoded copy is built, so a page that refers to one
 * large file many times is refused at the reference that passes the render cap instead of after it has been built.
 */
function chargeInlinedBytes(context: TransformContext, bytes: number): void {
  context.counter.inlinedBytes += bytes;
  if (context.counter.inlinedBytes > MAX_ARTIFACT_RENDER_BYTES) fail("limit", "artifact inlined resources exceed the render limit");
}

function asDataUrl(file: ArtifactFile, context: TransformContext): string {
  if (file.bytes.byteLength > MAX_ARTIFACT_RENDER_BYTES) fail("limit", "artifact resource exceeds render limit");
  const prefix = `data:${artifactMediaType(file.path, file.mediaType)};base64,`;
  chargeInlinedBytes(context, prefix.length + 4 * Math.ceil(file.bytes.byteLength / 3));
  return `${prefix}${toBase64(file.bytes)}`;
}

function decodeText(file: ArtifactFile, context?: TransformContext): string {
  if (file.bytes.byteLength > MAX_ARTIFACT_TEXT_BYTES) fail("limit", "artifact text file exceeds render limit");
  if (context !== undefined) chargeInlinedBytes(context, file.bytes.byteLength);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return fail("malformed", "artifact text is not utf-8");
  }
}

function assertClassicScript(source: string): void {
  if (UNSAFE_CLASSIC_SCRIPT.test(source)) fail("unsupported", "artifact script uses a blocked browser capability");
}

function normalizeMediaQuery(media: string | null | undefined, detail = "artifact uses an unsupported stylesheet media query"): string | null {
  const value = media?.trim() ?? "";
  if (value.length === 0 || value.toLowerCase() === "all") return null;
  if (/[\u0000-\u001f\u007f<>{};"'`\\]/.test(value) || !SAFE_MEDIA_QUERY.test(value)) fail("unsupported", detail);
  return value;
}

function wrapMediaCss(source: string, media: string | null | undefined, detail?: string): string {
  const value = normalizeMediaQuery(media, detail);
  if (value === null) return source;
  return `@media ${value} {\n${source}\n}`;
}

function classifyLinkRelation(rel: string | null): "stylesheet" | "icon" | null {
  const tokens = (rel?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []);
  if (tokens.length === 0) return null;
  const tokenSet = new Set(tokens);
  if (tokenSet.has("stylesheet") && [...tokenSet].every((token) => token === "stylesheet" || token === "alternate")) return "stylesheet";
  if ((tokenSet.has("icon") || tokenSet.has("apple-touch-icon")) && [...tokenSet].every((token) => token === "icon" || token === "apple-touch-icon" || token === "shortcut")) return "icon";
  return null;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The document and the content of every `<template>` in it (nested ones too). `querySelectorAll` does not enter template
 * content, but a browser clones it into the live page and a declarative shadow root (`shadowrootmode`) attaches it while
 * parsing, so it is examined and rewritten like the rest of the page.
 */
function documentRoots(doc: Document): ParentNode[] {
  const roots: ParentNode[] = [doc];
  for (let index = 0; index < roots.length; index += 1) {
    for (const template of roots[index]!.querySelectorAll<HTMLTemplateElement>("template")) roots.push(template.content);
  }
  return roots;
}

function queryAll<T extends Element = Element>(roots: readonly ParentNode[], selector: string): T[] {
  return roots.flatMap((root) => [...root.querySelectorAll<T>(selector)]);
}

/**
 * Attributes whose value is a URL (or a list of them) that a browser may fetch or navigate to, or that names a resource:
 * the HTML attributes that do (`src`, `href`, `srcset`, `imagesrcset`, `poster`, `action`, `formaction`, `ping`,
 * `background`, `cite`, `data`, `codebase`, `archive`, `classid`, `profile`, `longdesc`, `usemap`, `manifest`, `icon`,
 * `lowsrc`, `dynsrc`, `itemtype`, `itemid`), the Attribution Reporting `attributionsrc`, and `xlink:href` (matched by its
 * local name, like `href` on SVG `<use>`, `<image>`, `<feImage>`, `<mpath>` and MathML). In the finished page each must be
 * a `data:` URL the rewriter wrote or a `#fragment`.
 */
const URL_ATTRIBUTES = new Set([
  "href", "src", "srcset", "imagesrcset", "poster", "action", "formaction", "cite", "data", "codebase", "longdesc", "usemap",
  "ping", "background", "manifest", "icon", "archive", "classid", "profile", "lowsrc", "dynsrc", "attributionsrc", "itemtype", "itemid",
]);

/**
 * A URL parser trims leading and trailing C0 controls and spaces and only those: not U+00A0, not Unicode whitespace
 * (`String.prototype.trim` strips both, which would turn `&nbsp;#c` into a fragment). Tabs and newlines inside are removed.
 */
function trimUrl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

function urlText(value: string): string {
  return trimUrl(value).replace(/[\t\n\r]/g, "");
}

/** A same-document fragment: `#` and then printable characters (no control, no space, no backslash). */
function isFragmentOnly(trimmed: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^#[^\u0000-\u0020\u007f-\u009f\\]*$/.test(trimmed);
}

/** The shape of every `data:` URL the rewriter writes (once cut down by `withoutDataUris`), with an optional fragment. */
// The comma is optional because a `srcset` list is split on commas, which strips the one that ends `data:;base64,`.
const INLINE_DATA_URL = /^data:;base64(?:,[A-Za-z0-9+/=]*)?(?:#[^\u0000-\u0020\\]*)?$/;

/**
 * `data:` and `#fragment` are the only references the finished page may hold. Anything else is refused: a relative path
 * such as `other.png` resolves against the viewer's origin, and an empty value names the page itself.
 */
function isInlineReference(value: string): boolean {
  const text = urlText(value);
  return isFragmentOnly(text) || INLINE_DATA_URL.test(text);
}

function assertInlineSrcset(value: string): void {
  // The list is split on ASCII whitespace, as a browser splits it.
  for (const raw of value.split(/[\t\n\f\r ]+/)) {
    const token = raw.replace(/,+$/, "");
    if (token === "" || /^\d+(?:\.\d+)?[wx]$/i.test(token)) continue;
    if (!isInlineReference(token)) throw new ArtifactBundleError("unsupported", "artifact page still references a resource", undefined, token);
  }
}

/**
 * The values of a `<script type>` that name JavaScript (the HTML spec's JavaScript MIME type essences). Any other type makes
 * the element a data block that the browser or a script reads, not a script that runs: `speculationrules` (a list of URLs
 * the browser prefetches or prerenders), `importmap`, `webbundle`, templates, JSON. A page of this kind has no use for them,
 * so each is refused. `module` is refused separately.
 */
const JAVASCRIPT_TYPES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript", "text/ecmascript",
  "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2", "text/javascript1.3", "text/javascript1.4",
  "text/javascript1.5", "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript",
]);

/** An absent or empty `type`, or a JavaScript MIME type (parameters such as `;charset=utf-8` are not part of the type). */
function isJavaScriptType(value: string | null | undefined): boolean {
  const type = (value ?? "").replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
  if (type === "") return true;
  return JAVASCRIPT_TYPES.has(type.split(";")[0]!.replace(/[\t\n\f\r ]+$/g, ""));
}

const BLOCKED_ELEMENTS = "base, form, iframe, frame, frameset, object, embed, portal, noscript, plaintext, xmp, noembed, noframes, applet, area[href], link:not([href]), [ping]";

/**
 * The `data:` URLs the rewriter wrote, cut down to `data:;base64,`. They are the only large things in a finished page and
 * the only references it may hold, so the checks below read the page without them: parsing a multi-megabyte `style=`
 * value is what costs memory and time, and their content is base64 that no check looks at. Only text of the exact shape
 * `data:<type>;base64,<base64 characters>` is cut, so nothing that could carry markup or a URL is hidden.
 */
const DATA_URI = /data:[a-z0-9!#$&^_.+/-]*(?:;[a-z0-9!#$&^_.+=-]+)*;base64,[A-Za-z0-9+/=]*/gi;

function withoutDataUris(html: string): string {
  return html.replace(DATA_URI, "data:;base64,");
}

/** Attributes that carry text, not a URL a browser fetches or follows. Every other attribute may not look like a URL. */
const TEXT_ATTRIBUTES = /^(?:alt|title|placeholder|value|label|content|name|id|class|lang|summary|abbr|datetime|pattern|xmlns(?::[\w.-]+)?|aria-[\w.:-]*|data-[\w.:-]*)$/;

/** Text that a browser would take for a URL to fetch or follow: a network or script scheme, a `//host`, or a path. */
function looksLikeUrl(raw: string): boolean {
  // A browser reads a backslash as a slash in the URLs of the special schemes (`\\host/x` is `//host/x`).
  const value = raw.replace(/\\/g, "/");
  return /(?:^|[^a-z0-9+.-])(?:https?|ftps?|wss?|file|javascript|vbscript|blob|about|view-source|filesystem):/i.test(value)
    || /(?:^|[\s,;(="'])\/\/\S/.test(value)
    || /:\/\//.test(value)
    || /^\s*\.{0,2}\/[^\s]/.test(value);
}

const NAMED_CHARACTERS: Readonly<Record<string, string>> = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0", colon: ":", sol: "/", bsol: "\\", period: ".", comma: ",", semi: ";",
  equals: "=", num: "#", quest: "?", lpar: "(", rpar: ")", tab: "\t", newline: "\n",
};

/** The character references a page may still hold in an attribute value, decoded the way a browser decodes them. */
function decodeAttributeValue(value: string): string {
  return value.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z]{2,8}));?/g, (whole, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_CHARACTERS[name.toLowerCase()] ?? whole;
    const point = Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\ufffd";
  });
}

const MARKUP_BLOCKED_NAMES = new Set(["base", "form", "iframe", "frame", "frameset", "object", "embed", "portal", "noscript", "plaintext", "xmp", "noembed", "noframes", "applet"]);

function unsupportedOutput(detail: string, reference?: string): never {
  throw new ArtifactBundleError("unsupported", detail, undefined, reference);
}

/** An SVG animation element (`<set>`, `<animate>`, ...) whose `attributeName` is `href` or `xlink:href`: it writes a URL into the page. */
function isHrefAnimation(tag: string, attributeName: string, value: string): boolean {
  return /^(?:animate|set|animatetransform|animatemotion)$/i.test(tag) && attributeName.toLowerCase() === "attributename" && /^(?:xlink:)?href$/i.test(trimUrl(value));
}

function checkAttribute(name: string, decoded: string): void {
  const local = name.slice(name.lastIndexOf(":") + 1);
  if (/^on/.test(name)) unsupportedOutput("artifact output contains a blocked html feature");
  if (name === "style") {
    assertOnlyInlineCssReferences(decoded);
    return;
  }
  if (local === "srcset" || local === "imagesrcset") {
    assertInlineSrcset(decoded);
    return;
  }
  if (URL_ATTRIBUTES.has(local)) {
    if (!isInlineReference(decoded)) unsupportedOutput("artifact page still references a resource", decoded);
    return;
  }
  if (TEXT_ATTRIBUTES.test(name)) return;
  // Any other attribute: a name no list here knows may still be one a browser fetches, so a value that reads as a URL is
  // refused whatever the name is.
  if (looksLikeUrl(urlText(decoded))) unsupportedOutput("artifact page still references a resource", decoded);
  // CSS in an attribute that is not `style` (an SVG presentation attribute, for one): the same checks, escapes included.
  if (/url\s*\(|image-set|@import|\\/i.test(decoded) || /(?:^|[^\w-])src\s*\(/i.test(decoded)) assertOnlyInlineCssReferences(decoded);
}

/**
 * The only `<meta http-equiv>` a finished page may hold is the rewriter's own Content-Security-Policy. Every other one
 * either acts like a response header (`refresh`, `Link`, `Set-Cookie`, `Default-Style`, `Content-Security-Policy` of the
 * author) or is not needed in a page that is already one UTF-8 document, so the rewriter drops them all.
 */
function isOwnPolicyMeta(httpEquiv: string, content: string | null): boolean {
  return httpEquiv.trim().toLowerCase() === "content-security-policy" && content === INNER_CSP;
}

/** HTML's whitespace: space, tab, newline, form feed, carriage return. A tag or attribute name never ends at U+00A0 or other Unicode whitespace. */
const HTML_SPACE = "\\t\\n\\f\\r ";
const TAG_NAME = new RegExp(`[^${HTML_SPACE}/>]*`, "y");
const ATTRIBUTE_NAME = new RegExp(`=?[^${HTML_SPACE}/>=]*`, "y");
const UNQUOTED_VALUE = new RegExp(`[^${HTML_SPACE}>]*`, "y");
const SKIPPED = new RegExp(`[${HTML_SPACE}/]`);
const SPACE = new RegExp(`[${HTML_SPACE}]`);
/** Unicode whitespace and invisible characters that are never part of a tag name a page means. */
const ODD_TAG_NAME = /[\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/;
const COMMENT_END = /--!?>/g;
const SCRIPT_END = /<\/script/gi;
const STYLE_END = /<\/style/gi;

interface ScanOptions {
  /**
   * `true` (a finished page): every reference is checked and a malformed tag is refused. `false` (a source page, before it
   * is parsed): only the comment and attribute limits are enforced, and a malformed tag ends the scan.
   */
  readonly references: boolean;
}

/**
 * A scan of a page's text that shares nothing with the DOM parser: it finds the tags and attributes itself, so a difference
 * in how a parser reads some markup (jsdom against a browser) cannot hide a reference from both checks. Scripts are the
 * author's code and are skipped (a script may hold the text `https://` as data; what scripts may do is the sandbox's and the
 * CSP's job, with the capability scan on their source); `<style>` text is checked as CSS and then read as markup like
 * everything else, so nothing after a `<` is ever skipped except a script's source and a comment. A tag found in text that
 * is really not one (inside an `<xmp>` or a comment-like string) can only cause a refusal, never a miss. Names end at
 * HTML whitespace only, as a browser ends them.
 *
 * Both modes count comments and the attributes of each tag and refuse (`limit`) a page over `MAX_ARTIFACT_COMMENTS` or
 * `MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT`, so the DOM parser is never given a page whose comments or attributes would take
 * minutes to parse.
 */
function scanMarkup(html: string, options: ScanOptions): void {
  const checkReferences = options.references;
  const length = html.length;
  let index = 0;
  let comments = 0;
  /** A malformed page: refused when references are checked; in the pre-parse mode the scan simply ends. */
  const malformed = (detail: string): boolean => {
    if (checkReferences) unsupportedOutput(detail);
    return true;
  };
  const countComment = (): void => {
    comments += 1;
    if (comments > MAX_ARTIFACT_COMMENTS) fail("limit", "artifact page has too many comments");
  };
  while (index < length) {
    const open = html.indexOf("<", index);
    if (open === -1) return;
    index = open + 1;
    const next = html[index] ?? "";
    if (html.startsWith("!--", index)) {
      countComment();
      let end: number;
      if (html[index + 3] === ">") end = index + 4;
      else if (html.startsWith("->", index + 3)) end = index + 5;
      else {
        // The first `-->` or `--!>`, found in one pass.
        COMMENT_END.lastIndex = index + 3;
        const close = COMMENT_END.exec(html);
        if (close === null) {
          if (malformed("artifact output has an unterminated comment")) return;
          return;
        }
        end = close.index + close[0].length;
      }
      index = end;
      continue;
    }
    if (next === "!" || next === "?" || next === "/") {
      // A doctype, a bogus comment or an end tag ends at the first `>`; an end tag's attributes are never used.
      if (next === "?" || (next === "!" && !/^!doctype/i.test(html.slice(index, index + 8)))) countComment();
      const close = html.indexOf(">", index);
      if (close === -1) {
        if (malformed("artifact output has an unterminated tag")) return;
        return;
      }
      index = close + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) continue;
    TAG_NAME.lastIndex = index;
    const rawTag = TAG_NAME.exec(html)![0];
    const tag = rawTag.toLowerCase();
    index = TAG_NAME.lastIndex;
    if (checkReferences) {
      if (ODD_TAG_NAME.test(rawTag)) unsupportedOutput("artifact output has a tag name with an unexpected character");
      if (MARKUP_BLOCKED_NAMES.has(tag)) unsupportedOutput("artifact output contains a blocked html feature");
    }
    const attributes = new Map<string, string>();
    let attributeCount = 0;
    for (;;) {
      while (index < length && SKIPPED.test(html[index]!)) index += 1;
      if (index >= length) {
        if (malformed("artifact output has an unterminated tag")) return;
        return;
      }
      if (html[index] === ">") {
        index += 1;
        break;
      }
      ATTRIBUTE_NAME.lastIndex = index;
      const rawName = ATTRIBUTE_NAME.exec(html)![0];
      index = ATTRIBUTE_NAME.lastIndex;
      while (index < length && SPACE.test(html[index]!)) index += 1;
      let rawValue = "";
      if (html[index] === "=") {
        index += 1;
        while (index < length && SPACE.test(html[index]!)) index += 1;
        const quote = html[index];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, index + 1);
          if (close === -1) {
            if (malformed("artifact output has an unterminated attribute")) return;
            return;
          }
          rawValue = html.slice(index + 1, close);
          index = close + 1;
        } else {
          UNQUOTED_VALUE.lastIndex = index;
          rawValue = UNQUOTED_VALUE.exec(html)![0];
          index = UNQUOTED_VALUE.lastIndex;
        }
      }
      if (rawName.length > 0) {
        attributeCount += 1;
        if (attributeCount > MAX_ARTIFACT_ATTRIBUTES_PER_ELEMENT) fail("limit", "artifact element has too many attributes");
        if (!checkReferences) continue;
        const name = rawName.toLowerCase();
        const decoded = decodeAttributeValue(rawValue);
        checkAttribute(name, decoded);
        if (isHrefAnimation(tag, name, decoded)) unsupportedOutput("artifact svg animates a resource reference");
        // A repeated attribute: a browser keeps the first, so only the first is the one that counts for the tag-level checks.
        if (!attributes.has(name)) attributes.set(name, decoded);
      } else if (index < length && html[index] !== ">" && !SKIPPED.test(html[index]!)) {
        // A lone quote or other character that starts no name: step over it so the scan always moves forward.
        index += 1;
      }
    }
    if (checkReferences) {
      // The same elements and attributes the DOM pass refuses by selector (`BLOCKED_ELEMENTS`), so neither pass depends on the other.
      if ((tag === "area" && attributes.has("href")) || attributes.has("ping") || (tag === "link" && !attributes.has("href"))) {
        unsupportedOutput("artifact output contains a blocked html feature");
      }
      if (tag === "meta" && attributes.has("http-equiv") && !isOwnPolicyMeta(attributes.get("http-equiv")!, attributes.get("content") ?? null)) {
        unsupportedOutput("artifact output contains a meta http-equiv", attributes.get("http-equiv"));
      }
      if (tag === "script" && !isJavaScriptType(attributes.get("type"))) {
        unsupportedOutput("artifact output holds a script type that is not JavaScript", attributes.get("type"));
      }
    }
    if (tag === "script") {
      SCRIPT_END.lastIndex = index;
      const close = SCRIPT_END.exec(html);
      if (close === null) return;
      index = close.index;
    } else if (tag === "style" && checkReferences) {
      STYLE_END.lastIndex = index;
      const close = STYLE_END.exec(html);
      assertOnlyInlineCssReferences(html.slice(index, close === null ? length : close.index));
    }
  }
}

export interface AssertSelfContainedOptions {
  /** Parses HTML with the HTML5 tree builder. Defaults to the browser's `DOMParser`. */
  readonly parseHtml?: (html: string) => Document;
  /**
   * Run only one of the two passes: `"bytes"` (the scan with its own tokenizer) or `"dom"` (the DOM parser's view). Both run
   * by default; the option exists so each pass can be tested alone.
   */
  readonly only?: "bytes" | "dom";
}

/**
 * The last check, on a finished page and independent of the rewriting that made it: the page is read without its
 * `data:` URLs by a scan that has its own tokenizer and then by the DOM parser, and refused (`unsupported`) if anything in it
 * could still fetch or navigate to something other than a `data:` URL the rewriter wrote or a `#fragment` of the page.
 *
 * What it enforces (each class is refused, not rewritten):
 * - every URL-bearing attribute (`URL_ATTRIBUTES`: `href`, `xlink:href`, `src`, `srcset`, `imagesrcset`, `poster`, `ping`,
 *   `attributionsrc`, `background`, `formaction`, `cite`, `data`, `codebase`, `archive`, `profile`, `longdesc`, `usemap`,
 *   `manifest`, `lowsrc`, `dynsrc`, `itemtype`, ...) holds only `data:;base64,...` or `#fragment`, after the value is read the way
 *   a browser reads it (entities decoded, tabs and newlines removed, controls and spaces trimmed, U+00A0 and other Unicode
 *   whitespace not trimmed): a relative path, an empty value, `&nbsp;#c` and `\host/x` are all refused;
 * - any other attribute outside a text allow-list (`title`, `alt`, `aria-*`, `data-*`, `content`, `xmlns`, ...) whose value
 *   reads as a URL (a network or script scheme, `//host`, `\host`, a path) is refused;
 * - CSS in `<style>` and in attributes: no `@import`, `image-set()` or `src()`, and every `url()` is `data:` or `#fragment`,
 *   backslash escapes decoded first;
 * - no `<meta http-equiv>` except the rewriter's own Content-Security-Policy, no event handler, no `<base>`, `<form>`,
 *   frames, `<object>`, `<embed>`, `<noscript>`, `<xmp>`, `<plaintext>`, `<area href>`, no `ping`, no SVG `<script>`.
 *
 * What it does not enforce: what a page's own script does (the scripts are scanned for blocked capabilities at rewrite
 * time, and the viewer's sandbox and Content-Security-Policy are the second line), and text that is not an attribute or
 * `<style>` (a script or a text node may hold `https://` as data).
 */
export function assertSelfContainedPage(output: string, options: AssertSelfContainedOptions = {}): void {
  const page = withoutDataUris(output);
  if (options.only !== "dom") scanMarkup(page, { references: true });
  if (options.only === "bytes") return;
  const doc = (options.parseHtml ?? defaultParseHtml)(page);
  const roots = documentRoots(doc);
  if (queryAll(roots, BLOCKED_ELEMENTS).length > 0) fail("unsupported", "artifact output contains a blocked html feature");
  for (const meta of queryAll<HTMLMetaElement>(roots, "meta[http-equiv]")) {
    if (!isOwnPolicyMeta(meta.getAttribute("http-equiv") ?? "", meta.getAttribute("content"))) fail("unsupported", "artifact output contains a meta http-equiv");
  }
  if (queryAll(roots, "script[src]").length > 0) fail("unsupported", "artifact output still loads a script");
  for (const script of queryAll(roots, "script")) {
    if (!isJavaScriptType(script.getAttribute("type"))) fail("unsupported", "artifact output holds a script type that is not JavaScript");
  }
  for (const style of queryAll(roots, "style")) assertOnlyInlineCssReferences(style.textContent ?? "");
  for (const element of queryAll(roots, "*")) {
    const inSvg = element.namespaceURI === SVG_NAMESPACE;
    if (inSvg && element.localName === "script") fail("unsupported", "artifact svg contains a script");
    for (const name of element.getAttributeNames()) {
      const lower = name.toLowerCase();
      const local = lower.slice(lower.lastIndexOf(":") + 1);
      // The DOM already holds the decoded value.
      const value = element.getAttribute(name) ?? "";
      if (/^on/.test(lower)) fail("unsupported", "artifact output contains a blocked html feature");
      if (URL_ATTRIBUTES.has(local)) {
        if (local === "srcset" || local === "imagesrcset") assertInlineSrcset(value);
        else if (!isInlineReference(value)) throw new ArtifactBundleError("unsupported", "artifact page still references a resource", undefined, value);
      } else if (lower !== "style" && !TEXT_ATTRIBUTES.test(lower) && looksLikeUrl(urlText(value))) {
        // Any other attribute outside the text allow-list whose value reads as a URL, whatever its name.
        throw new ArtifactBundleError("unsupported", "artifact page still references a resource", undefined, value);
      }
      if (lower === "style" || inSvg) assertOnlyInlineCssReferences(value);
      if (isHrefAnimation(element.localName, lower, value)) fail("unsupported", "artifact svg animates a resource reference");
    }
  }
}

function verifySelfContained(output: string, context: TransformContext): void {
  assertSelfContainedPage(output, { parseHtml: context.parseHtml });
}

/**
 * Inline SVG elements (`<image>`, `<use>`, `<script>`, `<feImage>`, ...) reference resources through `href` or
 * `xlink:href`, which the HTML resource list above does not cover. Only same-document `#fragment` references are
 * allowed; a plain `href` on `<a>` is handled with the other anchors.
 */
function rejectSvgResourceReferences(roots: readonly ParentNode[]): void {
  for (const element of queryAll(roots, "*")) {
    if (element.namespaceURI !== SVG_NAMESPACE) continue;
    const animatesHref = /^(?:animate|set|animatetransform|animatemotion)$/i.test(element.localName)
      && element.getAttributeNames().some((name) => name.toLowerCase() === "attributename" && /^(?:xlink:)?href$/i.test(trimUrl(element.getAttribute(name) ?? "")));
    if (animatesHref) fail("unsupported", "artifact svg animates a resource reference");
    // An SVG `<script>` is read as markup by a browser's tokenizer, not as script text, so what is in it cannot be checked like a page script.
    if (element.localName === "script") fail("unsupported", "artifact svg contains a script");
    for (const attributeName of element.getAttributeNames()) {
      if (attributeName !== "href" && !attributeName.endsWith(":href")) continue;
      if (element.localName === "a" && attributeName === "href") continue;
      if (!isFragmentOnly(urlText(element.getAttribute(attributeName) ?? ""))) fail("unsupported", "artifact svg references a resource");
    }
  }
}

function rejectEventHandlerAttributes(roots: readonly ParentNode[]): void {
  for (const element of queryAll(roots, "*")) {
    for (const attributeName of element.getAttributeNames()) {
      if (/^on/i.test(attributeName)) fail("unsupported", "artifact contains a blocked html feature");
    }
  }
}

function replaceAsync(
  input: string,
  expression: RegExp,
  replacer: (...match: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(expression)];
  return matches.reduceRight(
    async (next, match) => {
      const value = await next;
      const replacement = await replacer(...match.map((entry) => entry ?? ""));
      return `${value.slice(0, match.index)}${replacement}${value.slice((match.index ?? 0) + match[0].length)}`;
    },
    Promise.resolve(input),
  );
}

interface TransformContext {
  readonly files: ReadonlyMap<string, ArtifactFile>;
  readonly cssStack: readonly string[];
  readonly counter: { references: number; inlinedBytes: number };
  readonly parseHtml: (html: string) => Document;
  readonly singlePage: boolean;
  /** Set while rewriting a `style=` attribute: inlined URLs are parked here and swapped back after serialization (see `Deferred`). */
  readonly deferred?: Deferred;
}

/**
 * Large `data:` URLs written into a `style=` attribute are parked behind a placeholder and put back in the serialized page.
 * A DOM that parses the value as CSS (jsdom does, on every set) takes seconds and gigabytes for a few megabytes of
 * base64, which no check needs to see: the placeholder has the same shape (`data:;base64,...`) and is replaced by exactly
 * the URL that was parked, through a per-page random token, so page text cannot collide with it.
 */
interface Deferred {
  readonly token: string;
  readonly urls: string[];
}

function newDeferred(): Deferred {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues !== undefined) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return { token: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""), urls: [] };
}

function parkUrl(deferred: Deferred, url: string): string {
  deferred.urls.push(url);
  return `data:;base64,TCPH${deferred.token}x${deferred.urls.length - 1}x`;
}

function restoreParkedUrls(page: string, deferred: Deferred): string {
  if (deferred.urls.length === 0) return page;
  const pattern = new RegExp(`data:;base64,TCPH${deferred.token}x(\\d+)x`, "g");
  return page.replace(pattern, (_whole, index: string) => deferred.urls[Number(index)]!);
}

/** `resolveArtifactReference`, with a refusal naming the file and the reference text that caused it. */
function resolveReferenceFrom(basePath: string, reference: string): ResolvedReference {
  try {
    return resolveArtifactReference(basePath, reference);
  } catch (error) {
    if (error instanceof ArtifactBundleError) throw new ArtifactBundleError(error.kind, error.message, basePath, reference);
    throw error;
  }
}

function requiredFile(context: TransformContext, basePath: string, reference: string): { file: ArtifactFile; resolved: ResolvedReference } {
  context.counter.references += 1;
  if (context.counter.references > MAX_ARTIFACT_REFERENCES) fail("limit", "artifact has too many resource references");
  const resolved = resolveReferenceFrom(basePath, reference);
  const file = context.files.get(resolved.path);
  if (file === undefined) throw new ArtifactBundleError("missing", "artifact resource is missing", basePath, reference);
  return { file, resolved };
}

/** The CSS names that start a reference. A backslash escape in one of them would hide it from the expressions below. */
const CSS_REFERENCE_NAMES = new Set(["url", "image-set", "-webkit-image-set", "src", "import"]);

function isCssIdentifierCode(code: number): boolean {
  return code >= 0x80 || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x2d;
}

/**
 * Decode the backslash escapes of function names and at-keywords that start a reference (`u\72l(`, `\75rl(`,
 * `@\69mport`), so the expressions that find `url()`, `@import`, `image-set()` and `src()` see the name a CSS parser
 * sees. Any other identifier (a selector such as `.sm\:flex`), string, comment and url token is copied unchanged, so the
 * result means what the source meant.
 */
export function normalizeCssEscapes(source: string): string {
  let output = "";
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index]!;
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? length : end + 2;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < length && source[cursor] !== char && source[cursor] !== "\n") cursor += source[cursor] === "\\" ? 2 : 1;
      const stop = Math.min(source[cursor] === char ? cursor + 1 : cursor, length);
      output += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "\\" || isCssIdentifierCode(source.charCodeAt(index))) {
      let cursor = index;
      let decoded = "";
      let escaped = false;
      while (cursor < length) {
        if (source[cursor] === "\\") {
          const next = source[cursor + 1];
          if (next === undefined) {
            decoded += "\ufffd";
            escaped = true;
            cursor += 1;
            break;
          }
          if (next === "\n" || next === "\r" || next === "\f") break;
          escaped = true;
          const hex = /^[0-9a-fA-F]{1,6}/.exec(source.slice(cursor + 1, cursor + 7));
          if (hex !== null) {
            const point = Number.parseInt(hex[0], 16);
            cursor += 1 + hex[0].length;
            if (source[cursor] === "\r" && source[cursor + 1] === "\n") cursor += 2;
            else if (/[ \t\n\r\f]/.test(source[cursor] ?? "")) cursor += 1;
            decoded += point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? "\ufffd" : String.fromCodePoint(point);
          } else {
            const point = source.codePointAt(cursor + 1)!;
            decoded += String.fromCodePoint(point);
            cursor += 1 + (point > 0xffff ? 2 : 1);
          }
        } else if (isCssIdentifierCode(source.charCodeAt(cursor))) {
          decoded += source[cursor];
          cursor += 1;
        } else break;
      }
      const raw = source.slice(index, cursor);
      const startsReference = escaped && (source[cursor] === "(" || output.endsWith("@")) && CSS_REFERENCE_NAMES.has(decoded.toLowerCase());
      output += startsReference ? decoded : raw;
      index = cursor;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/**
 * Whatever CSS is in the finished page: no `@import`, `image-set()` or `src()`, and every `url()` is a `data:` URL or a
 * `#fragment` (what this rewriter writes). Escapes in the names are decoded first.
 */
function assertOnlyInlineCssReferences(css: string): void {
  const text = normalizeCssEscapes(css);
  if (/@import/i.test(text)) fail("unsupported", "artifact css still imports a stylesheet");
  if (/(?:^|[^\w-])(?:-webkit-)?image-set\s*\(/i.test(text) || /(?:^|[^\w-])src\s*\(/i.test(text)) fail("unsupported", "artifact css uses an unsupported resource function");
  const opened = text.match(/url\(/gi)?.length ?? 0;
  let read = 0;
  // CSS whitespace is space, tab, newline, carriage return and form feed: not U+00A0, which stays part of the URL.
  for (const match of text.matchAll(/url\([ \t\n\r\f]*(?:"([^"]*)"|'([^']*)'|([^)"' \t\n\r\f]*))[ \t\n\r\f]*\)/gi)) {
    read += 1;
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!isInlineReference(value) || value.includes("\\")) {
      throw new ArtifactBundleError("unsupported", "artifact css references a resource", undefined, value);
    }
  }
  if (read !== opened) fail("unsupported", "artifact css has a url() that cannot be read");
}

async function transformCss(sourceText: string, basePath: string, context: TransformContext): Promise<string> {
  if (context.cssStack.length > MAX_ARTIFACT_CSS_IMPORT_DEPTH) fail("limit", "artifact stylesheet import depth exceeded");
  const source = normalizeCssEscapes(sourceText);
  const imported = await replaceAsync(
    source,
    /@import\s+(?:url\(\s*(?:(["'])([^"']+)\1|([^"')\s]+))\s*\)|(["'])([^"']+)\4)\s*([^;]*);/gi,
    async (_whole, _urlQuote, quotedUrl, unquotedUrl, _quote, quotedReference, media) => {
      const reference = quotedUrl || unquotedUrl || quotedReference;
      if (/^(?:layer|supports)\b/i.test(media.trim()) || /\b(?:layer|supports)\b/i.test(media)) fail("unsupported", "artifact uses an unsupported stylesheet import condition");
      const { file, resolved } = requiredFile(context, basePath, reference);
      if (context.cssStack.includes(resolved.path)) fail("unsupported", "artifact stylesheet import cycle");
      const css = await transformCss(decodeText(file, context), resolved.path, { ...context, cssStack: [...context.cssStack, resolved.path] });
      return wrapMediaCss(css, media, "artifact uses an unsupported stylesheet import condition");
    },
  );
  return replaceAsync(
    imported,
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    async (_whole, _quote, reference) => {
      if (trimUrl(reference).startsWith("#")) return `url("${trimUrl(reference)}")`;
      const { file, resolved } = requiredFile(context, basePath, reference);
      const dataUrl = asDataUrl(file, context);
      return `url("${context.deferred === undefined ? dataUrl : parkUrl(context.deferred, dataUrl)}${resolved.fragment}")`;
    },
  );
}

function serializeSrcset(value: string, basePath: string, context: TransformContext): string {
  return value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    const separator = trimmed.search(/\s/);
    const reference = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const descriptor = separator === -1 ? "" : trimmed.slice(separator).trim();
    const { file, resolved } = requiredFile(context, basePath, reference);
    return `${asDataUrl(file, context)}${resolved.fragment}${descriptor.length === 0 ? "" : ` ${descriptor}`}`;
  }).join(", ");
}

const CHILD_BOOTSTRAP = `(function(){
  "use strict";
  document.addEventListener("click",function(event){
    var target=event.target instanceof Element?event.target.closest("a[data-tc-artifact-path]"):null;
    if(!target)return;
    event.preventDefault();
    window.parent.postMessage({type:"navigate",path:target.getAttribute("data-tc-artifact-path"),fragment:target.getAttribute("data-tc-artifact-fragment")||""},"*");
  },true);
  window.addEventListener("message",function(event){
    if(event.source!==window.parent||event.origin!=="null"||!event.data||event.data.type!=="artifact-fragment"||typeof event.data.fragment!=="string")return;
    var fragment=event.data.fragment;
    if(!/^#[^\\u0000-\\u001f\\u007f]{1,1024}$/.test(fragment))return;
    try{var target=document.getElementById(decodeURIComponent(fragment.slice(1)));if(target)target.scrollIntoView();}catch(_){}
  });
  window.parent.postMessage({type:"artifact-ready"},"*");
})();`;

const INNER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

async function transformHtml(path: string, file: ArtifactFile, context: TransformContext): Promise<string> {
  const text = decodeText(file);
  // Before the DOM parser sees the page: the comment and attribute limits, which keep it from being given a page it would
  // take minutes to parse.
  scanMarkup(text, { references: false });
  const doc = context.parseHtml(text);
  const roots = documentRoots(doc);
  const deferred = newDeferred();
  if (doc.querySelector("parsererror") !== null) fail("malformed", "artifact html is malformed");
  // `noscript` is refused outright: a parser with scripting off (jsdom's) and the viewer's frame (scripting on) read its
  // content differently, so what is in it cannot be checked consistently.
  if (queryAll(roots, BLOCKED_ELEMENTS).length > 0) {
    fail("unsupported", "artifact contains a blocked html feature");
  }
  rejectEventHandlerAttributes(roots);
  rejectSvgResourceReferences(roots);
  const inlineStyles = queryAll<HTMLStyleElement>(roots, "style");
  // Every author `<meta http-equiv>` is dropped: they act like response headers (`refresh`, `Link`, `Set-Cookie`, the author's own
  // Content-Security-Policy), and the finished page carries only the rewriter's own policy.
  for (const meta of queryAll<HTMLMetaElement>(roots, "meta[http-equiv]")) meta.remove();
  for (const link of queryAll<HTMLLinkElement>(roots, "link[href]")) {
    const relation = classifyLinkRelation(link.getAttribute("rel"));
    if (relation === "stylesheet") {
      const { file: stylesheet, resolved } = requiredFile(context, path, link.getAttribute("href") ?? "");
      const style = doc.createElement("style");
      style.textContent = wrapMediaCss(await transformCss(decodeText(stylesheet, context), resolved.path, { ...context, cssStack: [resolved.path] }), link.getAttribute("media"));
      link.replaceWith(style);
      continue;
    }
    if (relation === "icon") {
      const { file: icon, resolved } = requiredFile(context, path, link.getAttribute("href") ?? "");
      link.href = `${asDataUrl(icon, context)}${resolved.fragment}`;
      continue;
    }
    fail("unsupported", "artifact contains an unsupported link relation");
  }
  for (const style of inlineStyles) {
    style.textContent = wrapMediaCss(await transformCss(style.textContent ?? "", path, { ...context, cssStack: [] }), style.getAttribute("media"));
  }
  for (const element of queryAll<HTMLElement>(roots, "[style]")) {
    const value = element.getAttribute("style");
    if (value !== null) element.setAttribute("style", await transformCss(value, path, { ...context, cssStack: [], deferred }));
  }
  for (const script of queryAll<HTMLScriptElement>(roots, "script")) {
    // `getAttribute`, not `script.type`: an SVG `<script>` has no `type` property in every DOM (jsdom has no SVGScriptElement).
    if ((script.getAttribute("type") ?? "").trim().toLowerCase() === "module" || script.hasAttribute("async") || script.hasAttribute("defer")) {
      fail("unsupported", "artifact uses an unsupported script mode");
    }
    if (!isJavaScriptType(script.getAttribute("type"))) fail("unsupported", "artifact uses a script type that is not JavaScript");
    let source = script.textContent ?? "";
    const reference = script.getAttribute("src");
    if (reference !== null) {
      const { file: scriptFile } = requiredFile(context, path, reference);
      source = decodeText(scriptFile, context);
      script.removeAttribute("src");
    }
    assertClassicScript(source);
    script.textContent = source.replace(/<\/script/gi, "<\\/script");
  }
  const resourceAttributes: ReadonlyArray<readonly [string, string]> = [
    ["img[src]", "src"], ["source[src]", "src"], ["video[src]", "src"], ["video[poster]", "poster"],
    ["audio[src]", "src"], ["track[src]", "src"], ["input[type=image][src]", "src"],
  ];
  for (const [selector, attribute] of resourceAttributes) {
    for (const element of queryAll<HTMLElement>(roots, selector)) {
      const reference = element.getAttribute(attribute);
      if (reference === null) continue;
      const { file: resource, resolved } = requiredFile(context, path, reference);
      element.setAttribute(attribute, `${asDataUrl(resource, context)}${resolved.fragment}`);
    }
  }
  for (const element of queryAll<HTMLElement>(roots, "[srcset]")) {
    const value = element.getAttribute("srcset");
    if (value !== null) element.setAttribute("srcset", serializeSrcset(value, path, context));
  }
  for (const anchor of queryAll<HTMLAnchorElement>(roots, "a[href]")) {
    anchor.removeAttribute("target");
    anchor.removeAttribute("download");
    const reference = anchor.getAttribute("href") ?? "";
    if (reference.startsWith("#")) continue;
    const resolved = resolveReferenceFrom(path, reference);
    if (context.singlePage) throw new ArtifactBundleError("unsupported", "artifact links to another page", path, reference);
    if (!context.files.has(resolved.path) || !/\.html?$/i.test(resolved.path)) fail("unsupported", "artifact link leaves its html bundle");
    anchor.href = "#";
    anchor.dataset.tcArtifactPath = resolved.path;
    if (resolved.fragment.length > 0) anchor.dataset.tcArtifactFragment = resolved.fragment;
  }
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = INNER_CSP;
  const bootstrap = doc.createElement("script");
  bootstrap.textContent = CHILD_BOOTSTRAP;
  head.prepend(bootstrap);
  head.prepend(csp);
  const output = restoreParkedUrls(`<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, deferred);
  verifySelfContained(output, context);
  return output;
}

export async function prepareHtmlArtifact(input: readonly ArtifactFile[], options: PrepareHtmlArtifactOptions = {}): Promise<PreparedArtifact> {
  if (input.length === 0) fail("malformed", "artifact bundle is empty");
  if (input.length > MAX_ARTIFACT_FILES) fail("limit", "artifact has too many files");
  const files = new Map<string, ArtifactFile>();
  const aliases = new Set<string>();
  let sourceBytes = 0;
  for (const candidate of input) {
    let path: string;
    try {
      path = canonicalArtifactPath(candidate.path);
    } catch (error) {
      if (error instanceof ArtifactBundleError) throw new ArtifactBundleError(error.kind, error.message, candidate.path);
      throw error;
    }
    const alias = path.toLowerCase();
    if (aliases.has(alias)) throw new ArtifactBundleError("malformed", "artifact paths collide after canonicalization", path);
    aliases.add(alias);
    sourceBytes += candidate.bytes.byteLength;
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_ARTIFACT_SOURCE_BYTES) throw new ArtifactBundleError("limit", "artifact source exceeds limit", path);
    files.set(path, { ...candidate, path });
  }
  const detection = detectHtmlArtifact([...files.keys()]);
  if (detection.kind !== "html") fail("malformed", "artifact root index is missing");
  const renderBytes = [...files.values()]
    .filter((file) => /^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/i.test(artifactMediaType(file.path, file.mediaType)))
    .reduce((total, file) => total + file.bytes.byteLength, 0);
  if (renderBytes > MAX_ARTIFACT_RENDER_BYTES) fail("limit", "artifact render aggregate exceeds limit");
  const context: TransformContext = {
    files,
    cssStack: [],
    counter: { references: 0, inlinedBytes: 0 },
    parseHtml: options.parseHtml ?? defaultParseHtml,
    singlePage: options.singlePage === true,
  };
  const pages: Record<string, string> = {};
  let renderedBytes = 0;
  for (const [path, file] of files) {
    if (!/\.html?$/i.test(path)) continue;
    if (context.singlePage && path !== ARTIFACT_ENTRY) continue;
    let page: string;
    try {
      page = await transformHtml(path, file, context);
    } catch (error) {
      if (error instanceof ArtifactBundleError && error.path === undefined) throw new ArtifactBundleError(error.kind, error.message, path, error.reference);
      throw error;
    }
    renderedBytes += new TextEncoder().encode(page).byteLength;
    if (!Number.isSafeInteger(renderedBytes) || renderedBytes > MAX_ARTIFACT_RENDER_BYTES) {
      fail("limit", "artifact rendered output exceeds limit");
    }
    pages[path] = page;
  }
  return { entry: ARTIFACT_ENTRY, pages: Object.freeze(pages), fileCount: files.size, sourceBytes };
}

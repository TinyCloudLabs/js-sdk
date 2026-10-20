import { hasUnsafeFilenameCodePoint } from "../filename-policy.js";

export const ARTIFACT_ENTRY = "index.html";
export const MAX_ARTIFACT_FILES = 1_000;
export const MAX_ARTIFACT_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_ARTIFACT_RENDER_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACT_REFERENCES = 2_000;
export const MAX_ARTIFACT_CSS_IMPORT_DEPTH = 16;

export type ArtifactFailureKind = "malformed" | "missing" | "unsupported" | "limit";

export class ArtifactBundleError extends Error {
  /**
   * `path` is the bundle file being processed when the refusal happened; `reference` is the reference text inside it
   * that was refused, when there is one. Both come from the (untrusted) folder: escape them before printing.
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
  const raw = reference.trim();
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

/** Attributes whose value is a URL (or a list of them) that a browser may fetch or navigate to. */
const URL_ATTRIBUTES = new Set([
  "href", "src", "srcset", "imagesrcset", "poster", "action", "formaction", "cite", "data", "codebase", "longdesc", "usemap",
  "ping", "background", "manifest", "icon", "archive", "classid", "profile", "lowsrc", "dynsrc",
]);

/** `data:` and `#fragment` are the only references the finished page may hold; an empty value fetches nothing. */
function isInlineReference(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || trimmed.startsWith("#") || /^data:/i.test(trimmed);
}

function assertInlineSrcset(value: string): void {
  for (const raw of value.trim().split(/\s+/)) {
    const token = raw.replace(/,+$/, "");
    if (token === "" || /^\d+(?:\.\d+)?[wx]$/i.test(token)) continue;
    if (!isInlineReference(token)) throw new ArtifactBundleError("unsupported", "artifact page still references a resource", undefined, token);
  }
}

const BLOCKED_ELEMENTS = "base, form, iframe, frame, frameset, object, embed, portal, noscript, area[href], link:not([href]), [ping]";

/**
 * The last check, on the finished page and independent of the rewriting above: parse the produced HTML again and refuse it
 * if anything in it could still fetch or navigate to something other than a `data:` URL or a `#fragment`. This catches
 * whatever the rewriting did not know about, so "self-contained" is verified, not assumed.
 */
function verifySelfContained(output: string, context: TransformContext): void {
  const doc = context.parseHtml(output);
  const roots = documentRoots(doc);
  if (queryAll(roots, BLOCKED_ELEMENTS).length > 0) fail("unsupported", "artifact output contains a blocked html feature");
  for (const meta of queryAll<HTMLMetaElement>(roots, "meta[http-equiv]")) {
    if ((meta.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") fail("unsupported", "artifact output contains a refresh");
  }
  if (queryAll(roots, "script[src]").length > 0) fail("unsupported", "artifact output still loads a script");
  for (const style of queryAll(roots, "style")) assertOnlyInlineCssReferences(style.textContent ?? "");
  for (const element of queryAll(roots, "*")) {
    const inSvg = element.namespaceURI === SVG_NAMESPACE;
    for (const name of element.getAttributeNames()) {
      const lower = name.toLowerCase();
      const local = lower.slice(lower.lastIndexOf(":") + 1);
      const value = element.getAttribute(name) ?? "";
      if (/^on/.test(lower)) fail("unsupported", "artifact output contains a blocked html feature");
      if (URL_ATTRIBUTES.has(local)) {
        if (local === "srcset" || local === "imagesrcset") assertInlineSrcset(value);
        else if (!isInlineReference(value)) throw new ArtifactBundleError("unsupported", "artifact page still references a resource", undefined, value);
      }
      if (lower === "style" || inSvg) assertOnlyInlineCssReferences(value);
    }
  }
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
      && element.getAttributeNames().some((name) => name.toLowerCase() === "attributename" && /^(?:xlink:)?href$/i.test((element.getAttribute(name) ?? "").trim()));
    if (animatesHref) fail("unsupported", "artifact svg animates a resource reference");
    for (const attributeName of element.getAttributeNames()) {
      if (attributeName !== "href" && !attributeName.endsWith(":href")) continue;
      if (element.localName === "a" && attributeName === "href") continue;
      if (!(element.getAttribute(attributeName) ?? "").trim().startsWith("#")) fail("unsupported", "artifact svg references a resource");
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
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi)) {
    read += 1;
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!(value.startsWith("#") || /^data:/i.test(value)) || value.includes("\\")) {
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
      if (reference.trim().startsWith("#")) return `url("${reference.trim()}")`;
      const { file, resolved } = requiredFile(context, basePath, reference);
      return `url("${asDataUrl(file, context)}${resolved.fragment}")`;
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
  const doc = context.parseHtml(decodeText(file));
  const roots = documentRoots(doc);
  if (doc.querySelector("parsererror") !== null) fail("malformed", "artifact html is malformed");
  // `noscript` is refused outright: a parser with scripting off (jsdom's) and the viewer's frame (scripting on) read its
  // content differently, so what is in it cannot be checked consistently.
  if (queryAll(roots, BLOCKED_ELEMENTS).length > 0) {
    fail("unsupported", "artifact contains a blocked html feature");
  }
  rejectEventHandlerAttributes(roots);
  rejectSvgResourceReferences(roots);
  const inlineStyles = queryAll<HTMLStyleElement>(roots, "style");
  for (const meta of queryAll<HTMLMetaElement>(roots, "meta[http-equiv]")) {
    const directive = meta.httpEquiv.toLowerCase();
    if (directive === "refresh" || directive === "content-security-policy") meta.remove();
  }
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
    if (value !== null) element.setAttribute("style", await transformCss(value, path, { ...context, cssStack: [] }));
  }
  for (const script of queryAll<HTMLScriptElement>(roots, "script")) {
    // `getAttribute`, not `script.type`: an SVG `<script>` has no `type` property in every DOM (jsdom has no SVGScriptElement).
    if ((script.getAttribute("type") ?? "").trim().toLowerCase() === "module" || script.hasAttribute("async") || script.hasAttribute("defer")) {
      fail("unsupported", "artifact uses an unsupported script mode");
    }
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
  const output = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
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

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { ArtifactFile } from "../../src/html-bundle/index.js";

const parser = new (new JSDOM("").window.DOMParser)();

/** The HTML5 tree builder a browser uses (jsdom is built on parse5), so the rewriter sees what a browser would. */
export function parseHtml(html: string): Document {
  return parser.parseFromString(html, "text/html");
}

export function utf8(path: string, value: string, mediaType?: string): ArtifactFile {
  return { path, bytes: new TextEncoder().encode(value), ...(mediaType === undefined ? {} : { mediaType }) };
}

export function binary(path: string, bytes: Uint8Array | number[], mediaType?: string): ArtifactFile {
  return { path, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), ...(mediaType === undefined ? {} : { mediaType }) };
}

/** A real small multi-file page (the share viewer's example): html, css with a font rule, classic script, svg. */
export function fixtureFiles(): ArtifactFile[] {
  const base = new URL("./fixtures/html-artifact/", import.meta.url);
  const read = (name: string): string => readFileSync(new URL(name, base), "utf8");
  return [
    utf8("index.html", read("index.html"), "text/html"),
    utf8("styles/site.css", read("styles/site.css"), "text/css"),
    utf8("scripts/app.js", read("scripts/app.js"), "text/javascript"),
    utf8("assets/cloud.svg", read("assets/cloud.svg"), "image/svg+xml"),
  ];
}

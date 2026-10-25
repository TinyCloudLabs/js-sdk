import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";

// Built by `bun run build:e2e-ui` as an ES module graph: the harness entry plus
// its split chunks. The panel is a dynamic import, so it lands in its own
// `panel-entry-*.js` chunk. Files are served one by one so a spec can see which
// chunks the page requested.
const DIR = resolve("e2e/.build/ui");
const ORIGIN = "http://tinycloud-ui.test";
const ENTRY = "harness-entry.js";

// Reads every built .js file in a harness output directory.
export function loadBuild(dir: string): Map<string, string> {
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => [name, readFileSync(resolve(dir, name), "utf8")]),
  );
}

const FILES = loadBuild(DIR);

const PANEL_CHUNK = /^panel-entry-.+\.js$/;

// Panel-only class name. Its absence from the entry shows the eager bundle carries no panel code.
export const PANEL_ONLY_MARKER = "sec-title";

export function entryBundle(): string {
  return FILES.get(ENTRY) ?? "";
}

export function isPanelChunk(name: string): boolean {
  return PANEL_CHUNK.test(name);
}

export function defaultDocument(frameTag = ""): string {
  return `<!doctype html><html><body>${frameTag}<script type="module" src="/${ENTRY}"></script></body></html>`;
}

// Routes the origin to the built harness. `pageHtml` returns the document for a
// path; the default loads the entry as a module. Returns the JS files the page
// requested, in request order.
export async function routeUiHarness(
  page: Page,
  pageHtml: (path: string) => string = () => defaultDocument(),
  files: ReadonlyMap<string, string> = FILES,
): Promise<string[]> {
  const requested: string[] = [];
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const name = path.slice(1);
    if (files.has(name)) {
      requested.push(name);
      // Module scripts are fetched in CORS mode. A sandboxed frame has an opaque origin, so it needs this header.
      return route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: files.get(name),
      });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(path) });
  });
  return requested;
}

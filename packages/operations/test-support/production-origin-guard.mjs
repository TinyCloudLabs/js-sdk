// Test-only: refuse the production links API under test, so a test that forgot its fetch stub or its
// origin fails fast instead of POSTing to https://api.tinycloud.xyz/v1/links.
//
// Three layers, because tests reach the links API three ways:
//  - In-process: `fetch` is wrapped and rejects any request to a production links origin. Tests that stub or
//    redirect `fetch` replace the wrapper for their own requests and are unaffected.
//  - Spawned Node CLIs (courier): the wrapper is installed through NODE_OPTIONS=--import, which a child that
//    copies process.env inherits (see nodeOptionsWithGuard). A child that sets its own NODE_OPTIONS brings its
//    own stub. Bun ignores NODE_OPTIONS=--import.
//  - Spawned Bun processes (`bun -e`, `bun script.ts`) whose working directory is the repository root: the root
//    bunfig.toml preloads production-origin-guard-bun-preload.mjs, which arms the wrapper only when the
//    TC_TEST_PRODUCTION_GUARD marker (set by the test bootstrap, inherited through process.env) is present, so
//    a developer's own `bun run` in the repository is untouched. BUN_OPTIONS=--preload is not used: Bun puts it
//    before the sub-command, which breaks any child that runs `bun test`, `bun run` or `bun install`.
//    A Bun child started in another directory is not covered.
// An origin variable that is explicitly production is refused at arm time in the test process only. A child
// arms the fetch refusal alone (armProductionFetchGuard), so a test that names the production origin on purpose
// as data (a staged request matched by its origin) can still start its child; the request itself is refused.

/** The environment marker the test bootstrap sets so a Bun child's bunfig preload knows it runs under test. */
export const GUARD_MARKER = "TC_TEST_PRODUCTION_GUARD";

const PRODUCTION_LINKS_ORIGINS = new Set(["https://api.tinycloud.xyz"]);
const ORIGIN_VARIABLES = ["TC_LINKS_API_ORIGIN", "COURIER_LINKS_API_ORIGIN"];

export function isProductionLinksOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return PRODUCTION_LINKS_ORIGINS.has(`${url.protocol}//${url.hostname.replace(/\.$/, "")}${url.port === "" ? "" : `:${url.port}`}`);
}

const refusal = (what) => new Error(
  `Tests must not use the production links API (${what}). Inject a fetch stub or point TC_LINKS_API_ORIGIN / ` +
  `COURIER_LINKS_API_ORIGIN at a local fixture.`,
);

/** Refuse requests to the production links API through `target.fetch`, once; leaves the origin variables alone. */
export function armProductionFetchGuard(target = globalThis) {
  const real = target.fetch;
  if (typeof real !== "function" || real.productionOriginGuard === true) return;
  target.fetch = Object.assign(async function guardedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isProductionLinksOrigin(url)) throw refusal(`${init?.method ?? input?.method ?? "GET"} ${url}`);
    return real.call(this, input, init);
  }, real, { productionOriginGuard: true });
}

export function armProductionOriginGuard(environment = process.env, target = globalThis) {
  for (const name of ORIGIN_VARIABLES) {
    const value = environment[name];
    if (value !== undefined && isProductionLinksOrigin(value)) throw refusal(`${name}=${value}`);
  }
  armProductionFetchGuard(target);
}

/** NODE_OPTIONS for a spawned Node process that should carry the same guard. */
export function nodeOptionsWithGuard(existing, preloadUrl = new URL("./production-origin-guard-preload.mjs", import.meta.url).href) {
  const flag = `--import=${preloadUrl}`;
  return existing?.includes(flag) ? existing : [existing, flag].filter(Boolean).join(" ");
}

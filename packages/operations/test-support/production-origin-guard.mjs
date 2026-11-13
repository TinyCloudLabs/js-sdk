// Test-only: refuse the production links API, location registry, TinyCloud nodes and OpenKey under test, so a test that
// forgot its fetch stub or its origin fails fast instead of calling production (for example POSTing to
// https://api.tinycloud.xyz/v1/links). A test that must reach one on purpose opts in per test (see ALLOW_VARIABLE).
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

/** The production origins a test must not reach unless it opts in, with what each one is (named in the refusal). */
const PRODUCTION_ORIGINS = new Map([
  ["https://api.tinycloud.xyz", "links API"],
  ["https://registry.tinycloud.xyz", "location registry"],
  ["https://node.tinycloud.xyz", "TinyCloud node"],
  ["https://tee.node.tinycloud.xyz", "TinyCloud node (TEE)"],
  ["https://openkey.so", "OpenKey"],
  ["https://api.openkey.so", "OpenKey API"],
]);
const ORIGIN_VARIABLES = ["TC_LINKS_API_ORIGIN", "COURIER_LINKS_API_ORIGIN"];

/**
 * The explicit per-test opt-in: a test that must reach a production host on purpose sets this to that host name
 * (comma-separated for several) for itself. Read at request time, so it is scoped to the test that sets it, and never
 * honoured when CI is set.
 */
export const ALLOW_VARIABLE = "TC_TEST_ALLOW_PRODUCTION_HOSTS";

function classify(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/\.$/, "");
  const label = PRODUCTION_ORIGINS.get(`${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}`);
  return label === undefined ? undefined : { host, label };
}

/** What production service `value` names ("links API", "location registry", ...), or undefined. */
export function productionOriginLabel(value) {
  return classify(value)?.label;
}

export function isProductionLinksOrigin(value) {
  return classify(value)?.label === "links API";
}

function optedIn(host, environment) {
  const ci = environment.CI;
  if (ci && ci !== "0" && ci !== "false") return false;
  return (environment[ALLOW_VARIABLE] ?? "").split(",").some((entry) => entry.trim().toLowerCase().replace(/\.$/, "") === host);
}

const refusal = (what, label = "links API") => new Error(
  `Tests must not use the production ${label} (${what}). Inject a fetch stub or ` +
  `${label === "links API" ? "point TC_LINKS_API_ORIGIN / COURIER_LINKS_API_ORIGIN" : "point the test"} at a local fixture. ` +
  `A test that must reach it on purpose sets ${ALLOW_VARIABLE}=<host> for itself; that is never honoured when CI is set.`,
);

/** Refuse requests to the production hosts through `target.fetch`, once; leaves the origin variables alone. */
export function armProductionFetchGuard(target = globalThis, environment = process.env) {
  const real = target.fetch;
  if (typeof real !== "function" || real.productionOriginGuard === true) return;
  target.fetch = Object.assign(async function guardedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const found = classify(url);
    if (found && !optedIn(found.host, environment)) throw refusal(`${init?.method ?? input?.method ?? "GET"} ${url}`, found.label);
    return real.call(this, input, init);
  }, real, { productionOriginGuard: true });
}

export function armProductionOriginGuard(environment = process.env, target = globalThis) {
  for (const name of ORIGIN_VARIABLES) {
    const value = environment[name];
    if (value !== undefined && isProductionLinksOrigin(value)) throw refusal(`${name}=${value}`);
  }
  armProductionFetchGuard(target, environment);
}

/** NODE_OPTIONS for a spawned Node process that should carry the same guard. */
export function nodeOptionsWithGuard(existing, preloadUrl = new URL("./production-origin-guard-preload.mjs", import.meta.url).href) {
  const flag = `--import=${preloadUrl}`;
  return existing?.includes(flag) ? existing : [existing, flag].filter(Boolean).join(" ");
}

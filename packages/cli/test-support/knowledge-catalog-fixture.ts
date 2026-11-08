import "../../operations/test-support/test-bootstrap.mjs";
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PinnedApp } from "../src/lib/apps-install-pin";

export const KNOWLEDGE_CATALOG_FIXTURE_ENV = "TC_KNOWLEDGE_CATALOG_FIXTURE";

export interface KnowledgeCatalogFixture {
  readonly descriptorPath: string;
  stop(): void;
}

// Only the explicit apps-install child preloads this descriptor. The installer,
// byte-integrity checks, SDK, and native KV/SQL transport remain real.
const descriptor = process.env[KNOWLEDGE_CATALOG_FIXTURE_ENV];
if (descriptor) {
  const { origin, entry } = JSON.parse(readFileSync(descriptor, "utf8")) as {
    origin: string;
    entry: PinnedApp;
  };
  mock.module(new URL("../src/lib/apps-install-pin.ts", import.meta.url).pathname, () => ({
    SHARE_ORIGIN: origin,
    pinnedApp: (appId: string) => appId === entry.appId ? entry : undefined,
  }));
}

export async function startKnowledgeCatalogFixture(root: string): Promise<KnowledgeCatalogFixture> {
  // This module also preloads children: static installer imports would evaluate
  // its catalog consumer before the child installs the catalog module mock.
  const { pinnedApp } = await import("../src/lib/apps-install-pin");
  const { sha256Hex } = await import("../src/lib/apps-install");
  const source = pinnedApp("xyz.tinycloud.sample.healthlog");
  if (!source) throw new Error("The healthlog catalog fixture is missing its source entry.");
  const schema = new Uint8Array(await readFile(new URL("../src/lib/apps-install.healthlog.schema.sql", import.meta.url)));
  const schemaPin = source.files.find((file) => file.path === "schema.sql");
  if (schemaPin?.size !== schema.length || schemaPin.sha256 !== sha256Hex(schema)) {
    throw new Error("The committed TEST schema does not match its existing catalog pin.");
  }

  // The public Share markdown is not vendored. These are explicitly TEST bytes,
  // not a claim that the original public bundle or its pins were exercised.
  const assets = new Map(source.files.map((file) => [
    file.path,
    file.path === "schema.sql" ? schema : new TextEncoder().encode(`# TEST-only catalog fixture\n\n${file.path}\n`),
  ]));
  const files = source.files.map(({ path }) => {
    const bytes = assets.get(path)!;
    return { path, size: bytes.length, sha256: sha256Hex(bytes) };
  });
  const entry: PinnedApp = {
    ...source,
    bundleDigest: `test-tc2481-${sha256Hex(new TextEncoder().encode(JSON.stringify(files)))}`,
    files,
  };
  const served = new Map([...assets].map(([path, bytes]) => [`/apps/b/${entry.bundleDigest}/${path}`, bytes]));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method !== "GET") return new Response("GET required", { status: 405 });
      const url = new URL(request.url);
      const bytes = served.get(url.pathname + url.search);
      return bytes === undefined ? new Response("Unknown TEST catalog asset", { status: 404 }) : new Response(bytes);
    },
  });
  const descriptorPath = join(root, "test-only-knowledge-catalog.json");
  try {
    await writeFile(descriptorPath, JSON.stringify({ origin: server.url.origin, entry }), { mode: 0o600 });
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return { descriptorPath, stop: () => server.stop(true) };
}

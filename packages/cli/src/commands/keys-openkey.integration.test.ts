import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { extractRecapAttenuations } from "@tinycloud/sdk-core";
import { profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

const PROFILE = "owner";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const KEY_CREATE = "tinycloud.encryption/key.create";
const DECRYPT = "tinycloud.encryption/decrypt";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

type Approval = "all" | "row-unticked" | "create-only";

/**
 * What OpenKey's approval page does to the encryption row: keep it, drop it, or keep one ability.
 * It rewrites the statement to describe the narrowed ReCap, as the node-side proof check requires.
 */
function narrow(siwe: string, resource: string, keep: string[]): string {
  const item = ` (8) 'tinycloud.encryption': 'decrypt', 'key.create' for '${resource}'.`;
  expect(siwe).toContain(item);
  const abilities = keep.map((ability) => `'${ability.split("/")[1]}'`).join(", ");
  const rewritten = siwe.replace(item, keep.length === 0 ? "" : ` (8) 'tinycloud.encryption': ${abilities} for '${resource}'.`);
  return rewritten.split("\n").map((line) => {
    const match = /^(- urn:recap:)([A-Za-z0-9_-]+=*)$/.exec(line);
    if (!match) return line;
    const recap = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown>> };
    if (!(resource in recap.att)) return line;
    if (keep.length === 0) delete recap.att[resource];
    else recap.att[resource] = Object.fromEntries(keep.map((ability) => [ability, recap.att[resource]![ability]]));
    return `${match[1]}${Buffer.from(JSON.stringify(recap)).toString("base64url")}`;
  }).join("\n");
}

async function setup(features = ["encryption-named-keys-v1"]) {
  const home = await mkdtemp("/var/tmp/tc2034-okkeys-");
  homes.push(home);
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response(`Unsupported stub node request: ${path}`, { status: 404 });
  } });
  servers.push(node);
  const openKeyApi = Bun.serve({ port: 0, fetch: () => Response.json({ cancelled: true }) });
  servers.push(openKeyApi);
  const signer = new PrivateKeySigner(OWNER_KEY);
  const address = await signer.getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const directory = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: "did:key:prior",
      ownerDid, posture: "owner-openkey", authMethod: "openkey", createdAt: "2026-10-01T00:00:00.000Z",
    });
    return profilePath(PROFILE);
  });
  const sessionFile = await withTinyCloudStateRoot(home, () => Promise.resolve(sessionPath(PROFILE)));
  return { home, node, openKeyApi, signer, ownerDid, directory, sessionFile, resource: `urn:tinycloud:encryption:${ownerDid}:default/qa/` };
}

async function keysLogin(approval: Approval, folder = "qa/") {
  const t = await setup();
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "openkey", "--keys", folder, "--owner", t.ownerDid, "--no-popup"], {
    env: { ...process.env, HOME: t.home, TC_HOME: t.home, TC_OPENKEY_HOST: "https://openkey.test", TC_OPENKEY_API_HOST: t.openKeyApi.url.origin },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stderr.getReader();
  let stderr = "";
  let url: string | undefined;
  const stalled = Promise.withResolvers<"stalled">();
  const timer = setTimeout(() => stalled.resolve("stalled"), 15_000);
  while (true) {
    const next = await Promise.race([reader.read(), stalled.promise]);
    if (next === "stalled" || next.done) break;
    stderr += new TextDecoder().decode(next.value);
    url = /(https:\/\/openkey\.test\/delegate#tv2=[A-Za-z0-9_-]+)(?:\x1b\[[0-9;]*m)*\r?\n/.exec(stderr)?.[1];
    if (url) break;
  }
  clearTimeout(timer);
  if (!url) { child.kill("SIGKILL"); throw new Error(`no hand-off URL: ${stderr}`); }
  const payload = JSON.parse(Buffer.from(new URL(url).hash.slice("#tv2=".length), "base64url").toString("utf8")) as {
    request: { siwe: string }; delivery: { callback: string; state: string };
  };
  const prepared = payload.request.siwe;
  const signedMessage = approval === "all" ? prepared
    : narrow(prepared, t.resource, approval === "create-only" ? [KEY_CREATE] : []);
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  const { parseCanonicalRecapResource } = await import("@tinycloud/sdk-core");
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(signedMessage))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const service = ability.slice(0, ability.indexOf("/"));
      if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      grouped.set(service, [...(grouped.get(service) ?? []), ability]);
    }
    for (const [service, granted] of grouped) permissions.push({ service, space, path, actions: granted });
  }
  const envelope = { transportVersion: 2, state: payload.delivery.state, result: {
    protocolVersion: 1, address: await t.signer.getAddress(), signature: await t.signer.signMessage(signedMessage),
    signedMessage, selectedActionKeys, permissions } };
  await fetch(payload.delivery.callback, { method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  while (true) { const { value, done } = await reader.read(); if (done) break; stderr += new TextDecoder().decode(value); }
  const exists = await access(t.sessionFile).then(() => true, () => false);
  const profile = await withTinyCloudStateRoot(t.home, async () =>
    JSON.parse(await readFile(profileConfigPath(PROFILE), "utf8")) as Record<string, unknown>);
  return { ...t, prepared, stdout, stderr, exitCode, sessionStored: exists, profile };
}

test("OpenKey --keys with everything approved records the folder and signs the requested ReCap", async () => {
  const r = await keysLogin("all");
  expect(r.exitCode, r.stderr).toBe(0);
  expect(r.stderr).toContain('encryption keys in the folder "qa/"');
  expect(r.profile.namedKeys).toEqual({ prefix: "qa", resource: r.resource });
  const stored = JSON.parse(await readFile(r.sessionFile, "utf8")) as { siwe: string };
  expect(extractRecapAttenuations(stored.siwe)[r.resource]).toBeDefined();
});

test("the prepared ReCap equals a prepared sign-in without --keys plus exactly the one encryption row", async () => {
  const r = await keysLogin("all");
  const bare = new TinyCloudNode({
    host: r.node.url.origin, signer: new PrivateKeySigner(OWNER_KEY),
    includeAccountRegistryPermissions: false, autoBootstrapAccount: false,
  });
  let plain: string | undefined;
  await bare.signInWithOpenKey(async (prepared: { siwe: string }) => { plain = prepared.siwe; throw new Error("stop"); }).catch(() => undefined);
  expect(plain).toBeDefined();
  const withKeys = extractRecapAttenuations(r.prepared) as Record<string, Record<string, unknown>>;
  const without = extractRecapAttenuations(plain!) as Record<string, Record<string, unknown>>;
  expect(Object.keys(withKeys).filter((key) => !(key in without))).toEqual([r.resource]);
  expect(Object.keys(withKeys[r.resource]!).sort()).toEqual([DECRYPT, KEY_CREATE].sort());
  const { [r.resource]: _row, ...rest } = withKeys;
  expect(rest).toEqual(without);
});

test("OpenKey --keys with the row unticked still signs in, records no folder and says so", async () => {
  const r = await keysLogin("row-unticked");
  expect(r.exitCode, r.stderr).toBe(0);
  expect(r.sessionStored).toBe(true);
  expect(r.profile.namedKeys).toBeUndefined();
  expect(r.stderr).toContain("can't use named keys yet");
});

test("OpenKey --keys with only one ability approved stores nothing and exits 5", async () => {
  const r = await keysLogin("create-only");
  expect(r.exitCode).toBe(5);
  expect(r.stderr + r.stdout).toContain("KEYS_PARTIAL_GRANT");
  expect(r.sessionStored).toBe(false);
  expect(r.profile.namedKeys).toBeUndefined();
});

test("OpenKey --keys with an apps/ folder is refused before the hand-off opens", async () => {
  const t = await setup();
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "openkey", "--keys", "apps/x", "--owner", t.ownerDid, "--no-popup"], {
    env: { ...process.env, HOME: t.home, TC_HOME: t.home, TC_OPENKEY_HOST: "https://openkey.test", TC_OPENKEY_API_HOST: t.openKeyApi.url.origin },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(2);
  expect(err + out).not.toContain("openkey.test/delegate");
});

test("OpenKey --keys against a node without named keys is refused before the hand-off opens", async () => {
  const t = await setup(["sql"]);
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "openkey", "--keys", "qa", "--owner", t.ownerDid, "--no-popup"], {
    env: { ...process.env, HOME: t.home, TC_HOME: t.home, TC_OPENKEY_HOST: "https://openkey.test", TC_OPENKEY_API_HOST: t.openKeyApi.url.origin },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(7);
  expect(err + out).not.toContain("openkey.test/delegate");
});

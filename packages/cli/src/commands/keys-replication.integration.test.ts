import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
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

/** What OpenKey's page does to the encryption row, rewriting the statement to match. */
function keepAbilities(siwe: string, resource: string, keep: string[]): string {
  const found = new RegExp(` \\((\\d+)\\) 'tinycloud\\.encryption': 'decrypt', 'key\\.create' for '${resource}'\\.`).exec(siwe);
  expect(found).not.toBeNull();
  const abilities = keep.map((ability) => `'${ability.split("/")[1]}'`).join(", ");
  const rewritten = siwe.replace(found![0], ` (${found![1]}) 'tinycloud.encryption': ${abilities} for '${resource}'.`);
  return rewritten.split("\n").map((line) => {
    const match = /^(- urn:recap:)([A-Za-z0-9_-]+=*)$/.exec(line);
    if (!match) return line;
    const recap = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown>> };
    if (!(resource in recap.att)) return line;
    recap.att[resource] = Object.fromEntries(keep.map((ability) => [ability, recap.att[resource]![ability]]));
    return `${match[1]}${Buffer.from(JSON.stringify(recap)).toString("base64url")}`;
  }).join("\n");
}

async function replicaLogin(options: { keys?: string; approve?: "all" | "create-only" } = {}) {
  const home = await mkdtemp("/var/tmp/tc2034b-repl-");
  homes.push(home);
  let delegations = 0;
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: ["encryption-named-keys-v1"] });
    if (path === "/delegate" && request.method === "POST") { delegations += 1; return Response.json({ activated: [], skipped: [] }); }
    return new Response(`Unexpected node request: ${path}`, { status: 404 });
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
  const resource = `urn:tinycloud:encryption:${ownerDid}:default/qa/`;
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "openkey", "--replication-prefix", "notes/", "--owner", ownerDid, "--no-popup",
    ...(options.keys === undefined ? [] : ["--keys", options.keys])], {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: "https://openkey.test", TC_OPENKEY_API_HOST: openKeyApi.url.origin },
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
  const handoffs = (stderr.match(/openkey\.test\/delegate#tv2=/g) ?? []).length;
  const payload = JSON.parse(Buffer.from(new URL(url).hash.slice("#tv2=".length), "base64url").toString("utf8")) as {
    request: { siwe: string }; delivery: { callback: string; state: string };
  };
  const prepared = payload.request.siwe;
  const signedMessage = options.approve === "create-only" ? keepAbilities(prepared, resource, [KEY_CREATE]) : prepared;
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [res, actions] of Object.entries(extractRecapAttenuations(signedMessage))) {
    const { space, path } = parseCanonicalRecapResource(res);
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const service = ability.slice(0, ability.indexOf("/"));
      if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      grouped.set(service, [...(grouped.get(service) ?? []), ability]);
    }
    for (const [service, granted] of grouped) permissions.push({ service, space, path, actions: granted });
  }
  const envelope = { transportVersion: 2, state: payload.delivery.state, result: {
    protocolVersion: 1, address, signature: await signer.signMessage(signedMessage), signedMessage, selectedActionKeys, permissions } };
  await fetch(payload.delivery.callback, { method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  while (true) { const { value, done } = await reader.read(); if (done) break; stderr += new TextDecoder().decode(value); }
  const profile = await withTinyCloudStateRoot(home, async () =>
    JSON.parse(await readFile(profileConfigPath(PROFILE), "utf8")) as Record<string, unknown>);
  const session = await readFile(await withTinyCloudStateRoot(home, () => Promise.resolve(sessionPath(PROFILE))), "utf8")
    .then((text) => JSON.parse(text) as { siwe: string }, () => null);
  return { prepared, stdout, stderr, exitCode, profile, session, resource, handoffs, directory };
}

const recapOf = (siwe: string) => extractRecapAttenuations(siwe) as Record<string, Record<string, unknown>>;

test("OpenKey --keys with a replication prefix opens one hand-off whose ReCap is the replica request plus exactly the key row", async () => {
  const withKeys = await replicaLogin({ keys: "qa/" });
  expect(withKeys.exitCode, withKeys.stderr).toBe(0);
  expect(withKeys.handoffs).toBe(1);
  const bare = await replicaLogin();
  expect(bare.exitCode, bare.stderr).toBe(0);
  const keyed = recapOf(withKeys.prepared);
  const plain = recapOf(bare.prepared);
  expect(Object.keys(keyed).filter((key) => !(key in plain))).toEqual([withKeys.resource]);
  expect(Object.keys(keyed[withKeys.resource]!).sort()).toEqual([DECRYPT, KEY_CREATE].sort());
  const { [withKeys.resource]: _row, ...rest } = keyed;
  expect(rest).toEqual(plain);
  expect(withKeys.profile.namedKeys).toEqual({ prefix: "qa", resource: withKeys.resource });
  expect(withKeys.profile.replication).toEqual({ prefixes: ["notes/"] });
  expect(withKeys.session).not.toBeNull();
  expect(recapOf(withKeys.session!.siwe)[withKeys.resource]).toBeDefined();
  expect(bare.profile.namedKeys).toBeUndefined();
}, 60_000);

test("OpenKey --keys with a replication prefix and one ability approved stores nothing and exits 5", async () => {
  const r = await replicaLogin({ keys: "qa/", approve: "create-only" });
  expect(r.exitCode).toBe(5);
  expect(r.stderr + r.stdout).toContain("KEYS_PARTIAL_GRANT");
  expect(r.session).toBeNull();
  expect(r.profile.namedKeys).toBeUndefined();
  expect(r.profile.replication).toBeUndefined();
}, 60_000);

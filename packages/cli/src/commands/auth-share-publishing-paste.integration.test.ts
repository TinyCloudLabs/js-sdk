import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { profileConfigPath, profilePath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

// A real CLI process, a local node stub and an OpenKey paste handoff signed by a throwaway key:
// `auth login --paste --manifest builtin:share-publishing` requests only the owner's default/share/ decrypt prefix.
const PROFILE = "publisher";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("paste sign-in for builtin:share-publishing requests the default/share/ prefix and no root decrypt", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2177-paste-"));
  homes.push(home);
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response(`Unexpected node request: ${path}`, { status: 404 });
  } });
  servers.push(node);
  const openKeyApi = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });
  servers.push(openKeyApi);
  const signer = new PrivateKeySigner(OWNER_KEY);
  const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
  const directory = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: "did:key:prior",
      ownerDid, posture: "owner-openkey", authMethod: "openkey", createdAt: "2026-10-01T00:00:00.000Z",
    });
    return profilePath(PROFILE);
  });
  const argv = [process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "openkey", "--paste", "--manifest", "builtin:share-publishing", "--owner", ownerDid];
  const child = Bun.spawn(argv, {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: "https://openkey.test", TC_OPENKEY_API_HOST: openKeyApi.url.origin },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stderr.getReader();
  let stderr = "";
  let url: string | undefined;
  const stalled = Promise.withResolvers<"stalled">();
  const stallTimer = setTimeout(() => stalled.resolve("stalled"), 15_000);
  while (true) {
    const next = await Promise.race([reader.read(), stalled.promise]);
    if (next === "stalled" || next.done) break;
    stderr += new TextDecoder().decode(next.value);
    url = /(https:\/\/openkey\.test\/delegate\?\S+)\r?\n/.exec(stderr)?.[1];
    if (url) break;
  }
  clearTimeout(stallTimer);
  if (!url) {
    child.kill("SIGKILL");
    throw new Error(`CLI did not issue a paste URL: ${stderr}`);
  }
  // OpenKey's side: build what the owner signs from the URL's request, and hand back the delegation code.
  const query = new URL(url).searchParams;
  const sessionDid = query.get("did")!;
  const jwk = JSON.parse(Buffer.from(query.get("jwk")!, "base64url").toString("utf8")) as Record<string, string>;
  const asked = (JSON.parse(Buffer.from(query.get("permissions")!, "base64url").toString("utf8")) as {
    permissions: Array<{ service: string; space: string; path: string; actions: string[] }>;
  }).permissions;
  const requestedDecrypt = asked.filter((permission) => permission.service === "tinycloud.encryption");
  const wasm = new NodeWasmBindings();
  const address = await signer.getAddress();
  const abilities: Record<string, Record<string, string[]>> = {};
  const rawAbilities: Record<string, string[]> = {};
  let spaceId = "";
  for (const permission of asked) {
    if (permission.service === "tinycloud.encryption") rawAbilities[permission.path] = permission.actions;
    else {
      spaceId = permission.space;
      (abilities[permission.service.slice("tinycloud.".length)] ??= {})[permission.path] = permission.actions;
    }
  }
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities, ...(Object.keys(rawAbilities).length ? { rawAbilities } : {}), address, chainId: 1, domain: "openkey.test", spaceId, jwk,
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const delegation = {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    jwk, verificationMethod: sessionDid, address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature, expiresAt, hostActivated: true,
  };
  child.stdin.write(JSON.stringify(delegation) + "\n");
  child.stdin.end();
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  await reader.cancel().catch(() => undefined);
  expect({ exitCode, rest: exitCode === 0 ? "" : stderr, requestedDecrypt }).toEqual({
    exitCode: 0, rest: "",
    requestedDecrypt: [{ service: "tinycloud.encryption", space: "encryption", path: `urn:tinycloud:encryption:${ownerDid}:default/share/`, actions: ["tinycloud.encryption/decrypt"] }],
  });
  expect(JSON.parse(stdout).authenticated).toBe(true);
  const stored = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as { permissions?: Array<{ service: string; path: string; actions: string[] }> };
  const storedDecrypt = (stored.permissions ?? []).filter((permission) => permission.service === "tinycloud.encryption");
  expect(storedDecrypt).toHaveLength(1);
  expect(storedDecrypt[0]!.actions).toEqual(["tinycloud.encryption/decrypt"]);
  expect(storedDecrypt[0]!.path.toLowerCase()).toBe(`urn:tinycloud:encryption:${ownerDid}:default/share/`.toLowerCase());
}, 60_000);

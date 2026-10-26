import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { profilePath, withTinyCloudStateRoot } from "@tinycloud/operations/state";

const PROFILE = "qaflip";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** `tc auth login --method openkey --keys qa` on an isolated HOME that has no profile yet. */
async function loginWithoutProfile(approve: boolean) {
  const home = await mkdtemp(join(tmpdir(), "tc2067-login-"));
  homes.push(home);
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: ["encryption-named-keys-v1"] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response(`Unexpected node request: ${path}`, { status: 404 });
  } });
  servers.push(node);
  const signer = new PrivateKeySigner(OWNER_KEY);
  const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
  const directory = await withTinyCloudStateRoot(home, async () => profilePath(PROFILE));
  const child = Bun.spawn([
    process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, "--host", node.url.origin,
    "auth", "login", "--method", "openkey", "--owner", ownerDid, "--keys", "qa", "--paste",
  ], {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: "https://openkey.test" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stderr.getReader();
  let stderr = "";
  let url: string | undefined;
  // A CLI that never prints the URL must fail with its output, not stall the suite; the child is a real process.
  const stalled = Promise.withResolvers<"stalled">();
  const stallTimer = setTimeout(() => stalled.resolve("stalled"), 15_000);
  while (true) {
    const next = await Promise.race([reader.read(), stalled.promise]);
    if (next === "stalled" || next.done) break;
    stderr += new TextDecoder().decode(next.value);
    url = /(https:\/\/openkey\.test\/delegate#tv2=[A-Za-z0-9_-]+)/.exec(stderr)?.[1];
    if (url) break;
  }
  clearTimeout(stallTimer);
  if (!url) {
    child.kill("SIGKILL");
    throw new Error(`CLI did not print the OpenKey URL (exit ${await child.exited}): ${stderr}`);
  }
  if (!approve) {
    child.stdin.end();
    const exitCode = await child.exited;
    return { directory, exitCode, stdout: await new Response(child.stdout).text(), ownerDid };
  }
  const payload = JSON.parse(Buffer.from(new URL(url).hash.slice("#tv2=".length), "base64url").toString("utf8")) as {
    state?: string;
    request: { siwe: string };
    delivery: { state: string };
  };
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(payload.request.siwe))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const service = ability.slice(0, ability.indexOf("/"));
      if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      grouped.set(service, [...(grouped.get(service) ?? []), ability]);
    }
    for (const [service, granted] of grouped) permissions.push({ service, space, path, actions: granted });
  }
  const envelope = {
    transportVersion: 2, state: payload.delivery.state,
    result: { protocolVersion: 1, address: await signer.getAddress(),
      signature: await signer.signMessage(payload.request.siwe), signedMessage: payload.request.siwe,
      selectedActionKeys, permissions },
  };
  child.stdin.write(Buffer.from(JSON.stringify(envelope)).toString("base64url") + "\n");
  child.stdin.end();
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { directory, exitCode, stdout, ownerDid };
}

test("auth login on a missing profile creates it, with its key and session, once the approval verifies", async () => {
  const { directory, exitCode, stdout, ownerDid } = await loginWithoutProfile(true);
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout).authenticated).toBe(true);
  const profile = JSON.parse(await readFile(join(directory, "profile.json"), "utf8")) as {
    name: string; ownerDid: string; authMethod: string; posture: string; did: string; sessionDid: string; namedKeys?: { prefix: string };
  };
  expect(profile.name).toBe(PROFILE);
  expect(profile.ownerDid).toBe(ownerDid);
  expect(profile.authMethod).toBe("openkey");
  expect(profile.posture).toBe("owner-openkey");
  expect(profile.namedKeys?.prefix).toBe("qa");
  const session = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as { verificationMethod: string };
  expect(session.verificationMethod).toBe(profile.sessionDid);
  const key = JSON.parse(await readFile(join(directory, "key.json"), "utf8")) as { d?: string };
  expect(typeof key.d).toBe("string");
}, 60_000);

test("an abandoned login on a missing profile leaves no profile behind", async () => {
  const { directory, exitCode } = await loginWithoutProfile(false);
  expect(exitCode).not.toBe(0);
  expect(await Bun.file(join(directory, "profile.json")).exists()).toBe(false);
  expect(await Bun.file(join(directory, "key.json")).exists()).toBe(false);
  expect(await Bun.file(join(directory, "session.json")).exists()).toBe(false);
}, 60_000);

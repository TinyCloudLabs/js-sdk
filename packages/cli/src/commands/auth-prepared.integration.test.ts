import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { restoreSessionStamp } from "@tinycloud/replica/profile-gate";
import { profileConfigPath, profilePath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

const PROFILE = "owner";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function preparedLogin(transport: "callback" | "paste", behavior: "success" | "invalid-signature" | "cancel" | "paste-eof" = "success") {
  const home = await mkdtemp(join(tmpdir(), `tc858-prepared-${transport}-`));
  homes.push(home);
  const requests: string[] = [];
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response(`Unexpected node request: ${path}`, { status: 404 });
  } });
  servers.push(node);
  const signer = new PrivateKeySigner(OWNER_KEY);
  const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
  const directory = await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: "did:key:prior",
      ownerDid, posture: "owner-openkey", authMethod: "openkey",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    return profilePath(PROFILE);
  });
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "openkey", "--replication-prefix", "notes/", "--owner", ownerDid,
    ...(transport === "paste" ? ["--paste"] : ["--no-popup"])], {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: "https://openkey.test" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stderr.getReader();
  let stderr = "";
  let url: string | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    stderr += new TextDecoder().decode(value);
    url = /https:\/\/openkey\.test\/delegate#tv2=[A-Za-z0-9_-]+/.exec(stderr)?.[0];
    if (url) break;
  }
  if (!url) {
    child.kill();
    throw new Error(`CLI did not issue SDK-prepared v2 URL: ${stderr}`);
  }
  const encoded = new URL(url).hash.slice("#tv2=".length);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    transportVersion: number;
    request: { siwe: string; jwk: Record<string, unknown>; sessionDid: string };
    delivery: { callback?: string; state: string; handoffId: string; cancelSecret: string };
  };
  expect(payload.transportVersion).toBe(2);
  expect(payload.request.jwk.d).toBeUndefined();
  expect(payload.request.sessionDid).toMatch(/^did:key:/);
  expect(payload.request.siwe).toContain(payload.request.sessionDid);
  expect(payload.delivery.handoffId).not.toBe(payload.delivery.state);
  expect(payload.delivery.cancelSecret).not.toBe(payload.delivery.state);
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
  if (behavior === "cancel") {
    child.kill("SIGINT");
    await child.exited;
    expect(await Bun.file(join(directory, "key.json")).exists()).toBe(false);
    expect(await Bun.file(join(directory, "session.json")).exists()).toBe(false);
    await expect(fetch(payload.delivery.callback!, {
      method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    })).rejects.toThrow();
    return;
  }
  if (behavior === "paste-eof") {
    child.stdin.end();
    const exitCode = await child.exited;
    expect(exitCode).not.toBe(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += new TextDecoder().decode(value);
    }
    expect(stderr).toContain("PASTE_CODE_MISSING");
    expect(await Bun.file(join(directory, "key.json")).exists()).toBe(false);
    expect(await Bun.file(join(directory, "session.json")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(directory, "profile.json"), "utf8")).did).toBe("did:key:prior");
    return;
  }
  if (behavior === "invalid-signature") {
    envelope.result.signature = await signer.signMessage(`${payload.request.siwe} rejected`);
  }
  let accepted: { accepted: boolean } | undefined;
  if (transport === "callback") {
    expect(payload.delivery.callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]+$/);
    const response = await fetch(payload.delivery.callback!, {
      method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    accepted = await response.json() as { accepted: boolean };
    expect(response.status).toBe(behavior === "invalid-signature" ? 422 : 200);
  } else {
    expect(payload.delivery.callback).toBeUndefined();
    child.stdin.write(Buffer.from(JSON.stringify(envelope)).toString("base64url") + "\n");
    child.stdin.end();
  }
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  await reader.cancel().catch(() => undefined);
  if (behavior === "invalid-signature") {
    expect(exitCode).not.toBe(0);
    expect(accepted).toEqual({ accepted: false });
    expect(await Bun.file(join(directory, "key.json")).exists()).toBe(false);
    expect(await Bun.file(join(directory, "session.json")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(directory, "profile.json"), "utf8")).did).toBe("did:key:prior");
    return;
  }
  expect(exitCode).toBe(0);
  if (transport === "callback") expect(accepted).toEqual({ accepted: true });
  if (transport === "callback") {
    await expect(fetch(payload.delivery.callback!, {
      method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    })).rejects.toThrow();
  }
  const stored = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as {
    ownerDid: string; verificationMethod: string; replicaStamp: Parameters<typeof restoreSessionStamp>[2];
  };
  expect(stored.ownerDid).toBe(ownerDid);
  expect(stored.verificationMethod).toBe(payload.request.sessionDid);
  expect(await restoreSessionStamp(directory, ownerDid, stored.replicaStamp)).toEqual(stored.replicaStamp);
  const storedProfile = JSON.parse(await readFile(join(directory, "profile.json"), "utf8")) as {
    sessionDid: string; replication: { prefixes: string[] };
  };
  expect(storedProfile.sessionDid).toBe(payload.request.sessionDid);
  expect(storedProfile.replication.prefixes).toEqual(["notes/"]);
  expect(JSON.parse(stdout).authenticated).toBe(true);
  expect(requests).toContain("/delegate");
}

test("prepared OpenKey callback ACK follows verified SDK sign-in and durable stamped CLI commit", () => preparedLogin("callback"), 30_000);
test("prepared OpenKey paste accepts the same signed envelope and persists verified stamp", () => preparedLogin("paste"), 30_000);
test("invalid signed callback receives no ACK and leaves the previous profile and key unchanged", () => preparedLogin("callback", "invalid-signature"), 30_000);
test("preclaim cancellation removes the uncommitted key and rejects a late signed callback", () => preparedLogin("callback", "cancel"), 30_000);
test("preclaim paste cancellation by stdin EOF shreds the prepared key and preserves the prior profile", () => preparedLogin("paste", "paste-eof"), 30_000);

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKeySigner, sqliteReplicaStorage } from "@tinycloud/node-sdk";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { REPLICA_DENY_FLOOR_FILE, restoreSessionStamp } from "@tinycloud/replica/profile-gate";
import { profileConfigPath, profilePath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";

const PROFILE = "owner";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

type Behavior = "success" | "invalid-signature" | "cancel" | "cancel-tty" | "paste-eof" | "expire" | "commit-failure";
const FAST_EXPIRY = join(import.meta.dir, "../../test-support/fast-openkey-expiry.ts");

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/** A hang regression must fail, not stall the suite; the child is killed at the deadline. */
async function exitWithin(child: { exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void }, ms: number): Promise<number | "timeout"> {
  // Real time is the subject here: the CLI must exit on its own.
  const deadline = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => deadline.resolve("timeout"), ms);
  const exit = await Promise.race([child.exited, deadline.promise]);
  clearTimeout(timer);
  if (exit === "timeout") child.kill("SIGKILL");
  return exit;
}

/**
 * One prepared OpenKey login. With `priorHome`, it re-logs into that home's existing profile
 * (and its live session) instead of a fresh one; a failed attempt must leave both unchanged.
 */
async function preparedLogin(transport: "callback" | "paste", behavior: Behavior = "success", priorHome?: string) {
  const home = priorHome ?? await mkdtemp(join(tmpdir(), `tc858-prepared-${transport}-`));
  if (!priorHome) homes.push(home);
  const requests: string[] = [];
  const invokedResources: string[] = [];
  const node = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/invoke") {
      // The invocation's capability targets, e.g. `<space>/sql/account`.
      const payload = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "").split(".")[1] ?? "";
      const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8") || "{}");
      if (typeof claims === "object" && claims !== null && "att" in claims && typeof claims.att === "object" && claims.att !== null) {
        invokedResources.push(...Object.keys(claims.att));
      }
    }
    if (path === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (path === "/delegate" && request.method === "POST") return Response.json({ activated: [], skipped: [] });
    return new Response(`Unexpected node request: ${path}`, { status: 404 });
  } });
  servers.push(node);
  const cancels: unknown[] = [];
  const openKeyApi = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/delegate/handoffs/cancel" && request.method === "POST") {
      cancels.push(await request.json());
      return Response.json({ cancelled: true });
    }
    return new Response("not found", { status: 404 });
  } });
  servers.push(openKeyApi);
  const tty = behavior === "cancel-tty";
  const signer = new PrivateKeySigner(OWNER_KEY);
  const ownerDid = `did:pkh:eip155:1:${await signer.getAddress()}`;
  const directory = await withTinyCloudStateRoot(home, async () => {
    if (!priorHome) {
      await writeJsonAtomic(profileConfigPath(PROFILE), {
        name: PROFILE, host: node.url.origin, chainId: 1, spaceName: "default", did: "did:key:prior",
        ownerDid, posture: "owner-openkey", authMethod: "openkey",
        createdAt: "2026-10-01T00:00:00.000Z",
      });
    }
    return profilePath(PROFILE);
  });
  const prior = {
    key: await readOptional(join(directory, "key.json")),
    session: await readOptional(join(directory, "session.json")),
    did: (JSON.parse(await readFile(join(directory, "profile.json"), "utf8")) as { did: string }).did,
  };
  const expectPriorKept = async () => {
    expect(await readOptional(join(directory, "key.json"))).toBe(prior.key);
    expect(await readOptional(join(directory, "session.json"))).toBe(prior.session);
    expect(JSON.parse(await readFile(join(directory, "profile.json"), "utf8")).did).toBe(prior.did);
    if (!priorHome) {
      // A failed first login leaves no gate bound to its owner, so another account can still sign in.
      const gate = await readOptional(join(directory, REPLICA_GATE_FILE));
      expect(gate === null ? null : (JSON.parse(gate) as { principalHash: string | null }).principalHash).toBeNull();
    }
  };
  const argv = [process.execPath, ...(behavior === "expire" ? ["--preload", FAST_EXPIRY] : []), cliEntry,
    "--quiet", "--json", "--profile", PROFILE,
    "auth", "login", "--method", "openkey", "--replication-prefix", "notes/", "--owner", ownerDid,
    ...(priorHome ? ["--replace-session"] : []),
    ...(transport === "paste" ? ["--paste"] : ["--no-popup"])];
  // `script` gives the CLI a real terminal, so Ctrl-C reaches readline as a keypress.
  const child = Bun.spawn(tty ? ["script", "-qefc", argv.map((arg) => `'${arg}'`).join(" "), "/dev/null"] : argv, {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: "https://openkey.test",
      TC_OPENKEY_API_HOST: openKeyApi.url.origin },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = (tty ? child.stdout : child.stderr).getReader();
  let stderr = "";
  let url: string | undefined;
  // A CLI (or `script`) that never prints the URL must fail with its output, not stall the suite.
  const stalled = Promise.withResolvers<"stalled">();
  const stallTimer = setTimeout(() => stalled.resolve("stalled"), 15_000);
  while (true) {
    const next = await Promise.race([reader.read(), stalled.promise]);
    if (next === "stalled" || next.done) break;
    stderr += new TextDecoder().decode(next.value);
    // A terminal may colour the line, so an SGR reset can sit between the URL and its newline.
    url = /(https:\/\/openkey\.test\/delegate#tv2=[A-Za-z0-9_-]+)(?:\x1b\[[0-9;]*m)*\r?\n/.exec(stderr)?.[1];
    if (url) break;
  }
  clearTimeout(stallTimer);
  if (!url) {
    child.kill("SIGKILL");
    const rest = tty ? "" : await new Response(child.stdout).text();
    throw new Error(`CLI did not issue SDK-prepared v2 URL (exit ${await child.exited}): ${stderr}${rest}`);
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
  if (behavior === "cancel" || behavior === "cancel-tty") {
    if (tty) {
      child.stdin.write("\x03");
      child.stdin.flush();
    } else child.kill("SIGINT");
    expect(await exitWithin(child, 15_000)).toBe(130);
    expect(cancels).toEqual([{ ticket: payload.delivery.handoffId, cancelSecret: payload.delivery.cancelSecret }]);
    await expectPriorKept();
    await expect(fetch(payload.delivery.callback!, {
      method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    })).rejects.toThrow();
    return { home, directory, ownerDid };
  }
  if (behavior === "paste-eof" || behavior === "expire") {
    if (behavior === "paste-eof") child.stdin.end();
    const exitCode = await exitWithin(child, 15_000);
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBe("timeout");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += new TextDecoder().decode(value);
    }
    expect(stderr).toContain(behavior === "paste-eof" ? "PASTE_CODE_MISSING" : "V2_EXPIRED");
    await expectPriorKept();
    return { home, directory, ownerDid };
  }
  if (behavior === "invalid-signature") {
    envelope.result.signature = await signer.signMessage(`${payload.request.siwe} rejected`);
  }
  if (behavior === "commit-failure") {
    // A concurrent profile write after approval started: the compare-and-commit refuses.
    const profileFile = join(directory, "profile.json");
    await writeFile(profileFile, JSON.stringify({ ...JSON.parse(await readFile(profileFile, "utf8")), label: "changed" }));
  }
  let accepted: { accepted: boolean } | undefined;
  if (transport === "callback") {
    expect(payload.delivery.callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]+$/);
    const response = await fetch(payload.delivery.callback!, {
      method: "POST", headers: { Origin: "https://openkey.test", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    accepted = await response.json() as { accepted: boolean };
    if (behavior !== "commit-failure") expect(response.status).toBe(behavior === "invalid-signature" ? 422 : 200);
  } else {
    expect(payload.delivery.callback).toBeUndefined();
    child.stdin.write(Buffer.from(JSON.stringify(envelope)).toString("base64url") + "\n");
    child.stdin.end();
  }
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), exitWithin(child, 15_000)]);
  await reader.cancel().catch(() => undefined);
  if (behavior === "invalid-signature" || behavior === "commit-failure") {
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBe("timeout");
    expect(accepted).toEqual({ accepted: false });
    await expectPriorKept();
    return { home, directory, ownerDid };
  }
  expect(exitCode).toBe(0);
  expect(cancels).toEqual([]);
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
  if (!stored.replicaStamp) throw new Error("Prepared sign-in did not persist its signed replica stamp");
  expect(await restoreSessionStamp(directory, ownerDid, stored.replicaStamp)).toEqual(stored.replicaStamp);
  const storedProfile = JSON.parse(await readFile(join(directory, "profile.json"), "utf8")) as {
    sessionDid: string; replication: { prefixes: string[] };
  };
  expect(storedProfile.sessionDid).toBe(payload.request.sessionDid);
  expect(storedProfile.replication.prefixes).toEqual(["notes/"]);
  expect(JSON.parse(stdout).authenticated).toBe(true);
  expect(requests).toContain("/delegate");
  // The prepared session holds no account-space authority, so registry sync
  // must not even try it (TC-1287: a deterministic 401 per login).
  expect(invokedResources.filter((resource) => resource.includes(":account/"))).toEqual([]);
  return { home, directory, ownerDid };
}

test("prepared OpenKey callback ACK follows verified SDK sign-in and durable stamped CLI commit", () => preparedLogin("callback"), 30_000);
test("prepared OpenKey paste accepts the same signed envelope and persists verified stamp", () => preparedLogin("paste"), 30_000);
test("invalid signed callback receives no ACK and leaves the previous profile and key unchanged", () => preparedLogin("callback", "invalid-signature"), 30_000);
test("preclaim non-TTY SIGINT cancels the handoff, exits CANCELLED 130 and rejects a late signed callback", () => preparedLogin("callback", "cancel"), 30_000);
test("preclaim terminal Ctrl-C takes the same cancellation path and exit code", () => preparedLogin("callback", "cancel-tty"), 30_000);
test("preclaim paste cancellation by stdin EOF shreds the prepared key and preserves the prior profile", () => preparedLogin("paste", "paste-eof"), 30_000);
test("an expired first login saves nothing and leaves no gate bound to its owner", () => preparedLogin("callback", "expire"), 30_000);
test("a first login whose commit fails saves nothing and leaves no gate bound to its owner", () => preparedLogin("callback", "commit-failure"), 30_000);

/** Every byte of the gate, the deny floor and the flag-owned replication tree. */
async function replicaState(directory: string): Promise<Record<string, string | null>> {
  const files: Record<string, string | null> = {};
  for (const name of [REPLICA_GATE_FILE, REPLICA_DENY_FLOOR_FILE]) files[name] = await readOptional(join(directory, name));
  const root = join(directory, "replication");
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(directory.length)] = (await readFile(path)).toString("base64");
    }
  }
  return files;
}

test.each([
  ["callback", "cancel"], ["callback", "expire"], ["callback", "invalid-signature"],
  ["paste", "paste-eof"], ["callback", "commit-failure"],
] as const)("a failed %s re-login (%s) never denies the live owner session's gate or touches its pending writes", async (transport, behavior) => {
  const { home, directory, ownerDid } = await preparedLogin("callback");
  // The live session's unsynced writes: a pending index in the owner's identity partition.
  const session = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as {
    spaceId: string; replicaStamp: Parameters<typeof restoreSessionStamp>[2];
  };
  const stamp = session.replicaStamp;
  if (!stamp) throw new Error("The first login did not persist its replica stamp");
  const host = (JSON.parse(await readFile(join(directory, "profile.json"), "utf8")) as { host: string }).host;
  await withTinyCloudStateRoot(home, async () => {
    const storage = sqliteReplicaStorage({
      dir: join(directory, "replication"),
      guard: (section) => withProfileLock(PROFILE, section, { requireProfile: true }),
    });
    await storage.pendingWrites!({ host, space: session.spaceId, principal: ownerDid }, { stamp })
      .update((state) => { state.seq = 1; });
  });
  const before = await replicaState(directory);
  expect(Object.keys(before).some((name) => name.endsWith("pending.json"))).toBe(true);
  expect(before[REPLICA_DENY_FLOOR_FILE]).toBeNull();

  await preparedLogin(transport, behavior, home);

  expect(await replicaState(directory)).toEqual(before);
  await expect(stat(join(directory, "replica-logout-pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await restoreSessionStamp(directory, ownerDid, stamp)).toEqual(stamp);
}, 60_000);

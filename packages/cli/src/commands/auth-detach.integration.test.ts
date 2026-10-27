import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";
import { tinyAppManifest } from "../lib/tiny-apps.js";

// `auth login --detach` and `auth status --wait`, end to end: the CLI runs from
// source in its own processes, with a throwaway TC_HOME, a fake OpenKey origin
// and an unreachable node. OpenKey's callback POST is played by the test.
const OPENKEY = "https://openkey.test";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
const cliEntry = join(import.meta.dir, "../index.ts");
let home: string;
let manifest: string;

async function run(args: string[], input?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: OPENKEY, TC_PROFILE: "" },
    stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function record(profile: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(home, ".tinycloud", "logins", `${profile}.json`), "utf8"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function newProfile(name: string): Promise<void> {
  const init = await run(["init", "--name", name, "--key-only", "--host", "http://127.0.0.1:9"]);
  expect(init.exitCode, init.stderr).toBe(0);
}

async function detach(profile: string) {
  return run(["--profile", profile, "auth", "login", "--method", "openkey", "--manifest", manifest, "--expiry", "30d", "--detach"]);
}

/** What OpenKey would POST after the owner approves: signed by the owner for this profile's own key. */
async function signedCallback(profile: string, approvalUrl: string): Promise<Record<string, unknown>> {
  const url = new URL(approvalUrl);
  const did = url.searchParams.get("did")!;
  const { permissions } = JSON.parse(Buffer.from(url.searchParams.get("permissions")!, "base64url").toString("utf8")) as { permissions: PermissionEntry[] };
  const jwk = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", profile, "key.json"), "utf8"));
  const { delegate } = openKeyDelegate({ wasm: new NodeWasmBindings(), signer: new PrivateKeySigner(OWNER_KEY), sessionKey: jwk, sessionDid: did });
  return { ...(await delegate(did, { permissions, expiry: url.searchParams.get("expiry")! })), permissions };
}

function post(approvalUrl: string, body: unknown, origin = OPENKEY): Promise<Response> {
  const callback = new URL(approvalUrl).searchParams.get("callback")!;
  return fetch(callback, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "tc-detach-"));
  manifest = join(home, "tinyapp-todos.json");
  await writeFile(manifest, `${JSON.stringify(tinyAppManifest("todos", "Todos"))}\n`);
});

afterAll(async () => {
  // Stop any listener a failed assertion left running.
  for (const profile of ["tinyapp-todos", "forged", "killed", "pending", "pasted"]) {
    const pid = await record(profile).then((r) => r.pid as number, () => undefined);
    if (pid !== undefined && alive(pid)) process.kill(pid);
  }
  await rm(home, { recursive: true, force: true });
});

describe("auth login --detach", () => {
  test("returns the link at once; the listener saves the signed approval; status --wait reports it", async () => {
    await newProfile("tinyapp-todos");
    const started = Date.now();
    const first = await detach("tinyapp-todos");
    expect(first.exitCode, first.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
    const output = JSON.parse(first.stdout);
    expect(output).toMatchObject({ authenticated: false, profile: "tinyapp-todos", reused: false, login: { state: "waiting" } });
    const approvalUrl: string = output.login.approvalUrl;
    const url = new URL(approvalUrl);
    expect(url.origin).toBe(OPENKEY);
    const callback = new URL(url.searchParams.get("callback")!);
    expect(callback.hostname).toBe("127.0.0.1");
    expect(callback.pathname).toMatch(/^\/callback\/[A-Za-z0-9_-]{22}$/);
    expect(url.searchParams.get("expiry")).toBe("2592000s");

    const listener = await record("tinyapp-todos");
    expect(alive(listener.pid)).toBe(true);
    expect(listener).not.toHaveProperty("session");

    // An agent that runs the same command again gets the same link, not a second listener.
    const again = await detach("tinyapp-todos");
    expect(again.exitCode, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ reused: true, login: { approvalUrl } });

    // Still waiting: exit 8, with the link.
    const waiting = await run(["--profile", "tinyapp-todos", "auth", "status", "--wait", "1"]);
    expect(waiting.exitCode).toBe(8);
    expect(JSON.parse(waiting.stdout)).toMatchObject({ authenticated: false, login: { state: "waiting", approvalUrl } });

    // Only OpenKey's origin may deliver.
    expect((await post(approvalUrl, {}, "https://evil.test")).status).toBe(403);
    const delivered = await post(approvalUrl, await signedCallback("tinyapp-todos", approvalUrl));
    expect(delivered.status).toBe(200);

    const done = await run(["--profile", "tinyapp-todos", "auth", "status", "--wait", "30"]);
    expect(done.exitCode, done.stderr).toBe(0);
    const status = JSON.parse(done.stdout);
    expect(status).toMatchObject({ authenticated: true, authMethod: "openkey", login: { state: "authenticated", declined: [] } });
    expect(status.login.sessionExpiresAt).toBe(status.session.expiresAt);
    expect(status.spaceId).toMatch(/:applications$/);
    expect(status.login).not.toHaveProperty("approvalUrl");
    const finished = await record("tinyapp-todos");
    expect(finished.result).toMatchObject({ authenticated: true, scoped: true, declined: [] });
    for (let i = 0; i < 50 && alive(listener.pid); i++) await Bun.sleep(100);
    expect(alive(listener.pid)).toBe(false);
  }, 60_000);

  test("a delegation that is not signed for the profile's key is refused and reported", async () => {
    await newProfile("forged");
    const started = await detach("forged");
    expect(started.exitCode, started.stderr).toBe(0);
    const approvalUrl: string = JSON.parse(started.stdout).login.approvalUrl;
    // Well-formed, but signed for another profile's key.
    await newProfile("other");
    const forged = await signedCallback("other", approvalUrl.replace(/did=[^&]+/, `did=${encodeURIComponent(JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "other", "profile.json"), "utf8")).did)}`));
    expect((await post(approvalUrl, forged)).status).toBe(200);

    const status = await run(["--profile", "forged", "auth", "status", "--wait", "30"]);
    expect(status.exitCode).not.toBe(0);
    expect(status.exitCode).not.toBe(8);
    const error = JSON.parse(status.stderr).error;
    expect(error.code).toBe("OPENKEY_PROOF_INVALID");
    expect(await readFile(join(home, ".tinycloud", "profiles", "forged", "session.json"), "utf8").catch(() => null)).toBeNull();
    expect((await record("forged")).state).toBe("failed");
  }, 60_000);

  test("a listener that dies is reported, with the paste fallback", async () => {
    await newProfile("killed");
    const started = await detach("killed");
    expect(started.exitCode, started.stderr).toBe(0);
    const { pid } = await record("killed");
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100);
    const status = await run(["--profile", "killed", "auth", "status", "--wait", "5"]);
    expect(status.exitCode).toBe(3);
    const error = JSON.parse(status.stderr).error;
    expect(error.code).toBe("LOGIN_LISTENER_EXITED");
    expect(error.message).toContain("--paste");

    // The record no longer blocks a new sign-in.
    const restarted = await detach("killed");
    expect(restarted.exitCode, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout).reused).toBe(false);
    process.kill((await record("killed")).pid);
  }, 60_000);

  test("the paste fallback (OpenKey couldn't reach the listener) signs in, and the listener stops", async () => {
    await newProfile("pasted");
    const started = await detach("pasted");
    expect(started.exitCode, started.stderr).toBe(0);
    const approvalUrl: string = JSON.parse(started.stdout).login.approvalUrl;
    const { pid } = await record("pasted");
    // The code OpenKey shows when its callback fails: the same signed delegation, base64-encoded.
    const code = Buffer.from(JSON.stringify(await signedCallback("pasted", approvalUrl))).toString("base64");
    const pasted = await run(["--profile", "pasted", "auth", "login", "--method", "openkey", "--paste", "--manifest", manifest, "--expiry", "30d"], `${code}\n`);
    expect(pasted.exitCode, pasted.stderr).toBe(0);
    const status = await run(["--profile", "pasted", "auth", "status", "--wait", "10"]);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).authenticated).toBe(true);
    for (let i = 0; i < 80 && alive(pid); i++) await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
    expect((await record("pasted")).state).toBe("superseded");
  }, 60_000);

  test("a different request while one waits is refused; nothing pending exits 3", async () => {
    await newProfile("pending");
    const started = await detach("pending");
    expect(started.exitCode, started.stderr).toBe(0);
    const other = await run(["--profile", "pending", "auth", "login", "--method", "openkey", "--manifest", manifest, "--expiry", "7d", "--detach"]);
    expect(other.exitCode).toBe(1);
    expect(JSON.parse(other.stderr).error.code).toBe("LOGIN_PENDING");
    process.kill((await record("pending")).pid);

    const none = await run(["--profile", "other", "auth", "status", "--wait", "1"]);
    expect(none.exitCode).toBe(3);
    expect(JSON.parse(none.stdout)).toMatchObject({ authenticated: false });
  }, 60_000);

  test("--detach refuses flags that need the terminal or another flow", async () => {
    for (const extra of [["--paste"], ["--device"], ["--keys", "qa"]]) {
      const refused = await run(["--profile", "other", "auth", "login", "--method", "openkey", "--manifest", manifest, "--detach", ...extra]);
      expect(refused.exitCode).toBe(2);
      expect(JSON.parse(refused.stderr).error.code).toBe("INVALID_ARGUMENT");
    }
    const wait = await run(["--profile", "other", "auth", "status", "--wait", "601"]);
    expect(wait.exitCode).toBe(2);
  }, 60_000);
});

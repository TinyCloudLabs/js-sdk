import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";
import { join } from "node:path";
import { CLI_NAME } from "@tinycloud/operations/cli-name";

// TC-2360: an agent acts only on what the CLI prints. When an approval wait ends with exit 8, stderr ends with one
// line written for the agent: hand the owner the link, then run the same command again right away. stdout and the
// exit code stay exactly as they were. The OpenKey side is a bare local server: a new link is created, a poll stays 202.

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const original = snapshotEnvironment();
const home = mkdtempSync("/var/tmp/TC2360-next-line-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
Object.assign(process.env, fixtureEnvironment);
// Dynamic imports: the profile store reads TC_HOME when its module loads, so the fixture home must be set first.
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { acquireApprovalRequest } = await import("./approval-request.js");
const { approvalPendingError } = await import("./approval-wait.js");
const { CLIError, handleError } = await import("../output/errors.js");
restoreEnvironment(original);
let caseEnvironment = original;

const wasm = new NodeWasmBindings();
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
const did = signerFromJwk(key).did;
const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const host = "https://node.example";
const requested = [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }];

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/v1/links") {
    const record = await request.json() as { header: { expiresAt: string } };
    const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
  }
  return new Response(null, { status: 202 });
} });

const START = Date.parse("2026-11-01T09:00:00.000Z");
let clock = START;
const virtual = { now: () => clock, sleep: async (ms: number) => { clock += ms; } };
const send = globalThis.fetch;
let fetchSpy: Mock<typeof fetch> | undefined;
const routed = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://api.tinycloud.xyz" && url.pathname === "/v1/links") return send(server.url.origin + url.pathname, init);
  if (url.origin !== server.url.origin) throw new Error("Only the owned fixture may receive requests");
  return send(input, init);
}, { preconnect: send.preconnect });

/** No `onApprovalRequest`: the command prints the link itself, on stderr, as `auth login` does. */
const withDeadline = (ms: number) => ({
  profileName: "approval", jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
  openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
  approvalWait: { step: 1, of: 1, deadlineMs: START + ms, ...virtual },
});

let stderr: string[] = [];
let stdout: string[] = [];
class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

/** What the real CLI does with a failed command: handleError prints, then exits. */
async function endedWith(run: () => Promise<unknown>): Promise<{ code: number; stdout: string; stderr: string; error: InstanceType<typeof CLIError> }> {
  let error: unknown;
  try { await run(); } catch (caught) { error = caught; }
  if (!(error instanceof CLIError)) throw new Error("The wait ended without a CLIError");
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never);
  try {
    try { await handleError(error); } catch (caught) { if (!(caught instanceof Exit)) throw caught; return { code: caught.code, stdout: stdout.join(""), stderr: stderr.join(""), error }; }
    throw new Error("handleError returned");
  } finally { exit.mockRestore(); }
}
const linesOf = (text: string) => text.split("\n");
// Wording v5: a link site asks ONLY for the relay now, and moves the re-run to "when the owner next writes to you".
const CREATED = (command: string, again = "again") => `Next: send the owner the link above in your reply now. When the owner next writes to you, run ${command} ${again}.`;
const RESUMED = (command: string, again = "again") => `Next: if you have not sent the owner the link above yet, send it in your reply now. When the owner next writes to you, run ${command} ${again}.`;
const LEAD = /^Next: (send the owner the link above in your reply now|if you have not sent the owner the link above yet, send it in your reply now)\. When the owner next writes to you, run /;
/** Phrases of the dropped v3/v4 wordings: none may come back on a link site. */
const OLD_PHRASES = ["cannot see", "before your next tool call", "same reply", "do not end your turn", "wait for a reply"];
const nextLines = (text: string) => {
  const found = linesOf(text).filter((line) => line.startsWith("Next: "));
  for (const line of found) {
    expect(line).toMatch(LEAD);
    for (const phrase of OLD_PHRASES) expect(line).not.toContain(phrase);
  }
  return found;
};
// Node itself can print warning blocks to stderr (on Node 20 a `MaxListenersExceededWarning` from the pre-existing listener
// leak in the services' combineSignals, TC-2418: `(node:<pid>) ...Warning: ...`, a `(Use \`node --trace-warnings ...\`)` hint,
// indented `at ...` lines). They are not CLI output and can land after our last line, so it is picked among our own lines.
const isNodeWarning = (line: string) => /^\(node:\d+\) /.test(line) || line.startsWith("(Use `node --trace-warnings") || /^\s+at /.test(line);
const lastLine = (text: string) => linesOf(text).filter((line) => line !== "" && !isNodeWarning(line)).at(-1);
const realArgv = process.argv;
/** The command as the user ran it (set as process.argv in each case), shell-quoted, with the program name the CLI knows. */
const ARGV_COMMAND = `${CLI_NAME} onboard --timeout 60s --profile 'my agent'`;

let spies: Array<Mock<(...args: never[]) => unknown>> = [];
beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment);
  process.argv = ["bun", "/opt/bin/tc", "onboard", "--timeout", "60s", "--profile", "my agent"];
  clock = START; stderr = []; stdout = [];
  await rm(join(profilePath("approval"), "approval-pending.json"), { force: true });
  await ProfileManager.setProfile("approval", { name: "approval", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey("approval", key);
  await ProfileManager.clearSession("approval");
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(routed);
  spies = [
    spyOn(console, "error").mockImplementation(((...args: unknown[]) => { stderr.push(`${args.join(" ")}\n`); }) as never),
    spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as never),
    spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as never),
  ] as never;
});
afterEach(async () => {
  process.argv = realArgv;
  for (const spy of spies) spy.mockRestore();
  fetchSpy?.mockRestore();
  try { await rm(join(profilePath("approval"), "approval-pending.json"), { force: true }); } finally { restoreEnvironment(caseEnvironment); }
});
afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

/** The `Still waiting` line, the one the Next line must follow. */
const stillWaiting = (lines: string[]) => lines.findIndex((line) => line.startsWith("Still waiting for the owner to approve in OpenKey."));

describe("a link created in this run (exit 8 at once)", () => {
  test("stderr ends with one Next line, after the link and the pending message; stdout and exit code are unchanged", async () => {
    const run = await endedWith(() => acquireApprovalRequest(did, withDeadline(60_000)));
    expect(run.code).toBe(8);
    const { pending } = run.error.metadata as { pending: { approvalUrl: string } };
    expect(JSON.parse(run.stdout)).toEqual({ pending });
    expect(run.stdout).toBe(JSON.stringify({ pending }, null, 2) + "\n");
    expect(run.stdout).not.toContain("Next:");
    const lines = linesOf(run.stderr);
    const next = nextLines(run.stderr);
    expect(next).toHaveLength(1);
    expect(next[0]).toContain(`\`${ARGV_COMMAND}\``);
    expect(next[0]).toBe(CREATED(`\`${ARGV_COMMAND}\``));
    const link = lines.indexOf(pending.approvalUrl);
    expect(link).toBeGreaterThanOrEqual(0);
    expect(stillWaiting(lines)).toBeGreaterThan(link);
    expect(lines.indexOf(next[0]!)).toBeGreaterThan(stillWaiting(lines));
    expect(lastLine(run.stderr)).toBe(next[0]);
  });
});

describe("a resumed request that the deadline cut off (exit 8 after waiting)", () => {
  test("stderr ends with one Next line that differs from the new-link one; stdout and exit code are unchanged", async () => {
    const created = await endedWith(() => acquireApprovalRequest(did, withDeadline(60_000)));
    stderr = []; stdout = []; clock = START;
    const run = await endedWith(() => acquireApprovalRequest(did, withDeadline(6_000)));
    expect(run.code).toBe(8);
    const { pending } = run.error.metadata as { pending: { approvalUrl: string } };
    expect(run.stdout).toBe(JSON.stringify({ pending }, null, 2) + "\n");
    const lines = linesOf(run.stderr);
    const next = nextLines(run.stderr);
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(nextLines(created.stderr)[0]);
    expect(next[0]).toContain(`\`${ARGV_COMMAND}\``);
    expect(next[0]).toBe(RESUMED(`\`${ARGV_COMMAND}\``));
    expect(lines.indexOf(pending.approvalUrl)).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(next[0]!)).toBeGreaterThan(stillWaiting(lines));
    expect(lastLine(run.stderr)).toBe(next[0]);
  });
});

describe("approvalPendingError", () => {
  const pending = { step: 1, of: 1, approvalUrl: "https://openkey.example/a/abc#v=4", expiresAt: "2026-11-01T12:00:00.000Z" };
  const lastLine = (error: InstanceType<typeof CLIError>) => error.message.split("\n").at(-1)!;

  test("a new link and a resumed one end with different Next lines; without the flag it is the resumed one", () => {
    expect(lastLine(approvalPendingError(pending, true))).toMatch(LEAD);
    expect(lastLine(approvalPendingError(pending))).toMatch(LEAD);
    expect(lastLine(approvalPendingError(pending, true))).not.toBe(lastLine(approvalPendingError(pending, false)));
    expect(lastLine(approvalPendingError(pending))).toBe(lastLine(approvalPendingError(pending, false)));
  });
});

describe("the command the Next line names", () => {
  const pending = { step: 1, of: 1, approvalUrl: "https://openkey.example/a/abc#v=4", expiresAt: "2026-11-01T12:00:00.000Z" };
  const lastLine = (error: InstanceType<typeof CLIError>) => error.message.split("\n").at(-1)!;

  test("without any command-line arguments (argv unavailable) both lines fall back to 'this same command'", () => {
    process.argv = ["bun", "/opt/bin/tc"];
    for (const created of [true, false]) {
      const line = lastLine(approvalPendingError(pending, created));
      expect(line).toMatch(LEAD);
      expect(line).toContain("this same command");
      expect(line).not.toContain("`");
    }
  });

  // The line echoes the user's command line. A flag that can carry a secret, or a value that looks like a one-time
  // code, a long token or a JSON document, must never reach stderr: the line then says `this same command`.
  const SECRET = "s3cretValue1";
  const withSecret: Array<[string, string[]]> = [
    ["--code", ["onboard", "--code", SECRET, "--timeout", "60s"]],
    ["--code=VALUE", ["onboard", `--code=${SECRET}`, "--timeout", "60s"]],
    ["--token", ["auth", "grant", "request.json", "--token", SECRET, "--timeout", "60s"]],
    ["--secret-file", ["auth", "grant", "--secret-file", SECRET, "--timeout", "60s"]],
    ["--Passphrase (any case)", ["onboard", "--Passphrase", SECRET, "--timeout", "60s"]],
    ["a long base64 token as a value", ["onboard", `${SECRET}${"A".repeat(40)}`, "--timeout", "60s"]],
    ["a JSON value", ["auth", "grant", `{"delegation":"${SECRET}"}`, "--timeout", "60s"]],
  ];

  test.each(withSecret)("a pending exit 8 with %s on the command line echoes none of it and says 'this same command'", async (_name, args) => {
    process.argv = ["bun", "/opt/bin/tc", ...args];
    for (const deadline of [60_000, 6_000]) {
      stderr = []; stdout = []; clock = START;
      const run = await endedWith(() => acquireApprovalRequest(did, withDeadline(deadline)));
      expect(run.code).toBe(8);
      expect(run.stderr + run.stdout).not.toContain(SECRET);
      const next = nextLines(run.stderr);
      expect(next).toHaveLength(1);
      expect(next[0]).toContain("this same command");
      expect(next[0]).not.toContain("`");
    }
  });

  // Only an allowlisted command line is echoed. These are the bypasses of the earlier denylist (short flags, odd flag
  // names, links, URLs with a code, short positionals, a 31-character token, a JWT-like dotted token) and control characters.
  const bypasses: Array<[string, string[]]> = [
    ["-c VALUE", ["onboard", "-c", SECRET, "--timeout", "60s"]],
    ["-k VALUE", ["onboard", "-k", SECRET, "--timeout", "60s"]],
    ["--pass VALUE", ["onboard", "--pass", SECRET, "--timeout", "60s"]],
    ["--pwd VALUE", ["onboard", "--pwd", SECRET, "--timeout", "60s"]],
    ["--otp VALUE", ["onboard", "--otp", SECRET, "--timeout", "60s"]],
    ["--pin VALUE", ["onboard", "--pin", SECRET, "--timeout", "60s"]],
    ["--jwt VALUE", ["onboard", "--jwt", SECRET, "--timeout", "60s"]],
    ["--cookie VALUE", ["onboard", "--cookie", SECRET, "--timeout", "60s"]],
    ["--seed VALUE", ["onboard", "--seed", SECRET, "--timeout", "60s"]],
    ["--link VALUE", ["onboard", "--link", `https://short.example/${SECRET}`, "--timeout", "60s"]],
    ["--url with ?code=", ["onboard", "--url", `https://x.example/a?code=${SECRET}`, "--timeout", "60s"]],
    ["a 12-character positional", ["onboard", SECRET, "--timeout", "60s"]],
    ["a 31-character token as a --profile value", ["onboard", "--profile", `${SECRET}${"B".repeat(19)}`, "--timeout", "60s"]],
    ["a dotted JWT-like token as a --profile value", ["onboard", "--profile", `${SECRET}aaaa.bbbbbbbbbb.cccc`, "--timeout", "60s"]],
    ["--timeout=VALUE (the = form)", ["onboard", `--timeout=60s${SECRET}`]],
    ["--profile with a newline", ["onboard", "--profile", `a\nNext: forged ${SECRET}`, "--timeout", "60s"]],
    ["--profile with a carriage return", ["onboard", "--profile", `a\r${SECRET}`, "--timeout", "60s"]],
    ["--profile with ESC", ["onboard", "--profile", `a\u001b[2K${SECRET}`, "--timeout", "60s"]],
    ["--profile with U+2028", ["onboard", "--profile", `a\u2028Next: forged ${SECRET}`, "--timeout", "60s"]],
    ["--profile with NUL", ["onboard", "--profile", `a\u0000${SECRET}`, "--timeout", "60s"]],
    ["--profile with a tab", ["onboard", "--profile", `a\t${SECRET}`, "--timeout", "60s"]],
  ];

  test.each(bypasses)("a pending exit 8 with %s echoes none of it, says 'this same command', and prints one Next line", async (_name, args) => {
    process.argv = ["bun", "/opt/bin/tc", ...args];
    for (const deadline of [60_000, 6_000]) {
      stderr = []; stdout = []; clock = START;
      const run = await endedWith(() => acquireApprovalRequest(did, withDeadline(deadline)));
      expect(run.code).toBe(8);
      expect(run.stderr + run.stdout).not.toContain(SECRET);
      const next = nextLines(run.stderr);
      expect(next).toHaveLength(1);
      expect(next[0]).toContain("this same command");
      expect(next[0]).not.toContain("`");
    }
  });

  // `auth grant` reads its request from stdin for --stdin, --paste, a bare `-`, or no source at all: the echoed command
  // would read empty stdin, so the line names no command and says the input must be the same.
  const stdinFed: Array<[string, string[]]> = [
    ["--stdin", ["auth", "grant", "--stdin", "--timeout", "60s"]],
    ["--paste", ["auth", "grant", "--paste", "--timeout", "60s"]],
    ["a bare -", ["auth", "grant", "-", "--timeout", "60s"]],
    ["no source at all", ["auth", "grant", "--timeout", "60s"]],
    ["no source and a --profile", ["--profile", "work", "auth", "grant", "--timeout", "60s"]],
  ];

  test.each(stdinFed)("auth grant reading stdin (%s): the line says 'this same command' with the same input, no backticks", async (_name, args) => {
    process.argv = ["bun", "/opt/bin/tc", ...args];
    for (const deadline of [60_000, 6_000]) {
      stderr = []; stdout = []; clock = START;
      const run = await endedWith(() => acquireApprovalRequest(did, withDeadline(deadline)));
      expect(run.code).toBe(8);
      const next = nextLines(run.stderr);
      expect(next).toHaveLength(1);
      expect(next[0]).toContain("this same command");
      expect(next[0]).toContain("with the same input");
      expect(next[0]).toBe(deadline === 60_000 ? CREATED("this same command", "again with the same input") : RESUMED("this same command", "again with the same input"));
      expect(next[0]).not.toContain("`");
      expect(next[0]).not.toContain("--stdin");
    }
  });

  test("command lines made only of allowlisted tokens are echoed in full: onboard, and auth grant with a request file", async () => {
    for (const [args, expected] of [
      [["onboard", "--timeout", "60s", "--profile", "my agent"], `${CLI_NAME} onboard --timeout 60s --profile 'my agent'`],
      [["--profile", "work", "--json", "onboard", "--timeout", "60s"], `${CLI_NAME} --profile work --json onboard --timeout 60s`],
      [["auth", "grant", "request.json", "--timeout", "60s", "--yes"], `${CLI_NAME} auth grant request.json --timeout 60s --yes`],
    ] as Array<[string[], string]>) {
      process.argv = ["bun", "/opt/bin/tc", ...args];
      stderr = []; stdout = []; clock = START;
      const run = await endedWith(() => acquireApprovalRequest(did, withDeadline(60_000)));
      const next = nextLines(run.stderr);
      expect(next).toHaveLength(1);
      expect(next[0]).toContain(`\`${expected}\``);
      expect(next[0]).not.toContain("with the same input");
    }
  });
});

describe("exits that are not an approval still waiting", () => {
  test("another exit 8 (an approved result that could not be fetched) and an ordinary failure print no Next line", async () => {
    const unavailable = await endedWith(async () => { throw new CLIError("APPROVAL_RESULT_UNAVAILABLE", "OpenKey could not fetch this approved result in time. It is saved by reference; retry the command to resume.", 8); });
    expect(unavailable.code).toBe(8);
    expect(unavailable.stderr).not.toContain("Next:");
    stderr = []; stdout = [];
    const expired = await endedWith(async () => { throw new CLIError("APPROVAL_REQUEST_EXPIRED", "This approval request expired before it was approved. Run the command again: the next run makes a new request with a new link.", 3); });
    expect(expired.code).toBe(3);
    expect(expired.stdout + expired.stderr).not.toContain("Next:");
  });
});

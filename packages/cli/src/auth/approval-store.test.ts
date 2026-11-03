import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { QUARANTINE_RETENTION_MS, RESULT_RETENTION_MS, parseApprovalFile, serializeApprovalFile, signerFromJwk, type ApprovalEntry } from "@tinycloud/share-envelope/links";
import { createApprovalFixture } from "./test-support/approval-fixture.js";
import { legacyReader } from "./test-support/legacy-approval-reader.js";

// TC-2377 PR-B: `approval-pending.json` becomes the version 2 file of the share-envelope machine, written by a file adapter that
// keeps the CLI's guarantees: ProfileManager.withLock + an atomic durable write, 0600 in a 0700 directory, and no pending approval
// (it may hold the only copy of a key, or an approval the owner already gave) lost to a migration, a corrupt file or a crash.

const fx = await createApprovalFixture("TC2377-approval-store");
// The adapter loads after the fixture so its paths come from the temp HOME (see the fixture).
const { APPROVAL_STATE_FILE, loadApprovals, updateApprovals, fileApprovalStore } = await import("./approval-store.js");
const { clearProfileCredentials } = await import("../lib/logout-pending.js");

beforeEach(() => fx.enter());
afterEach(() => fx.leave());
afterAll(() => fx.dispose());

const PROFILE = "approval";
const dir = () => fx.profilePath(PROFILE);
const file = () => join(dir(), APPROVAL_STATE_FILE);
const read = async () => await readFile(file(), "utf8");
const names = async () => (await readdir(dir())).filter((name) => name.includes("approval-pending.json")).sort();
/** The file as JSON, read with no schema: what is really on disk. */
interface OnDisk { version: number; entries: ApprovalEntry[]; unrecognized: Array<{ raw: unknown; quarantinedAt: string }> }
const onDisk = async (): Promise<OnDisk> => JSON.parse(await read());
const COMMAND_INTENT = `auth-grant:${"ab".repeat(32)}`;

describe("version 1 to version 2 migration", () => {
  test("every legacy phase becomes its version 2 phase; no entry is lost, and the key material survives intact", async () => {
    const childExpiry = new Date(fx.clock + 3600_000).toISOString();
    const requests = await Promise.all([1, 2, 3, 4, 5].map(() => fx.buildRequest()));
    const legacy = [
      await fx.v1Entry(requests[0]!, { phase: "open" }),
      await fx.v1Entry(requests[1]!, { phase: "discovered" }),
      await fx.v1Entry(requests[2]!, { phase: "fetched" }),
      await fx.v1Entry(requests[3]!, { phase: "committed" }),
      await fx.v1Entry(requests[4]!, { phase: "committed", acknowledged: true, commandIntent: COMMAND_INTENT, command: { request: {}, result: { expiry: childExpiry } } }),
    ];
    await fx.writeState(legacy);
    await updateApprovals(PROFILE, (entries) => entries);

    const state = await onDisk();
    expect(state.version).toBe(2);
    expect(state.entries.map((entry) => entry.requestId)).toEqual(legacy.map((entry) => entry.requestId));
    expect(state.entries.map((entry) => entry.phase)).toEqual(["open", "discovered", "fetched", "committed", "acked"]);
    // v1-only fields are gone; the expiry is the signed header's, not a stored copy.
    for (const entry of state.entries) {
      expect(entry).not.toHaveProperty("version");
      expect(entry).not.toHaveProperty("requestExpiresAt");
      expect(entry).not.toHaveProperty("relayPrivateKey");
      expect(entry).not.toHaveProperty("committed");
      expect(entry).not.toHaveProperty("acknowledged");
    }
    const [open, discovered, fetched, committed, acked] = state.entries;
    for (const [index, entry] of [open, discovered, fetched, committed].entries()) {
      expect(entry!.keys!.relayPrivateKey, `entry ${index}`).toBe(requests[index]!.relayPrivateKey);
    }
    expect(fetched!.resultEnvelope).toEqual(legacy[2]!.resultEnvelope);
    // An acknowledged command entry is kept key-free (no keys, no link: its fragment holds the content key) until the child grant ends.
    expect(acked!.keys).toBeUndefined();
    expect(acked!.approvalUrl).toBeUndefined();
    expect(acked!.retainUntil).toBe(childExpiry);
    expect(acked!.ext.cli).toMatchObject({ commandIntent: COMMAND_INTENT, command: { result: { expiry: childExpiry } } });
    expect(await read()).not.toContain(requests[4]!.relayPrivateKey);
  });

  test("a legacy relay key stored without its leading zero byte (1 key in 256, 31 bytes) is migrated as the same scalar padded to 32 bytes, not quarantined", async () => {
    const request = await fx.buildRequest({ shortRelayKey: true });
    expect(Buffer.from(request.legacyRelayPrivateKey, "base64url")).toHaveLength(31);
    const delegation = await fx.signedDelegation();
    await fx.writeState([await fx.v1Entry(request, { phase: "fetched", delegation })]);
    await updateApprovals(PROFILE, (entries) => entries);

    const state = await onDisk();
    expect(state.unrecognized).toEqual([]);
    expect(state.entries).toHaveLength(1);
    // The same scalar, padded to 32 bytes: it is the key that decrypts the saved result.
    expect(state.entries[0]!.keys!.relayPrivateKey).toBe(request.relayPrivateKey);
    expect(Buffer.from(state.entries[0]!.keys!.relayPrivateKey, "base64url")).toHaveLength(32);
  });

  test("a legacy entry that holds a staged signing key keeps it exactly: the CLI's real session key { crv, d, kid, kty, x }", async () => {
    // The only copy of a first sign-in's or a rotation's key lives in this entry (refused-approval.ts: `heldOnlyInMemory`).
    expect(Object.keys(fx.key).sort()).toEqual(["crv", "d", "kid", "kty", "x"]);
    const request = await fx.buildRequest();
    await fx.writeState([await fx.v1Entry(request, { phase: "open", stagedKey: fx.key })]);
    await updateApprovals(PROFILE, (entries) => entries);

    const [entry] = (await loadApprovals(PROFILE)).entries;
    expect(entry!.keys!.stagedSigningKey).toEqual(fx.key);
    expect(entry!.keys!.relayPrivateKey).toBe(request.relayPrivateKey);
    expect(signerFromJwk(entry!.keys!.stagedSigningKey!).did).toBe(fx.did);
    // Round trip through the machine's own parser and serializer: bytes in, the same entry out.
    const parsed = parseApprovalFile(JSON.parse(await read()), { now: fx.clock });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.migratedFrom).toBe(0);
      expect(JSON.parse(serializeApprovalFile(parsed.file))).toEqual(JSON.parse(await read()));
    }
  });

  test("a read does not rewrite a version 1 file that needs no change (migration happens on the first write)", async () => {
    await fx.writeState([await fx.v1Entry(await fx.buildRequest(), { phase: "open" })]);
    const before = await read();
    const state = await loadApprovals(PROFILE);
    expect(state.entries).toHaveLength(1);
    expect(await read()).toBe(before);
    expect(Array.isArray(JSON.parse(before))).toBe(true);
  });

  test("an entry that cannot be read is quarantined with its raw content, never deleted; its neighbours are kept", async () => {
    const good = await fx.v1Entry(await fx.buildRequest(), { phase: "open" });
    const broken = { version: 1, requestId: "not-a-request", relayPrivateKey: "S".repeat(43), note: "kept verbatim" };
    await fx.writeState([good, broken]);
    await updateApprovals(PROFILE, (entries) => entries);

    const state = await onDisk();
    expect(state.entries.map((entry) => entry.requestId)).toEqual([good.requestId]);
    expect(state.unrecognized).toHaveLength(1);
    expect(state.unrecognized[0]!.raw).toEqual(broken);
    expect(new Date(state.unrecognized[0]!.quarantinedAt).toISOString()).toBe(state.unrecognized[0]!.quarantinedAt);
  });

  test("a file that is not JSON is moved aside whole as approval-pending.json.corrupt-* (0600), a warning names the file but never its contents, and the command goes on", async () => {
    const garbage = '{ "relayPrivateKey": "SYNTHETIC-KEY-IN-A-BROKEN-FILE", ';
    await writeFile(file(), garbage, { mode: 0o600 });
    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect((await loadApprovals(PROFILE)).entries).toEqual([]);
    } finally { process.stderr.write = originalWrite; }

    const aside = (await names()).filter((name) => name.startsWith("approval-pending.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir(), aside[0]!), "utf8")).toBe(garbage);
    expect((await stat(join(dir(), aside[0]!))).mode & 0o777).toBe(0o600);
    expect(await names()).not.toContain("approval-pending.json");
    expect(warnings.join("")).toContain("approval-pending.json");
    expect(warnings.join("")).not.toContain("SYNTHETIC-KEY-IN-A-BROKEN-FILE");
  });

  test("a set-aside file or a killed writer's temp file is purged once it is older than the longest request life plus retention; a younger one stays", async () => {
    const staleNames = ["approval-pending.json.corrupt-2026-01-01T00-00-00-000Z", ".approval-pending.json.4242.00000000-0000-0000-0000-000000000001.tmp"];
    const youngNames = ["approval-pending.json.corrupt-2026-01-02T00-00-00-000Z", ".approval-pending.json.4242.00000000-0000-0000-0000-000000000002.tmp"];
    for (const name of [...staleNames, ...youngNames]) await writeFile(join(dir(), name), "{", { mode: 0o600 });
    const age = (name: string, ms: number) => utimes(join(dir(), name), new Date(fx.clock - ms), new Date(fx.clock - ms));
    for (const name of staleNames) await age(name, QUARANTINE_RETENTION_MS + 1000);
    for (const name of youngNames) await age(name, QUARANTINE_RETENTION_MS - 60_000);
    await loadApprovals(PROFILE, { now: fx.clock });
    const left = await names();
    for (const name of staleNames) expect(left).not.toContain(name);
    for (const name of youngNames) expect(left).toContain(name);
  });

  test("a file written by a newer client is reported and left exactly as it is, by a read and by a write", async () => {
    const newer = JSON.stringify({ version: 3, entries: [{ requestId: "x" }] });
    await writeFile(file(), newer, { mode: 0o600 });
    const entry = await fx.v2Entry(await fx.buildRequest());
    for (const run of [() => loadApprovals(PROFILE), () => updateApprovals(PROFILE, (entries) => entries), () => fileApprovalStore(PROFILE).write(entry)]) {
      const error = await fx.caught(run);
      expect(error.code).toBe("APPROVAL_STATE_UNREADABLE");
      expect(error.message).toMatch(/newer/i);
    }
    expect(await read()).toBe(newer);
    expect(await names()).toEqual(["approval-pending.json"]);
  });
});

describe("the sweep on load: no key outlives its use", () => {
  test("an entry past its purge time leaves the file with its keys, an entry inside its life is untouched", async () => {
    const stale = await fx.buildRequest({ expiresInMs: 3600_000 });
    const live = await fx.buildRequest({ expiresInMs: 7 * 3600_000 });
    await fx.writeState({ version: 2, entries: [await fx.v2Entry(stale, { stagedKey: fx.key }), await fx.v2Entry(live)], unrecognized: [] });
    // E + R + S: the end of an open request's life.
    const state = await loadApprovals(PROFILE, { now: fx.clock + 3600_000 + RESULT_RETENTION_MS + 30_000 });
    expect(state.entries.map((entry) => entry.requestId)).toEqual([live.requestId]);
    const text = await read();
    expect(text).not.toContain(stale.relayPrivateKey);
    expect(text).not.toContain(fx.key.d);
    expect(text).toContain(live.relayPrivateKey);
  });

  test("a read that has nothing to sweep writes nothing", async () => {
    await fx.writeState({ version: 2, entries: [await fx.v2Entry(await fx.buildRequest())], unrecognized: [] });
    const before = await stat(file());
    await loadApprovals(PROFILE);
    const after = await stat(file());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  test("a quarantined entry is purged after the longest request life plus retention", async () => {
    const stamp = (ms: number) => new Date(ms).toISOString();
    await fx.writeState({ version: 2, entries: [], unrecognized: [
      { raw: { gone: true }, quarantinedAt: stamp(fx.clock - QUARANTINE_RETENTION_MS - 1000) },
      { raw: { kept: true }, quarantinedAt: stamp(fx.clock - QUARANTINE_RETENTION_MS + 60_000) },
    ] });
    const state = await loadApprovals(PROFILE, { now: fx.clock });
    expect(state.unrecognized.map((item) => item.raw)).toEqual([{ kept: true }]);
  });
});

describe("the file adapter", () => {
  test("the file is version 2, mode 0600 in a 0700 directory", async () => {
    await fileApprovalStore(PROFILE).write(await fx.v2Entry(await fx.buildRequest()));
    expect((await onDisk()).version).toBe(2);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await stat(dir())).mode & 0o777).toBe(0o700);
  });

  test("write replaces one entry and leaves the others byte for byte; read returns what was written and nothing for an unknown id", async () => {
    const first = await fx.v2Entry(await fx.buildRequest(), { commandIntent: COMMAND_INTENT });
    const second = await fx.v2Entry(await fx.buildRequest(), { commandIntent: `auth-grant:${"cd".repeat(32)}` });
    const store = fileApprovalStore(PROFILE);
    await store.write(first);
    await store.write(second);
    const before = await onDisk();
    await store.write({ ...first, phase: "discovered", resultRef: fx.resultRef, resultExpiresAt: new Date(fx.clock + 600_000).toISOString() });
    const after = await onDisk();
    expect(after.entries).toHaveLength(2);
    expect(after.entries[1]).toEqual(before.entries[1]);
    expect(after.entries[0]!.phase).toBe("discovered");
    expect(await store.read(second.requestId)).toEqual(second);
    expect(await store.read("zzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeUndefined();
  });

  test("remove deletes the entry and its keys from the file; the other entry and ITS keys stay", async () => {
    const gone = await fx.buildRequest();
    const kept = await fx.buildRequest();
    const store = fileApprovalStore(PROFILE);
    await store.write(await fx.v2Entry(gone, { stagedKey: fx.key }));
    await store.write(await fx.v2Entry(kept));
    await store.remove(gone.requestId);
    const text = await read();
    expect(text).not.toContain(gone.requestId);
    expect(text).not.toContain(gone.relayPrivateKey);
    expect(text).not.toContain(fx.key.d);
    expect(text).toContain(kept.relayPrivateKey);
    expect(await store.read(gone.requestId)).toBeUndefined();
  });

  test("an entry never carries createdThisRun out of the file: only the run that created the request may say so", async () => {
    const entry = await fx.v2Entry(await fx.buildRequest());
    await fx.writeState({ version: 2, entries: [{ ...entry, createdThisRun: true }], unrecognized: [] });
    const stored = await fileApprovalStore(PROFILE).read(entry.requestId);
    expect(stored === undefined || !("createdThisRun" in stored)).toBe(true);
  });

  test("concurrent writers under the profile lock never lose an update", async () => {
    const store = fileApprovalStore(PROFILE);
    const requests = await Promise.all(Array.from({ length: 12 }, () => fx.buildRequest()));
    await Promise.all(requests.map(async (request) => store.write(await fx.v2Entry(request))));
    expect((await loadApprovals(PROFILE)).entries.map((entry) => entry.requestId).sort()).toEqual(requests.map((request) => request.requestId).sort());
  });
});

describe("a kill never leaves a half-written file", () => {
  test("SIGKILL at arbitrary moments: the file is always a whole version 2 file holding the old or the new entries, never a mix", async () => {
    const template = join(fx.home, "template.json");
    await writeFile(template, JSON.stringify(await fx.v2Entry(await fx.buildRequest(), { stagedKey: fx.key })));
    const writer = join(import.meta.dir, "test-support", "approval-store-writer.ts");
    const environment = { PATH: process.env.PATH, HOME: fx.home, TC_HOME: join(fx.home, "tc"), COURIER_HOME: join(fx.home, "courier"), BUN_INSTALL_CACHE_DIR: join(fx.home, "bun-cache") };

    for (const stopAfter of [1, 2, 3, 5, 8]) {
      await fx.writeState({ version: 2, entries: [], unrecognized: [] });
      const child = Bun.spawn([process.execPath, "--no-env-file", writer, PROFILE, template], { env: environment, stdout: "pipe", stderr: "pipe" });
      let completed = 0;
      const reader = child.stdout.getReader();
      while (completed < stopAfter) {
        const chunk = await reader.read();
        if (chunk.done) break;
        completed += new TextDecoder().decode(chunk.value).split("\n").filter((line) => line.startsWith("wrote ")).length;
      }
      // Kill with the next write most likely in flight: after the report, before the one that follows.
      child.kill("SIGKILL");
      await child.exited;
      expect(completed, `the writer reported ${completed} writes (stderr: ${await new Response(child.stderr).text()})`).toBeGreaterThanOrEqual(stopAfter);

      const text = await read();
      const parsed = parseApprovalFile(JSON.parse(text), { now: fx.clock });
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") continue;
      expect(parsed.migratedFrom).toBe(0);
      expect(parsed.file.unrecognized).toEqual([]);
      // The old file (completed writes) or the new one (one more): every entry whole and carrying its keys.
      expect(parsed.file.entries.length).toBeGreaterThanOrEqual(completed);
      expect(parsed.file.entries.length).toBeLessThanOrEqual(completed + 1);
      for (const entry of parsed.file.entries) expect(entry.keys?.stagedSigningKey).toEqual(fx.key);
      expect((await stat(file())).mode & 0o777).toBe(0o600);
    }
  }, 60_000);

  test("a temp file a killed writer left behind is ignored by the next read and never mistaken for the file", async () => {
    const entry = await fx.v2Entry(await fx.buildRequest());
    await fx.writeState({ version: 2, entries: [entry], unrecognized: [] });
    await writeFile(join(dir(), ".approval-pending.json.4242.00000000-0000-0000-0000-000000000000.tmp"), '{ "version": 2, "entries": [ { "requestId": "ha', { mode: 0o600 });
    const state = await loadApprovals(PROFILE);
    expect(state.entries.map((item) => item.requestId)).toEqual([entry.requestId]);
    expect(state.unrecognized).toEqual([]);
  });
});

describe("downgrade: what a 1.6.x CLI does with a version 2 file", () => {
  const legacy = () => legacyReader({
    profilePath: fx.profilePath, readJson: fx.readJson, writeJsonDurable: fx.writeJsonDurable,
    withLock: (profile, action, options) => fx.ProfileManager.withLock(profile, action, options),
    ensureProfileDir: (profile) => fx.ProfileManager.ensureProfileDir(profile),
  });

  test("the old reader sees no saved approval (it reads an object where it expects an array), and its first write FAILS with a TypeError instead of overwriting the file", async () => {
    await fx.writeState({ version: 2, entries: [await fx.v2Entry(await fx.buildRequest(), { stagedKey: fx.key })], unrecognized: [] });
    const before = await read();
    const old = legacy();

    expect(await old.activePending(PROFILE)).toEqual([]);
    const failed = await rejected(old.updatePending(PROFILE, (items) => [...items, { requestId: "x" }]));
    expect(failed).toBeInstanceOf(TypeError);
    // Bun: "Spread syntax requires ...iterable[Symbol.iterator] to be a function"; Node: "items is not iterable". Nothing says "upgrade".
    expect(failed.message).toMatch(/iterable/);
    const recovery = await rejected(old.recoveryEntries(PROFILE, COMMAND_INTENT));
    expect(recovery).toBeInstanceOf(TypeError);
    expect(recovery.message).toMatch(/filter is not a function/);

    // Nothing was dropped or overwritten: upgrading the CLI gets every entry back.
    expect(await read()).toBe(before);
    expect((await loadApprovals(PROFILE)).entries).toHaveLength(1);
  });
});

describe("sign-out still scrubs", () => {
  test("logout removes the pending file with every key in it, the quarantine, any set-aside copy and a killed writer's temp file", async () => {
    const request = await fx.buildRequest();
    await fx.writeState({ version: 2, entries: [await fx.v2Entry(request, { stagedKey: fx.key })], unrecognized: [{ raw: { relayPrivateKey: "SYNTHETIC-QUARANTINED-KEY" }, quarantinedAt: new Date(fx.clock).toISOString() }] });
    await writeFile(join(dir(), "approval-pending.json.corrupt-2026-11-03T00-00-00-000Z"), `{ "relayPrivateKey": "${request.relayPrivateKey}"`, { mode: 0o600 });
    await writeFile(join(dir(), ".approval-pending.json.4242.00000000-0000-0000-0000-000000000000.tmp"), JSON.stringify({ version: 2, entries: [await fx.v2Entry(request, { stagedKey: fx.key })], unrecognized: [] }), { mode: 0o600 });
    expect(await names()).not.toEqual([]);

    await clearProfileCredentials(PROFILE);
    expect(await names()).toEqual([]);
  });
});
const rejected = async (run: Promise<unknown>): Promise<Error> => {
  try { await run; } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("The call resolved; a rejection was expected");
};

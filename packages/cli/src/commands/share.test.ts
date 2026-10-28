import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySenderShareRecordStorage, revokeShare, ShareNotifyError, ShareReceiveError, type PublishedShare, type SenderShareRecord, type ShareTarget } from "@tinycloud/share-sdk";
import { ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { buildShortLink } from "@tinycloud/share-envelope/links";
import { configureShareCommandServices as configureServices, inspectShareInputOnce, registerShareCommand, parseShareTarget, shareCliError, shareHistoryRecoverError, type ShareCommandServices } from "./share.js";
import { ShareHistoryReadError, ShareHistoryRetryError, ShareHistoryUnreadableError, SharePublishAuthorityError } from "../share/errors.js";
import { safeFilename, writeShareOutput } from "../share/io.js";
import { runShareCaptured } from "./share.integration-harness.js";

const SHORT_LINK = buildShortLink({
  origin: "https://share.example", type: "share", id: "a".repeat(26), key: new Uint8Array(32).fill(7),
  bodyCid: "bafkreibm6jg3ux5qucnwb24kinphs4b5fbc7n5t3lti2skm4du5qjn4fli",
});
const emailDescriptorFixture = await Bun.file(new URL("../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as {
  vectors: { name: string; descriptor: unknown }[];
};
const emailDescriptor = emailDescriptorFixture.vectors.find((vector) => vector.name === "email")?.descriptor;
if (emailDescriptor === undefined) throw new Error("golden email descriptor is missing");

async function emailPublishArgs(directory: string): Promise<string[]> {
  const path = join(directory, "email-descriptor.json");
  await writeFile(path, JSON.stringify(emailDescriptor));
  return ["--credential-descriptor", path, "--issuer-did", "did:web:issuer.credentials.org", "--issuer-kid", "did:web:issuer.credentials.org#controller"];
}

/** These tests exercise the commands with short links available and invitations enabled; the gate has its own tests. */
function configureShareCommandServices(services: ShareCommandServices): void {
  configureServices(Object.keys(services).length === 0 ? services : {
    links: { show: async (published) => ({ url: published.url, short: true }), unlink: async () => "deleted" },
    shortLinkInvitations: true,
    ...services,
  });
}

describe("tc share command contract", () => {
  const reviewRecord: SenderShareRecord = {
    shareId: "review-share",
    target: { origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
    resource: { kind: "exact", path: "shares/review-share/note.md" },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "emailDomain", value: "example.com" },
    ownerDid: "did:key:z6Mkowner",
    enforcementDelegationCid: "bafy-enforcement",
    registeredAt: new Date().toISOString(),
    expiresAt: "2030-01-01T00:00:00.000Z",
    link: SHORT_LINK,
  };
  const reviewPublished: PublishedShare = {
    protocol: "tinycloud-share", version: 1, url: SHORT_LINK,
    link: { kind: "policy", cid: "bafy-review" },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId: reviewRecord.shareId, origin: "https://share.example",
      target: { kind: "email", ...reviewRecord.target },
      resource: reviewRecord.resource, actions: ["read"],
      expiresAt: reviewRecord.expiresAt, display: { filename: "note.md" },
      recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
    },
  };
  test("parses every target spelling without accepting an unknown target", () => {
    expect(parseShareTarget("anyone")).toEqual({ kind: "bearer" });
    expect(parseShareTarget("did:key:z6Mkexample")).toEqual({ kind: "recipientDid", did: "did:key:z6Mkexample" });
    expect(parseShareTarget("person@example.com")).toEqual({ kind: "email", address: "person@example.com" });
    expect(parseShareTarget("domain:Example.COM")).toEqual({ kind: "emailDomain", domain: "example.com" });
    // The issuer accepts only the canonical mailbox, so targets are canonical from the start.
    expect(parseShareTarget("email:Foo@X.com")).toEqual({ kind: "email", address: "foo@x.com" });
    expect(() => parseShareTarget("email:a%b@example.com")).toThrow("recipient email is invalid");
    expect(() => parseShareTarget("domain:example.123")).toThrow("recipient email domain is invalid");
    expect(() => parseShareTarget("unknown-target")).toThrow();
  });
  test("an untrusted-origin inline link exits 5 ORIGIN_MISMATCH and a malformed link exits 2 INVALID_LINK (TC-1737)", () => {
    const mismatch = shareCliError(new ShareReceiveError("origin-mismatch", "share link origin does not match the trusted viewer origin"));
    expect([mismatch.code, mismatch.exitCode]).toEqual(["ORIGIN_MISMATCH", 5]);
    const malformed = shareCliError(new ShareReceiveError("invalid-link", "share link format is invalid"));
    expect([malformed.code, malformed.exitCode]).toEqual(["INVALID_LINK", 2]);
  });
  test("share list prints a status column: active, revoked, expired (TC-1754)", async () => {
    const records = new MemorySenderShareRecordStorage();
    await records.put({ ...reviewRecord, shareId: "active-share", expiresAt: "2099-01-01T00:00:00.000Z" });
    await records.put({ ...reviewRecord, shareId: "revoked-share", expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: "2026-01-01T00:00:00.000Z" });
    await records.put({ ...reviewRecord, shareId: "expired-share", expiresAt: "2000-01-01T00:00:00.000Z" });
    configureShareCommandServices({ records });
    try {
      const output = await runShareCaptured(["share", "list"]);
      expect(output.exitCode).toBe(0);
      const rows = new Map(output.stdout.trimEnd().split("\n").map((line) => line.split("\t")).map((cells) => [cells[0], cells]));
      expect(rows.size).toBe(3);
      expect(rows.get("active-share")).toEqual(["active-share", "email-domain", "2099-01-01T00:00:00.000Z", "active"]);
      expect(rows.get("revoked-share")?.[3]).toBe("revoked");
      expect(rows.get("expired-share")?.[3]).toBe("expired");
      expect([...rows.values()].every((cells) => cells.length === 4)).toBe(true);
      const json = await runShareCaptured(["share", "list", "--json"]);
      expect(JSON.parse(json.stdout).shares.map((item: { shareId: string; revoked: boolean }) => [item.shareId, item.revoked]).sort()).toEqual([["active-share", false], ["expired-share", false], ["revoked-share", true]]);
    } finally {
      configureShareCommandServices({});
    }
  });
  test("maps authority failures to profile-aware actionable CLI codes", () => {
    const localAuth = shareCliError(new SharePublishAuthorityError({
      kind: "owner-space-unresolved",
      localKey: true,
      profileName: "wallet",
    }));
    expect(localAuth.code).toBe("AUTH_REQUIRED");
    expect(localAuth.message).toContain("tc --profile wallet auth login --method local");

    const sessionAuth = shareCliError(new SharePublishAuthorityError({
      kind: "owner-space-unresolved",
      localKey: false,
      profileName: "remote",
    }));
    expect(sessionAuth.code).toBe("AUTH_REQUIRED");
    expect(sessionAuth.message).toContain("tc --profile remote auth login --device --manifest builtin:share-publishing");
    expect(sessionAuth.message).toContain("tc --profile remote enable share");
    expect(sessionAuth.message).not.toContain("--method local");

    const scope = shareCliError(new SharePublishAuthorityError({
      kind: "scope-denied",
      capability: "KV upload",
      requiredAction: "tinycloud.kv/put",
      localKey: true,
      profileName: "wallet",
    }));
    expect(scope.code).toBe("PERMISSION_DENIED");
    expect(scope.message).toContain("tinycloud.kv/put");
    expect(scope.message).toContain("tc --profile wallet auth login --method local");
    expect(scope.message).not.toContain("builtin:share-publishing");

    const openKeyScope = shareCliError(new SharePublishAuthorityError({
      kind: "scope-denied",
      capability: "sharing delegation",
      requiredAction: "tinycloud.kv/get",
      localKey: false,
      profileName: "publisher",
    }));
    expect(openKeyScope.code).toBe("PERMISSION_DENIED");
    expect(openKeyScope.message).toContain("builtin:share-publishing scope");
    expect(openKeyScope.message).toContain("verify the session includes");
    expect(openKeyScope.message).toContain("tc --profile publisher auth login --device --manifest builtin:share-publishing");
    // A caveated session is fixed by a fresh unrestricted approval, not by
    // logging the same profile in again for a scope it already has.
    const caveated = shareCliError(new SharePublishAuthorityError({
      kind: "caveated-session",
      profileName: "wallet",
    }));
    expect(caveated).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(caveated.message).toContain("tc init --name publisher --key-only && tc --profile publisher enable share");
    expect(caveated.message).not.toContain("--profile wallet");
    const quota = shareCliError(new SharePublishAuthorityError({
      kind: "storage-full",
      code: "STORAGE_QUOTA_EXCEEDED",
      account: { usedBytes: 389_777_359, limitBytes: 104_857_600, plan: "free" },
    }));
    expect(quota).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      exitCode: 10,
      message: "TinyCloud storage is full; nothing was written.",
    });
    expect(quota.metadata?.hint).toBe("371.7 MiB used of 100 MiB (free plan). Reading still works.\nFree up space or upgrade: https://account.tinycloud.xyz/storage");
    const tooLarge = shareCliError(new SharePublishAuthorityError({ kind: "storage-full", code: "STORAGE_LIMIT_REACHED" }));
    expect(tooLarge).toMatchObject({ code: "STORAGE_LIMIT_REACHED", exitCode: 10 });
    expect(tooLarge.metadata?.hint).toBe("Reading still works.\nFree up space or upgrade: https://account.tinycloud.xyz/storage");
    // A storage rejection from another share write (history, delegation) is the same error.
    expect(shareCliError({ code: "STORAGE_QUOTA_EXCEEDED", message: "raw node text", meta: { status: 402 } })).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", exitCode: 10 });

    const nodeError = { code: "KV_WRITE_FAILED", message: "Failed to put key: 404 - Space not found", meta: { status: 404 } };
    const notReady = shareCliError(new SharePublishAuthorityError({ kind: "space-not-ready" }, { cause: nodeError }));
    expect(notReady).toMatchObject({ code: "SPACE_NOT_READY", exitCode: 4, cause: nodeError });
    expect(notReady.message).toBe("Your TinyCloud space isn't ready for this yet (SPACE_NOT_READY). This is a known node problem being fixed: retry after the node update; contact support with this code if it persists.");
    // A bare node 404 reaching the mapper (an unknown share, a missing key) is not SPACE_NOT_READY.
    expect(shareCliError(nodeError).code).not.toBe("SPACE_NOT_READY");

    // A failure no specific mapping claims is named by class and HTTP status, never by remote text.
    const secret = "tc1-SECRET-TOKEN https://share.example/viewer#tc1=SECRETFRAGMENT bafyPRIVATEMATERIALCID";
    const withStatus = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`policy root revocation rejected: HTTP ${status} - ${secret}`), { status, ...extra });
    const classes: ReadonlyArray<readonly [string, unknown, string, number, string]> = [
      ["401", withStatus(401), "AUTH_REQUIRED", 3, "HTTP 401"],
      ["403", withStatus(403), "PERMISSION_DENIED", 5, "HTTP 403"],
      ["service verdict on meta.status", { code: "AUTH_UNAUTHORIZED", message: secret, meta: { status: 403 } }, "PERMISSION_DENIED", 5, "HTTP 403"],
      ["404", withStatus(404), "NOT_FOUND", 4, "HTTP 404"],
      ["status on cause", Object.assign(new Error(secret), { cause: withStatus(404) }), "NOT_FOUND", 4, "HTTP 404"],
      ["409", withStatus(409), "NODE_REJECTED", 1, "HTTP 409"],
      ["422", withStatus(422), "INVALID_ARGUMENT", 2, "HTTP 422"],
      ["429", withStatus(429), "NODE_UNAVAILABLE", 7, "HTTP 429"],
      ["502 with an upstream code", withStatus(502, { code: "UPSTREAM_DOWN" }), "NODE_UNAVAILABLE", 7, "HTTP 502, UPSTREAM_DOWN"],
      ["unreachable node", new TypeError(`fetch failed ${secret}`), "NETWORK_ERROR", 6, "could not be reached"],
    ];
    for (const [label, input, code, exitCode, reason] of classes) {
      const mapped = shareCliError(input);
      expect(mapped, label).toMatchObject({ code, exitCode, cause: input });
      expect(mapped.message, label).toContain(reason);
      expect(mapped.message, label).not.toMatch(/SECRET|PRIVATEMATERIAL|tc1-|viewer/);
      expect(shareCliError(input, "notify").code, label).toBe(code);
    }
    // An upstream code that is not a plain identifier is dropped, not echoed.
    expect(shareCliError(withStatus(500, { code: `bad ${secret}` })).message).not.toMatch(/SECRET|PRIVATEMATERIAL/);
    // No status, verdict or network signal: unchanged.
    expect(shareCliError(new Error(secret))).toMatchObject({ code: "INVALID_ARGUMENT", exitCode: 2, message: "share operation failed" });
    expect(shareCliError(new TypeError("recipient is invalid"))).toMatchObject({ code: "INVALID_ARGUMENT", message: "share input is invalid" });

    const upload = shareCliError(new SharePublishAuthorityError({ kind: "upload-failed" }));
    expect(upload).toMatchObject({ code: "UPLOAD_FAILED", exitCode: 4 });
    expect(upload.message).toContain("nothing was shared");

    const beyondSession = shareCliError(new SharePublishAuthorityError({
      kind: "lifetime-exceeds-session",
      sessionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      reason: "beyond-session",
    }));
    expect(beyondSession.code).toBe("SESSION_LIFETIME_EXCEEDED");
    expect(beyondSession.message).toContain("2099-01-01T00:00:00.000Z");
    expect(beyondSession.message).toContain("shorter --expires value or renew the session");

    const belowMinimum = shareCliError(new SharePublishAuthorityError({
      kind: "lifetime-exceeds-session",
      sessionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      reason: "below-minimum",
    }));
    expect(belowMinimum.code).toBe("SESSION_LIFETIME_EXCEEDED");
    expect(belowMinimum.message).toContain("longer --expires");

    const sessionTooClose = shareCliError(new SharePublishAuthorityError({
      kind: "lifetime-exceeds-session",
      sessionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      reason: "session-too-close",
      profileName: "remote",
    }));
    expect(sessionTooClose.code).toBe("AUTH_REQUIRED");
    expect(sessionTooClose.message).toContain("log in again");
    expect(sessionTooClose.message).toContain("tc --profile remote auth login --device --manifest builtin:share-publishing");

    const originMismatch = shareCliError(new SharePublishAuthorityError({ kind: "origin-mismatch" }));
    expect(originMismatch.code).toBe("ORIGIN_MISMATCH");
    expect(originMismatch.message).toBe("share origin does not match the configured service");
  });

  test("names a refused addressed request and separates retryable from rejected registry failures", () => {
    const invalid = shareCliError(new SharePublishAuthorityError({ kind: "invalid-request", reason: "email-domain shares are view-only" }));
    expect([invalid.code, invalid.message, invalid.exitCode]).toEqual(["INVALID_ARGUMENT", "email-domain shares are view-only", 2]);
    const unsupportedVersion = shareCliError(new SharePublishAuthorityError({ kind: "invalid-request", reason: "node reports version 1.17.2" }));
    expect([unsupportedVersion.code, unsupportedVersion.exitCode, unsupportedVersion.message]).toEqual(["INVALID_ARGUMENT", 2, "node reports version 1.17.2"]);
    const missingNodeInfo = shareCliError(new SharePublishAuthorityError({ kind: "node-info-unavailable" }));
    expect([missingNodeInfo.code, missingNodeInfo.exitCode]).toEqual(["UNAVAILABLE", 4]);
    const unavailable = shareCliError(new SharePublishAuthorityError({ kind: "registry-unavailable" }));
    expect([unavailable.code, unavailable.exitCode]).toEqual(["UNAVAILABLE", 4]);
    const shareService = shareCliError(new SharePublishAuthorityError({ kind: "share-service-unavailable", origin: "https://share.example" }));
    expect([shareService.code, shareService.exitCode]).toEqual(["SHARE_SERVICE_UNAVAILABLE", 4]);
    expect(shareService.message).toContain("the Share service at https://share.example could not be reached, so nothing was shared");
    expect(shareService.message).not.toContain("node");
    const publishInfo = shareCliError(new SharePublishAuthorityError({ kind: "node-info-unavailable" }));
    expect(publishInfo.message).toContain("nothing was shared and no invitation was sent");
    const notifyInfo = shareCliError(new SharePublishAuthorityError({ kind: "node-info-unavailable" }), "notify");
    expect(notifyInfo.message).toContain("no invitation was sent");
    expect(notifyInfo.message).not.toContain("nothing was shared");
    const locked = shareCliError(new ProfileLockTimeoutError("publisher", 2000));
    expect([locked.code, locked.exitCode]).toEqual(["PROFILE_LOCK_TIMEOUT", 1]);
    expect(locked.metadata?.hint).toContain("retry");
    expect(unavailable.message).toContain("try again");
    const rejected = shareCliError(new SharePublishAuthorityError({ kind: "registry-rejected" }));
    expect([rejected.code, rejected.exitCode]).toEqual(["REGISTRY_REJECTED", 6]);
    expect(rejected.message).toContain("retrying will not help");
  });

  test("registers only the current native sharing lifecycle commands", () => {
    const program = new Command();
    registerShareCommand(program);
    const share = program.commands.find((command) => command.name() === "share");
    expect(share?.commands.map((command) => command.name())).toEqual([
      "publish", "inspect", "versions", "receive", "list", "show", "notify", "revoke", "unlink", "history",
    ]);
    const history = share?.commands.find((command) => command.name() === "history");
    expect(history?.commands.map((command) => command.name())).toEqual(["recover"]);
  });

  test("--notify without read refuses before publishing or recording anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-no-read-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    let publishes = 0;
    let records = 0;
    configureShareCommandServices({
      targetAdapter: { async publish() { publishes++; throw new Error("must not publish"); } },
      records: {
        async put() { records++; },
        async get() { return undefined; },
        async list() { return []; },
        async delete() {},
      },
    });
    const originalExit = process.exit;
    const originalExitCode = process.exitCode;
    const originalError = process.stderr.write;
    const errors: string[] = [];
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerShareCommand(program);
      await program.parseAsync(["node", "tc", "share", "publish", file, "--to", "email:alice@example.com", "--notify", "--action", "edit"]);
    } finally {
      process.exit = originalExit;
      process.exitCode = originalExitCode;
      process.stderr.write = originalError;
      configureShareCommandServices({});
    }
    expect(errors.join("")).toContain("INVALID_ARGUMENT");
    expect(errors.join("")).toContain("read");
    expect(exitCode).toBe(2);
    expect(publishes).toBe(0);
    expect(records).toBe(0);
  });

  test("a mixed-case --notify publish delivers to the canonical recipient and prints the link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-notify-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    const records = new Map<string, SenderShareRecord>();
    const delivered: string[] = [];
    configureShareCommandServices({
      // Mirrors the real adapter: the published matcher is the target it was given.
      targetAdapter: { async publish(input) {
        const target: ShareTarget = input.target;
        if (target.kind !== "email") throw new Error("expected an email target");
        return {
          protocol: "tinycloud-share", version: 1, url: SHORT_LINK,
          link: { kind: "policy", cid: "bafy-share" },
          metadata: {
            protocol: "tinycloud-share", version: 1, shareId: "share-notify", origin: "https://share.example",
            target: { kind: "email", origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
            resource: { kind: "exact", path: "shares/share-notify/note.md" }, actions: ["read"],
            expiresAt: "2030-01-01T00:00:00.000Z", display: { filename: "note.md" },
            recipientMatcher: { kind: "exactEmail", value: target.address },
          },
        } satisfies PublishedShare;
      } },
      records: {
        async put(record) { records.set(record.shareId, record); },
        async update(shareId, change) {
          const current = records.get(shareId);
          if (current === undefined) return undefined;
          const updated = await change(current);
          records.set(shareId, updated);
          return updated;
        },
        async get(shareId) { return records.get(shareId); },
        async list() { return [...records.values()]; },
        async delete(shareId) { records.delete(shareId); },
      },
      delivery: { async deliver(request) { delivered.push(request.recipient); return "delivered"; } },
    });
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const program = new Command();
      registerShareCommand(program);
      await program.parseAsync(["node", "tc", "share", "publish", file, "--to", "email:Foo@X.com", "--notify", ...await emailPublishArgs(directory)]);
      await program.parseAsync(["node", "tc", "share", "notify", "share-notify", "--to", "FOO@X.COM"]);
    } finally {
      process.stdout.write = write;
      configureShareCommandServices({});
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(records.get("share-notify")?.recipientMatcher).toEqual({ kind: "exactEmail", value: "foo@x.com" });
    expect(records.get("share-notify")?.deliveredRecipients).toEqual(["foo@x.com"]);
    expect(delivered).toEqual(["foo@x.com", "foo@x.com"]);
    expect(written.join("")).toContain(SHORT_LINK);
    expect(written.at(-1)).toBe("already-delivered\n");
  });

  test("domain --notify requires a matching mailbox and passes read+edit to publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-domain-notify-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    const published: Array<{ readonly target: ShareTarget; readonly actions?: readonly string[]; readonly notify?: boolean }> = [];
    const deliveries: string[] = [];
    configureShareCommandServices({
      targetAdapter: { async publish(input) {
        published.push({ target: input.target, actions: input.actions, notify: input.notify });
        return {
          protocol: "tinycloud-share", version: 1, url: SHORT_LINK,
          link: { kind: "policy", cid: "bafy-domain" },
          metadata: {
            protocol: "tinycloud-share", version: 1, shareId: "share-domain", origin: "https://share.example",
            target: { kind: "emailDomain", origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
            resource: { kind: "exact", path: "shares/share-domain/note.md" }, actions: ["read", "edit"],
            expiresAt: "2030-01-01T00:00:00.000Z", display: { filename: "note.md" },
            recipientMatcher: { kind: "emailDomain", value: "example.com" },
          },
        } satisfies PublishedShare;
      } },
      delivery: { async deliver(input) { deliveries.push(input.recipient); return "delivered"; } },
    });
    const originalExit = process.exit;
    const originalWrite = process.stdout.write;
    const originalError = process.stderr.write;
    const originalExitCode = process.exitCode;
    const errors: string[] = [];
    process.exit = (() => {}) as typeof process.exit;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerShareCommand(program);
      await program.parseAsync(["node", "tc", "share", "publish", file, "--to", "domain:example.com", "--notify"]);
      await program.parseAsync(["node", "tc", "share", "publish", file, "--to", "domain:example.com", "--notify", "--notify-to", "bob@other.com"]);
      expect(published).toHaveLength(0);
      expect(errors.join("")).toContain("INVALID_ARGUMENT");
      await program.parseAsync(["node", "tc", "share", "publish", file, "--to", "domain:example.com", "--notify", "--notify-to", "Bob@Example.COM", "--action", "read", "edit"]);
    } finally {
      process.exit = originalExit;
      process.stdout.write = originalWrite;
      process.stderr.write = originalError;
      process.exitCode = originalExitCode;
      configureShareCommandServices({});
    }
    expect(published).toEqual([{ target: { kind: "emailDomain", domain: "example.com" }, actions: ["read", "edit"], notify: true }]);
    expect(deliveries).toEqual(["bob@example.com"]);
  });

  test("publish keeps its link and immediate invitation when initial sender history cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-initial-history-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    let deliveries = 0;
    configureShareCommandServices({
      targetAdapter: { async publish() { return reviewPublished; } },
      records: {
        async put() { throw new ProfileLockTimeoutError("publisher", 45000); },
        async get() { return undefined; },
        async list() { return []; },
        async delete() {},
      },
      delivery: { async deliver() { deliveries++; return "delivered"; } },
    });
    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;
    try {
      const output = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify", ...await emailPublishArgs(directory)]);
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe(`${reviewPublished.url}\n`);
      expect(output.stderr).toContain("published but not recorded");
      expect(output.stderr).toContain("share list");
      expect(output.stderr).toContain("share notify");
      expect(deliveries).toBe(1);
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  });

  async function publishJsonWithHistoryPut(put: () => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-history-reason-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    configureShareCommandServices({
      targetAdapter: { async publish() { return reviewPublished; } },
      records: {
        put,
        async get() { return undefined; },
        async list() { return []; },
        async delete() {},
      },
    });
    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;
    try {
      return await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--json", ...await emailPublishArgs(directory)]);
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  }

  function expectHistoryWarningWithoutSecrets(stderr: string, reason: string) {
    expect(stderr).toContain(`(${reason})`);
    expect(stderr).toContain(reviewPublished.metadata.shareId);
    expect(stderr).toContain(reviewPublished.link.cid);
    expect(stderr).not.toContain(reviewPublished.url);
    expect(stderr).not.toContain("k=");
    expect(stderr).not.toContain("#v=4");
  }

  test("publish --json reports HISTORY_UNREADABLE when the existing sender history cannot be decrypted", async () => {
    const output = await publishJsonWithHistoryPut(async () => { throw new ShareHistoryUnreadableError(); });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      link: reviewPublished.link,
      metadata: { shareId: reviewPublished.metadata.shareId },
      history: { recorded: false, reason: "HISTORY_UNREADABLE" },
    });
    expectHistoryWarningWithoutSecrets(output.stderr, "HISTORY_UNREADABLE");
  });

  test("publish --json reports HISTORY_READ_FAILED when the filesystem cannot read the existing sender history", async () => {
    const output = await publishJsonWithHistoryPut(async () => { throw new ShareHistoryReadError(); });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ history: { recorded: false, reason: "HISTORY_READ_FAILED" } });
    expectHistoryWarningWithoutSecrets(output.stderr, "HISTORY_READ_FAILED");
  });

  test("publish --json reports HISTORY_WRITE_FAILED for filesystem write errors", async () => {
    const diskFull = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const output = await publishJsonWithHistoryPut(async () => { throw diskFull; });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ history: { recorded: false, reason: "HISTORY_WRITE_FAILED" } });
    expectHistoryWarningWithoutSecrets(output.stderr, "HISTORY_WRITE_FAILED");
  });

  test("publish --json reports HISTORY_UNAVAILABLE for other sender history failures", async () => {
    const output = await publishJsonWithHistoryPut(async () => { throw new ProfileLockTimeoutError("publisher", 45000); });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ history: { recorded: false, reason: "HISTORY_UNAVAILABLE" } });
    expectHistoryWarningWithoutSecrets(output.stderr, "HISTORY_UNAVAILABLE");
  });

  test("publish --json reports recorded history without a warning when the write succeeds", async () => {
    const output = await publishJsonWithHistoryPut(async () => {});
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ history: { recorded: true } });
    expect(output.stderr).not.toContain("not recorded in sender history");
  });

  test("publish --json reports unconfigured sender history instead of skipping it silently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-history-unconfigured-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    configureShareCommandServices({ targetAdapter: { async publish() { return reviewPublished; } } });
    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;
    try {
      const output = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--json", ...await emailPublishArgs(directory)]);
      expect(output.exitCode).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({ history: { recorded: false, reason: "HISTORY_UNAVAILABLE" } });
      expectHistoryWarningWithoutSecrets(output.stderr, "HISTORY_UNAVAILABLE");
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  });

  test("revoke reports a retryable history race after node revocation already succeeded", async () => {
    let revocations = 0;
    configureShareCommandServices({
      records: {
        async put() {},
        async get() { return reviewRecord; },
        async list() { return [reviewRecord]; },
        async delete() {},
        async update() { throw new ShareHistoryRetryError("publisher"); },
      },
      revocation: {
        async revokePolicyRoot() { revocations++; },
      },
    });
    const originalExit = process.exit;
    const exits: number[] = [];
    process.exit = ((code?: number) => { exits.push(code ?? 0); }) as typeof process.exit;
    try {
      const output = await runShareCaptured(["share", "revoke", reviewRecord.shareId]);
      expect(revocations).toBe(1);
      expect(exits).toEqual([1]);
      const failure = (JSON.parse(output.stderr) as { error: { code: string; hint: string } }).error;
      expect(failure.code).toBe("SHARE_HISTORY_RETRY");
      expect(failure.hint).toContain('--profile "publisher"');
      expect(failure.hint).toContain("revocation may already have succeeded");
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  });

  test("an unknown profile keeps PROFILE_NOT_FOUND for list and revoke before any node call", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-share-unknown-profile-"));
    try {
      for (const command of [["list", "--json"], ["revoke", "abc"]]) {
        const child = Bun.spawn(["bun", new URL("../index.ts", import.meta.url).pathname, "--profile", "nope", "share", ...command], {
          cwd: join(import.meta.dir, "../../../.."),
          env: { ...process.env, TC_HOME: home },
          stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exit).toBe(1);
        expect(stdout).toBe("");
        expect(JSON.parse(stderr)).toMatchObject({
          error: { code: "PROFILE_NOT_FOUND", message: expect.stringContaining("tc init") },
        });
        expect(stderr).not.toContain("revocation may already have succeeded");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("publish and standalone notify retain success when delivery confirmation cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-confirmation-failure-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    let persisted: SenderShareRecord | undefined;
    let writes = 0;
    configureShareCommandServices({
      targetAdapter: { async publish() { return reviewPublished; } },
      records: {
        async put(record) {
          writes++;
          if (writes > 1) throw new Error("sender history disk is full");
          persisted = record;
        },
        async get() { return persisted; },
        async list() { return persisted === undefined ? [] : [persisted]; },
        async delete() {},
        async update() { throw new Error("sender history disk is full"); },
      },
      delivery: { async deliver() { return "delivered"; } },
    });
    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;
    try {
      const published = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify", ...await emailPublishArgs(directory)]);
      expect(published).toMatchObject({ exitCode: 0, stdout: `${reviewPublished.url}\n` });
      expect(published.stderr).toContain("(HISTORY_UNAVAILABLE)");
      expect(persisted?.deliveredRecipients).toBeUndefined();
      const notified = await runShareCaptured(["share", "notify", reviewPublished.metadata.shareId, "--to", "alice@example.com", "--json"]);
      expect(notified.exitCode).toBe(0);
      expect(JSON.parse(notified.stdout)).toMatchObject({ state: "delivered" });
      expect(notified.stderr).toContain("(HISTORY_UNAVAILABLE)");
      expect(notified.stderr).not.toContain(reviewPublished.link.cid);
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  });

  test("publish --notify --json keeps history recorded and names the share when delivery confirmation cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-confirmation-json-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    configureShareCommandServices({
      targetAdapter: { async publish() { return reviewPublished; } },
      records: {
        async put() {},
        async get() { return undefined; },
        async list() { return []; },
        async delete() {},
        async update() { throw new Error("sender history disk is full"); },
      },
      delivery: { async deliver() { return "delivered"; } },
    });
    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;
    try {
      const output = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify", "--json", ...await emailPublishArgs(directory)]);
      expect(output.exitCode).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({ history: { recorded: true }, notification: { state: "delivered" } });
      expectHistoryWarningWithoutSecrets(output.stderr, "HISTORY_UNAVAILABLE");
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  });

  test("publish JSON includes its notification outcome without changing publication fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-publish-json-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    configureShareCommandServices({
      targetAdapter: { async publish() { return reviewPublished; } },
      records: new MemorySenderShareRecordStorage(),
      delivery: { async deliver() { throw new ShareNotifyError("window expired", "delivery-window-expired"); } },
    });
    try {
      const output = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify", "--json", ...await emailPublishArgs(directory)]);
      expect(output.exitCode).toBe(9);
      expect(JSON.parse(output.stdout)).toMatchObject({
        protocol: "tinycloud-share", version: 1, link: reviewPublished.link,
        metadata: { shareId: reviewPublished.metadata.shareId },
        notification: { state: "partial-failure", retryable: false, reason: "delivery-window-expired", attempts: 1 },
      });
    } finally {
      configureShareCommandServices({});
    }
  });

  test("standalone notify refuses records without read and unsupported domain delivery before sending", async () => {
    let deliveries = 0;
    let probes = 0;
    let record: SenderShareRecord = { ...reviewRecord, actions: ["tinycloud.kv/put"] };
    configureShareCommandServices({
      records: {
        async put() {},
        async get() { return record; },
        async list() { return [record]; },
        async delete() {},
      },
      delivery: { async deliver() { deliveries++; return "delivered"; } },
      assertDomainDelivery: async () => {
        probes++;
        throw new SharePublishAuthorityError({ kind: "invalid-request", reason: "node version 1.17.2 is below 1.17.3" });
      },
    });
    const originalExit = process.exit;
    const exits: number[] = [];
    process.exit = ((code?: number) => { exits.push(code ?? 0); }) as typeof process.exit;
    try {
      const readless = await runShareCaptured(["share", "notify", record.shareId, "--to", "alice@example.com"]);
      expect(readless.stderr).toContain("read");
      expect(exits.at(-1)).toBe(2);
      expect(probes).toBe(0);
      record = { ...reviewRecord };
      const unsupported = await runShareCaptured(["share", "notify", record.shareId, "--to", "alice@example.com"]);
      expect(unsupported.stderr).toContain("1.17.2");
      expect(exits.at(-1)).toBe(2);
      expect(probes).toBe(1);
      expect(deliveries).toBe(0);
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  });

  test("notification confirmation preserves a revocation committed during delivery", async () => {
    const storage = new MemorySenderShareRecordStorage();
    await storage.put(reviewRecord);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let deliveries = 0;
    configureShareCommandServices({
      records: storage,
      assertDomainDelivery: async () => {},
      delivery: { async deliver() {
        deliveries++;
        if (deliveries === 1) { entered.resolve(); await release.promise; }
        return "delivered";
      } },
    });
    try {
      const notifying = runShareCaptured(["share", "notify", reviewRecord.shareId, "--to", "alice@example.com"]);
      await entered.promise;
      await revokeShare({
        record: reviewRecord, records: storage, adapter: { async revokePolicyRoot() {} },
      });
      release.resolve();
      expect((await notifying).exitCode).toBe(0);
      expect(await storage.get(reviewRecord.shareId)).toMatchObject({
        revokedAt: expect.any(String), deliveredRecipients: ["alice@example.com"],
      });

    } finally {
      release.resolve();
      configureShareCommandServices({});
    }
  });

  test("two overlapping notifications retain both confirmations", async () => {
    const storage = new MemorySenderShareRecordStorage();
    await storage.put({ ...reviewRecord, deliveredRecipients: ["alice@example.com"] });
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const both = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let waiting = 0;
    configureShareCommandServices({
      records: storage,
      assertDomainDelivery: async () => {},
      delivery: { async deliver() {
        waiting++;
        if (waiting === 1) { first.resolve(); await both.promise; await releaseFirst.promise; }
        if (waiting === 2) { second.resolve(); both.resolve(); }
        return "delivered";
      } },
    });
    try {
      const firstNotify = runShareCaptured(["share", "notify", reviewRecord.shareId, "--to", "bob@example.com", "--json"]);
      await first.promise;
      const secondNotify = runShareCaptured(["share", "notify", reviewRecord.shareId, "--to", "carol@example.com", "--json"]);
      await second.promise;
      expect((await secondNotify).exitCode).toBe(0);
      releaseFirst.resolve();
      expect((await firstNotify).exitCode).toBe(0);
      expect([...(await storage.get(reviewRecord.shareId))?.deliveredRecipients ?? []].sort()).toEqual([
        "alice@example.com", "bob@example.com", "carol@example.com",
      ]);
    } finally {
      both.resolve();
      releaseFirst.resolve();
      configureShareCommandServices({});
    }
  });

  test("domain notify validates recipient and expired window before querying node info", async () => {
    let record: SenderShareRecord = { ...reviewRecord, registeredAt: "2020-01-01T00:00:00.000Z" };
    let probes = 0;
    let deliveries = 0;
    configureShareCommandServices({
      records: {
        async put() {},
        async get() { return record; },
        async list() { return [record]; },
        async delete() {},
      },
      assertDomainDelivery: async () => {
        probes++;
        throw new SharePublishAuthorityError({ kind: "node-info-unavailable" });
      },
      delivery: { async deliver() { deliveries++; throw new Error("must not deliver"); } },
    });
    const originalExit = process.exit;
    const exits: number[] = [];
    process.exit = ((code?: number) => { exits.push(code ?? 0); }) as typeof process.exit;
    try {
      const expired = await runShareCaptured(["share", "notify", record.shareId, "--to", "alice@example.com", "--json"]);
      expect(expired.exitCode).toBe(9);
      expect(JSON.parse(expired.stdout)).toMatchObject({
        state: "partial-failure", retryable: false, reason: "delivery-window-expired", attempts: 1,
      });
      expect(expired.stderr).toContain("publish a new share");
      expect([probes, deliveries]).toEqual([0, 0]);

      record = { ...reviewRecord };
      const mismatch = await runShareCaptured(["share", "notify", record.shareId, "--to", "alice@other.example"]);
      expect(mismatch.stderr).toContain("recipient does not match");
      expect(exits.at(-1)).toBe(2);
      expect([probes, deliveries]).toEqual([0, 0]);
    } finally {
      process.exit = originalExit;
      configureShareCommandServices({});
    }
  });

  test("an expired notify window reports non-retryable partial success and a republish hint", async () => {
    const record: SenderShareRecord = {
      shareId: "share-expired",
      target: { origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
      resource: { kind: "exact", path: "shares/share-expired/note.md" },
      actions: ["tinycloud.kv/get"],
      recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
      registeredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      link: SHORT_LINK,
    };
    configureShareCommandServices({
      records: {
        async put() {},
        async get() { return record; },
        async list() { return [record]; },
        async delete() {},
      },
      delivery: { async deliver() { throw new ShareNotifyError("window expired", "delivery-window-expired"); } },
    });
    const written: string[] = [];
    const warnings: string[] = [];
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    const exitCode = process.exitCode;
    process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerShareCommand(program);
      await program.parseAsync(["node", "tc", "share", "notify", record.shareId, "--to", "alice@example.com", "--json"]);
      expect(process.exitCode).toBe(9);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      process.exitCode = exitCode ?? 0;
      configureShareCommandServices({});
    }
    expect(JSON.parse(written.join(""))).toMatchObject({ state: "partial-failure", retryable: false, reason: "delivery-window-expired", attempts: 1 });
    expect(warnings.join("")).toContain("publish a new share");
  });

  test("inspect consumes an addressed URL from stdin exactly once", async () => {
    let reads = 0;
    let inspected = "";
    const result = await inspectShareInputOnce(undefined, true, "https://share.example", {
      read: async () => { reads += 1; return SHORT_LINK; },
      inspect: (async (link: string) => {
        inspected = link;
        return { protocol: "tinycloud-share", version: 1 } as never;
      }) as never,
    });
    expect(reads).toBe(1);
    expect(inspected).toBe(SHORT_LINK);
    expect(result).toMatchObject({ protocol: "tinycloud-share", version: 1 });
  });

  test("an inline link at an untrusted origin is an origin mismatch before any inspection; one that does not parse is left to share-sdk", async () => {
    let inspected = 0;
    const inspect = (async () => { inspected += 1; throw new ShareReceiveError("invalid-link", "share link format is invalid"); }) as never;
    for (const link of [
      SHORT_LINK.replace("https://share.example", "https://share.example.evil.example"),
      SHORT_LINK.replace("https://share.example", "http://share.example"),
    ]) {
      await expect(inspectShareInputOnce(link, false, "https://share.example", { inspect })).rejects.toMatchObject({ code: "origin-mismatch" });
    }
    expect(inspected).toBe(0);
    await expect(inspectShareInputOnce("not a url", false, "https://share.example", { inspect })).rejects.toMatchObject({ code: "invalid-link" });
    expect(inspected).toBe(1);
  });
});

describe("safe Share output", () => {
  test("creates exclusively and rejects a pre-existing path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-output-"));
    const path = await writeShareOutput(directory, "report.md", new TextEncoder().encode("one"), false);
    expect(path).toBe(join(directory, "report.md"));
    await expect(writeShareOutput(directory, "report.md", new TextEncoder().encode("two"), false)).rejects.toThrow("OUTPUT_EXISTS");
  });

  test("rejects symlink outputs even when force is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-symlink-"));
    const target = join(directory, "outside.md");
    const link = join(directory, "report.md");
    await symlink(target, link);
    await expect(writeShareOutput(directory, "report.md", new TextEncoder().encode("secret"), true)).rejects.toThrow();
  });

  test("rejects a symlink in an output-directory ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-ancestor-"));
    const outside = await mkdtemp(join(tmpdir(), "tc-share-outside-"));
    await mkdir(join(root, "real"));
    await symlink(outside, join(root, "real", "alias"));
    await expect(writeShareOutput(join(root, "real", "alias", "nested"), "report.md", new TextEncoder().encode("secret"), false)).rejects.toThrow("OUTPUT_EXISTS");
  });

  test("allows only one safe Markdown filename segment", () => {
    expect(safeFilename("report.md")).toBe("report.md");
    expect(() => safeFilename("../report.md")).toThrow("filename must be one safe path segment");
    expect(() => safeFilename("nested/report.md")).toThrow("filename must be one safe path segment");
    for (const name of ["a\u0001.md", "a\u200b.md", "a\u202e.md", "a\u2028.md"]) {
      let caught: unknown;
      try { safeFilename(name); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: "UNSAFE_FILENAME", exitCode: 8, message: "filename contains control or invisible characters" });
    }
  });
});

describe("share history recover failures", () => {
  test("names a filesystem failure on the quarantine step without hinting at the input", () => {
    for (const code of ["EACCES", "EEXIST", "EPERM", "EROFS", "EXDEV", "ENOTSUP", "ENOSPC", "EIO"]) {
      const failure = shareHistoryRecoverError(Object.assign(new Error("raw fs text"), { code }));
      expect(failure).toMatchObject({ code: "SHARE_HISTORY_RECOVER_FAILED", exitCode: 1 });
      expect(failure.message).toBe(`could not move the unreadable sender history aside (${code})`);
      expect(failure.metadata?.hint).toBe("The original history file was not deleted. Check write permission on the profile directory, then retry.");
    }
  });

  test("leaves other failures to the generic share mapping", () => {
    const unknown = shareHistoryRecoverError(new Error("Not signed in. Call signIn() first."));
    expect(unknown).toMatchObject({ code: "INVALID_ARGUMENT", exitCode: 2, message: "share operation failed" });
    expect(shareHistoryRecoverError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toMatchObject({ code: "INVALID_ARGUMENT", exitCode: 2 });
  });
});

describe("tc share with the default services", () => {
  // No `links` and no `shortLinkInvitations`: the configuration index.ts installs. The wrapper the other tests use is not involved.
  test("invitations fail closed with exit 4 and the final text, and a publish without --notify works", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-default-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    const stored = new Map<string, SenderShareRecord>();
    let publishes = 0;
    let deliveries = 0;
    const published: PublishedShare = {
      protocol: "tinycloud-share", version: 1, url: SHORT_LINK, link: { kind: "policy", cid: "bafy-default" },
      metadata: {
        protocol: "tinycloud-share", version: 1, shareId: "share-default", origin: "https://share.example",
        target: { kind: "email", origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
        resource: { kind: "exact", path: "shares/share-default/note.md" }, actions: ["read"],
        expiresAt: "2030-01-01T00:00:00.000Z", display: { filename: "note.md" },
        recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
      },
    };
    stored.set("share-default", { ...reviewRecordForDefaults(), link: SHORT_LINK });
    configureServices({
      targetAdapter: { async publish() { publishes += 1; return published; } },
      records: {
        async put(record) { stored.set(record.shareId, record); },
        async get(shareId) { return stored.get(shareId); },
        async list() { return [...stored.values()]; },
        async delete(shareId) { stored.delete(shareId); },
      },
      delivery: { async deliver() { deliveries += 1; return "delivered"; } },
    });
    const originalExit = process.exit;
    const exits: (number | undefined)[] = [];
    process.exit = ((code?: number) => { exits.push(code); }) as typeof process.exit;
    try {
      const notifyPublish = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify", ...await emailPublishArgs(directory)]);
      expect(exits).toEqual([4]);
      expect(notifyPublish.stderr).toContain("Invitation emails are not available yet. Nothing was shared and no invitation was sent.");
      expect(publishes).toBe(0);

      exits.length = 0;
      const notify = await runShareCaptured(["share", "notify", "share-default", "--to", "alice@example.com"]);
      expect(exits).toEqual([4]);
      expect(notify.stderr).toContain("Invitation emails are not available yet. No invitation was sent.");
      expect(deliveries).toBe(0);

      stored.delete("share-default");
      exits.length = 0;
      const plain = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", ...await emailPublishArgs(directory)]);
      expect(exits).toEqual([]);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toBe(`${SHORT_LINK}\n`);
      expect(publishes).toBe(1);
      expect(stored.get("share-default")?.link).toBe(SHORT_LINK);
    } finally {
      process.exit = originalExit;
      configureServices({});
    }
  });
});

function reviewRecordForDefaults(): SenderShareRecord {
  return {
    shareId: "share-default",
    target: { origin: "https://node.example", nodeAudience: "did:key:z6Mknode", spaceId: "tinycloud:space" },
    resource: { kind: "exact", path: "shares/share-default/note.md" },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
    registeredAt: new Date().toISOString(),
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("tc share from a sign-in without the default-key decrypt", () => {
  test("an email share is refused with PERMISSION_DENIED pointing at the paste sign-in, and nothing is stored or sent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc-share-decrypt-"));
    const file = join(directory, "note.md");
    await writeFile(file, "# note\n");
    const stored = new Map<string, SenderShareRecord>();
    let deliveries = 0;
    configureShareCommandServices({
      targetAdapter: { async publish() { throw new SharePublishAuthorityError({ kind: "decrypt-not-held" }); } },
      records: {
        async put(record) { stored.set(record.shareId, record); },
        async get(shareId) { return stored.get(shareId); },
        async list() { return [...stored.values()]; },
        async delete(shareId) { stored.delete(shareId); },
      },
      delivery: { async deliver() { deliveries += 1; return "delivered"; } },
    });
    const originalExit = process.exit;
    const exits: (number | undefined)[] = [];
    process.exit = ((code?: number) => { exits.push(code); }) as typeof process.exit;
    try {
      const result = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify", "--json", ...await emailPublishArgs(directory)]);
      expect(exits).toEqual([5]);
      expect(result.stderr).toContain("PERMISSION_DENIED");
      expect(result.stderr).toContain("--paste");
      expect(result.stdout).toBe("");
      expect(stored.size).toBe(0);
      expect(deliveries).toBe(0);
    } finally {
      process.exit = originalExit;
      configureServices({});
      await rm(directory, { recursive: true, force: true });
    }
  });
});

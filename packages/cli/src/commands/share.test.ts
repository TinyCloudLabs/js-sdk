import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySenderShareRecordStorage, revokeShare, ShareNotifyError, type PublishedShare, type SenderShareRecord, type ShareTarget } from "@tinycloud/share-sdk";
import { ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { configureShareCommandServices, inspectShareInputOnce, registerShareCommand, parseShareTarget, shareCliError } from "./share.js";
import { ShareHistoryRetryError, SharePublishAuthorityError } from "../share/errors.js";
import { safeFilename, writeShareOutput } from "../share/io.js";
import { runShareCaptured } from "./share.integration-harness.js";

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
  };
  const reviewPublished: PublishedShare = {
    protocol: "tinycloud-share", version: 1, url: "https://share.example/s/inline#v=2&p=sealed",
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
      kind: "storage-quota-exceeded",
      usedBytes: 387_382_794,
      limitBytes: 8_119_195,
    }));
    expect(quota).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      exitCode: 4,
    });
    expect(quota.message).toContain("369.4 MB used of 7.7 MB limit");
    expect(quota.message).toContain("nothing was shared");
    const quotaWithoutSizes = shareCliError(new SharePublishAuthorityError({ kind: "storage-quota-exceeded" }));
    expect(quotaWithoutSizes).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", exitCode: 4 });
    expect(quotaWithoutSizes.message).toBe("storage quota exceeded; nothing was shared");

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
      "publish", "inspect", "receive", "list", "show", "notify", "revoke",
    ]);
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
          protocol: "tinycloud-share", version: 1, url: "https://share.example/s/inline#v=2&p=sealed",
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
      await program.parseAsync(["node", "tc", "share", "publish", file, "--to", "email:Foo@X.com", "--notify"]);
      await program.parseAsync(["node", "tc", "share", "notify", "share-notify", "--to", "FOO@X.COM"]);
    } finally {
      process.stdout.write = write;
      configureShareCommandServices({});
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(records.get("share-notify")?.recipientMatcher).toEqual({ kind: "exactEmail", value: "foo@x.com" });
    expect(records.get("share-notify")?.deliveredRecipients).toEqual(["foo@x.com"]);
    expect(delivered).toEqual(["foo@x.com", "foo@x.com"]);
    expect(written.join("")).toContain("https://share.example/s/inline#v=2&p=sealed");
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
          protocol: "tinycloud-share", version: 1, url: "https://share.example/s/inline#v=2&p=sealed",
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
      const output = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify"]);
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
      const published = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify"]);
      expect(published).toMatchObject({ exitCode: 0, stdout: `${reviewPublished.url}\n` });
      expect(published.stderr).toContain("could not record");
      expect(persisted?.deliveredRecipients).toBeUndefined();
      const notified = await runShareCaptured(["share", "notify", reviewPublished.metadata.shareId, "--to", "alice@example.com", "--json"]);
      expect(notified.exitCode).toBe(0);
      expect(JSON.parse(notified.stdout)).toMatchObject({ state: "delivered" });
      expect(notified.stderr).toContain("could not record");
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
      const output = await runShareCaptured(["share", "publish", file, "--to", "email:alice@example.com", "--notify", "--json"]);
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
      read: async () => { reads += 1; return "https://share.example/s/inline#v=2&p=sealed"; },
      inspect: (async (link: string) => {
        inspected = link;
        return { protocol: "tinycloud-share", version: 1 } as never;
      }) as never,
    });
    expect(reads).toBe(1);
    expect(inspected).toBe("https://share.example/s/inline#v=2&p=sealed");
    expect(result).toMatchObject({ protocol: "tinycloud-share", version: 1 });
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

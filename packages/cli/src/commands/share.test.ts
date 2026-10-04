import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShareNotifyError, type PublishedShare, type SenderShareRecord, type ShareTarget } from "@tinycloud/share-sdk";
import { configureShareCommandServices, inspectShareInputOnce, registerShareCommand, parseShareTarget, shareCliError } from "./share.js";
import { SharePublishAuthorityError } from "../share/errors.js";
import { safeFilename, writeShareOutput } from "../share/io.js";

describe("tc share command contract", () => {
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
    const unavailable = shareCliError(new SharePublishAuthorityError({ kind: "registry-unavailable" }));
    expect([unavailable.code, unavailable.exitCode]).toEqual(["UNAVAILABLE", 4]);
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

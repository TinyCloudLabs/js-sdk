import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedShare, SenderShareRecord, ShareTarget } from "@tinycloud/share-sdk";
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
    expect(openKeyScope.message).toContain("tc --profile publisher auth login --device --manifest builtin:share-publishing");

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
    } finally {
      process.stdout.write = write;
      configureShareCommandServices({});
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(records.get("share-notify")?.recipientMatcher).toEqual({ kind: "exactEmail", value: "foo@x.com" });
    expect(delivered).toEqual(["foo@x.com"]);
    expect(written.join("")).toContain("https://share.example/s/inline#v=2&p=sealed");
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
    expect(() => safeFilename("../report.md")).toThrow("UNSAFE_FILENAME");
    expect(() => safeFilename("nested/report.md")).toThrow("UNSAFE_FILENAME");
  });
});

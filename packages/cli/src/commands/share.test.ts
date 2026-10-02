import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectShareInputOnce, registerShareCommand, parseShareTarget, shareCliError } from "./share.js";
import { SharePublishAuthorityError } from "../share/errors.js";
import { safeFilename, writeShareOutput } from "../share/io.js";

describe("tc share command contract", () => {
  test("parses every target spelling without accepting an unknown target", () => {
    expect(parseShareTarget("anyone")).toEqual({ kind: "bearer" });
    expect(parseShareTarget("did:key:z6Mkexample")).toEqual({ kind: "recipientDid", did: "did:key:z6Mkexample" });
    expect(parseShareTarget("person@example.com")).toEqual({ kind: "email", address: "person@example.com" });
    expect(parseShareTarget("domain:Example.COM")).toEqual({ kind: "emailDomain", domain: "Example.COM" });
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
    expect(sessionAuth.message).toContain("tc --profile remote auth login");
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
    expect(sessionTooClose.message).toContain("tc --profile remote auth login");

    const originMismatch = shareCliError(new SharePublishAuthorityError({ kind: "origin-mismatch" }));
    expect(originMismatch.code).toBe("ORIGIN_MISMATCH");
    expect(originMismatch.message).toBe("share origin does not match the configured service");
  });

  test("registers only the current native sharing lifecycle commands", () => {
    const program = new Command();
    registerShareCommand(program);
    const share = program.commands.find((command) => command.name() === "share");
    expect(share?.commands.map((command) => command.name())).toEqual([
      "publish", "inspect", "receive", "list", "show", "notify", "revoke",
    ]);
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

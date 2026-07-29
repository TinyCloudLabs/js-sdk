import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerShareCommand, parseShareTarget } from "./share.js";
import { safeFilename, writeShareOutput } from "../share/io.js";

describe("tc share command contract", () => {
  test("parses every target spelling without accepting an unknown target", () => {
    expect(parseShareTarget("anyone")).toEqual({ kind: "bearer" });
    expect(parseShareTarget("did:key:z6Mkexample")).toEqual({ kind: "recipientDid", did: "did:key:z6Mkexample" });
    expect(parseShareTarget("person@example.com")).toEqual({ kind: "email", address: "person@example.com" });
    expect(parseShareTarget("domain:Example.COM")).toEqual({ kind: "emailDomain", domain: "Example.COM" });
    expect(() => parseShareTarget("unknown-target")).toThrow();
  });

  test("registers explicit lifecycle commands, including legacy migration", () => {
    const program = new Command();
    registerShareCommand(program);
    const share = program.commands.find((command) => command.name() === "share");
    expect(share?.commands.map((command) => command.name())).toEqual([
      "publish", "inspect", "receive", "migrate", "list", "show", "notify", "revoke",
    ]);
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

  test("allows only one safe Markdown filename segment", () => {
    expect(safeFilename("report.md")).toBe("report.md");
    expect(() => safeFilename("../report.md")).toThrow("UNSAFE_FILENAME");
    expect(() => safeFilename("nested/report.md")).toThrow("UNSAFE_FILENAME");
  });
});

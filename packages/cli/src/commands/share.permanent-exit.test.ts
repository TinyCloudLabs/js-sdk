import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareCliError } from "./share.js";
import { approvalPendingError } from "../auth/approval-wait.js";
import { shareFilename, writeShareOutput } from "../share/io.js";
import { runShareCaptured } from "./share.integration-harness.js";

describe("share errors that cannot change on retry exit 2", () => {
  test.each(["UNSAFE_FILENAME", "OUTPUT_EXISTS"])("%s maps to exit 2 with its own code", (name) => {
    const error = shareCliError(new Error(name));
    expect(error.code).toBe(name);
    expect(error.exitCode).toBe(2);
  });

  test("an unsafe filename is exit 2", () => {
    expect(() => shareFilename("a\u200b.md")).toThrow(expect.objectContaining({ code: "UNSAFE_FILENAME", exitCode: 2 }));
  });

  test("an existing output path is exit 2 through the command mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-exit2-"));
    await writeShareOutput(root, "report.md", new TextEncoder().encode("one"), false);
    let caught: unknown;
    try { await writeShareOutput(root, "report.md", new TextEncoder().encode("two"), false); } catch (error) { caught = error; }
    expect(shareCliError(caught).exitCode).toBe(2);
  });

  test("an unsafe folder path is exit 2 and prints nothing on stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-share-exit2-"));
    await writeFile(join(root, "index.html"), '<!doctype html><img src="../secret.png">');
    // handleError ends the process; record its exit code and let the action return instead.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
    let result: { stdout: string; stderr: string };
    try { result = await runShareCaptured(["share", "publish", root, "--json"]); }
    finally { process.exit = originalExit; }
    expect(exitCode).toBe(2);
    expect(result.stderr).toContain("UNSAFE_PATH");
    expect(result.stdout.trim()).toBe("");
  });

  test("an owner approval still pending stays exit 8 with its pending object", () => {
    const pending = { step: 1, of: 1, approvalUrl: "https://openkey.example/a/abc#v=4", expiresAt: "2026-11-01T12:00:00.000Z" };
    const error = shareCliError(approvalPendingError(pending));
    expect(error.code).toBe("APPROVAL_PENDING");
    expect(error.exitCode).toBe(8);
    expect(error.metadata).toEqual({ pending });
  });
});

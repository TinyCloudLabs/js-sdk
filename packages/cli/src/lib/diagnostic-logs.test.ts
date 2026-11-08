import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDiagnosticLog, clearDiagnosticLogs, readDiagnosticLogs, recordDiagnosticFailure, setDiagnosticCommandContext } from "./diagnostic-logs.js";

const dirs: string[] = [];
async function makeDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tc-diagnostic-logs-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("diagnostic logs redact sensitive values before writing owner-only files", async () => {
  const root = await makeDirectory();
  await appendDiagnosticLog({ root, entry: {
    command: "auth request --grant",
    args: ["--profile", "private-profile", "--token", "secret-token-value", "-pClientAcme", "-Hhttps://operator:ShortSecret@private.example/tenant", "--value", "-sekret", "--", "curl", "-uadmin:hunter2", "https://private.example"],
    exitCode: 1,
    errorCode: "AUTH_REQUIRED",
    errorMessage: `failed for profile "private-profile" for key "clients/acme/payroll" https://operator:ShortSecret@private.example/tenant/spaceSecret did:key:z6MkExample alice@example.test /home/alice/.tinycloud/profile.json Bearer ${"A".repeat(43)} \u001b[31mcolored\u001b[0m`,
    cliVersion: "1.2.3",
    nodeVersion: "v20.0.0",
    durationMs: 4,
  } });
  const content = await readDiagnosticLogs(root);
  expect(content).toContain("auth request --grant");
  expect(content).toContain("AUTH_REQUIRED");
  for (const secret of ["private-profile", "secret-token-value", "-pClientAcme", "ClientAcme", "operator:ShortSecret", "ShortSecret", "private.example/tenant", "spaceSecret", "sekret", "hunter2", "clients/acme/payroll", "did:key:z6MkExample", "alice@example.test", "/home/alice/", "A".repeat(43), "abcdef1234567890"]) {
    expect(content).not.toContain(secret);
  }
  expect(content).not.toContain("\u001b[");
  const details = await stat(join(root, "cli-diagnostics.jsonl"));
  expect(details.mode & 0o777).toBe(0o600);
});

test("diagnostic logs keep only the newest bounded window and clear it", async () => {
  const root = await makeDirectory();
  for (let index = 0; index < 12; index += 1) {
    await appendDiagnosticLog({ root, maxBytes: 360, entry: {
      command: "kv get", args: ["--key", `key-${index}`], exitCode: 0,
      cliVersion: "1.2.3", nodeVersion: "v20.0.0", durationMs: index,
    } });
  }
  const content = await readDiagnosticLogs(root, 360);
  expect(Buffer.byteLength(content)).toBeLessThanOrEqual(360);
  expect(content).toContain("durationMs\":11");
  expect(content).not.toContain("durationMs\":0");
  await clearDiagnosticLogs(root);
  expect(await readDiagnosticLogs(root)).toBe("");
});
test("diagnostic log reads and writes reject a symbolic-link target", async () => {
  const root = await makeDirectory();
  const target = join(root, "private-data");
  await writeFile(target, "must not be attached");
  await symlink(target, join(root, "cli-diagnostics.jsonl"));
  await expect(readDiagnosticLogs(root)).rejects.toThrow("not a regular file");
  await expect(appendDiagnosticLog({ root, entry: {
    command: "kv get", args: [], exitCode: 0, cliVersion: "1.2.3", nodeVersion: "v20.0.0", durationMs: 1,
  } })).rejects.toThrow("not a regular file");
  expect(await readFile(target, "utf8")).toBe("must not be attached");
});
test("CLI failures record safe command metadata and redacted error text", async () => {
  const root = await makeDirectory();
  setDiagnosticCommandContext({
    command: "auth request",
    args: ["--profile", "sam", "--cap", "tinycloud.kv:secrets:private:get"],
    disabled: false,
    cliVersion: "1.6.3-beta.6",
  });
  await recordDiagnosticFailure({
    code: "AUTH_REQUIRED",
    message: `Profile "sam" requires token=${"B".repeat(43)} at /home/sam/private`,
    exitCode: 7,
  }, root);
  const entry = JSON.parse(await readDiagnosticLogs(root)) as Record<string, unknown>;
  expect(entry).toMatchObject({
    command: "auth request",
    args: ["--profile=[REDACTED]", "--cap=[REDACTED]"],
    exitCode: 7,
    errorCode: "AUTH_REQUIRED",
    cliVersion: "1.6.3-beta.6",
    nodeVersion: process.version,
  });
  expect(String(entry.errorMessage)).not.toContain("sam");
  expect(String(entry.errorMessage)).not.toContain("B".repeat(43));
  expect(String(entry.errorMessage)).not.toContain("/home/sam");
  expect(typeof entry.timestamp).toBe("string");
  setDiagnosticCommandContext({ command: "bug-report", args: [], disabled: true, cliVersion: "1.6.3-beta.6" });
});

import { afterEach, expect, test } from "bun:test";
import { access, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore, resolveDiagnosticTenant } from "@tinycloud/operations/diagnostics";

import { diagnosticsAdmin } from "./diagnostics-admin.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("tenant administration requires an existing verified mapping and explicit owner request", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-admin-policy-"));
  roots.push(root);
  const diagnosticRoot = join(root, "history");
  const tenant = "a".repeat(64);
  await expect(diagnosticsAdmin(["enable", "--root", diagnosticRoot, "--tenant", tenant, "--owner-request"])).rejects.toThrow();
  expect(await access(diagnosticRoot).then(() => true, () => false)).toBe(false);
  const partition = await resolveDiagnosticTenant(diagnosticRoot, tenant, { create: true });
  await expect(diagnosticsAdmin(["enable", "--root", diagnosticRoot, "--tenant", tenant])).rejects.toThrow();
  const args = ["--root", diagnosticRoot, "--tenant", tenant, "--owner-request"];
  expect(await diagnosticsAdmin(["status", ...args])).toMatchObject({ enabled: false });
  expect(await diagnosticsAdmin(["enable", ...args])).toMatchObject({ enabled: true, paused: false });
  expect(await diagnosticsAdmin(["pause", ...args])).toMatchObject({ paused: true });
  expect(await diagnosticsAdmin(["resume", ...args])).toMatchObject({ enabled: true, paused: false });
  expect(await diagnosticsAdmin(["disable", ...args])).toMatchObject({ enabled: false });
  const service = await resolveDiagnosticTenant(diagnosticRoot, "service", { create: true });
  expect(service).not.toBe(partition);
  expect(await new DiagnosticStore(diagnosticRoot, service!).status()).toMatchObject({ enabled: false });
  await expect(diagnosticsAdmin(["delete", ...args])).rejects.toThrow();
  const selection = join(root, "selection.json");
  await writeFile(selection, JSON.stringify({ all: true }), { mode: 0o600 });
  await expect(diagnosticsAdmin(["delete", ...args, "--selection", selection])).rejects.toThrow();
});

test("installed ESM and CJS admin entrypoints operate without business SDK, auth configuration or a listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-admin-installed-"));
  roots.push(root);
  const packageRoot = join(root, "node_modules/@tinycloud/mcp");
  const operationsRoot = join(packageRoot, "node_modules/@tinycloud/operations");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await mkdir(operationsRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@tinycloud/mcp", type: "module" }));
  await copyFile(new URL("../../operations/package.json", import.meta.url), join(operationsRoot, "package.json"));
  await cp(new URL("../../operations/dist", import.meta.url), join(operationsRoot, "dist"), { recursive: true });
  const historyRoot = join(root, "history");
  const tenant = "b".repeat(64);
  await resolveDiagnosticTenant(historyRoot, tenant, { create: true });
  for (const extension of ["js", "cjs"]) {
    const entry = join(packageRoot, "dist", `http-cli.${extension}`);
    await copyFile(new URL(`../dist/http-cli.${extension}`, import.meta.url), entry);
    const child = Bun.spawnSync([
      process.env.NODE_BINARY ?? "node", entry, "diagnostics", "status", "--root", historyRoot, "--tenant", tenant, "--owner-request",
    ], { env: { PATH: process.env.PATH, HOME: join(root, "home"), TC_HOME: join(root, "forbidden-profile") } });
    expect(child.exitCode).toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toMatchObject({ enabled: false });
  }
  expect(await access(join(root, "forbidden-profile")).then(() => true, () => false)).toBe(false);
});

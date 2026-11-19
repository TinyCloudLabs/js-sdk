import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("public browser restore binds the requested account before activation", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/tc2934-restore.ts")], { cwd: resolve(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stdout).toContain('"label":"ordinary same account","status":"restored"');
  expect(stdout).toContain('"label":"CAIP chain mismatch","status":"restore-failed"');
}, 60_000);

test("signed renewal history restores only the requested owner", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/tc2934-renewal.ts")], { cwd: resolve(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stdout).toContain('"label":"signed renewal same account","status":"restored"');
  expect(stdout).toContain('"label":"signed renewal wrong slot","status":"restore-failed"');
}, 60_000);

import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("public web sign-in requests only app authority outside first-party bootstrap", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/tc2931-signin.ts")], {
    cwd: resolve(import.meta.dir, "../../.."), env: process.env,
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr, stdout }).toMatchObject({ code: 0 });
  expect(stdout).toContain('"refusedBeforeSignature":true');
  expect(stdout).toContain('"rows":1');
  expect(stdout).toContain('"rows":8');
}, 60_000);

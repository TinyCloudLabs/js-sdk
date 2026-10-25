import { expect, test } from "bun:test";
import { join } from "node:path";

test("the requested named-key row is verified in an isolated process", async () => {
  const fixture = join(import.meta.dir, "../../test-fixtures/scoped-login-key-row.test.ts");
  const child = Bun.spawn([process.execPath, "test", fixture], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stderr).toContain("14 pass");
}, 60_000);

import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const format of ["mjs", "cjs"]) {
  test(`public ${format} keeps uncached routing when its optional cache sibling is absent`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/browser-registry-cache-missing.ts"), format], {
      cwd: resolve(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain('"initialized":true');
    expect(stdout).toContain('"uncachedReads":true');
    expect(stdout).toContain('"noCopiedError":true');
  }, 60_000);
}

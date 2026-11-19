import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const format of ["mjs", "cjs"]) {
  test(`public ${format} initializes a separate lazy registry verdict cache without network I/O`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/browser-registry-verdict-built.ts"), format], {
      cwd: resolve(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain('"lazyFactory":true');
    expect(stdout).toContain('"separateCaches":true');
    expect(stdout).toContain('"requests":0');
  }, 60_000);
}

import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const format of ["mjs", "cjs"]) {
  test(`public ${format} placement stays lazy and shares root verification identities`, async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/share-placement-built.ts"), format], {
      cwd: resolve(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain('"rootDomainAbsent":true');
    expect(stdout).toContain('"received":true');
    expect(stdout).toContain('"sharedErrorIdentity":true');
  }, 60_000);
}

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliEntry = join(import.meta.dir, "../../bin/tc");
const node = process.env.NODE_BINARY ?? "node";

// TC-1025: a wrapper that writes the code and keeps stdin open must get the
// same result as `echo CODE | tc …`, without waiting for the pipe to close.
describe("auth login --paste with stdin still open exits as it does when stdin is closed", () => {
  test.each([
    ["a delegation code", JSON.stringify({ delegationHeader: { Authorization: "Bearer pasted" }, delegationCid: "bafy-pasted", spaceId: "space" })],
    ["an unreadable code", "not-a-code"],
  ])("%s", async (_label, code) => {
    const home = await mkdtemp(join(tmpdir(), "tc-paste-exit-"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const login = (profile: string) => Bun.spawn([node, cliEntry, "--json", "--profile", profile, "auth", "login", "--method", "openkey", "--paste"], {
      env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      for (const profile of ["closed", "open"]) {
        const init = Bun.spawn([node, cliEntry, "init", "--name", profile, "--key-only"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        expect(await init.exited).toBe(0);
      }

      const control = login("closed");
      control.stdin.write(`${code}\n`);
      control.stdin.end();
      const [controlOut, controlExit] = await Promise.all([new Response(control.stdout).text(), control.exited]);

      const held = login("open");
      held.stdin.write(`${code}\n`);
      await held.stdin.flush();
      // A real child process with an open pipe: fake timers can't stand in. The
      // sleep is only the failure ceiling; a passing run returns as soon as the CLI exits.
      const outcome = await Promise.race([
        held.exited.then(() => "exited"),
        Bun.sleep(10_000).then(() => "still running"),
      ]);
      held.stdin.end();
      held.kill();
      expect(outcome).toBe("exited");
      const heldOut = await new Response(held.stdout).text();
      expect({ exitCode: held.exitCode, authenticated: heldOut.includes('"authenticated": true') })
        .toEqual({ exitCode: controlExit, authenticated: controlOut.includes('"authenticated": true') });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});

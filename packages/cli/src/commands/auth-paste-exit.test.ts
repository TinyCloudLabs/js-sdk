import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliEntry = join(import.meta.dir, "../../bin/tc");
const node = process.env.NODE_BINARY ?? "node";

// TC-1025: a wrapper that writes the code and keeps stdin open must not hang
// after `auth login --paste` has finished, whether the code worked or not.
describe("auth login --paste exits once the code is handled, with stdin still open", () => {
  test.each([
    ["a delegation code", JSON.stringify({ delegationHeader: { Authorization: "Bearer pasted" }, delegationCid: "bafy-pasted", spaceId: "space" })],
    ["an unreadable code", "not-a-code"],
  ])("%s", async (_label, code) => {
    const home = await mkdtemp(join(tmpdir(), "tc-paste-exit-"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    try {
      const init = Bun.spawn([node, cliEntry, "init", "--name", "paste", "--key-only"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      expect(await init.exited).toBe(0);

      const login = Bun.spawn([node, cliEntry, "--profile", "paste", "auth", "login", "--method", "openkey", "--paste"], {
        env, stdin: "pipe", stdout: "ignore", stderr: "ignore",
      });
      login.stdin.write(`${code}\n`);
      await login.stdin.flush();
      // A real child process with an open pipe: fake timers can't stand in. The
      // sleep is only the failure ceiling; a passing run returns as soon as the CLI exits.
      const outcome = await Promise.race([
        login.exited.then(() => "exited"),
        Bun.sleep(10_000).then(() => "still running"),
      ]);
      login.stdin.end();
      login.kill();
      expect(outcome).toBe("exited");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});

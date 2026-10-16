import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliEntry = join(import.meta.dir, "../../bin/tc");
const node = process.env.NODE_BINARY ?? "node";

// TC-1025: a wrapper that writes the code and keeps stdin open must get the
// same result as `echo CODE | tc …`, without waiting for the pipe to close.
describe("auth login --paste with stdin still open exits as it does when stdin is closed", () => {
  test.each(["disabled", "enabled", "failed"].flatMap((capture) => [
    [capture, "a delegation code", JSON.stringify({ delegationHeader: { Authorization: "Bearer pasted" }, delegationCid: "bafy-pasted", spaceId: "space" })],
    [capture, "an unreadable code", "not-a-code"],
  ]))("%s capture: %s", async (capture, _label, code) => {
    const home = await mkdtemp(join(tmpdir(), "tc-paste-exit-"));
    const guard = join(home, "deny-network.cjs");
    await writeFile(guard, `function deny(){throw new Error("network_disabled_in_synthetic_paste_fixture");}globalThis.fetch=deny;for(const name of ["node:http","node:https"]){const module=require(name);module.request=deny;module.get=deny;}`, { mode: 0o600 });
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH, HOME: home, TC_HOME: join(home, "profiles"),
      XDG_STATE_HOME: join(home, "state"), TC_DIAGNOSTICS_HOME: join(home, "diagnostics"),
      NODE_OPTIONS: `--require=${guard}`, NO_COLOR: "1",
    };
    const login = (profile: string) => Bun.spawn([node, cliEntry, "--json", "--profile", profile, "auth", "login", "--method", "openkey", "--paste"], {
      env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      for (const profile of ["closed", "open"]) {
        const init = Bun.spawn([node, cliEntry, "init", "--name", profile, "--key-only"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        expect(await init.exited).toBe(0);
      }
      env.TC_DIAGNOSTICS_CONTEXT = JSON.stringify({ version: 1, scope: "tc-apps" });
      if (capture === "enabled") {
        const enable = Bun.spawn([node, cliEntry, "diagnostics", "enable", "--scope", "tc-apps"], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
        expect(await enable.exited).toBe(0);
      } else if (capture === "failed") {
        const failed = join(home, "failed-sink");
        await writeFile(failed, "synthetic", { mode: 0o600 });
        env.TC_DIAGNOSTICS_HOME = failed;
      }

      const control = login("closed");
      control.stdin.write(`${code}\n`);
      control.stdin.end();
      const [controlOut, controlErr, controlExit] = await Promise.all([new Response(control.stdout).text(), new Response(control.stderr).text(), control.exited]);
      expect(controlExit).not.toBe(0);

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
      const [heldOut, heldErr] = await Promise.all([new Response(held.stdout).text(), new Response(held.stderr).text()]);
      expect({ exitCode: held.exitCode, authenticated: heldOut.includes('"authenticated": true'), error: JSON.parse(heldErr.slice(heldErr.indexOf("{"))).error.code })
        .toEqual({ exitCode: controlExit, authenticated: controlOut.includes('"authenticated": true'), error: JSON.parse(controlErr.slice(controlErr.indexOf("{"))).error.code });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});

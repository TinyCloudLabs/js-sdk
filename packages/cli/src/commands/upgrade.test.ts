import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { confirmation, resultLines } from "./upgrade.js";

const PACKAGE_DIR = resolve(import.meta.dir, "../..");

describe("tinycloud upgrade", () => {
  test("--yes skips the question; a terminal asks it; no terminal, or CI, needs --yes", () => {
    expect(confirmation(true, false, { CI: "true" })).toBe("skip");
    expect(confirmation(false, true, {})).toBe("ask");
    expect(confirmation(false, false, {})).toBe("refuse");
    expect(confirmation(false, true, { CI: "1" })).toBe("refuse");
    expect(confirmation(false, true, { CI: "false" })).toBe("ask");
    expect(confirmation(false, true, { CI: "0" })).toBe("ask");
  });

  test("under Bun older than 1.4 it says why nothing was installed and how to run it", () => {
    expect(resultLines({ status: "refused", reason: "UNSUPPORTED_RUNTIME", from: "1.10.0", detail: "Bun 1.3.14" }, {})).toEqual([
      `TinyCloud CLI can't verify updates under Bun 1.3.14; it needs Node or Bun 1.4 or newer. Nothing was installed. Run ${CLI_NAME} with Node (without \`bun --bun\`).`,
    ]);
  });

  test("an install it can't manage exits 12 with the command that updates it", () => {
    const home = mkdtempSync(join(tmpdir(), "tc4276-upgrade-"));
    const { TC_HOME: _home, CI: _ci, ...ambient } = process.env;
    try {
      // The repository build is neither an npm nor a bun global install.
      const result = spawnSync("node", [join(PACKAGE_DIR, "bin", "tinycloud"), "--json", "upgrade", "--to", "1.9.5", "--yes"], {
        encoding: "utf8",
        env: { ...ambient, HOME: home, TC_NO_AUTO_UPDATE: "1", TC_VERSIONS_DIR: join(home, "versions") },
      });
      expect(result.status).toBe(12);
      const output = JSON.parse(result.stdout) as { status: string; reason: string; manualCommand: string };
      expect(output).toMatchObject({ status: "refused", reason: "UNSUPPORTED_INSTALL" });
      expect(output.manualCommand).toEndWith(" @tinycloud/cli@1.9.5");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

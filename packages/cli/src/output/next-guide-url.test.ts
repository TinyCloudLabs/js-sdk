import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveBundledSkill } from "../skill/run.js";
import { GUIDE_URL_LINE, onboardGuideLine, saveGuideNextLine } from "./next.js";

// TC-3366: after `onboard` the CLI says where the guide for agents is while none is saved on this computer.
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tc-guide-url-"));
  made.push(dir);
  return dir;
};

/** A computer where Claude Code is installed and no guide is saved. */
function computer(): { home: string; env: Record<string, string | undefined> } {
  const home = scratch();
  mkdirSync(join(home, ".claude"));
  return { home, env: {} };
}

describe("the line after onboard that names the guide", () => {
  test("is one plain sentence with the guide's address, not a Next: step with a command", () => {
    expect(GUIDE_URL_LINE).toBe("The TinyCloud CLI guide for agents is at https://agents.tinycloud.xyz/skills/cli.md.");
    expect(GUIDE_URL_LINE).not.toContain("\n");
    expect(GUIDE_URL_LINE).not.toContain("Next:");
    expect(GUIDE_URL_LINE).not.toContain("`");
  });

  test("is printed when no guide is saved in a client's skills folder", () => {
    expect(onboardGuideLine(computer(), "tinycloud")).toBe(GUIDE_URL_LINE);
  });

  test("is printed when no agent's skills folder is found on this computer", () => {
    expect(onboardGuideLine({ home: scratch(), env: {} }, "tinycloud")).toBe(GUIDE_URL_LINE);
  });

  test("gives way to the skill save offer when the saved guide is from an older CLI", () => {
    const context = computer();
    const pack = scratch();
    writeFileSync(join(pack, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version: "0.0.1" }));
    const older = join(pack, "skills", "tinycloud-cli");
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, "SKILL.md"), "an older guide");
    saveBundledSkill({ context, bundledDir: older });
    expect(onboardGuideLine(context, "tinycloud")).toBe(saveGuideNextLine("tinycloud"));
  });

  test("is not printed when the guide is saved and current", () => {
    const context = computer();
    saveBundledSkill({ context });
    expect(onboardGuideLine(context, "tinycloud")).toBeUndefined();
  });

  test("is not printed over files in the skills folder that TinyCloud did not write", () => {
    const context = computer();
    const folder = join(context.home, ".claude", "skills", "tinycloud-cli");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "someone else's guide");
    expect(onboardGuideLine(context, "tinycloud")).toBeUndefined();
  });
});

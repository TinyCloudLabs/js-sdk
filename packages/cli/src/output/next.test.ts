import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveBundledSkill } from "../skill/run.js";
import { onboardNextLine, saveGuideNextLine } from "./next.js";

// TC-3278: after `onboard` the CLI offers `skill save` on stderr only when that is the next step.
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tc-next-"));
  made.push(dir);
  return dir;
};

/** A computer where Claude Code is installed and no guide is saved. */
function computer(): { home: string; env: Record<string, string | undefined> } {
  const home = scratch();
  mkdirSync(join(home, ".claude"));
  return { home, env: {} };
}

describe("the Next: line after onboard", () => {
  test("names the skill save command in the CLI's own form", () => {
    expect(saveGuideNextLine("tinycloud")).toBe("Next: `tinycloud skill save` saves a short guide to TinyCloud in your skills folder, so you have it next time.");
    expect(saveGuideNextLine("npx -y @tinycloud/cli@1.8.0")).toContain("`npx -y @tinycloud/cli@1.8.0 skill save`");
  });

  test("is offered when no guide is saved in a client's skills folder", () => {
    const next = onboardNextLine(computer(), "tinycloud");
    expect(next).toBe(saveGuideNextLine("tinycloud"));
    expect(next).not.toContain("\n");
  });

  test("is offered when the saved guide is from an older CLI", () => {
    const context = computer();
    const pack = scratch();
    writeFileSync(join(pack, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version: "0.0.1" }));
    const older = join(pack, "skills", "tinycloud-cli");
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, "SKILL.md"), "an older guide");
    saveBundledSkill({ context, bundledDir: older });
    expect(onboardNextLine(context, "tinycloud")).toBe(saveGuideNextLine("tinycloud"));
  });

  test("is not offered when the guide is already saved and current", () => {
    const context = computer();
    saveBundledSkill({ context });
    expect(onboardNextLine(context, "tinycloud")).toBeUndefined();
  });

  test("is not offered when the skills folder holds files TinyCloud did not write, which skill save would refuse", () => {
    const context = computer();
    const folder = join(context.home, ".claude", "skills", "tinycloud-cli");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "someone else's guide");
    expect(onboardNextLine(context, "tinycloud")).toBeUndefined();
  });

  test("is not offered when no agent's skills folder is found, which skill save could not choose", () => {
    expect(onboardNextLine({ home: scratch(), env: {} }, "tinycloud")).toBeUndefined();
  });
});

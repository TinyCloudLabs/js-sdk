import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedSut } from "../src/contracts/lifecycle";
import type { RunContextView } from "../src/contracts/scenario";
import { createRequirementProbe, type RequirementPins } from "../src/runner/requirements";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function run(sut: ResolvedSut): RunContextView {
  return { tiers: ["core"], backends: ["sqlite"], sut,
    image: { role: "default", ref: "node", digest: "sha256:test", pinned: "node:test", nodeVersion: "test", features: [] }, ciPinImage: "node:test" };
}

function workspaceSut(root: string, gitSha: string): ResolvedSut {
  return { source: "workspace", root, gitSha,
    cli: { version: "1.0.0", packageJson: "cli/package.json", entry: "cli/index.js" },
    nodeSdk: { version: "1.0.0", packageJson: "sdk/package.json", entry: "sdk/index.js", condition: "import" } };
}

async function repository(content = "first\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tc893-requirement-probe-"));
  temporaryDirectories.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Harness Probe Test");
  git("config", "user.email", "harness-probe@example.invalid");
  await writeFile(join(root, "commit.txt"), content);
  git("add", "commit.txt");
  git("commit", "-q", "-m", "first");
  return root;
}

const pins = (workspace: string | null, published: string | null): RequirementPins => ({
  tc674WorkspaceMergeSha: workspace,
  tc674PublishedMinimumCliVersion: published,
});
const requirement = "tc674:delegate-session-expiry" as const;

describe("TC-674 identity-pinned capability probe", () => {
  test("reports TC-674 not landed when the applicable pin is null", async () => {
    const root = await repository();
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(createRequirementProbe(pins(null, null))(requirement, run(workspaceSut(root, head)))).toBe("TC-674 not landed");
    const published: ResolvedSut = { source: "published", cli: { version: "1.0.0", packageJson: "cli/package.json", entry: "cli/index.js" },
      nodeSdk: { version: "1.0.0", packageJson: "sdk/package.json", entry: "sdk/index.js", condition: "import" } };
    expect(createRequirementProbe(pins(null, null))(requirement, run(published))).toBe("TC-674 not landed");
  });

  test("accepts a workspace pin that is an ancestor of the SUT SHA", async () => {
    const root = await repository();
    const pin = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(join(root, "commit.txt"), "second\n");
    execFileSync("git", ["-C", root, "add", "commit.txt"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "second"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(createRequirementProbe(pins(pin, null))(requirement, run(workspaceSut(root, head)))).toBe(true);
  });

  test("rejects a workspace pin that is not an ancestor of the SUT SHA", async () => {
    const root = await repository();
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const unrelated = await repository("unrelated\n");
    const unrelatedPin = execFileSync("git", ["-C", unrelated, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(createRequirementProbe(pins(unrelatedPin, null))(requirement, run(workspaceSut(root, head)))).toBe("TC-674 merge pin is not an ancestor of workspace SUT");
  });

  test("uses the published minimum CLI version for published SUTs", () => {
    const published: ResolvedSut = { source: "published", cli: { version: "2.1.0", packageJson: "cli/package.json", entry: "cli/index.js" },
      nodeSdk: { version: "2.1.0", packageJson: "sdk/package.json", entry: "sdk/index.js", condition: "import" } };
    expect(createRequirementProbe(pins(null, "2.0.0"))(requirement, run(published))).toBe(true);
    expect(createRequirementProbe(pins(null, "2.2.0"))(requirement, run(published))).toBe("published CLI is older than the TC-674 minimum");
  });
});

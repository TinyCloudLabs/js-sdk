import { execFileSync } from "node:child_process";
import { exactSemver } from "../gate/semver";
import type { Requirement, RunContextView } from "../contracts/scenario";
import type { ProbeRequirement } from "./registry";

export interface RequirementPins {
  tc674WorkspaceMergeSha: string | null;
  tc674PublishedMinimumCliVersion: string | null;
}

// TC-674 updates the relevant pin when its implementation lands.
export const requirementPins: RequirementPins = {
  tc674WorkspaceMergeSha: null,
  tc674PublishedMinimumCliVersion: null,
};

function compareSemver(left: string, right: string): number {
  if (!exactSemver(left) || !exactSemver(right)) throw new Error("invalid semantic version");
  const parse = (version: string) => {
    const withoutBuild = version.split("+", 1)[0]!;
    const separator = withoutBuild.indexOf("-");
    const release = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease = separator < 0 ? "" : withoutBuild.slice(separator + 1);
    return { core: release.split(".").map(Number), prerelease: prerelease ? prerelease.split(".") : [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return x.length === y.length ? (x < y ? -1 : 1) : x.length < y.length ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function workspaceAncestor(pin: string, run: RunContextView): true | string {
  const root = run.sut.root;
  const head = run.sut.gitSha;
  if (!root || !head) return "TC-674 workspace pin cannot be checked: SUT identity is incomplete";
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", pin, head], { stdio: "ignore" });
    return true;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return status === 1 || status === 128 ? "TC-674 merge pin is not an ancestor of workspace SUT" : "TC-674 workspace merge pin could not be verified";

  }
}
export function createRequirementProbe(pins: RequirementPins = requirementPins): ProbeRequirement {
  return (requirement: Requirement, run: RunContextView): true | string => {
    if (requirement !== "tc674:delegate-session-expiry") return `requirement probe unavailable: ${requirement}`;
    if (run.sut.source === "workspace") {
      if (pins.tc674WorkspaceMergeSha === null) return "TC-674 not landed";
      return workspaceAncestor(pins.tc674WorkspaceMergeSha, run);
    }
    const minimum = pins.tc674PublishedMinimumCliVersion;
    if (minimum === null) return "TC-674 not landed";
    try {
      return compareSemver(run.sut.cli.version, minimum) >= 0 ? true : "published CLI is older than the TC-674 minimum";
    } catch {
      return "published CLI version cannot be compared with the TC-674 minimum";
    }
  };
}

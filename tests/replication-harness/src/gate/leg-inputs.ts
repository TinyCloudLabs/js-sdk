import type { RunInputs } from "../contracts/gate";
import type { ValidatedRunReport } from "../schemas/report";
import { canonicalSha256 } from "./canonical-json";

export interface LegInputMismatch { field: string; expected: string; actual: string }

export function verifyLegInputs(inputs: RunInputs, report: ValidatedRunReport): LegInputMismatch[] {
  const mismatches: LegInputMismatch[] = [];
  const { inputsSha256, ...inputBody } = inputs;
  if (canonicalSha256(inputBody) !== inputsSha256) mismatches.push({ field: "inputs.inputsSha256", expected: canonicalSha256(inputBody), actual: inputsSha256 });
  if (report.inputsSha256 !== inputsSha256) mismatches.push({ field: "report.inputsSha256", expected: inputsSha256, actual: report.inputsSha256 ?? "null" });
  if (canonicalSha256(report.subject) !== canonicalSha256(inputs.subject)) mismatches.push({ field: "subject", expected: canonicalSha256(inputs.subject), actual: canonicalSha256(report.subject) });
  if (report.harnessSha !== inputs.harnessSha) mismatches.push({ field: "harnessSha", expected: inputs.harnessSha, actual: report.harnessSha });
  const expectedSut = inputs.sut;
  if (expectedSut.source !== report.sut.source) mismatches.push({ field: "sut.source", expected: expectedSut.source, actual: report.sut.source });
  if (expectedSut.source === "published") {
    if (expectedSut.cli.version !== report.sut.cli.version || expectedSut.cli.integrity !== report.sut.cli.integrity || expectedSut.nodeSdk.version !== report.sut.nodeSdk.version || expectedSut.nodeSdk.integrity !== report.sut.nodeSdk.integrity || expectedSut.lockfileSha256 !== report.sut.lockfileSha256) mismatches.push({ field: "sut", expected: "resolved published package versions, integrity, and lockfile", actual: "leg SUT identity differs" });
  } else if (expectedSut.gitSha !== report.sut.gitSha || expectedSut.distSha256 !== report.sut.distSha256) mismatches.push({ field: "sut", expected: `${expectedSut.gitSha}:${expectedSut.distSha256}`, actual: `${report.sut.gitSha}:${report.sut.distSha256}` });
  if (inputs.image.digest !== report.image.digest) mismatches.push({ field: "image.digest", expected: inputs.image.digest, actual: report.image.digest });
  return mismatches;
}

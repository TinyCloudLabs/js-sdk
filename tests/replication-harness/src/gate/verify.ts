import { readFile } from "node:fs/promises";
import type { AggregateReport } from "../contracts/gate";
import type { GateId } from "../contracts/common";
import { AggregateReportSchema } from "../schemas/report";
import { exactSemver } from "./semver";
import { canonicalSha256 } from "./canonical-json";
import { validateJunitPrecondition } from "./resolve";

export type PrintedAggregateValue = "cli.version" | "node-sdk.version" | "image";
export type VerifyFailure = "INVALID_AGGREGATE" | "GATE_FAILED" | "RUN_ID_MISMATCH" | "PRODUCTION_DRIFT" | "COMPANION_ESCALATE" | "INVALID_VERSION";
export class VerifyAggregateError extends Error {
  constructor(readonly failure: VerifyFailure, message: string) {
    super(message);
  }
}
export interface VerifyOptions { gate: GateId; runId?: string; print?: PrintedAggregateValue; currentProductionVersion?: string }
export interface VerifyResult { output: string; gatePassed: boolean; companionPassed: boolean }

export function verifyAggregate(value: unknown, options: VerifyOptions): VerifyResult {
  const parsed = AggregateReportSchema.safeParse(value);
  if (!parsed.success) throw new VerifyAggregateError("INVALID_AGGREGATE", parsed.error.message);
  const aggregate = parsed.data as AggregateReport;
  if (!aggregate.gate || aggregate.gate.id !== options.gate) throw new VerifyAggregateError("INVALID_AGGREGATE", `aggregate does not contain gate ${options.gate}`);
  const { inputsSha256, ...inputBody } = aggregate.inputs;
  if (canonicalSha256(inputBody) !== inputsSha256) throw new VerifyAggregateError("INVALID_AGGREGATE", "resolved inputs hash does not match aggregate contents");
  if (options.runId !== undefined && aggregate.inputs.subject.runId !== options.runId) throw new VerifyAggregateError("RUN_ID_MISMATCH", "aggregate subject runId does not match --run-id");
  if (aggregate.inputs.gate === "tc858-phase1-workspace" && aggregate.inputs.subject.event !== "local") {
    try {
      validateJunitPrecondition(aggregate.inputs.junitPrecondition, aggregate.inputs.subject);
    } catch (error) {
      throw new VerifyAggregateError("INVALID_AGGREGATE", `invalid junit precondition: ${String(error)}`);
    }
  }
  if (options.currentProductionVersion !== undefined && aggregate.inputs.production?.version !== options.currentProductionVersion) throw new VerifyAggregateError("PRODUCTION_DRIFT", "production /info version changed; rerun the gate");
  const companionPassed = aggregate.companion.every((item) => item.passed);
  if (!aggregate.gate.passed) throw new VerifyAggregateError("GATE_FAILED", "aggregate gate failed");
  if (!companionPassed) throw new VerifyAggregateError("COMPANION_ESCALATE", "companion verdict failed; stop and escalate before production smoke");
  let output = "";
  if (options.print === "cli.version") {
    output = aggregate.inputs.sut.cli.version;
    if (!exactSemver(output)) throw new VerifyAggregateError("INVALID_VERSION", "aggregate CLI version is not an exact SemVer");
  } else if (options.print === "node-sdk.version") {
    output = aggregate.inputs.sut.nodeSdk.version;
    if (!exactSemver(output)) throw new VerifyAggregateError("INVALID_VERSION", "aggregate node-sdk version is not an exact SemVer");
  } else if (options.print === "image") output = aggregate.inputs.image.pinned;
  return { output, gatePassed: aggregate.gate.passed, companionPassed };
}

export async function verifyAggregateFile(path: string, options: VerifyOptions & { fetchProduction?: () => Promise<{ version: string }> }): Promise<VerifyResult> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const result = verifyAggregate(value, options);
  const aggregate = AggregateReportSchema.parse(value) as AggregateReport;
  const fetchProduction = options.fetchProduction ?? (async () => {
    const response = await fetch("https://tee.node.tinycloud.xyz/info");
    if (!response.ok) throw new Error(`production /info returned HTTP ${response.status}`);
    const info = await response.json() as { version: string };
    return { version: info.version };
  });
  const currentProductionVersion = (await fetchProduction()).version;
  if (aggregate.inputs.production?.version !== currentProductionVersion) throw new VerifyAggregateError("PRODUCTION_DRIFT", "production /info version changed; rerun the gate");
  return result;
}

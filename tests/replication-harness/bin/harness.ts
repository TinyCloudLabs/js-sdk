#!/usr/bin/env bun
import { scenarioRegistry, validateRegistry, registerScenarios } from "../src/runner/registry";
import { coreScenarios } from "../src/scenarios/core";
import { runHarnessCommand } from "../src/runner/run-command";
import { dockerDoctor, gc } from "../src/topology/gc";
import { realClock } from "../src/contracts/clock";
import type { RunEnvironment } from "../src/contracts/lifecycle";
import { verifyAggregateFile, VerifyAggregateError, type PrintedAggregateValue } from "../src/gate/verify";
import { exactSemver } from "../src/gate/semver";
import type { GateId } from "../src/contracts/common";
import { runGateLocally, type LocalGateHooks } from "../src/gate/local-run";
import { aggregateCommand, createGateHooks, manifestCommand, resolveCommand, runLegCommand, verifyAggregateCommandFile } from "./gate-adapters";

export { exactSemver };
registerScenarios(...coreScenarios);
export const commands = ["run", "list", "manifest", "resolve", "aggregate", "verify-aggregate", "doctor", "gc"] as const;
export type Command = typeof commands[number];
export interface ParsedArgs { command: Command; positionals: string[]; options: Record<string, string | true> }
export interface HarnessCommandHandlers {
  run?: (parsed: ParsedArgs) => Promise<void> | void;
  gateHooks?: (parsed: ParsedArgs) => Promise<LocalGateHooks>;
  list?: (parsed: ParsedArgs) => Promise<void> | void;
  manifest?: (parsed: ParsedArgs) => Promise<void> | void;
  resolve?: (parsed: ParsedArgs) => Promise<void> | void;
  aggregate?: (parsed: ParsedArgs) => Promise<void> | void;
  doctor?: (parsed: ParsedArgs) => Promise<void> | void;
  gc?: (parsed: ParsedArgs) => Promise<void> | void;
}
let handlers: HarnessCommandHandlers = {};

export function registerHarnessCommandHandlers(next: HarnessCommandHandlers): void {
  handlers = { ...handlers, ...next };
}

export function parseArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args;
  if (!commands.includes(command as Command)) throw new Error(`usage: harness <${commands.join("|")}> [options]`);
  const options: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    if (!key) throw new Error(`invalid option ${arg}`);
    if (equals >= 0) options[key] = arg.slice(equals + 1);
    else if (rest[index + 1] && !rest[index + 1].startsWith("--")) options[key] = rest[++index];
    else options[key] = true;
  }
  return { command: command as Command, positionals, options };
}

function optionValue(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options[key];
  return typeof value === "string" ? value : undefined;
}
export type CommandHandler = (parsed: ParsedArgs) => Promise<void> | void;
let runHandler: CommandHandler | undefined;
export function setRunCommandHandler(handler: CommandHandler): void { runHandler = handler; }

function gateValue(value: string | undefined): GateId {
  if (value === "tc858-phase1-workspace" || value === "tc858-phase1-beta") return value;
  throw new Error("--gate must be tc858-phase1-workspace or tc858-phase1-beta");
}

async function verifyCommand(parsed: ParsedArgs): Promise<void> {
  const [aggregatePath] = parsed.positionals;
  if (!aggregatePath) throw new Error("usage: harness verify-aggregate <aggregate.json> --gate <id> [--run-id N] [--print cli.version|node-sdk.version|image]");
  const printValue = optionValue(parsed, "print");
  if (printValue && !["cli.version", "node-sdk.version", "image"].includes(printValue)) throw new Error(`unsupported --print value ${printValue}`);
  const options = {
    gate: gateValue(optionValue(parsed, "gate")),
    ...(optionValue(parsed, "run-id") ? { runId: optionValue(parsed, "run-id") } : {}),
    ...(printValue ? { print: printValue as PrintedAggregateValue } : {}),
  };
  try {
    const result = await verifyAggregateCommandFile(aggregatePath, options);
    if (printValue) {
      if (printValue === "cli.version" && !exactSemver(result.output)) throw new Error("CLI version was not exact SemVer");
      process.stdout.write(`${result.output}\n`);
      process.stderr.write(`gate=passed companion=${result.companionPassed ? "passed" : "failed"}\n`);
      return;
    }
    console.log(JSON.stringify({ gatePassed: result.gatePassed, companionPassed: result.companionPassed }));
  } catch (error) {
    if (error instanceof VerifyAggregateError) {
      console.error(`${error.failure}: ${error.message}`);
      process.exitCode = error.failure === "GATE_FAILED" ? 3 : error.failure === "PRODUCTION_DRIFT" ? 4 : error.failure === "COMPANION_ESCALATE" ? 5 : 1;
      return;
    }
    throw error;
  }
}
export async function runCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.options.help === true) {
    console.log(`Usage: harness ${parsed.command} [options]`);
    return;
  }
  if (parsed.command === "doctor") {
    const result = await dockerDoctor();
    console.log(JSON.stringify({ docker: result }, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (parsed.command === "gc") {
    const base = process.env.TC893_RESULTS ?? "results";
    const now = new Date();
    const environment = { runId: now.toISOString().replace(/[^0-9A-Za-z-]/g, "-"), resultsDir: base, clock: realClock, docker: process.env.DOCKER ? process.env.DOCKER.split(/\s+/) : ["sudo", "-n", "docker"], sut: {} as RunEnvironment["sut"], image: () => { throw new Error("gc does not resolve node images"); }, slackMs: 3000, teardownMs: 60_000 } satisfies RunEnvironment;
    const older = parsed.options["older-than"] === undefined ? 2 * 60 * 60_000 : parseDuration(String(parsed.options["older-than"]));
    const result = await gc(environment, { olderThanMs: older });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
    return;
  }
  if (parsed.command === "list") {
    validateRegistry(scenarioRegistry);
    const tier = typeof parsed.options.tier === "string" ? parsed.options.tier.split(",") : undefined;
    const only = typeof parsed.options.only === "string" ? parsed.options.only.split(",") : undefined;
    const variants = typeof parsed.options.variant === "string" ? parsed.options.variant.split(",") : undefined;
    if (parsed.options.set !== undefined && parsed.options.set !== "phase1-companion") throw new Error(`unknown scenario set: ${parsed.options.set}`);
    const set = parsed.options.set === "phase1-companion" ? "phase1-companion" : undefined;
    const backends = typeof parsed.options.backend === "string" ? parsed.options.backend.split(",") : ["sqlite", "pg16", "pg16-c"];
    const rows = scenarioRegistry.filter((scenario) => (!tier || tier.includes(scenario.tier)) &&
      (!only || only.includes(scenario.id)) && (!set || scenario.sets?.includes(set)));
    for (const scenario of rows) for (const variant of scenario.variants?.length ? scenario.variants : [null]) {
      if (variants && (variant === null || !variants.includes(variant))) continue;
      for (const backend of scenario.backends ?? backends) {
        if (!backends.includes(backend)) continue;
        console.log(`${scenario.id}${variant ? `[${variant}]` : ""}@${backend}\t${scenario.tier}\t${scenario.title}`);
      }
    }
    return;
  }
  if (parsed.command === "verify-aggregate") return verifyCommand(parsed);
  if (parsed.command === "resolve") return (handlers.resolve ?? resolveCommand)(parsed);
  if (parsed.command === "manifest") return (handlers.manifest ?? manifestCommand)(parsed);
  if (parsed.command === "aggregate") return (handlers.aggregate ?? aggregateCommand)(parsed);
  if (parsed.command === "run") {
    if (parsed.options.gate !== undefined) {
      const result = await runGateLocally(await (handlers.gateHooks ? handlers.gateHooks(parsed) : createGateHooks(parsed)));
      const companionPassed = result.aggregate.companion.every((item) => item.passed);
      console.log(JSON.stringify({ gatePassed: result.aggregate.gate?.passed ?? false, companionPassed }));
      if (!result.aggregate.gate?.passed) process.exitCode = 3;
      else if (!companionPassed) process.exitCode = 5;
      return;
    }
    if (parsed.options.inputs !== undefined) return runLegCommand(parsed);
    if (handlers.run) await handlers.run(parsed);
    else if (runHandler) await runHandler(parsed);
    else await runHarnessCommand(parsed);
    return;
  }
}
function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`invalid duration ${value}; expected e.g. 2h`);
  return Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[match[2] as "ms" | "s" | "m" | "h" | "d"];
}
if (import.meta.main) {
  try { await runCommand(Bun.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}

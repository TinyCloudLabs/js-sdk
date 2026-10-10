#!/usr/bin/env bun
import { scenarioRegistry, validateRegistry } from "../src/runner/registry";
export const commands = ["run", "list", "manifest", "resolve", "aggregate", "verify-aggregate", "doctor", "gc"] as const;
export type Command = typeof commands[number];
export interface ParsedArgs { command: Command; positionals: string[]; options: Record<string, string | true> }
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
export function exactSemver(value: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return false;
  return (match[4]?.split(".") ?? []).every((identifier) => !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0"));
}
export type CommandHandler = (parsed: ParsedArgs) => Promise<void> | void;
let runHandler: CommandHandler | undefined;
export function setRunCommandHandler(handler: CommandHandler): void { runHandler = handler; }
export async function runCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.options.help === true) {
    console.log(`Usage: harness ${parsed.command} [options]`);
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
  if (parsed.command === "run") {
    if (!runHandler) throw new Error("run requires the topology runner to be configured");
    await runHandler(parsed);
    return;
  }
  const owner: Record<Exclude<Command, "run" | "list">, string> = {
    manifest: "S3b", resolve: "S3b", aggregate: "S3b", "verify-aggregate": "S3b", doctor: "S1", gc: "S1",
  };
  throw new Error(`${parsed.command} is owned by ${owner[parsed.command]}`);
}
if (import.meta.main) {
  try { await runCommand(Bun.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
}

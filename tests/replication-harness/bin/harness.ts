#!/usr/bin/env bun
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
const owner: Record<Command, string> = {
  run: "S3a", list: "S3a", manifest: "S3b", resolve: "S3b", aggregate: "S3b", "verify-aggregate": "S3b", doctor: "S1", gc: "S1",
};
export function runCommand(args: string[]): never {
  const parsed = parseArgs(args);
  if (parsed.options.help === true) {
    console.log(`Usage: harness ${parsed.command} [options]`);
    return process.exit(0) as never;
  }
  throw new Error(`${parsed.command} is not implemented in S0 (owned by ${owner[parsed.command]})`);
}
if (import.meta.main) {
  try { runCommand(Bun.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
}

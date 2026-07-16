import { Command } from "commander";

import { registerSecretsCommand } from "../src/commands/secrets.js";

const program = new Command();
program
  .name("tc")
  .option("-p, --profile <name>", "Profile to use")
  .option("-H, --host <url>", "TinyCloud node URL")
  .option("-q, --quiet", "Suppress non-essential output")
  .option("--json", "Force JSON output");

registerSecretsCommand(program);
await program.parseAsync(process.argv);

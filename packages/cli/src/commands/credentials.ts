import type { Command } from "commander";
import { runCredentialCliHandoff } from "../credentials/handoff.js";

export function registerCredentialsCommand(program: Command): void {
  const credentials = program.command("credentials").description("Complete a hosted credential ceremony");
  credentials.command("ensure")
    .requiredOption("--hosted <origin>", "credentials.org origin")
    .requiredOption("--issuer <origin>", "credential issuer origin")
    .action(async (options: { hosted: string; issuer: string }) => {
      const result = await runCredentialCliHandoff({ hostedOrigin: options.hosted, issuerOrigin: options.issuer });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });
}

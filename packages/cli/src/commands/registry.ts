import { Command } from "commander";
import { invokeOperation } from "@tinycloud/operations";
import { CLIError, handleError } from "../output/errors.js";
import { outputJson, shouldOutputJson } from "../output/formatter.js";

export function registerRegistryCommand(program: Command): void {
  program.command("registry").description("See where your data is stored, from the copy saved on this computer")
    .command("show [account-id]").description("Check and show the saved storage settings: account, version, age, spaces, servers and decryption service. Works offline, no sign-in.")
    .action(async (did: string | undefined, _options: unknown, command: Command) => {
      try {
        const options = command.optsWithGlobals();
        const result = await invokeOperation("tinycloud.registry.show", 1, {
          ...(options.profile ? { profile: options.profile } : {}), allowOwnerProfile: true,
        }, did === undefined ? {} : { did });
        if (result.status !== "ok") {
          if (result.status === "error") throw new CLIError(result.error.code, result.error.message);
          throw new CLIError("REGISTRY_UNAVAILABLE", "Couldn't read the storage settings saved on this computer.");
        }
        if (shouldOutputJson()) { outputJson(result.output); return; }
        const value = result.output as { owner: string; sequence: number; ageMs: number; nodes: { did: string; url: string }[]; spaces: { space: string; nodes: { did: string; mode: string }[] }[]; encryptionNode: string | null };
        // JSON quoting prevents control characters in signed space names reaching the terminal.
        const quote = (text: string) => JSON.stringify(text);
        const ageDivisor = value.ageMs < 60_000 ? 1_000 : value.ageMs > 7_200_000 ? 3_600_000 : 60_000;
        const ageUnit = ageDivisor === 1_000 ? "second" : ageDivisor === 60_000 ? "minute" : "hour";
        const ageCount = Math.floor(value.ageMs / ageDivisor);
        process.stdout.write(`Account: ${quote(value.owner)}\nVersion: ${value.sequence}\nSaved: ${ageCount} ${ageUnit}${ageCount === 1 ? "" : "s"} ago\n`);
        const nodes = new Map(value.nodes.map((node) => [node.did, node.url]));
        for (const space of value.spaces) {
          process.stdout.write(`Space: ${quote(space.space)}\n`);
          for (const node of space.nodes) process.stdout.write(`  ${quote(nodes.get(node.did)!)} (${node.mode === "read-write" ? "read and write" : "read only"}), server ID ${quote(node.did)}\n`);
        }
        process.stdout.write(`Decryption service: ${value.encryptionNode === null ? "none" : `${quote(nodes.get(value.encryptionNode)!)}, ID ${quote(value.encryptionNode)}`}\n`);
      } catch (error) { return handleError(error); }
    });
}

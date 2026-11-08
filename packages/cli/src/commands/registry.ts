import { Command } from "commander";
import { invokeOperation } from "@tinycloud/operations";
import { CLIError, handleError } from "../output/errors.js";
import { outputJson, shouldOutputJson } from "../output/formatter.js";

export function registerRegistryCommand(program: Command): void {
  program.command("registry").description("Inspect locally cached signed registry placement")
    .command("show [did]").description("Verify and show cached owner, sequence, age, spaces, node modes and encryption destination (no network or sign-in)")
    .action(async (did: string | undefined, _options: unknown, command: Command) => {
      try {
        const options = command.optsWithGlobals();
        const result = await invokeOperation("tinycloud.registry.show", 1, {
          ...(options.profile ? { profile: options.profile } : {}), allowOwnerProfile: true,
        }, did === undefined ? {} : { did });
        if (result.status !== "ok") {
          if (result.status === "error") throw new CLIError(result.error.code, result.error.message);
          throw new CLIError("REGISTRY_UNAVAILABLE", "The cached registry entry could not be inspected.");
        }
        if (shouldOutputJson()) { outputJson(result.output); return; }
        const value = result.output as { owner: string; sequence: number; ageMs: number; nodes: { did: string; url: string }[]; spaces: { space: string; nodes: { did: string; mode: string }[] }[]; encryptionNode: string | null };
        // JSON quoting prevents control characters in signed space names reaching the terminal.
        const quote = (text: string) => JSON.stringify(text);
        process.stdout.write(`Owner: ${quote(value.owner)}\nSequence: ${value.sequence}\nFetch age: ${Math.floor(value.ageMs / 1000)}s\n`);
        const nodes = new Map(value.nodes.map((node) => [node.did, node.url]));
        for (const space of value.spaces) {
          process.stdout.write(`Space: ${quote(space.space)}\n`);
          for (const node of space.nodes) process.stdout.write(`  ${quote(nodes.get(node.did)!)} ${node.mode} ${quote(node.did)}\n`);
        }
        process.stdout.write(`Encryption: ${value.encryptionNode === null ? "none" : `${quote(nodes.get(value.encryptionNode)!)} ${quote(value.encryptionNode)}`}\n`);
      } catch (error) { return handleError(error); }
    });
}

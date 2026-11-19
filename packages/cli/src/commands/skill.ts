import { Command } from "commander";
import { homedir } from "node:os";
import { handleError } from "../output/errors.js";
import { outputJson } from "../output/formatter.js";
import { checkSkill, saveBundledSkill } from "../skill/run.js";
import { shownPath } from "../skill/bundle.js";

/** `skill save`: the TinyCloud guide the CLI ships, copied into the skills folder an agent reads. Needs no sign-in or network. */
export function registerSkillCommand(program: Command): void {
  const skill = program.command("skill").description("The TinyCloud guide for agents");

  skill
    .command("save")
    .description("Save the TinyCloud guide in your agent's skills folder")
    .option("--agent <clients>", "Client to save it for: amp, claude-code, codex, copilot, cursor, gemini, hermes, omp, openclaw, opencode or auto (default: the clients found on this computer)")
    .option("--check", "Report whether the guide is saved and current, and write nothing")
    .action(async (options: { agent?: string; check?: boolean }, command: Command) => {
      try {
        const context = { home: homedir(), env: process.env };
        if (options.check) {
          outputJson(checkSkill({ agent: options.agent, context }));
          return;
        }
        const saved = saveBundledSkill({ agent: options.agent, context });
        outputJson({ saved: saved.saved, version: saved.version, folder: saved.folder, folders: saved.folders });
        if (command.optsWithGlobals().quiet) return;
        for (const folder of saved.unchanged) process.stderr.write(`TinyCloud's guide is already saved in ${shownPath(folder)}.\n`);
        process.stderr.write("Next: carry on with the owner's request.\n");
      } catch (error) {
        await handleError(error);
      }
    });
}

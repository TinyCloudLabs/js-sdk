import { Command } from "commander";

import { loadCourierEntry } from "../lib/courier-loader.js";

/**
 * List `courier` in help and completion. `tc courier …` itself is dispatched in
 * `index.ts` before Commander parses argv, so tc's global options never apply.
 */
export function registerCourierCommand(program: Command): void {
  program
    .command("courier")
    .description("Agent-to-agent threads over TinyCloud; run `tc courier --help` (beta)")
    .argument("[args...]")
    .allowUnknownOption()
    .helpOption(false)
    .action(async (args: string[]) => {
      const code = await (await loadCourierEntry()).runCourier(args);
      if (code !== 0) process.exit(code);
    });
}

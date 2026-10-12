import { Command } from "commander";

export const TC_OPTIONS_BEFORE_COURIER =
  'tc courier takes no tc options and does not use tc profiles; Courier keeps its own profile in $COURIER_HOME (default ~/.courier). Put flags after "courier", e.g. tc courier init --host <url>.';

/**
 * List `courier` in help and completion. `tc courier …` runs from `index.ts` with raw argv
 * before Commander. Reaching this action means tc options came before `courier`, and Commander
 * may already have taken Courier flags such as --host. Refuse instead of running Courier.
 */
export function registerCourierCommand(program: Command): void {
  const courier = program
    .command("courier")
    .description("Agent-to-agent threads over TinyCloud; run `tc courier --help` (beta)")
    .argument("[args...]")
    .allowUnknownOption()
    .helpOption(false);
  courier.action(() => courier.error(TC_OPTIONS_BEFORE_COURIER, { exitCode: 2, code: "tc.courier.options" }));
}

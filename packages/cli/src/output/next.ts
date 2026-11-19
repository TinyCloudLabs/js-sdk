import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { checkSkill } from "../skill/run.js";
import type { SkillContext } from "../skill/clients.js";

/**
 * `Next:` lines on stderr (the approval-wait one is in `auth/next-line.ts`). A line is printed only when there is one
 * definite next step, never after every command.
 */

/** After `onboard` completes: offer to save the guide. */
export function saveGuideNextLine(cli: string = CLI_NAME): string {
  return `Next: \`${cli} skill save\` saves a short guide to TinyCloud in your skills folder, so you have it next time.`;
}

/** After `skill save` succeeds: back to what the owner asked for. */
export const CONTINUE_NEXT_LINE = "Next: carry on with the owner's request.";

/** With the not-signed-in error: the one command that fixes it. */
export function signInNextLine(cli: string = CLI_NAME): string {
  return `Next: \`${cli} onboard\` asks the owner for approval and waits for it.`;
}

/**
 * The offer after `onboard`, or `undefined` when `skill save` would not be the next step: the guide is already saved
 * and current, a skills folder holds files TinyCloud did not write (`skill save` refuses it), or no agent's skills
 * folder is found on this computer (`skill save` cannot tell which agent this is).
 */
export function onboardNextLine(context: SkillContext, cli: string = CLI_NAME): string | undefined {
  try {
    const { state } = checkSkill({ context });
    return state === "missing" || state === "outdated" ? saveGuideNextLine(cli) : undefined;
  } catch {
    return undefined;
  }
}

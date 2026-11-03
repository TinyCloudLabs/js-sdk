/**
 * The one line, on stderr, that tells an agent what to do when an approval wait ends with exit 8 (TC-2360).
 * Agents act only on what the CLI prints, and rewrite the guides they were given: this text is the one they keep.
 */

/** The link was created by this run. */
export const NEXT_NEW_LINK =
  "Next: send the owner the link above, then run this same command again now, in this same turn; do not wait for the owner to reply (the command sees the approval itself).";

/** The wait ended on a saved request; the CLI cannot know whether the agent already relayed its link. */
export const NEXT_RESUMED =
  "Next: run this same command again now, in this same turn, and send the owner the link above first only if you have not sent it yet; do not wait for the owner to reply.";

export function approvalNextLine(created: boolean): string {
  return created ? NEXT_NEW_LINK : NEXT_RESUMED;
}

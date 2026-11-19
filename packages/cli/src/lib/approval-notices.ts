import type { PermissionEntry } from "@tinycloud/node-sdk";

const spaceLabel = (group: PermissionEntry[]): string => {
  const space = group[0]?.space ?? "";
  return `${space.split(":").pop() || space} space`;
};

/**
 * OpenKey signs one space per approval, so a grant spanning N spaces takes N
 * approvals. These are the lines to print before the first prompt and at each
 * one; a single-space grant needs none.
 */
export function approvalNotices(groups: PermissionEntry[][]): { intro: string; prompts: string[] } | undefined {
  if (groups.length < 2) return undefined;
  return {
    intro: `This needs ${groups.length} approvals in OpenKey (${groups.map(spaceLabel).join(", then ")}).`,
    prompts: groups.map((group, index) => `Approval ${index + 1} of ${groups.length}: ${spaceLabel(group)}...`),
  };
}

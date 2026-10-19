import { ACCOUNT_MANIFEST_PERMISSIONS } from "@tinycloud/sdk-core";
import type { PermissionEntry, TinyCloudNode } from "@tinycloud/node-sdk";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { resolvePermissionSpaces } from "./permissions.js";

/** The account-space abilities every `account` command needs. */
export function accountPermissionEntries(): PermissionEntry[] {
  return ACCOUNT_MANIFEST_PERMISSIONS.map((resource) => ({
    service: resource.service,
    space: resource.space,
    path: resource.path,
    actions: [...resource.actions],
  }));
}

/** `--cap` specs (tinycloud.<service>:<space>:<path>:<actions-csv>) for the account abilities. */
export function accountCapSpecs(): string[] {
  return accountPermissionEntries().map((entry) => {
    const actions = entry.actions.map((action) => action.slice(action.lastIndexOf("/") + 1));
    return `${entry.service}:${entry.space}:${entry.path}:${actions.join(",")}`;
  });
}

/**
 * Fail with ACCOUNT_ACCESS_REQUIRED, before any node call, when the session
 * holds no account-space abilities. A plain OpenKey login is granted its
 * defaults on `default` only.
 */
export async function assertAccountAccess(
  node: Pick<TinyCloudNode, "hasRuntimePermissions">,
  profile: string,
): Promise<void> {
  // Same resolution `auth request --grant` applies: `account` becomes this
  // owner's full account space URI before the session is asked about it.
  const required = await resolvePermissionSpaces(accountPermissionEntries(), profile);
  if (node.hasRuntimePermissions(required)) return;
  const caps = accountCapSpecs().map((spec) => `--cap '${spec}'`).join(" ");
  throw new CLIError(
    "ACCOUNT_ACCESS_REQUIRED",
    "This session has no account-space permissions (kv applications/ and spaces/, " +
      "sql account, delegation list, capabilities read on the `account` space). " +
      "A plain OpenKey login grants only the `default` space.",
    ExitCode.PERMISSION_DENIED,
    {
      hint: `Grant account access, then retry: ${CLI_NAME} --profile ${profile} auth request --grant ${caps}`,
    },
  );
}

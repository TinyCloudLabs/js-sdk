import { ACCOUNT_MANIFEST_PERMISSIONS } from "@tinycloud/sdk-core";
import type { PermissionEntry, TinyCloudNode } from "@tinycloud/node-sdk";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { resolvePermissionSpaces } from "./permissions.js";

/**
 * What an `account` command invokes beyond the account registry (kv get/put/list,
 * sql, delegation list and capabilities read on the `account` space):
 * - `registry`: nothing more.
 * - `remove`: also `tinycloud.kv/del` on `applications/` and `spaces/`.
 * - `spaces`: also `tinycloud.space/list` on the primary space.
 * - `delegations`: `spaces`, plus `tinycloud.capabilities/read` on every space
 *   it lists (the primary space is static; the rest are found by one
 *   `space/list` once that ability is held).
 */
export type AccountNeed = "registry" | "remove" | "spaces" | "delegations";

const PRIMARY_SPACE = "default";

/** The abilities an `account` command needs, in the shape `auth request --grant` takes. */
export function accountPermissionEntries(need: AccountNeed = "registry"): PermissionEntry[] {
  const entries: PermissionEntry[] = ACCOUNT_MANIFEST_PERMISSIONS.map((resource) => ({
    service: resource.service,
    space: resource.space,
    path: resource.path,
    actions: [...resource.actions],
  }));
  if (need === "remove") {
    for (const path of ["applications/", "spaces/"]) {
      entries.push({ service: "tinycloud.kv", space: "account", path, actions: ["tinycloud.kv/del"] });
    }
  }
  if (need === "spaces" || need === "delegations") {
    entries.push({ service: "tinycloud.space", space: PRIMARY_SPACE, path: "", actions: ["tinycloud.space/list"] });
  }
  if (need === "delegations") {
    entries.push(capabilitiesRead(PRIMARY_SPACE));
  }
  return entries;
}

function capabilitiesRead(space: string): PermissionEntry {
  return { service: "tinycloud.capabilities", space, path: "", actions: ["tinycloud.capabilities/read"] };
}

/** `--cap` specs (tinycloud.<service>:<space>:<path>:<actions-csv>) for permission entries. */
export function capSpecs(entries: PermissionEntry[]): string[] {
  return entries.map((entry) => {
    const actions = entry.actions.map((action) => action.slice(action.lastIndexOf("/") + 1));
    return `${entry.service}:${entry.space}:${entry.path}:${actions.join(",")}`;
  });
}

/** The abilities an `account` command needs, as `--cap` specs. */
export function accountCapSpecs(need: AccountNeed = "registry"): string[] {
  return capSpecs(accountPermissionEntries(need));
}

type AccessNode = Pick<TinyCloudNode, "hasRuntimePermissions" | "spaces">;

function accessRequired(profile: string, entries: PermissionEntry[], what: string): CLIError {
  const grant = `${CLI_NAME} --profile ${profile} auth request --grant ` +
    capSpecs(entries).map((spec) => `--cap '${spec}'`).join(" ");
  return new CLIError(
    "ACCOUNT_ACCESS_REQUIRED",
    `This session lacks account permissions this command needs (${what}). ` +
      "A plain OpenKey login grants only the `default` space.",
    ExitCode.PERMISSION_DENIED,
    {
      hint: `Grant account access, then retry: ${grant}\n` +
        `If the browser cannot reach the CLI, re-run with --paste: ${grant} --paste`,
    },
  );
}

/**
 * Fail with ACCOUNT_ACCESS_REQUIRED when the session lacks an ability the
 * command invokes. The static abilities are checked first, with no node call.
 * `delegations` then lists the owner's spaces (allowed, `space/list` is held)
 * to check `capabilities/read` on each, so the command cannot pass the gate
 * and 401 on a space it only learns about from that list.
 */
export async function assertAccountAccess(
  node: AccessNode,
  profile: string,
  need: AccountNeed = "registry",
): Promise<void> {
  // Same resolution `auth request --grant` applies: `account` becomes this
  // owner's full account space URI before the session is asked about it.
  const entries = accountPermissionEntries(need);
  const required = await resolvePermissionSpaces(entries, profile);
  if (!node.hasRuntimePermissions(required)) {
    throw accessRequired(profile, entries, need === "registry"
      ? "kv applications/ and spaces/, sql account, delegation list, capabilities read on `account`"
      : `the \`account\` registry set plus ${need === "remove" ? "kv del on applications/ and spaces/" : "space list on `default`"}`);
  }
  if (need !== "delegations") return;

  const listed = await node.spaces.list();
  if (!listed.ok) return; // the command surfaces the same failure itself
  const known = new Set(required.map((entry) => entry.space));
  const more = listed.data.filter((space) => !known.has(space.id)).map((space) => capabilitiesRead(space.id));
  if (more.length === 0) return;
  if (!node.hasRuntimePermissions(more)) {
    throw accessRequired(profile, [...entries, ...more], "capabilities read on every space it lists");
  }
}

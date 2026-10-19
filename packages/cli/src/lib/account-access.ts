import { ACCOUNT_MANIFEST_PERMISSIONS } from "@tinycloud/sdk-core";
import type { PermissionEntry, TinyCloudNode } from "@tinycloud/node-sdk";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { ProfileManager } from "../config/profiles.js";
import { resolvePermissionSpaces } from "./permissions.js";

/**
 * What an `account` command invokes beyond the account registry (kv get/put/list,
 * sql, delegation list and capabilities read on the `account` space). The sets
 * below are what the production services record in account-invocations.test.ts:
 * - `registry`: nothing more.
 * - `remove`: also `tinycloud.kv/del` on `applications/` and `spaces/`.
 * - `spaces`: also `tinycloud.space/list` on the primary space.
 * - `delegations`: `spaces`, plus `tinycloud.capabilities/read` on the primary
 *   space. SpaceService's per-space delegation reads invoke it with the primary
 *   session whichever space they list, so no per-space grant exists to ask for.
 * - `revoke`: no session ability. `DelegationManager.revoke` signs with the
 *   owner's wallet when the node has one (local-key profiles), and otherwise
 *   invokes `tinycloud.delegation/revoke` on `urn:cid:<cid>`, which no OpenKey
 *   grant can carry (see ensureDelegationAuthority in auth.ts).
 */
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

type AccessNode = Pick<TinyCloudNode, "hasRuntimePermissions">;

/** A profile name as a shell word: bare when plain, single-quoted otherwise. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9._@:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function accessRequired(profile: string, entries: PermissionEntry[], what: string): CLIError {
  const grant = `${CLI_NAME} --profile ${shellWord(profile)} auth request --grant ` +
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
 * Fail with ACCOUNT_ACCESS_REQUIRED, before any node call, when the session
 * lacks an ability the command invokes.
 */
export async function assertAccountAccess(
  node: AccessNode,
  profile: string,
  need: AccountNeed = "registry",
  cid?: string,
): Promise<void> {
  if (need === "revoke") {
    // Local-key profiles sign the revocation with the owner wallet: no session ability involved.
    if ((await ProfileManager.getProfile(profile)).authMethod === "local") return;
    throw new CLIError(
      "ACCOUNT_REVOKE_UNSUPPORTED",
      "This profile signs through OpenKey, which cannot sign the raw-CID revocation `account delegations revoke` needs.",
      ExitCode.PERMISSION_DENIED,
      { hint: `Revoke it with: ${CLI_NAME} --profile ${shellWord(profile)} delegation revoke ${cid ?? "<cid>"}` },
    );
  }
  // Same resolution `auth request --grant` applies: `account` becomes this
  // owner's full account space URI before the session is asked about it.
  const entries = accountPermissionEntries(need);
  const required = await resolvePermissionSpaces(entries, profile);
  if (node.hasRuntimePermissions(required)) return;
  throw accessRequired(profile, entries, need === "registry"
    ? "kv applications/ and spaces/, sql account, delegation list, capabilities read on `account`"
    : `the \`account\` registry set plus ${need === "remove" ? "kv del on applications/ and spaces/" : "space list and capabilities read on `default`"}`);
}

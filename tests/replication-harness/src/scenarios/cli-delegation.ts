import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliClient } from "../contracts/client";

export interface CliDelegationSetup {
  space: string;
  prefix: string;
  actions: readonly string[];
  expires: string;
}
export interface CliDelegationResult { cid?: string }
function grantCid(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(grantCid).find((item) => item !== undefined);
  if (typeof value !== "object" || value === null) return undefined;
  for (const [name, nested] of Object.entries(value)) {
    if (/^(cid|delegationCid|grantCid)$/i.test(name) && typeof nested === "string") return nested;
    const found = grantCid(nested);
    if (found) return found;
  }
  return undefined;
}

export async function createCliDelegation(owner: CliClient, device: CliClient, setup: CliDelegationSetup): Promise<CliDelegationResult> {
  const requestPath = join(device.home(), `.tc893-delegation-${randomUUID()}.json`);
  const grantPath = join(owner.home(), `.tc893-delegation-${randomUUID()}.json`);
  const initialized = await device.tc(["profile", "create", device.profile(), "--posture", "delegate-session"]);
  if (initialized.exit !== 0) throw new Error(`delegate profile setup failed (exit ${initialized.exit}): ${initialized.stderr}`);
  const request = await device.tc(["auth", "request", "--cap", `tinycloud.kv:${setup.space}:${setup.prefix}:${setup.actions.join(",")}`, "--expiry", setup.expires, "--emit", requestPath]);
  if (request.exit !== 0) throw new Error(`delegate request failed (exit ${request.exit}): ${request.stderr}`);
  const grant = await owner.tc(["auth", "grant", "--yes", requestPath]);
  if (grant.exit !== 0) throw new Error(`owner grant failed (exit ${grant.exit}): ${grant.stderr}`);
  await writeFile(grantPath, grant.stdout, { mode: 0o600 });
  const profilePath = join(device.home(), ".tinycloud", "profiles", device.profile(), "profile.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  profile.authMethod = "openkey";
  profile.replication = { prefixes: [setup.prefix] };
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const imported = await device.tc(["auth", "import", grantPath]);
  if (imported.exit !== 0) throw new Error(`delegate import failed (exit ${imported.exit}): ${imported.stderr}`);
  let grantObject: unknown;
  try { grantObject = JSON.parse(Buffer.from(grant.stdout).toString("utf8")); } catch { grantObject = undefined; }
  return { cid: grantCid(grantObject) };
}

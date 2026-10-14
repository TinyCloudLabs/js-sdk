import { join } from "node:path";
import { profilePath, readJson, writeJsonAtomic, readAdditionalDelegations, withProfileLock } from "../state.js";
import { isTcAppsPermission, TC_APPS_COPY_ACTIONS } from "../tc-apps.js";
import { isObject } from "./records.js";

export function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); return true; }
  catch { return false; }
}

export async function appsTimezone(profile: string, timezone?: string): Promise<string | null> {
  const path = join(profilePath(profile), "tc-apps.json");
  if (timezone !== undefined) {
    await withProfileLock(profile, async () => {
      const current = await readJson<Record<string, unknown>>(path);
      await writeJsonAtomic(path, { ...current, timezone });
    });
    return timezone;
  }
  const stored = await readJson<{ timezone?: unknown }>(path);
  return typeof stored?.timezone === "string" && validTimezone(stored.timezone) ? stored.timezone : null;
}

function localParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}
function offsetAt(date: Date, timezone: string): string {
  const parts = localParts(date, timezone);
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const minutes = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}
export function appsNow(timezone: string | null, date = new Date()): string {
  const zone = timezone ?? "UTC";
  const parts = localParts(date, zone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${offsetAt(date, zone)}`;
}

export function withLocalOffset(at: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(at)) return at;
  const local = new Date(`${at}Z`);
  if (Number.isNaN(local.getTime())) return at;
  let offset = offsetAt(local, timezone);
  // Re-evaluate at the actual instant, not UTC noon: DST may change that day.
  for (let pass = 0; pass < 2; pass++) offset = offsetAt(new Date(`${at}${offset}`), timezone);
  return `${at}${offset}`;
}

/** A stored grant is a preference signal, not authorization; runtime preflight still verifies it. */
export async function appsCopyState(profile: string, space: string): Promise<"present" | "expired" | "none"> {
  let expired = false;
  for (const entry of await readAdditionalDelegations<unknown>(profile)) {
    if (!isObject(entry) || !isObject(entry.delegation) || !Array.isArray(entry.permissions)) continue;
    const copy = entry.permissions.some((permission) => isObject(permission) &&
      isTcAppsPermission(permission, true) && (permission.space === space || permission.space === "default") &&
      Array.isArray(permission.actions) && TC_APPS_COPY_ACTIONS.every((action) => (permission.actions as unknown[]).includes(action)));
    if (!copy || typeof entry.delegation.expiry !== "string") continue;
    const expiry = Date.parse(entry.delegation.expiry);
    if (!Number.isFinite(expiry)) continue;
    if (expiry > Date.now()) return "present";
    expired = true;
  }
  return expired ? "expired" : "none";
}

import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";

import {
  describeAction,
  describeGrantScope,
  entriesForSigning,
  finalizeSigningEntries,
} from "./apps-agent-preset.js";
import { normalizePkhIdentifier } from "./space.js";

/**
 * The key invariant of `auth grant`: the entries it prints, the entries it
 * gates and the entries the signer signs are one list. This models the
 * signer (`TinyCloudNode.resolvePermissionSpace` and the per-(service, path)
 * merge in `createDelegationViaWasmPath`) and the profile's name resolution,
 * then checks generated requests against both.
 */

const OWNER = "0xAbC0000000000000000000000000000000000001";
const FOREIGN = "0x2222222222222222222222222222222222222222";
const spaceId = (name: string, owner = OWNER) => `tinycloud:pkh:eip155:1:${owner}:${name}`;
const OWNER_APPLICATIONS = spaceId("applications");

// --- model of the profile (CLI side): names to space ids, short names to full abilities ---

function expandNames(entries: readonly PermissionEntry[]): PermissionEntry[] {
  return entries.map((entry) => {
    const service = entry.service.startsWith("tinycloud.") ? entry.service : `tinycloud.${entry.service}`;
    return { ...entry, service, actions: entry.actions.map((action) => (action.includes("/") ? action : `${service}/${action}`)) };
  });
}

function profileResolve(entries: readonly PermissionEntry[]): PermissionEntry[] {
  return expandNames(entries).map((entry) => {
    const space = entry.space!;
    if (space.startsWith("tinycloud:")) return entry;
    if (!/^[A-Za-z0-9_-]+$/.test(space)) throw new Error("INVALID_SPACE");
    return { ...entry, space: spaceId(space) };
  });
}

// --- model of the signer ---

function signerSpace(space: string | undefined): string {
  if (space === undefined) return spaceId("applications");
  if (space === "default") return spaceId("default");
  if (space.startsWith("tinycloud:")) return space;
  return spaceId(space);
}

/** The resources the signer would sign, as sorted keys; `refused` when it throws (nothing signed). */
function signedResources(entries: readonly PermissionEntry[]): string[] | "refused" {
  const spaces = new Set(entries.map((entry) => signerSpace(entry.space)));
  if (spaces.size > 1) return "refused";
  const space = [...spaces][0]!;
  const byServicePath = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.service, entry.path]);
    const actions = byServicePath.get(key) ?? new Set<string>();
    entry.actions.forEach((action) => actions.add(action));
    byServicePath.set(key, actions);
  }
  return [...byServicePath].map(([key, actions]) => {
    const [service, path] = JSON.parse(key) as [string, string];
    return JSON.stringify([service, space, path, [...actions].sort()]);
  }).sort();
}

const keyOf = (entry: PermissionEntry) => JSON.stringify([entry.service, entry.space, entry.path, [...entry.actions].sort()]);

// --- generator ---

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPACES: (string | undefined)[] = [
  undefined, undefined, undefined, "", "applications", "applications", "applications", "applications", "Applications", "default", "other",
  OWNER_APPLICATIONS, spaceId("applications", OWNER.toLowerCase()), spaceId("applications", FOREIGN), spaceId("Applications"), spaceId("default"),
];
const SERVICES = ["tinycloud.kv", "tinycloud.kv", "tinycloud.kv", "tinycloud.sql", "tinycloud.sql", "kv", "sql", "tinycloud.delegation", "tinycloud.capabilities", "tinycloud.hooks", "tinycloud.zzz"];
const PATHS = ["", "", "/", "a/", "xyz.app/", "xyz.app/", "xyz.app/knowledge/", "xyz.app", "xyz.app//", "../x/", "Xyz.App/", "x y/", "other.app/"];
const ACTIONS = ["get", "list", "put", "del", "read", "write", "admin", "schema", "*", "create", "revoke", "frob", "tinycloud.kv/get", "tinycloud.sql/read", "tinycloud.delegation/*", "tinycloud.kv/put"];

function generate(next: () => number): PermissionEntry[] {
  const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const count = 1 + Math.floor(next() * 16);
  const entries: PermissionEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (entries.length > 0 && next() < 0.3) {
      // a duplicate (service, space, path) with different actions: the signer merges these
      const copy = pick(entries);
      entries.push({ ...copy, actions: [pick(ACTIONS)] });
      continue;
    }
    if (next() < 0.5) {
      // an entry inside the preset's limits: many of these make the "others" list long
      const kv = next() < 0.5;
      entries.push({
        service: kv ? "tinycloud.kv" : "tinycloud.sql",
        space: pick(["applications", OWNER_APPLICATIONS]),
        path: pick(["xyz.app/", "xyz.app/knowledge/", "other.app/", "a.b.c/", "b.c.d/", "c.d.e/", "d.e.f/", "e.f.g/"]),
        actions: [kv ? pick(["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"]) : pick(["tinycloud.sql/read", "tinycloud.sql/write"])],
      });
      continue;
    }
    const actions = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(ACTIONS));
    const space = pick(SPACES);
    entries.push({ service: pick(SERVICES), ...(space === undefined ? {} : { space }), path: pick(PATHS), actions });
  }
  return entries;
}

// --- the checks ---

function beyondPreset(entries: readonly PermissionEntry[]): PermissionEntry[] {
  const touches = entries.some((entry) => entry.space!.split(":").at(-1) === "applications");
  if (!touches) return [];
  return entries.filter((entry) => {
    const named = /^[A-Za-z0-9][\w.-]*\//.test(entry.path);
    const reads = entry.service === "tinycloud.kv" ? ["tinycloud.kv/get", "tinycloud.kv/list"] : entry.service === "tinycloud.sql" ? ["tinycloud.sql/read"] : [];
    const writes = entry.service === "tinycloud.kv" ? ["tinycloud.kv/put"] : entry.service === "tinycloud.sql" ? ["tinycloud.sql/write"] : [];
    const allowed = (action: string) => reads.includes(action) || (named && writes.includes(action));
    const kvOrSql = reads.length > 0;
    const owners = normalizePkhIdentifier(entry.space!) === normalizePkhIdentifier(OWNER_APPLICATIONS);
    return !(kvOrSql && owners && entry.actions.every(allowed));
  });
}

function prepare(raw: readonly PermissionEntry[]): PermissionEntry[] | "refused" {
  try {
    return finalizeSigningEntries(profileResolve(entriesForSigning(raw)));
  } catch {
    return "refused";
  }
}

describe("auth grant: printed == gated == signed, over generated requests", () => {
  const next = prng(20261020);
  const cases = Array.from({ length: 500 }, () => generate(next));
  const stats = { prepared: 0, refused: 0, missingSpace: 0, merged: 0, many: 0, longOthers: 0, multiSpace: 0 };

  test("for every request, the printed set is the signed set and anything beyond the preset is gated", () => {
    for (const raw of cases) {
      const prepared = prepare(raw);
      if (prepared === "refused") {
        // refused before anything is described or signed: only an empty space, a bad name or a bad shape
        stats.refused += 1;
        continue;
      }
      stats.prepared += 1;
      if (raw.some((entry) => entry.space === undefined)) stats.missingSpace += 1;
      if (prepared.length < raw.length) stats.merged += 1;
      if (raw.length > 5) stats.many += 1;

      // 1. the signer consumes the prepared list, and signs exactly that set (one resource per entry)
      const signed = signedResources(prepared);
      if (signed === "refused") {
        stats.multiSpace += 1; // the signer refuses mixed spaces: nothing is signed, nothing to compare
      } else {
        expect(signed).toEqual(prepared.map(keyOf).sort());
      }

      // 2. preparing does not change what the signer would have signed from the raw request
      const rawSigned = signedResources(expandNames(raw));
      if (rawSigned !== "refused" && signed !== "refused") expect(signed).toEqual(rawSigned);

      // 3. the text describes that same list: one line per entry, none merged or dropped
      const scope = describeGrantScope(prepared, "9d", OWNER_APPLICATIONS);
      expect(scope.entries).toBe(prepared);
      if (scope.entries.length - scope.extras.length > 5) stats.longOthers += 1;
      const lines = scope.text.split("\n").filter((line) => /^[-!] /.test(line));
      expect(lines).toHaveLength(prepared.length);
      const ordered = [...scope.extras, ...prepared.filter((entry) => !scope.extras.includes(entry))];
      ordered.forEach((entry, index) => {
        const line = lines[index]!;
        expect(line.startsWith(scope.extras.includes(entry) ? "! " : "- ")).toBe(true);
        const space = normalizePkhIdentifier(entry.space!) === normalizePkhIdentifier(OWNER_APPLICATIONS)
          ? "your `applications` space"
          : `space \`${entry.space}\``;
        expect(line).toContain(space);
        const whole = entry.path === "" || entry.path === "/";
        expect(line).toContain(whole ? (space.startsWith("your") ? "ALL apps in" : "everything in") : `\`${entry.path}\``);
        for (const action of entry.actions) expect(line).toContain(describeAction(action));
        expect(line.includes(`unrecognised service ${entry.service}`) || line.includes(`(${entry.service})`)).toBe(true);
      });

      // 4. the gate: exactly the entries an independent oracle says go beyond the preset
      const expected = beyondPreset(prepared);
      expect(scope.extras.map(keyOf).sort()).toEqual(expected.map(keyOf).sort());
      if (expected.length > 0) expect(scope.text).toContain("MORE than the apps-agent preset");
    }
    // the generator really exercised the hard cases
    expect(stats.prepared).toBeGreaterThan(150);
    expect(stats.refused).toBeGreaterThan(10);
    expect(stats.missingSpace).toBeGreaterThan(50);
    expect(stats.merged).toBeGreaterThan(30);
    expect(stats.many).toBeGreaterThan(100);
    expect(stats.longOthers).toBeGreaterThan(10);
    expect(stats.multiSpace).toBeGreaterThan(0);
  });
});

describe("auth grant: the entry with no space (the signer puts it in the owner's applications space)", () => {
  const prepared = prepare([
    { service: "tinycloud.kv", path: "", actions: ["get", "put", "del"] },
    { service: "tinycloud.kv", space: "applications", path: "xyz.app/", actions: ["get", "list"] },
  ]);

  test("resolves to the owner's applications space, is printed as that, and is gated", () => {
    expect(prepared).not.toBe("refused");
    if (prepared === "refused") return;
    expect(prepared[0]).toMatchObject({ space: OWNER_APPLICATIONS, path: "" });
    const scope = describeGrantScope(prepared, "7d", OWNER_APPLICATIONS);
    expect(scope.extras).toEqual([prepared[0]!]);
    expect(scope.text).toContain("MORE than the apps-agent preset");
    expect(scope.text).toContain("ALL apps in your `applications` space");
    expect(scope.text).not.toContain("space ``");
    expect(signedResources(prepared)).toContain(JSON.stringify(["tinycloud.kv", OWNER_APPLICATIONS, "", ["tinycloud.kv/del", "tinycloud.kv/get", "tinycloud.kv/put"]]));
  });

  test("an empty space is refused, not guessed", () => {
    expect(() => entriesForSigning([{ service: "tinycloud.kv", space: "", path: "", actions: ["tinycloud.kv/get"] }])).toThrow(
      expect.objectContaining({ exitCode: 2, message: expect.stringContaining("empty space") }),
    );
  });

  test("an entry that does not resolve to a concrete space is refused", () => {
    expect(() => finalizeSigningEntries([{ service: "tinycloud.kv", path: "", actions: ["tinycloud.kv/get"] }])).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
    expect(() => finalizeSigningEntries([{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/get"] }])).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
  });

  test("duplicate (service, space, path) entries are merged the way the signer merges them, so a hidden action cannot ride along", () => {
    const merged = prepare([
      { service: "tinycloud.kv", space: "applications", path: "xyz.app/", actions: ["get"] },
      { service: "tinycloud.kv", space: OWNER_APPLICATIONS, path: "xyz.app/", actions: ["del"] },
    ]);
    expect(merged).not.toBe("refused");
    if (merged === "refused") return;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.actions).toEqual(["tinycloud.kv/del", "tinycloud.kv/get"]);
    const scope = describeGrantScope(merged, "7d", OWNER_APPLICATIONS);
    expect(scope.text).toContain("delete files");
    expect(scope.extras).toHaveLength(1);
  });

  test("a space that differs only by case in its name is not the applications space", () => {
    const scope = describeGrantScope(prepare([{ service: "tinycloud.kv", space: "Applications", path: "", actions: ["get"] }]) as PermissionEntry[], "7d", OWNER_APPLICATIONS);
    expect(scope.text).toContain(`space \`${spaceId("Applications")}\``);
    expect(scope.text).not.toContain("your `applications` space");
  });
});

import { existsSync } from "node:fs";
import { join } from "node:path";
// The build bundles the file (esbuild) and bun reads it as is; tsc's `module: Node16` does not accept import attributes.
// @ts-expect-error TS2823
import table from "./clients.json" with { type: "json" };

/**
 * Where each agent client reads skills from (user scope), for `skill save`. The table is data, in clients.json: the
 * same file, byte for byte, as the one in prompts that install.js and its README carry (clients-table.test.ts pins its hash,
 * so a change is a deliberate edit of both).
 * "shared" is the `.agents/skills` convention; every client except Claude Code gets that copy, and Amp, Hermes,
 * OpenClaw and Claude Code also read a folder of their own.
 */
export interface SkillContext {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

interface FolderEntry {
  user: string;
  project: string | null;
}

interface ClientEntry {
  label: string;
  folders: readonly string[];
  /** The folder whose presence means the client is installed, for choosing clients when none is named. */
  present: string | null;
}

interface ClientTable {
  folders: Readonly<Record<string, FolderEntry>>;
  clients: Readonly<Record<string, ClientEntry>>;
}

const TABLE: ClientTable = table;
const CLIENTS = TABLE.clients;

/** `~/…` is the home folder; `{ENV|fallback}` is the trimmed environment variable when it is not empty, else the fallback. */
function expand(path: string, context: SkillContext): string {
  const withEnv = path.replace(/\{(\w+)\|([^}]*)\}/g, (_, name: string, fallback: string) => context.env[name]?.trim() || fallback);
  return withEnv.startsWith("~/") ? join(context.home, withEnv.slice(2)) : withEnv;
}

/** The clients the error line names; `agents` is accepted too but is not an agent a reader would name. */
export const CLIENT_NAMES: readonly string[] = Object.keys(CLIENTS).filter((name) => name !== "agents");

/**
 * The skills folders for the named clients (comma-separated), or for every client found on this computer when
 * `agent` is empty or "auto". `undefined` when a name is unknown or no client is found: the caller cannot tell which
 * agent this is.
 */
export function skillRoots(agent: string | undefined, context: SkillContext): string[] | undefined {
  const asked = (agent ?? "auto").split(",").map((name) => name.trim()).filter(Boolean);
  if (asked.length === 0) return undefined;
  let names: string[];
  if (asked.length === 1 && asked[0] === "auto") {
    names = Object.keys(CLIENTS).filter((name) => {
      const present = CLIENTS[name]!.present;
      return present !== null && existsSync(expand(present, context));
    });
  } else {
    if (asked.some((name) => !Object.hasOwn(CLIENTS, name))) return undefined;
    names = asked;
  }
  if (names.length === 0) return undefined;
  const roots: string[] = [];
  for (const name of names) {
    for (const folder of CLIENTS[name]!.folders) {
      const root = expand(TABLE.folders[folder]!.user, context);
      if (!roots.includes(root)) roots.push(root);
    }
  }
  return roots;
}

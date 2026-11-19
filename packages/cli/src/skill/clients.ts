import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where each agent client reads skills from (user scope), for `skill save`. The same table prompts' install.js
 * carries for the skills it fetches from the web; the vendor pages it was read from are listed in that repo's README.
 * "shared" is the `.agents/skills` convention; every client except Claude Code gets that copy, and Amp, Hermes,
 * OpenClaw and Claude Code also read a folder of their own.
 */
export interface SkillContext {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

const claudeDir = (context: SkillContext): string => context.env.CLAUDE_CONFIG_DIR?.trim() || join(context.home, ".claude");
const openclawDir = (context: SkillContext): string => context.env.OPENCLAW_STATE_DIR?.trim() || join(context.home, ".openclaw");

const FOLDERS = {
  shared: (context: SkillContext) => join(context.home, ".agents", "skills"),
  claude: (context: SkillContext) => join(claudeDir(context), "skills"),
  hermes: (context: SkillContext) => join(context.home, ".hermes", "skills"),
  amp: (context: SkillContext) => join(context.home, ".config", "agents", "skills"),
  openclaw: (context: SkillContext) => join(openclawDir(context), "skills"),
} satisfies Record<string, (context: SkillContext) => string>;

interface Client {
  folders: readonly (keyof typeof FOLDERS)[];
  /** The folder whose presence means the client is installed, for choosing clients when none is named. */
  present: ((context: SkillContext) => string) | null;
}

const CLIENTS: Readonly<Record<string, Client>> = {
  amp: { folders: ["shared", "amp"], present: (context) => join(context.home, ".config", "amp") },
  "claude-code": { folders: ["claude"], present: claudeDir },
  codex: { folders: ["shared"], present: (context) => join(context.home, ".codex") },
  copilot: { folders: ["shared"], present: (context) => join(context.home, ".copilot") },
  cursor: { folders: ["shared"], present: (context) => join(context.home, ".cursor") },
  gemini: { folders: ["shared"], present: (context) => join(context.home, ".gemini") },
  hermes: { folders: ["shared", "hermes"], present: (context) => join(context.home, ".hermes") },
  omp: { folders: ["shared"], present: (context) => join(context.home, ".omp") },
  openclaw: { folders: ["shared", "openclaw"], present: openclawDir },
  opencode: { folders: ["shared"], present: (context) => join(context.home, ".config", "opencode") },
  // Any other client that reads `.agents/skills`.
  agents: { folders: ["shared"], present: null },
};

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
      return present !== null && existsSync(present(context));
    });
  } else {
    if (asked.some((name) => !Object.hasOwn(CLIENTS, name))) return undefined;
    names = asked;
  }
  if (names.length === 0) return undefined;
  const roots: string[] = [];
  for (const name of names) {
    for (const folder of CLIENTS[name]!.folders) {
      const root = FOLDERS[folder](context);
      if (!roots.includes(root)) roots.push(root);
    }
  }
  return roots;
}

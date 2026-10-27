import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { readBundledSkill, replaceFolder, SkillInstallError } from "./skill-install.js";

/**
 * `tinycloud setup apps`: the /apps guide's install steps (folders, the CLI
 * in its private folder, the tc-apps skill, the helper script) as one
 * command. The skill comes from this package, checked against its bundled
 * SHA256SUMS; the CLI installed is exactly this package's version.
 */

export const TC_APPS_SKILL = "tc-apps";
export type SetupAgent = "claude-code" | "codex" | "opencode" | "none";
export const SETUP_AGENT_CHOICES = ["claude-code", "codex", "opencode", "auto", "none"] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PRIVATE_DIR = 0o700;

function usage(message: string): CLIError {
  return new CLIError("INVALID_ARGUMENT", message, ExitCode.USAGE_ERROR);
}

/**
 * The client whose skills folder gets the skill. `auto` reads the variables
 * the clients set in their shells; anything else is refused rather than
 * guessed, because a skill in the wrong folder is silently never found.
 */
export function resolveSetupAgent(input: string, env: NodeJS.ProcessEnv): SetupAgent {
  switch (input) {
    case "claude-code":
    case "codex":
    case "opencode":
    case "none":
      return input;
    case "auto": {
      if (env.CLAUDECODE === "1") return "claude-code";
      const names = Object.keys(env);
      if (names.some((name) => name === "OPENCODE" || name.startsWith("OPENCODE_"))) return "opencode";
      if (names.some((name) => name.startsWith("CODEX_"))) return "codex";
      throw new CLIError("AGENT_NOT_DETECTED", "Could not tell which agent runs this. Pass --agent claude-code, codex or opencode.", ExitCode.USAGE_ERROR);
    }
    default:
      throw usage(`Unknown --agent "${input.slice(0, 40)}". Use ${SETUP_AGENT_CHOICES.join(", ")}.`);
  }
}

/** A non-empty environment value, as the guide's `${NAME:-default}` reads it. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export interface SetupPaths {
  /** `${TC_HOME:-$HOME}/.tinycloud`: the CLI's profile store. */
  readonly tinycloudHome: string;
  /** `~/.local/share/tc-apps`: everything this setup installs except the agent's skill copy. */
  readonly share: string;
  readonly cliPrefix: string;
  readonly cliBin: string;
  readonly cliPackage: string;
  /** The skill's private copy (the guide's download folder), with SHA256SUMS. */
  readonly privateSkill: string;
  /** `cli-path` names the CLI the helper runs. */
  readonly cliPathFile: string;
  /** The helper script, a copy of the skill's tc-wrapper.sh. */
  readonly helper: string;
  /** `${TC_APPS_STATE:-~/.local/state/tc-apps}`. */
  readonly state: string;
  /** The agent's skills folder, or null for `none`. */
  readonly skillsRoot: string | null;
}

export function setupPaths(env: NodeJS.ProcessEnv, agent: SetupAgent): SetupPaths {
  const home = envValue(env, "HOME") ?? homedir();
  const share = join(home, ".local", "share", "tc-apps");
  const cliPrefix = join(share, "cli");
  const skillsRoot = agent === "claude-code"
    ? join(envValue(env, "CLAUDE_CONFIG_DIR") ?? join(home, ".claude"), "skills")
    : agent === "none" ? null : join(home, ".agents", "skills");
  return {
    tinycloudHome: join(envValue(env, "TC_HOME") ?? home, ".tinycloud"),
    share,
    cliPrefix,
    cliBin: join(cliPrefix, "node_modules", ".bin", "tinycloud"),
    cliPackage: join(cliPrefix, "node_modules", "@tinycloud", "cli"),
    privateSkill: join(share, "skill"),
    cliPathFile: join(share, "cli-path"),
    helper: join(share, "tinycloud"),
    state: envValue(env, "TC_APPS_STATE") ?? join(home, ".local", "state", "tc-apps"),
    skillsRoot,
  };
}

export interface SetupDependencies {
  readonly env: NodeJS.ProcessEnv;
  /** This package's version: the only version ever installed. */
  readonly ownVersion: string;
  /** This package's `skills/tc-apps`. */
  readonly bundleDir: string;
  /** This package's root, to tell whether it already is the private copy. */
  readonly packageRoot: string;
  /** Runs `npm` with these arguments; throws on failure. */
  readonly runNpm: (args: readonly string[]) => Promise<void>;
}

export interface SetupResult {
  readonly agent: SetupAgent;
  readonly cli: {
    readonly path: string;
    /** null when the owner's TC_BIN is used: this setup doesn't run it. */
    readonly version: string | null;
    readonly installed: boolean;
    readonly source: "private" | "TC_BIN";
  };
  readonly skill: {
    readonly name: string;
    readonly version: string;
    readonly files: number;
    /** Where the agent's client finds it; null when it wasn't copied there. */
    readonly folder: string | null;
    /** The private copy: read SKILL.md here when `folder` is null. */
    readonly privateCopy: string;
    readonly folderError?: string;
    /** For the owner's own terminal: puts the skill in the client's folder later. */
    readonly later?: string;
  };
  readonly helper: string;
  readonly state: string;
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR });
  await chmod(path, PRIVATE_DIR);
}

async function installedVersion(cliPackage: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(cliPackage, "package.json"), "utf8")) as { name?: string; version?: string };
    return manifest.name === "@tinycloud/cli" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/** Write a file by renaming a sibling temp file into place. */
async function writeAtomic(path: string, body: string | Buffer, mode: number): Promise<void> {
  const temp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temp, body, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function skillError(error: unknown): CLIError {
  if (error instanceof SkillInstallError) return new CLIError(error.code, error.message, ExitCode.ERROR);
  return error instanceof CLIError ? error : new CLIError("SKILL_INSTALL_FAILED", error instanceof Error ? error.message : String(error), ExitCode.ERROR);
}

export async function setupApps(agent: SetupAgent, deps: SetupDependencies): Promise<SetupResult> {
  if (!EXACT_VERSION.test(deps.ownVersion)) {
    throw new CLIError("CLI_INSTALL_FAILED", `This CLI's version "${deps.ownVersion}" is not an exact version; refusing to install.`, ExitCode.ERROR);
  }
  const paths = setupPaths(deps.env, agent);

  // Check the bundled skill before anything is written.
  const skill = await readBundledSkill(deps.bundleDir, TC_APPS_SKILL).catch((error: unknown) => {
    throw skillError(error);
  });
  const wrapper = skill.files.get("tc-wrapper.sh");
  if (wrapper === undefined) throw new CLIError("SKILL_INTEGRITY_FAILED", "The bundled tc-apps skill has no tc-wrapper.sh.", ExitCode.ERROR);

  // Step 1 of the guide: the profile store, the skill's state folder, and this setup's folder.
  await privateDir(paths.tinycloudHome);
  await privateDir(join(paths.tinycloudHome, "profiles"));
  await privateDir(paths.state);
  await mkdir(paths.share, { recursive: true });

  // Step 2: the CLI, unless the owner chose one with TC_BIN.
  const ownerCli = envValue(deps.env, "TC_BIN");
  let cli: SetupResult["cli"];
  if (ownerCli !== undefined) {
    cli = { path: ownerCli, version: null, installed: false, source: "TC_BIN" };
  } else {
    const current = await installedVersion(paths.cliPackage);
    const runningHere = await samePath(deps.packageRoot, paths.cliPackage);
    let installed = false;
    if (!runningHere && current !== deps.ownVersion) {
      // Exactly this version, never a tag or a range.
      await deps.runNpm(["install", "--prefix", paths.cliPrefix, "--no-audit", "--no-fund", "--save-exact", `@tinycloud/cli@${deps.ownVersion}`]);
      installed = true;
    }
    const now = await installedVersion(paths.cliPackage);
    if (now !== deps.ownVersion) {
      throw new CLIError("CLI_INSTALL_FAILED", `${paths.cliPrefix} holds @tinycloud/cli ${now ?? "nothing"} after the install, not ${deps.ownVersion}.`, ExitCode.ERROR);
    }
    cli = { path: paths.cliBin, version: deps.ownVersion, installed, source: "private" };
  }

  // Steps 3 to 4: the skill's private copy, with its checksum list, from this package.
  let privateCopy: string;
  try {
    privateCopy = await replaceFolder(paths.share, "skill", new Map([...skill.files, ["SHA256SUMS", skill.sums]]), { dirMode: PRIVATE_DIR });
  } catch (error) {
    throw skillError(error);
  }

  // Step 6: the helper script and the CLI it runs.
  await writeAtomic(paths.cliPathFile, `${cli.path}\n`, 0o644);
  await writeAtomic(paths.helper, wrapper, 0o755);

  // Step 5, last: the copy in the client's skills folder. A client can refuse writes there (it is
  // the client's own configuration); setup still succeeds, and the skill is read from the private copy.
  let folder: string | null = null;
  let folderError: string | undefined;
  if (paths.skillsRoot !== null) {
    try {
      folder = await replaceFolder(paths.skillsRoot, TC_APPS_SKILL, skill.files);
    } catch (error) {
      folderError = error instanceof Error ? error.message : String(error);
    }
  }
  const laterAgent = agent === "none" ? "<claude-code|codex|opencode>" : agent;
  return {
    agent,
    cli,
    skill: {
      name: skill.name,
      version: skill.version,
      files: skill.files.size,
      folder,
      privateCopy,
      ...(folderError === undefined ? {} : { folderError }),
      ...(folder === null ? {
        later: cli.source === "private"
          ? `"${paths.cliBin}" setup apps --agent ${laterAgent}`
          : `npx -y @tinycloud/cli@${deps.ownVersion} setup apps --agent ${laterAgent}`,
      } : {}),
    },
    helper: paths.helper,
    state: paths.state,
  };
}

/** npm's own prefix settings from an `npx` parent must not override `--prefix`. */
function npmEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^npm_config_(prefix|local_prefix|global_prefix|global)$/i.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

/** Run `npm` (no shell) and fail with the end of its output. */
export function runNpm(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", [...args], { stdio: ["ignore", "pipe", "pipe"], env: npmEnvironment(env) });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-8_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      reject((error as NodeJS.ErrnoException).code === "ENOENT"
        ? new CLIError("NPM_NOT_FOUND", "npm was not found. TinyCloud setup needs Node.js 22.20 or later, with npm.", ExitCode.ERROR)
        : new CLIError("CLI_INSTALL_FAILED", `Could not run npm: ${error.message}`, ExitCode.ERROR));
    });
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const tail = output.trim().split("\n").slice(-8).join("\n");
      reject(new CLIError("CLI_INSTALL_FAILED", `npm ${args.join(" ")} failed (exit ${code ?? "signal"}).${tail ? `\n${tail}` : ""}`, ExitCode.ERROR));
    });
  });
}

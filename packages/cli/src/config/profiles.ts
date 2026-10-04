import { chmod, lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  profilePath,
  readSession,
  recordProfileDeletion,
  refuseWriteToDeletedProfile,
  removeSession,
  withProfileLock,
  writeSession,
  type ProfileLockOptions,
} from "@tinycloud/operations/state";
import {
  CONFIG_DIR,
  PROFILES_DIR,
  CONFIG_FILE,
  DEFAULT_PROFILE,
  DEFAULT_HOST,
  ExitCode,
} from "./constants.js";
import {
  readJson,
  writeJson,
  fileExists,
  ensureDir,
  listDirs,
  PRIVATE_DIR_MODE,
} from "./storage.js";
import type { GlobalConfig, ProfileConfig, CLIContext } from "./types.js";
import { CLIError, setActiveProfileName } from "../output/errors.js";

export class ProfileManager {
  // ── Initialization ──────────────────────────────────────────────────

  /**
   * Runs `action` holding the profile's store lock (shared with operations
   * and MCP). Reentrant, so the writers below can be called inside it; hold
   * it around a whole read-modify-write, not just each write.
   */
  static async withLock<T>(name: string, action: () => Promise<T>, options?: ProfileLockOptions): Promise<T> {
    return withProfileLock(name, action, options);
  }

  /**
   * Read-modify-write of profile.json under the profile lock, so concurrent
   * updates (another command, a login commit) are never erased.
   */
  static async updateProfile(name: string, update: (profile: ProfileConfig) => ProfileConfig): Promise<ProfileConfig> {
    return ProfileManager.withLock(name, async () => {
      const next = update(await ProfileManager.getProfile(name));
      await ProfileManager.setProfile(name, next);
      return next;
    });
  }

  /**
   * Creates ~/.tinycloud/ and ~/.tinycloud/profiles/ if they don't exist and
   * (re)sets both to 0700: older releases created them 0775.
   */
  static async ensureConfigDir(): Promise<void> {
    for (const directory of [CONFIG_DIR, PROFILES_DIR]) {
      await ensureDir(directory);
      await chmod(directory, PRIVATE_DIR_MODE);
    }
  }

  /** Owner-only profile directory (0700), created or tightened before any write into it. */
  static async ensureProfileDir(name: string): Promise<string> {
    await ProfileManager.ensureConfigDir();
    const profileDir = join(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await chmod(profileDir, PRIVATE_DIR_MODE);
    return profileDir;
  }

  // ── Global config ───────────────────────────────────────────────────

  /**
   * Reads config.json. Returns a default config if the file is missing.
   */
  static async getConfig(): Promise<GlobalConfig> {
    const config = await readJson<GlobalConfig>(CONFIG_FILE);
    if (!config) {
      return { defaultProfile: DEFAULT_PROFILE, version: 1 };
    }
    return config;
  }

  /**
   * Writes the global config to config.json.
   */
  static async setConfig(config: GlobalConfig): Promise<void> {
    await ProfileManager.ensureConfigDir();
    await writeJson(CONFIG_FILE, config);
  }

  // ── Profile CRUD ────────────────────────────────────────────────────

  /**
   * Returns the profile config for the given name.
   * Throws CLIError if the profile doesn't exist.
   */
  static async getProfile(name: string): Promise<ProfileConfig> {
    const profilePath = join(PROFILES_DIR, name, "profile.json");
    const profile = await readJson<ProfileConfig>(profilePath);
    if (!profile) {
      throw new CLIError(
        "PROFILE_NOT_FOUND",
        `Profile "${name}" does not exist. Run \`tc init\` or \`tc profile create ${name}\` first.`,
      );
    }
    return profile;
  }

  /**
   * Saves a profile config under the profile lock, creating the profile
   * directory if needed. Use `updateProfile` to change an existing profile.
   */
  static async setProfile(name: string, data: ProfileConfig): Promise<void> {
    await ProfileManager.withLock(name, async () => {
      await writeJson(join(await ProfileManager.ensureProfileDir(name), "profile.json"), data);
    });
  }

  /** Removes profile.json under the profile lock (rollback of a profile a failed login created). */
  static async removeProfileConfig(name: string): Promise<void> {
    await ProfileManager.withLock(name, () => rm(join(PROFILES_DIR, name, "profile.json"), { force: true }));
  }

  /**
   * Returns true if a profile directory exists.
   */
  static async profileExists(name: string): Promise<boolean> {
    return fileExists(join(PROFILES_DIR, name, "profile.json"));
  }

  /**
   * Returns an array of profile directory names.
   */
  static async listProfiles(): Promise<string[]> {
    return listDirs(PROFILES_DIR);
  }

  /**
   * Deletes a profile. Its key, session, settings, stores and cache are
   * removed while holding the profile lock, so another writer's critical
   * section never sees them vanish midway: session and key first, settings
   * last, so a crash midway never leaves a session or key without its
   * profile. The deletion is then recorded, so a store write that waited for
   * the lock meanwhile refuses rather than recreating a profile with only a
   * session in it. `.lock` itself is left to the lock's release; the
   * then-empty directory is removed afterwards unless another writer took
   * the lock (or wrote) meanwhile. A profile directory that is a symlink is
   * unlinked, its target left alone.
   * Throws if the name is not one path segment or names the default profile.
   */
  static async deleteProfile(name: string): Promise<void> {
    let profileDir: string;
    try {
      profileDir = profilePath(name);
    } catch {
      throw new CLIError(
        "INVALID_PROFILE_NAME",
        `Invalid profile name "${name}": a profile name is one path segment (no "/", "\\", "." or "..").`,
        ExitCode.USAGE_ERROR,
      );
    }
    const config = await ProfileManager.getConfig();
    if (config.defaultProfile === name) {
      throw new CLIError(
        "PROFILE_DELETE_DEFAULT",
        `Cannot delete the default profile "${name}". Change the default first with \`tc profile default <other>\`.`,
      );
    }
    const kind = await lstat(profileDir).then((stats) => stats.isSymbolicLink() ? "link" : "present", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "missing";
      throw error;
    });
    // Nothing to delete; taking the lock would create the profile's lock state.
    if (kind === "missing") return;
    if (kind === "link") {
      await rm(profileDir, { force: true });
      return;
    }
    await ProfileManager.withLock(name, async () => {
      for (const file of ["session.json", "key.json"]) await rm(join(profileDir, file), { force: true });
      for (const entry of await readdir(profileDir)) {
        if (entry !== ".lock" && entry !== "profile.json") await rm(join(profileDir, entry), { recursive: true, force: true });
      }
      await rm(join(profileDir, "profile.json"), { force: true });
      await recordProfileDeletion(name);
    });
    await rmdir(profileDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    });
  }

  // ── Key management ──────────────────────────────────────────────────

  /**
   * Returns the parsed JWK for a profile, or null if no key exists.
   */
  static async getKey(name: string): Promise<object | null> {
    return readJson<object>(join(PROFILES_DIR, name, "key.json"));
  }

  /**
   * Saves a JWK key under the profile lock (0600, in an owner-only profile
   * directory). Refused (PROFILE_NOT_FOUND) if the profile was deleted while
   * this waited for the lock, rather than leaving a key-only profile.
   */
  static async setKey(name: string, jwk: object): Promise<void> {
    await ProfileManager.withLock(name, async () => {
      await refuseWriteToDeletedProfile(name);
      await writeJson(join(await ProfileManager.ensureProfileDir(name), "key.json"), jwk);
    });
  }

  /** Removes key.json under the profile lock (rollback of a key a failed login created). */
  static async removeKey(name: string): Promise<void> {
    await ProfileManager.withLock(name, () => rm(join(PROFILES_DIR, name, "key.json"), { force: true }));
  }

  // ── Session management ──────────────────────────────────────────────

  /**
   * Returns the parsed session for a profile, or null if none exists.
   */
  static async getSession(name: string): Promise<object | null> {
    return readSession<object>(name);
  }

  /**
   * Saves session data for a profile.
   */
  static async setSession(name: string, session: object): Promise<void> {
    await writeSession(name, session);
  }

  /**
   * Removes the session file for a profile.
   */
  static async clearSession(name: string): Promise<void> {
    await removeSession(name);
  }

  // ── Cache management ────────────────────────────────────────────────

  /**
   * Returns the profile's cache directory (share history lives here),
   * created or tightened to 0700.
   */
  static async getCacheDir(name: string): Promise<string> {
    const cacheDir = join(await ProfileManager.ensureProfileDir(name), "cache");
    await ensureDir(cacheDir);
    await chmod(cacheDir, PRIVATE_DIR_MODE);
    return cacheDir;
  }

  // ── Resolution helpers ──────────────────────────────────────────────

  /**
   * Resolves the full CLI context from flags, env vars, and config.
   *
   * Profile resolution: options.profile > TC_PROFILE env > config.defaultProfile > "default"
   * Host resolution:    options.host    > TC_HOST env    > discovered local node > profile.host > DEFAULT_HOST
   *
   * Local-node discovery (TC-106) only runs when no explicit host was given
   * (`--host` / `TC_HOST`); it probes configured or registered local nodes and,
   * after DID verification against the profile's pinned identity, prefers one
   * over the stored/default host. Loopback requires an explicit `localNodeUrl`.
   * Disable discovery per profile with
   * `autoDiscoverLocalNode: false` in profile.json.
   */
  static async resolveContext(options: {
    profile?: string;
    host?: string;
    verbose?: boolean;
    noCache?: boolean;
    quiet?: boolean;
  }): Promise<CLIContext> {
    // Resolve profile name
    const config = await ProfileManager.getConfig();
    const profile =
      options.profile ??
      process.env.TC_PROFILE ??
      config.defaultProfile ??
      DEFAULT_PROFILE;

    // Resolve host — try profile config if it exists, but don't fail if it doesn't
    let profileHost: string | undefined;
    try {
      const profileConfig = await ProfileManager.getProfile(profile);
      profileHost = profileConfig.host;
    } catch {
      // Profile may not exist yet (e.g., during `tc init`)
    }

    const explicitHost = options.host ?? process.env.TC_HOST;
    let host = explicitHost ?? profileHost ?? DEFAULT_HOST;
    if (explicitHost === undefined) {
      const { discoverLocalNodeHost } = await import("../lib/host.js");
      const localHost = await discoverLocalNodeHost(profile);
      if (localHost) {
        host = localHost;
      }
    }

    setActiveProfileName(profile);

    return {
      profile,
      host,
      verbose: options.verbose ?? false,
      noCache: options.noCache ?? false,
      quiet: options.quiet ?? false,
    };
  }
}

import { chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  readSession,
  removeSession,
  withProfileLock,
  writeSession,
} from "@tinycloud/operations/state";
import {
  CONFIG_DIR,
  PROFILES_DIR,
  CONFIG_FILE,
  DEFAULT_PROFILE,
  DEFAULT_HOST,
} from "./constants.js";
import {
  readJson,
  writeJson,
  fileExists,
  ensureDir,
  removeDir,
  listDirs,
  PRIVATE_DIR_MODE,
} from "./storage.js";
import type { GlobalConfig, ProfileConfig, CLIContext } from "./types.js";
import { CLIError, setActiveProfileName } from "../output/errors.js";

export class ProfileManager {
  // ── Initialization ──────────────────────────────────────────────────

  /**
   * Runs `action` holding the profile's store lock (shared with operations
   * and MCP). Reentrant, so store writes inside `action` do not deadlock.
   */
  static async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    return withProfileLock(name, action);
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
   * Saves a profile config, creating the profile directory if needed.
   */
  static async setProfile(name: string, data: ProfileConfig): Promise<void> {
    await writeJson(join(await ProfileManager.ensureProfileDir(name), "profile.json"), data);
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
   * Deletes a profile directory.
   * Throws if trying to delete the current default profile.
   */
  static async deleteProfile(name: string): Promise<void> {
    const config = await ProfileManager.getConfig();
    if (config.defaultProfile === name) {
      throw new CLIError(
        "PROFILE_DELETE_DEFAULT",
        `Cannot delete the default profile "${name}". Change the default first with \`tc profile default <other>\`.`,
      );
    }
    const profileDir = join(PROFILES_DIR, name);
    await removeDir(profileDir);
  }

  // ── Key management ──────────────────────────────────────────────────

  /**
   * Returns the parsed JWK for a profile, or null if no key exists.
   */
  static async getKey(name: string): Promise<object | null> {
    return readJson<object>(join(PROFILES_DIR, name, "key.json"));
  }

  /** Saves a JWK key for a profile (0600, in an owner-only profile directory). */
  static async setKey(name: string, jwk: object): Promise<void> {
    await writeJson(join(await ProfileManager.ensureProfileDir(name), "key.json"), jwk);
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

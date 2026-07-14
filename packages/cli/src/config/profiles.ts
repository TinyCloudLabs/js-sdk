import { join } from "node:path";
import {
  readSession,
  removeSession,
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
} from "./storage.js";
import type { GlobalConfig, ProfileConfig, CLIContext } from "./types.js";
import { CLIError, setActiveProfileName } from "../output/errors.js";

export class ProfileManager {
  // ── Initialization ──────────────────────────────────────────────────

  /**
   * Creates ~/.tinycloud/ and ~/.tinycloud/profiles/ if they don't exist.
   */
  static async ensureConfigDir(): Promise<void> {
    await ensureDir(CONFIG_DIR);
    await ensureDir(PROFILES_DIR);
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
    const profileDir = join(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join(profileDir, "profile.json"), data);
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

  /**
   * Saves a JWK key for a profile.
   */
  static async setKey(name: string, jwk: object): Promise<void> {
    const profileDir = join(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join(profileDir, "key.json"), jwk);
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
   * Returns the path to the profile's cache directory, creating it if needed.
   */
  static async getCacheDir(name: string): Promise<string> {
    const cacheDir = join(PROFILES_DIR, name, "cache");
    await ensureDir(cacheDir);
    return cacheDir;
  }

  // ── Resolution helpers ──────────────────────────────────────────────

  /**
   * Resolves the full CLI context from flags, env vars, and config.
   *
   * Profile resolution: options.profile > TC_PROFILE env > config.defaultProfile > "default"
   * Host resolution:    options.host    > TC_HOST env    > profile.host          > DEFAULT_HOST
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

    const host =
      options.host ??
      process.env.TC_HOST ??
      profileHost ??
      DEFAULT_HOST;

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

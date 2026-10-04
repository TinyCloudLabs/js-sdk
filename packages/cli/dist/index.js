var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/config/constants.ts
import {
  profilesPath,
  tinycloudConfigPath,
  tinycloudHomePath
} from "@tinycloud/operations/state";
var CONFIG_DIR, PROFILES_DIR, CONFIG_FILE, DEFAULT_HOST, DEFAULT_PROFILE, PROFILE_COMMIT_LOCK_TIMEOUT_MS, ExitCode;
var init_constants = __esm({
  "src/config/constants.ts"() {
    "use strict";
    CONFIG_DIR = tinycloudHomePath();
    PROFILES_DIR = profilesPath();
    CONFIG_FILE = tinycloudConfigPath();
    DEFAULT_HOST = "https://tee.node.tinycloud.xyz";
    DEFAULT_PROFILE = "default";
    PROFILE_COMMIT_LOCK_TIMEOUT_MS = 45e3;
    ExitCode = {
      SUCCESS: 0,
      ERROR: 1,
      USAGE_ERROR: 2,
      AUTH_REQUIRED: 3,
      NOT_FOUND: 4,
      PERMISSION_DENIED: 5,
      NETWORK_ERROR: 6,
      NODE_ERROR: 7
    };
  }
});

// src/output/theme.ts
import chalk from "chalk";
var TC_PALETTE, theme;
var init_theme = __esm({
  "src/output/theme.ts"() {
    "use strict";
    TC_PALETTE = {
      primary: "#4473b9",
      accent: "#5b9bd5",
      success: "#2fba6a",
      warn: "#e8a838",
      error: "#d94040",
      muted: "#808080",
      dim: "#5a5a5a"
    };
    theme = {
      primary: chalk.hex(TC_PALETTE.primary),
      accent: chalk.hex(TC_PALETTE.accent),
      success: chalk.hex(TC_PALETTE.success),
      warn: chalk.hex(TC_PALETTE.warn),
      error: chalk.hex(TC_PALETTE.error),
      muted: chalk.hex(TC_PALETTE.muted),
      dim: chalk.hex(TC_PALETTE.dim),
      heading: chalk.bold.hex(TC_PALETTE.primary),
      command: chalk.hex(TC_PALETTE.accent),
      brand: chalk.bold.hex(TC_PALETTE.primary),
      label: chalk.bold,
      value: chalk.white,
      hint: chalk.italic.hex(TC_PALETTE.muted)
    };
  }
});

// src/output/formatter.ts
import ora from "ora";
function outputError(code3, message, hint, meta) {
  if (isInteractive()) {
    process.stderr.write(
      `${theme.error("\u2717")} ${theme.label(code3)}: ${message}
`
    );
    if (hint) {
      for (const line of hint.split("\n")) {
        process.stderr.write(`  ${theme.hint(line)}
`);
      }
    }
  } else {
    const payload = {
      error: { code: code3, message }
    };
    if (hint) payload.error.hint = hint;
    if (meta) payload.error.meta = meta;
    process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
  }
}
function isInteractive() {
  return Boolean(process.stdout.isTTY);
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
var init_formatter = __esm({
  "src/output/formatter.ts"() {
    "use strict";
    init_theme();
  }
});

// src/output/errors.ts
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { ProfileDeletedError, ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { authorizationVerdictOf, parseCapabilityResource, SERVICE_LONG_TO_SHORT, validatedCapabilityOf } from "@tinycloud/sdk-core";
function setActiveProfileName(name) {
  activeProfileName = name;
}
function wrapError(error) {
  if (error instanceof CLIError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const verdict = authorizationVerdictOf(error);
  if (verdict === "unauthenticated") {
    return new CLIError("AUTH_REQUIRED", message, ExitCode.AUTH_REQUIRED);
  }
  if (verdict === "forbidden") {
    return new CLIError("PERMISSION_DENIED", message, ExitCode.PERMISSION_DENIED);
  }
  if (verdict === void 0 && message.includes("Missing private key parameter in JWK")) {
    return missingPrivateKeyError();
  }
  if (error instanceof ProfileLockTimeoutError) {
    return new CLIError(
      "PROFILE_LOCK_TIMEOUT",
      `${message} Another tc or MCP process held this profile's lock, so the change that needed it was not written.`,
      ExitCode.ERROR,
      { hint: "Wait for the other command to finish and retry. A crashed process's lock is reclaimed automatically after 30 s." }
    );
  }
  if (error instanceof ProfileDeletedError) {
    return new CLIError("PROFILE_NOT_FOUND", message);
  }
  if (verdict === void 0 && (message.includes("Not signed in") || message.includes("AUTH_EXPIRED") || message.includes("Session expired"))) {
    return new CLIError("AUTH_REQUIRED", message, ExitCode.AUTH_REQUIRED);
  }
  if (message.includes("NOT_FOUND") || message.includes("KV_NOT_FOUND")) {
    return new CLIError("NOT_FOUND", message, ExitCode.NOT_FOUND);
  }
  if (verdict === void 0 && message.includes("PERMISSION_DENIED")) {
    return new CLIError("PERMISSION_DENIED", message, ExitCode.PERMISSION_DENIED);
  }
  if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("fetch failed")) {
    return new CLIError("NETWORK_ERROR", message, ExitCode.NETWORK_ERROR);
  }
  return new CLIError("ERROR", message, ExitCode.ERROR);
}
function missingPrivateKeyError() {
  const profileName = activeProfileName ?? process.env.TC_PROFILE ?? DEFAULT_PROFILE;
  return new CLIError(
    "AUTH_REQUIRED",
    `Profile "${profileName}" cannot restore its session because its private key material is missing.`,
    ExitCode.AUTH_REQUIRED,
    { hint: `Sign in again with: tc --profile ${profileName} auth login --method openkey` }
  );
}
function handleError(error) {
  const cliError = wrapError(error);
  const prebuilt = typeof cliError.metadata?.hint === "string" ? cliError.metadata.hint : void 0;
  const hint = prebuilt ?? buildAuthHint(cliError) ?? (cliError.code === "NETWORK_ERROR" ? buildNetworkHint() : void 0);
  const authMeta = cliError.code === "AUTH_REQUIRED" || cliError.code === "PERMISSION_DENIED" ? cliError.metadata : void 0;
  const meta = {};
  if (cliError.status !== void 0 && authMeta !== void 0) meta.status = cliError.status;
  const capability = validatedCapabilityOf({ meta: authMeta });
  if (capability) {
    meta.resource = capability.resource;
    meta.requiredAction = capability.requiredAction;
  }
  outputError(cliError.code, cliError.message, hint, Object.keys(meta).length ? meta : void 0);
  process.exit(cliError.exitCode);
}
function buildAuthHint(error) {
  const capability = validatedCapabilityOf({ meta: error.metadata });
  if (!capability) return void 0;
  const spec = capSpecFromAuthMeta(capability.resource, capability.requiredAction);
  if (!spec) return void 0;
  return [
    "The active session is missing a TinyCloud capability.",
    `Request it with: tc auth request --cap '${spec.replaceAll("'", "'\\''")}'`,
    "Then retry the original command."
  ].join("\n");
}
function capSpecFromAuthMeta(resource, action) {
  const slash = action.indexOf("/");
  if (slash < 0) return void 0;
  const longService = action.slice(0, slash);
  const serviceShort = SERVICE_LONG_TO_SHORT[longService];
  if (!serviceShort) return void 0;
  const parsed = parseCapabilityResource(resource, serviceShort);
  if (!parsed) return void 0;
  const spaceName = parsed.space.slice(parsed.space.lastIndexOf(":") + 1);
  return `${longService}:${spaceName}:${parsed.path}:${action.slice(slash + 1)}`;
}
function buildNetworkHint() {
  const readHost = (name) => {
    try {
      const raw = readFileSync(join(PROFILES_DIR, name, "profile.json"), "utf8");
      return JSON.parse(raw).host;
    } catch {
      return void 0;
    }
  };
  let activeName = activeProfileName ?? process.env.TC_PROFILE ?? DEFAULT_PROFILE;
  if (!activeProfileName) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      activeName = process.env.TC_PROFILE ?? cfg.defaultProfile ?? DEFAULT_PROFILE;
    } catch {
    }
  }
  let names;
  try {
    names = readdirSync(PROFILES_DIR);
  } catch {
    return void 0;
  }
  const activeHost = readHost(activeName);
  const others = names.filter((n) => n !== activeName).map((n) => ({ name: n, host: readHost(n) })).filter((p) => Boolean(p.host));
  const lines = [];
  lines.push(activeHost ? `Active profile "${activeName}" \u2192 ${activeHost}` : `Active profile "${activeName}"`);
  if (others.length === 0) {
    lines.push(`No other profiles configured. Run \`tc profile create <name>\` or \`tc init\`.`);
  } else {
    lines.push(`Switch to a reachable profile:`);
    const longest = Math.max(...others.map((p) => p.name.length));
    for (const { name, host } of others) {
      lines.push(`  tc profile switch ${name.padEnd(longest)}   # ${host}`);
    }
  }
  lines.push(`Or override per-command with --host or TC_HOST.`);
  return lines.join("\n");
}
var activeProfileName, CLIError;
var init_errors = __esm({
  "src/output/errors.ts"() {
    "use strict";
    init_constants();
    init_formatter();
    CLIError = class extends Error {
      constructor(code3, message, exitCode = ExitCode.ERROR, metadata) {
        super(message);
        this.code = code3;
        this.exitCode = exitCode;
        this.metadata = metadata;
        this.name = "CLIError";
        if (typeof metadata?.status === "number" && Number.isInteger(metadata.status) && metadata.status >= 400 && metadata.status <= 599) this.status = metadata.status;
      }
      status;
    };
  }
});

// src/config/storage.ts
import { randomUUID } from "crypto";
import { readFile, writeFile, stat, mkdir, rm, readdir, rename } from "fs/promises";
import { basename, dirname, join as join2 } from "path";
async function readJson(filePath) {
  try {
    const data = await readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
async function writeJson(filePath, data) {
  const directory = dirname(filePath);
  const tempPath = join2(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => void 0);
    throw err;
  }
}
async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
}
async function listDirs(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
var PRIVATE_FILE_MODE, PRIVATE_DIR_MODE;
var init_storage = __esm({
  "src/config/storage.ts"() {
    "use strict";
    PRIVATE_FILE_MODE = 384;
    PRIVATE_DIR_MODE = 448;
  }
});

// src/config/types.ts
function isCLIProfilePosture(value) {
  return typeof value === "string" && CLI_PROFILE_POSTURES.includes(value);
}
function resolveProfilePosture(profile) {
  if (isCLIProfilePosture(profile.posture)) return profile.posture;
  if (profile.authMethod === "local") return "local-owner-key";
  return "owner-openkey";
}
var CLI_PROFILE_POSTURES;
var init_types = __esm({
  "src/config/types.ts"() {
    "use strict";
    CLI_PROFILE_POSTURES = [
      "owner-openkey",
      "delegate-session",
      "local-owner-key"
    ];
  }
});

// src/lib/space.ts
function canonicalizeAddress(address) {
  const trimmed = address.trim();
  return trimmed.startsWith("0x") ? `0x${trimmed.slice(2).toLowerCase()}` : trimmed.toLowerCase();
}
function parsePkhDid(did) {
  const match = did.match(/^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
  if (!match) return null;
  return {
    chainId: Number(match[1]),
    address: canonicalizeAddress(match[2])
  };
}
function makePkhSpaceId(address, chainId, name) {
  return `tinycloud:pkh:eip155:${chainId}:${canonicalizeAddress(address)}:${name}`;
}
function parseSpaceUri(input) {
  if (!input.startsWith("tinycloud:")) return null;
  const parts = input.split(":");
  if (parts.length < 3) return null;
  const name = parts.at(-1);
  if (!name) return null;
  return {
    owner: parts.slice(1, -1).join(":"),
    name
  };
}
function buildSpaceUri(owner, name) {
  return `tinycloud:${owner}:${name}`;
}
function resolveAddress(profile, session) {
  const sessAddr = session?.address;
  if (typeof sessAddr === "string" && sessAddr.length > 0) {
    return canonicalizeAddress(sessAddr);
  }
  if (profile.address) return canonicalizeAddress(profile.address);
  if (profile.ownerDid) {
    const pkh = parsePkhDid(profile.ownerDid);
    if (pkh) return pkh.address;
  }
  throw new CLIError(
    "ADDRESS_UNKNOWN",
    `Cannot determine Ethereum address for profile "${profile.name}". Run \`tc auth login\` to refresh the session.`,
    ExitCode.AUTH_REQUIRED
  );
}
function resolveChainId(profile, session) {
  const sessChain = session?.chainId;
  if (typeof sessChain === "number" && Number.isFinite(sessChain)) return sessChain;
  return profile.chainId;
}
async function resolveSpaceUri(input, profileName, options = {}) {
  const profile = await ProfileManager.getProfile(profileName);
  const useProfileDefault = options.useProfileDefault ?? true;
  const effective = input || (useProfileDefault ? profile.defaultSpace : void 0);
  if (!effective) return void 0;
  if (effective.startsWith("tinycloud:")) {
    const parsed = parseSpaceUri(effective);
    if (!parsed) {
      throw new CLIError(
        "INVALID_SPACE",
        `Invalid space "${effective}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
        ExitCode.USAGE_ERROR
      );
    }
    return buildSpaceUri(parsed.owner, parsed.name);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(effective)) {
    throw new CLIError(
      "INVALID_SPACE",
      `Invalid space "${effective}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
      ExitCode.USAGE_ERROR
    );
  }
  const session = await ProfileManager.getSession(profileName);
  const address = resolveAddress(profile, session);
  const chainId = resolveChainId(profile, session);
  return makePkhSpaceId(address, chainId, effective);
}
var init_space = __esm({
  "src/lib/space.ts"() {
    "use strict";
    init_errors();
    init_constants();
    init_profiles();
  }
});

// src/lib/host.ts
var host_exports = {};
__export(host_exports, {
  discoverLocalNodeHost: () => discoverLocalNodeHost,
  isRootAuthority: () => isRootAuthority,
  ownerDidFromSpaceUri: () => ownerDidFromSpaceUri,
  profileLocalNodeIdentityStore: () => profileLocalNodeIdentityStore,
  resolveHostSpace: () => resolveHostSpace,
  spaceNameFromUri: () => spaceNameFromUri,
  unhostedSpaceError: () => unhostedSpaceError
});
import {
  discoverLocalTinyCloudNode
} from "@tinycloud/sdk-core";
function profileLocalNodeIdentityStore(profileName) {
  return {
    get: async (url) => {
      const profile = await ProfileManager.getProfile(profileName).catch(
        () => null
      );
      return profile?.pinnedLocalNodeDids?.[url];
    },
    set: async (url, nodeDid) => {
      if (!await ProfileManager.profileExists(profileName)) return;
      await ProfileManager.updateProfile(profileName, (profile) => ({
        ...profile,
        pinnedLocalNodeDids: {
          ...profile.pinnedLocalNodeDids,
          [url]: nodeDid
        }
      }));
    }
  };
}
async function discoverLocalNodeHost(profileName) {
  const profile = await ProfileManager.getProfile(profileName).catch(
    () => null
  );
  if (profile?.autoDiscoverLocalNode === false) {
    return null;
  }
  const discovered = await discoverLocalTinyCloudNode({
    localNodeUrl: profile?.localNodeUrl,
    localLinkName: profile?.localLinkName,
    expectedNodeDid: profile?.expectedNodeDid,
    identityStore: profileLocalNodeIdentityStore(profileName)
  });
  return discovered?.url ?? null;
}
function canonicalizeAddress2(address) {
  const trimmed = address.trim();
  return trimmed.startsWith("0x") ? `0x${trimmed.slice(2).toLowerCase()}` : trimmed.toLowerCase();
}
async function resolveLocalAddress(profile, profileName) {
  const session = await ProfileManager.getSession(profileName);
  const sessAddr = session?.address;
  if (typeof sessAddr === "string" && sessAddr.length > 0) {
    return canonicalizeAddress2(sessAddr);
  }
  if (profile.address) return canonicalizeAddress2(profile.address);
  if (profile.ownerDid) {
    const match = profile.ownerDid.match(/^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})$/);
    if (match) return canonicalizeAddress2(match[1]);
  }
  return null;
}
function ownerAddressFromSpaceUri(spaceUri) {
  const match = spaceUri.match(/^tinycloud:pkh:eip155:\d+:(0x[a-fA-F0-9]{40}):/);
  return match ? canonicalizeAddress2(match[1]) : null;
}
function ownerDidFromSpaceUri(spaceUri) {
  const match = spaceUri.match(/^tinycloud:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40}):/);
  if (!match) return null;
  return `did:pkh:eip155:${match[1]}:${canonicalizeAddress2(match[2])}`;
}
async function isRootAuthority(spaceUri, profileName) {
  const profile = await ProfileManager.getProfile(profileName);
  if (resolveProfilePosture(profile) === "delegate-session") return false;
  const ownerAddr = ownerAddressFromSpaceUri(spaceUri);
  if (!ownerAddr) return false;
  const selfAddr = await resolveLocalAddress(profile, profileName);
  return selfAddr !== null && selfAddr === ownerAddr;
}
function spaceNameFromUri(spaceUri) {
  return spaceUri.slice(spaceUri.lastIndexOf(":") + 1);
}
async function unhostedSpaceError(error, spaceUri, profileName) {
  if (!spaceUri) return null;
  const status = error.meta?.status;
  const isUnhosted = status === 404 && /space not found/i.test(error.message);
  if (!isUnhosted) return null;
  const spaceName = spaceNameFromUri(spaceUri);
  const owner = await isRootAuthority(spaceUri, profileName);
  const hint = owner ? [
    "You are the owner. Host it once:",
    `  tc space host ${spaceName}`,
    "Then retry."
  ].join("\n") : [
    "You are a delegate and CANNOT host this space \u2014 only its owner can.",
    "Emit a host request:",
    `  tc space host-request ${spaceName} --emit ./host-request.json`,
    "Send it to the owner; they run `tc space host` and confirm. Then retry."
  ].join("\n");
  const message = owner ? `Space '${spaceName}' (${spaceUri}) is not hosted.` : `Space '${spaceName}' (owner ${ownerDidFromSpaceUri(spaceUri) ?? spaceUri}) is not hosted.`;
  return new CLIError("SPACE_NOT_HOSTED", message, ExitCode.ERROR, { hint });
}
async function resolveHostSpace(name, profileName) {
  const resolved = await resolveSpaceUri(name, profileName);
  if (!resolved) {
    throw new Error(`Could not resolve a space for "${name}".`);
  }
  return resolved;
}
var init_host = __esm({
  "src/lib/host.ts"() {
    "use strict";
    init_profiles();
    init_constants();
    init_types();
    init_errors();
    init_space();
  }
});

// src/config/profiles.ts
import { chmod, lstat, readdir as readdir2, rm as rm2, rmdir } from "fs/promises";
import { join as join3 } from "path";
import {
  profilePath,
  readSession,
  recordProfileDeletion,
  refuseWriteToDeletedProfile,
  removeSession,
  withProfileLock,
  writeSession
} from "@tinycloud/operations/state";
var ProfileManager;
var init_profiles = __esm({
  "src/config/profiles.ts"() {
    "use strict";
    init_constants();
    init_storage();
    init_errors();
    ProfileManager = class _ProfileManager {
      // ── Initialization ──────────────────────────────────────────────────
      /**
       * Runs `action` holding the profile's store lock (shared with operations
       * and MCP). Reentrant, so the writers below can be called inside it; hold
       * it around a whole read-modify-write, not just each write.
       */
      static async withLock(name, action, options) {
        return withProfileLock(name, action, options);
      }
      /**
       * Read-modify-write of profile.json under the profile lock, so concurrent
       * updates (another command, a login commit) are never erased.
       */
      static async updateProfile(name, update) {
        return _ProfileManager.withLock(name, async () => {
          const next = update(await _ProfileManager.getProfile(name));
          await _ProfileManager.setProfile(name, next);
          return next;
        });
      }
      /**
       * Creates ~/.tinycloud/ and ~/.tinycloud/profiles/ if they don't exist and
       * (re)sets both to 0700: older releases created them 0775.
       */
      static async ensureConfigDir() {
        for (const directory of [CONFIG_DIR, PROFILES_DIR]) {
          await ensureDir(directory);
          await chmod(directory, PRIVATE_DIR_MODE);
        }
      }
      /** Owner-only profile directory (0700), created or tightened before any write into it. */
      static async ensureProfileDir(name) {
        await _ProfileManager.ensureConfigDir();
        const profileDir = join3(PROFILES_DIR, name);
        await ensureDir(profileDir);
        await chmod(profileDir, PRIVATE_DIR_MODE);
        return profileDir;
      }
      // ── Global config ───────────────────────────────────────────────────
      /**
       * Reads config.json. Returns a default config if the file is missing.
       */
      static async getConfig() {
        const config = await readJson(CONFIG_FILE);
        if (!config) {
          return { defaultProfile: DEFAULT_PROFILE, version: 1 };
        }
        return config;
      }
      /**
       * Writes the global config to config.json.
       */
      static async setConfig(config) {
        await _ProfileManager.ensureConfigDir();
        await writeJson(CONFIG_FILE, config);
      }
      // ── Profile CRUD ────────────────────────────────────────────────────
      /**
       * Returns the profile config for the given name.
       * Throws CLIError if the profile doesn't exist.
       */
      static async getProfile(name) {
        const profilePath2 = join3(PROFILES_DIR, name, "profile.json");
        const profile = await readJson(profilePath2);
        if (!profile) {
          throw new CLIError(
            "PROFILE_NOT_FOUND",
            `Profile "${name}" does not exist. Run \`tc init\` or \`tc profile create ${name}\` first.`
          );
        }
        return profile;
      }
      /**
       * Saves a profile config under the profile lock, creating the profile
       * directory if needed. Use `updateProfile` to change an existing profile.
       */
      static async setProfile(name, data) {
        await _ProfileManager.withLock(name, async () => {
          await writeJson(join3(await _ProfileManager.ensureProfileDir(name), "profile.json"), data);
        });
      }
      /** Removes profile.json under the profile lock (rollback of a profile a failed login created). */
      static async removeProfileConfig(name) {
        await _ProfileManager.withLock(name, () => rm2(join3(PROFILES_DIR, name, "profile.json"), { force: true }));
      }
      /**
       * Returns true if a profile directory exists.
       */
      static async profileExists(name) {
        return fileExists(join3(PROFILES_DIR, name, "profile.json"));
      }
      /**
       * Returns an array of profile directory names.
       */
      static async listProfiles() {
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
      static async deleteProfile(name) {
        let profileDir;
        try {
          profileDir = profilePath(name);
        } catch {
          throw new CLIError(
            "INVALID_PROFILE_NAME",
            `Invalid profile name "${name}": a profile name is one path segment (no "/", "\\", "." or "..").`,
            ExitCode.USAGE_ERROR
          );
        }
        const config = await _ProfileManager.getConfig();
        if (config.defaultProfile === name) {
          throw new CLIError(
            "PROFILE_DELETE_DEFAULT",
            `Cannot delete the default profile "${name}". Change the default first with \`tc profile default <other>\`.`
          );
        }
        const kind = await lstat(profileDir).then((stats) => stats.isSymbolicLink() ? "link" : "present", (error) => {
          if (error.code === "ENOENT") return "missing";
          throw error;
        });
        if (kind === "missing") return;
        if (kind === "link") {
          await rm2(profileDir, { force: true });
          return;
        }
        await _ProfileManager.withLock(name, async () => {
          for (const file of ["session.json", "key.json"]) await rm2(join3(profileDir, file), { force: true });
          for (const entry of await readdir2(profileDir)) {
            if (entry !== ".lock" && entry !== "profile.json") await rm2(join3(profileDir, entry), { recursive: true, force: true });
          }
          await rm2(join3(profileDir, "profile.json"), { force: true });
          await recordProfileDeletion(name);
        });
        await rmdir(profileDir).catch((error) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
        });
      }
      // ── Key management ──────────────────────────────────────────────────
      /**
       * Returns the parsed JWK for a profile, or null if no key exists.
       */
      static async getKey(name) {
        return readJson(join3(PROFILES_DIR, name, "key.json"));
      }
      /**
       * Saves a JWK key under the profile lock (0600, in an owner-only profile
       * directory). Refused (PROFILE_NOT_FOUND) if the profile was deleted while
       * this waited for the lock, rather than leaving a key-only profile.
       */
      static async setKey(name, jwk) {
        await _ProfileManager.withLock(name, async () => {
          await refuseWriteToDeletedProfile(name);
          await writeJson(join3(await _ProfileManager.ensureProfileDir(name), "key.json"), jwk);
        });
      }
      /** Removes key.json under the profile lock (rollback of a key a failed login created). */
      static async removeKey(name) {
        await _ProfileManager.withLock(name, () => rm2(join3(PROFILES_DIR, name, "key.json"), { force: true }));
      }
      // ── Session management ──────────────────────────────────────────────
      /**
       * Returns the parsed session for a profile, or null if none exists.
       */
      static async getSession(name) {
        return readSession(name);
      }
      /**
       * Saves session data for a profile.
       */
      static async setSession(name, session) {
        await writeSession(name, session);
      }
      /**
       * Removes the session file for a profile.
       */
      static async clearSession(name) {
        await removeSession(name);
      }
      // ── Cache management ────────────────────────────────────────────────
      /**
       * Returns the profile's cache directory (share history lives here),
       * created or tightened to 0700.
       */
      static async getCacheDir(name) {
        const cacheDir = join3(await _ProfileManager.ensureProfileDir(name), "cache");
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
      static async resolveContext(options) {
        const config = await _ProfileManager.getConfig();
        const profile = options.profile ?? process.env.TC_PROFILE ?? config.defaultProfile ?? DEFAULT_PROFILE;
        let profileHost;
        try {
          const profileConfig = await _ProfileManager.getProfile(profile);
          profileHost = profileConfig.host;
        } catch {
        }
        const explicitHost = options.host ?? process.env.TC_HOST;
        let host = explicitHost ?? profileHost ?? DEFAULT_HOST;
        if (explicitHost === void 0) {
          const { discoverLocalNodeHost: discoverLocalNodeHost2 } = await Promise.resolve().then(() => (init_host(), host_exports));
          const localHost = await discoverLocalNodeHost2(profile);
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
          quiet: options.quiet ?? false
        };
      }
    };
  }
});

// ../../node_modules/@noble/hashes/esm/cryptoNode.js
import * as nc from "crypto";
var crypto2;
var init_cryptoNode = __esm({
  "../../node_modules/@noble/hashes/esm/cryptoNode.js"() {
    "use strict";
    crypto2 = nc && typeof nc === "object" && "webcrypto" in nc ? nc.webcrypto : nc && typeof nc === "object" && "randomBytes" in nc ? nc : void 0;
  }
});

// ../../node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u8(arr) {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex3 = "";
  for (let i = 0; i < bytes.length; i++) {
    hex3 += hexes[bytes[i]];
  }
  return hex3;
}
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex3) {
  if (typeof hex3 !== "string")
    throw new Error("hex string expected, got " + typeof hex3);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex3);
  const hl = hex3.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex3.charCodeAt(hi));
    const n2 = asciiToBase16(hex3.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex3[hi] + hex3[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function createXOFer(hashCons) {
  const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
  const tmp = hashCons({});
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto2 && typeof crypto2.getRandomValues === "function") {
    return crypto2.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto2 && typeof crypto2.randomBytes === "function") {
    return Uint8Array.from(crypto2.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}
var isLE, swap8IfBE, swap32IfBE, hasHexBuiltin, hexes, asciis, Hash;
var init_utils = __esm({
  "../../node_modules/@noble/hashes/esm/utils.js"() {
    "use strict";
    init_cryptoNode();
    isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
    swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n);
    swap32IfBE = isLE ? (u) => u : byteSwap32;
    hasHexBuiltin = /* @__PURE__ */ (() => (
      // @ts-ignore
      typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
    ))();
    hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
    asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
    Hash = class {
    };
  }
});

// ../../node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE2) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE2);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE2 ? 4 : 0;
  const l = isLE2 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE2);
  view.setUint32(byteOffset + l, wl, isLE2);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD, SHA256_IV, SHA512_IV;
var init_md = __esm({
  "../../node_modules/@noble/hashes/esm/_md.js"() {
    "use strict";
    init_utils();
    HashMD = class extends Hash {
      constructor(blockLen, outputLen, padOffset, isLE2) {
        super();
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE2;
        this.buffer = new Uint8Array(blockLen);
        this.view = createView(this.buffer);
      }
      update(data) {
        aexists(this);
        data = toBytes(data);
        abytes(data);
        const { view, buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          if (take === blockLen) {
            const dataView = createView(data);
            for (; blockLen <= len - pos; pos += blockLen)
              this.process(dataView, pos);
            continue;
          }
          buffer.set(data.subarray(pos, pos + take), this.pos);
          this.pos += take;
          pos += take;
          if (this.pos === blockLen) {
            this.process(view, 0);
            this.pos = 0;
          }
        }
        this.length += data.length;
        this.roundClean();
        return this;
      }
      digestInto(out) {
        aexists(this);
        aoutput(out, this);
        this.finished = true;
        const { buffer, view, blockLen, isLE: isLE2 } = this;
        let { pos } = this;
        buffer[pos++] = 128;
        clean(this.buffer.subarray(pos));
        if (this.padOffset > blockLen - pos) {
          this.process(view, 0);
          pos = 0;
        }
        for (let i = pos; i < blockLen; i++)
          buffer[i] = 0;
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE2);
        this.process(view, 0);
        const oview = createView(out);
        const len = this.outputLen;
        if (len % 4)
          throw new Error("_sha2: outputLen should be aligned to 32bit");
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
          throw new Error("_sha2: outputLen bigger than state");
        for (let i = 0; i < outLen; i++)
          oview.setUint32(4 * i, state[i], isLE2);
      }
      digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
      }
      _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length: length4, finished, destroyed, pos } = this;
        to.destroyed = destroyed;
        to.finished = finished;
        to.length = length4;
        to.pos = pos;
        if (length4 % blockLen)
          to.buffer.set(buffer);
        return to;
      }
      clone() {
        return this._cloneInto();
      }
    };
    SHA256_IV = /* @__PURE__ */ Uint32Array.from([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    SHA512_IV = /* @__PURE__ */ Uint32Array.from([
      1779033703,
      4089235720,
      3144134277,
      2227873595,
      1013904242,
      4271175723,
      2773480762,
      1595750129,
      1359893119,
      2917565137,
      2600822924,
      725511199,
      528734635,
      4215389547,
      1541459225,
      327033209
    ]);
  }
});

// ../../node_modules/@noble/hashes/esm/_u64.js
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var U32_MASK64, _32n, shrSH, shrSL, rotrSH, rotrSL, rotrBH, rotrBL, add3L, add3H, add4L, add4H, add5L, add5H;
var init_u64 = __esm({
  "../../node_modules/@noble/hashes/esm/_u64.js"() {
    "use strict";
    U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
    _32n = /* @__PURE__ */ BigInt(32);
    shrSH = (h, _l, s) => h >>> s;
    shrSL = (h, l, s) => h << 32 - s | l >>> s;
    rotrSH = (h, l, s) => h >>> s | l << 32 - s;
    rotrSL = (h, l, s) => h << 32 - s | l >>> s;
    rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
    rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
    add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
    add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
    add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
    add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
    add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
    add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
  }
});

// ../../node_modules/@noble/hashes/esm/sha2.js
var SHA256_K, SHA256_W, SHA256, K512, SHA512_Kh, SHA512_Kl, SHA512_W_H, SHA512_W_L, SHA512, sha256, sha512;
var init_sha2 = __esm({
  "../../node_modules/@noble/hashes/esm/sha2.js"() {
    "use strict";
    init_md();
    init_u64();
    init_utils();
    SHA256_K = /* @__PURE__ */ Uint32Array.from([
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ]);
    SHA256_W = /* @__PURE__ */ new Uint32Array(64);
    SHA256 = class extends HashMD {
      constructor(outputLen = 32) {
        super(64, outputLen, 8, false);
        this.A = SHA256_IV[0] | 0;
        this.B = SHA256_IV[1] | 0;
        this.C = SHA256_IV[2] | 0;
        this.D = SHA256_IV[3] | 0;
        this.E = SHA256_IV[4] | 0;
        this.F = SHA256_IV[5] | 0;
        this.G = SHA256_IV[6] | 0;
        this.H = SHA256_IV[7] | 0;
      }
      get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
      }
      // prettier-ignore
      set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4)
          SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
          const W15 = SHA256_W[i - 15];
          const W2 = SHA256_W[i - 2];
          const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
          const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
          SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
        }
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
          const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
          const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
          const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
          const T2 = sigma0 + Maj(A, B, C) | 0;
          H = G;
          G = F;
          F = E;
          E = D + T1 | 0;
          D = C;
          C = B;
          B = A;
          A = T1 + T2 | 0;
        }
        A = A + this.A | 0;
        B = B + this.B | 0;
        C = C + this.C | 0;
        D = D + this.D | 0;
        E = E + this.E | 0;
        F = F + this.F | 0;
        G = G + this.G | 0;
        H = H + this.H | 0;
        this.set(A, B, C, D, E, F, G, H);
      }
      roundClean() {
        clean(SHA256_W);
      }
      destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        clean(this.buffer);
      }
    };
    K512 = /* @__PURE__ */ (() => split([
      "0x428a2f98d728ae22",
      "0x7137449123ef65cd",
      "0xb5c0fbcfec4d3b2f",
      "0xe9b5dba58189dbbc",
      "0x3956c25bf348b538",
      "0x59f111f1b605d019",
      "0x923f82a4af194f9b",
      "0xab1c5ed5da6d8118",
      "0xd807aa98a3030242",
      "0x12835b0145706fbe",
      "0x243185be4ee4b28c",
      "0x550c7dc3d5ffb4e2",
      "0x72be5d74f27b896f",
      "0x80deb1fe3b1696b1",
      "0x9bdc06a725c71235",
      "0xc19bf174cf692694",
      "0xe49b69c19ef14ad2",
      "0xefbe4786384f25e3",
      "0x0fc19dc68b8cd5b5",
      "0x240ca1cc77ac9c65",
      "0x2de92c6f592b0275",
      "0x4a7484aa6ea6e483",
      "0x5cb0a9dcbd41fbd4",
      "0x76f988da831153b5",
      "0x983e5152ee66dfab",
      "0xa831c66d2db43210",
      "0xb00327c898fb213f",
      "0xbf597fc7beef0ee4",
      "0xc6e00bf33da88fc2",
      "0xd5a79147930aa725",
      "0x06ca6351e003826f",
      "0x142929670a0e6e70",
      "0x27b70a8546d22ffc",
      "0x2e1b21385c26c926",
      "0x4d2c6dfc5ac42aed",
      "0x53380d139d95b3df",
      "0x650a73548baf63de",
      "0x766a0abb3c77b2a8",
      "0x81c2c92e47edaee6",
      "0x92722c851482353b",
      "0xa2bfe8a14cf10364",
      "0xa81a664bbc423001",
      "0xc24b8b70d0f89791",
      "0xc76c51a30654be30",
      "0xd192e819d6ef5218",
      "0xd69906245565a910",
      "0xf40e35855771202a",
      "0x106aa07032bbd1b8",
      "0x19a4c116b8d2d0c8",
      "0x1e376c085141ab53",
      "0x2748774cdf8eeb99",
      "0x34b0bcb5e19b48a8",
      "0x391c0cb3c5c95a63",
      "0x4ed8aa4ae3418acb",
      "0x5b9cca4f7763e373",
      "0x682e6ff3d6b2b8a3",
      "0x748f82ee5defb2fc",
      "0x78a5636f43172f60",
      "0x84c87814a1f0ab72",
      "0x8cc702081a6439ec",
      "0x90befffa23631e28",
      "0xa4506cebde82bde9",
      "0xbef9a3f7b2c67915",
      "0xc67178f2e372532b",
      "0xca273eceea26619c",
      "0xd186b8c721c0c207",
      "0xeada7dd6cde0eb1e",
      "0xf57d4f7fee6ed178",
      "0x06f067aa72176fba",
      "0x0a637dc5a2c898a6",
      "0x113f9804bef90dae",
      "0x1b710b35131c471b",
      "0x28db77f523047d84",
      "0x32caab7b40c72493",
      "0x3c9ebe0a15c9bebc",
      "0x431d67c49c100d4c",
      "0x4cc5d4becb3e42b6",
      "0x597f299cfc657e2a",
      "0x5fcb6fab3ad6faec",
      "0x6c44198c4a475817"
    ].map((n) => BigInt(n))))();
    SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
    SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
    SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
    SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
    SHA512 = class extends HashMD {
      constructor(outputLen = 64) {
        super(128, outputLen, 16, false);
        this.Ah = SHA512_IV[0] | 0;
        this.Al = SHA512_IV[1] | 0;
        this.Bh = SHA512_IV[2] | 0;
        this.Bl = SHA512_IV[3] | 0;
        this.Ch = SHA512_IV[4] | 0;
        this.Cl = SHA512_IV[5] | 0;
        this.Dh = SHA512_IV[6] | 0;
        this.Dl = SHA512_IV[7] | 0;
        this.Eh = SHA512_IV[8] | 0;
        this.El = SHA512_IV[9] | 0;
        this.Fh = SHA512_IV[10] | 0;
        this.Fl = SHA512_IV[11] | 0;
        this.Gh = SHA512_IV[12] | 0;
        this.Gl = SHA512_IV[13] | 0;
        this.Hh = SHA512_IV[14] | 0;
        this.Hl = SHA512_IV[15] | 0;
      }
      // prettier-ignore
      get() {
        const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
      }
      // prettier-ignore
      set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
        this.Ah = Ah | 0;
        this.Al = Al | 0;
        this.Bh = Bh | 0;
        this.Bl = Bl | 0;
        this.Ch = Ch | 0;
        this.Cl = Cl | 0;
        this.Dh = Dh | 0;
        this.Dl = Dl | 0;
        this.Eh = Eh | 0;
        this.El = El | 0;
        this.Fh = Fh | 0;
        this.Fl = Fl | 0;
        this.Gh = Gh | 0;
        this.Gl = Gl | 0;
        this.Hh = Hh | 0;
        this.Hl = Hl | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4) {
          SHA512_W_H[i] = view.getUint32(offset);
          SHA512_W_L[i] = view.getUint32(offset += 4);
        }
        for (let i = 16; i < 80; i++) {
          const W15h = SHA512_W_H[i - 15] | 0;
          const W15l = SHA512_W_L[i - 15] | 0;
          const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
          const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
          const W2h = SHA512_W_H[i - 2] | 0;
          const W2l = SHA512_W_L[i - 2] | 0;
          const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
          const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
          const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
          const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
          SHA512_W_H[i] = SUMh | 0;
          SHA512_W_L[i] = SUMl | 0;
        }
        let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        for (let i = 0; i < 80; i++) {
          const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
          const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
          const CHIh = Eh & Fh ^ ~Eh & Gh;
          const CHIl = El & Fl ^ ~El & Gl;
          const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
          const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
          const T1l = T1ll | 0;
          const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
          const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
          const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
          const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
          Hh = Gh | 0;
          Hl = Gl | 0;
          Gh = Fh | 0;
          Gl = Fl | 0;
          Fh = Eh | 0;
          Fl = El | 0;
          ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
          Dh = Ch | 0;
          Dl = Cl | 0;
          Ch = Bh | 0;
          Cl = Bl | 0;
          Bh = Ah | 0;
          Bl = Al | 0;
          const All = add3L(T1l, sigma0l, MAJl);
          Ah = add3H(All, T1h, sigma0h, MAJh);
          Al = All | 0;
        }
        ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
        ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
        ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
        ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
        ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
        ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
        ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
        ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
        this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
      }
      roundClean() {
        clean(SHA512_W_H, SHA512_W_L);
      }
      destroy() {
        clean(this.buffer);
        this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      }
    };
    sha256 = /* @__PURE__ */ createHasher(() => new SHA256());
    sha512 = /* @__PURE__ */ createHasher(() => new SHA512());
  }
});

// ../../node_modules/@noble/hashes/esm/sha256.js
var sha2562;
var init_sha256 = __esm({
  "../../node_modules/@noble/hashes/esm/sha256.js"() {
    "use strict";
    init_sha2();
    sha2562 = sha256;
  }
});

// ../../node_modules/zod/v3/helpers/util.js
var util2, objectUtil2, ZodParsedType2, getParsedType2;
var init_util = __esm({
  "../../node_modules/zod/v3/helpers/util.js"() {
    "use strict";
    (function(util3) {
      util3.assertEqual = (_) => {
      };
      function assertIs(_arg) {
      }
      util3.assertIs = assertIs;
      function assertNever(_x) {
        throw new Error();
      }
      util3.assertNever = assertNever;
      util3.arrayToEnum = (items) => {
        const obj = {};
        for (const item of items) {
          obj[item] = item;
        }
        return obj;
      };
      util3.getValidEnumValues = (obj) => {
        const validKeys = util3.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
        const filtered = {};
        for (const k of validKeys) {
          filtered[k] = obj[k];
        }
        return util3.objectValues(filtered);
      };
      util3.objectValues = (obj) => {
        return util3.objectKeys(obj).map(function(e) {
          return obj[e];
        });
      };
      util3.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object3) => {
        const keys = [];
        for (const key in object3) {
          if (Object.prototype.hasOwnProperty.call(object3, key)) {
            keys.push(key);
          }
        }
        return keys;
      };
      util3.find = (arr, checker) => {
        for (const item of arr) {
          if (checker(item))
            return item;
        }
        return void 0;
      };
      util3.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
      function joinValues(array, separator = " | ") {
        return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
      }
      util3.joinValues = joinValues;
      util3.jsonStringifyReplacer = (_, value) => {
        if (typeof value === "bigint") {
          return value.toString();
        }
        return value;
      };
    })(util2 || (util2 = {}));
    (function(objectUtil3) {
      objectUtil3.mergeShapes = (first, second) => {
        return {
          ...first,
          ...second
          // second overwrites first
        };
      };
    })(objectUtil2 || (objectUtil2 = {}));
    ZodParsedType2 = util2.arrayToEnum([
      "string",
      "nan",
      "number",
      "integer",
      "float",
      "boolean",
      "date",
      "bigint",
      "symbol",
      "function",
      "undefined",
      "null",
      "array",
      "object",
      "unknown",
      "promise",
      "void",
      "never",
      "map",
      "set"
    ]);
    getParsedType2 = (data) => {
      const t = typeof data;
      switch (t) {
        case "undefined":
          return ZodParsedType2.undefined;
        case "string":
          return ZodParsedType2.string;
        case "number":
          return Number.isNaN(data) ? ZodParsedType2.nan : ZodParsedType2.number;
        case "boolean":
          return ZodParsedType2.boolean;
        case "function":
          return ZodParsedType2.function;
        case "bigint":
          return ZodParsedType2.bigint;
        case "symbol":
          return ZodParsedType2.symbol;
        case "object":
          if (Array.isArray(data)) {
            return ZodParsedType2.array;
          }
          if (data === null) {
            return ZodParsedType2.null;
          }
          if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
            return ZodParsedType2.promise;
          }
          if (typeof Map !== "undefined" && data instanceof Map) {
            return ZodParsedType2.map;
          }
          if (typeof Set !== "undefined" && data instanceof Set) {
            return ZodParsedType2.set;
          }
          if (typeof Date !== "undefined" && data instanceof Date) {
            return ZodParsedType2.date;
          }
          return ZodParsedType2.object;
        default:
          return ZodParsedType2.unknown;
      }
    };
  }
});

// ../../node_modules/zod/v3/ZodError.js
var ZodIssueCode2, quotelessJson2, ZodError2;
var init_ZodError = __esm({
  "../../node_modules/zod/v3/ZodError.js"() {
    "use strict";
    init_util();
    ZodIssueCode2 = util2.arrayToEnum([
      "invalid_type",
      "invalid_literal",
      "custom",
      "invalid_union",
      "invalid_union_discriminator",
      "invalid_enum_value",
      "unrecognized_keys",
      "invalid_arguments",
      "invalid_return_type",
      "invalid_date",
      "invalid_string",
      "too_small",
      "too_big",
      "invalid_intersection_types",
      "not_multiple_of",
      "not_finite"
    ]);
    quotelessJson2 = (obj) => {
      const json = JSON.stringify(obj, null, 2);
      return json.replace(/"([^"]+)":/g, "$1:");
    };
    ZodError2 = class _ZodError2 extends Error {
      get errors() {
        return this.issues;
      }
      constructor(issues) {
        super();
        this.issues = [];
        this.addIssue = (sub) => {
          this.issues = [...this.issues, sub];
        };
        this.addIssues = (subs = []) => {
          this.issues = [...this.issues, ...subs];
        };
        const actualProto = new.target.prototype;
        if (Object.setPrototypeOf) {
          Object.setPrototypeOf(this, actualProto);
        } else {
          this.__proto__ = actualProto;
        }
        this.name = "ZodError";
        this.issues = issues;
      }
      format(_mapper) {
        const mapper = _mapper || function(issue) {
          return issue.message;
        };
        const fieldErrors = { _errors: [] };
        const processError = (error) => {
          for (const issue of error.issues) {
            if (issue.code === "invalid_union") {
              issue.unionErrors.map(processError);
            } else if (issue.code === "invalid_return_type") {
              processError(issue.returnTypeError);
            } else if (issue.code === "invalid_arguments") {
              processError(issue.argumentsError);
            } else if (issue.path.length === 0) {
              fieldErrors._errors.push(mapper(issue));
            } else {
              let curr = fieldErrors;
              let i = 0;
              while (i < issue.path.length) {
                const el = issue.path[i];
                const terminal = i === issue.path.length - 1;
                if (!terminal) {
                  curr[el] = curr[el] || { _errors: [] };
                } else {
                  curr[el] = curr[el] || { _errors: [] };
                  curr[el]._errors.push(mapper(issue));
                }
                curr = curr[el];
                i++;
              }
            }
          }
        };
        processError(this);
        return fieldErrors;
      }
      static assert(value) {
        if (!(value instanceof _ZodError2)) {
          throw new Error(`Not a ZodError: ${value}`);
        }
      }
      toString() {
        return this.message;
      }
      get message() {
        return JSON.stringify(this.issues, util2.jsonStringifyReplacer, 2);
      }
      get isEmpty() {
        return this.issues.length === 0;
      }
      flatten(mapper = (issue) => issue.message) {
        const fieldErrors = {};
        const formErrors = [];
        for (const sub of this.issues) {
          if (sub.path.length > 0) {
            const firstEl = sub.path[0];
            fieldErrors[firstEl] = fieldErrors[firstEl] || [];
            fieldErrors[firstEl].push(mapper(sub));
          } else {
            formErrors.push(mapper(sub));
          }
        }
        return { formErrors, fieldErrors };
      }
      get formErrors() {
        return this.flatten();
      }
    };
    ZodError2.create = (issues) => {
      const error = new ZodError2(issues);
      return error;
    };
  }
});

// ../../node_modules/zod/v3/locales/en.js
var errorMap2, en_default2;
var init_en = __esm({
  "../../node_modules/zod/v3/locales/en.js"() {
    "use strict";
    init_ZodError();
    init_util();
    errorMap2 = (issue, _ctx) => {
      let message;
      switch (issue.code) {
        case ZodIssueCode2.invalid_type:
          if (issue.received === ZodParsedType2.undefined) {
            message = "Required";
          } else {
            message = `Expected ${issue.expected}, received ${issue.received}`;
          }
          break;
        case ZodIssueCode2.invalid_literal:
          message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util2.jsonStringifyReplacer)}`;
          break;
        case ZodIssueCode2.unrecognized_keys:
          message = `Unrecognized key(s) in object: ${util2.joinValues(issue.keys, ", ")}`;
          break;
        case ZodIssueCode2.invalid_union:
          message = `Invalid input`;
          break;
        case ZodIssueCode2.invalid_union_discriminator:
          message = `Invalid discriminator value. Expected ${util2.joinValues(issue.options)}`;
          break;
        case ZodIssueCode2.invalid_enum_value:
          message = `Invalid enum value. Expected ${util2.joinValues(issue.options)}, received '${issue.received}'`;
          break;
        case ZodIssueCode2.invalid_arguments:
          message = `Invalid function arguments`;
          break;
        case ZodIssueCode2.invalid_return_type:
          message = `Invalid function return type`;
          break;
        case ZodIssueCode2.invalid_date:
          message = `Invalid date`;
          break;
        case ZodIssueCode2.invalid_string:
          if (typeof issue.validation === "object") {
            if ("includes" in issue.validation) {
              message = `Invalid input: must include "${issue.validation.includes}"`;
              if (typeof issue.validation.position === "number") {
                message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
              }
            } else if ("startsWith" in issue.validation) {
              message = `Invalid input: must start with "${issue.validation.startsWith}"`;
            } else if ("endsWith" in issue.validation) {
              message = `Invalid input: must end with "${issue.validation.endsWith}"`;
            } else {
              util2.assertNever(issue.validation);
            }
          } else if (issue.validation !== "regex") {
            message = `Invalid ${issue.validation}`;
          } else {
            message = "Invalid";
          }
          break;
        case ZodIssueCode2.too_small:
          if (issue.type === "array")
            message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
          else if (issue.type === "string")
            message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
          else if (issue.type === "number")
            message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
          else if (issue.type === "bigint")
            message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
          else if (issue.type === "date")
            message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
          else
            message = "Invalid input";
          break;
        case ZodIssueCode2.too_big:
          if (issue.type === "array")
            message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
          else if (issue.type === "string")
            message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
          else if (issue.type === "number")
            message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
          else if (issue.type === "bigint")
            message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
          else if (issue.type === "date")
            message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
          else
            message = "Invalid input";
          break;
        case ZodIssueCode2.custom:
          message = `Invalid input`;
          break;
        case ZodIssueCode2.invalid_intersection_types:
          message = `Intersection results could not be merged`;
          break;
        case ZodIssueCode2.not_multiple_of:
          message = `Number must be a multiple of ${issue.multipleOf}`;
          break;
        case ZodIssueCode2.not_finite:
          message = "Number must be finite";
          break;
        default:
          message = _ctx.defaultError;
          util2.assertNever(issue);
      }
      return { message };
    };
    en_default2 = errorMap2;
  }
});

// ../../node_modules/zod/v3/errors.js
function setErrorMap2(map) {
  overrideErrorMap2 = map;
}
function getErrorMap2() {
  return overrideErrorMap2;
}
var overrideErrorMap2;
var init_errors2 = __esm({
  "../../node_modules/zod/v3/errors.js"() {
    "use strict";
    init_en();
    overrideErrorMap2 = en_default2;
  }
});

// ../../node_modules/zod/v3/helpers/parseUtil.js
function addIssueToContext2(ctx, issueData) {
  const overrideMap = getErrorMap2();
  const issue = makeIssue2({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default2 ? void 0 : en_default2
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var makeIssue2, EMPTY_PATH2, ParseStatus2, INVALID2, DIRTY2, OK2, isAborted2, isDirty2, isValid2, isAsync2;
var init_parseUtil = __esm({
  "../../node_modules/zod/v3/helpers/parseUtil.js"() {
    "use strict";
    init_errors2();
    init_en();
    makeIssue2 = (params) => {
      const { data, path, errorMaps, issueData } = params;
      const fullPath = [...path, ...issueData.path || []];
      const fullIssue = {
        ...issueData,
        path: fullPath
      };
      if (issueData.message !== void 0) {
        return {
          ...issueData,
          path: fullPath,
          message: issueData.message
        };
      }
      let errorMessage = "";
      const maps = errorMaps.filter((m) => !!m).slice().reverse();
      for (const map of maps) {
        errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
      }
      return {
        ...issueData,
        path: fullPath,
        message: errorMessage
      };
    };
    EMPTY_PATH2 = [];
    ParseStatus2 = class _ParseStatus2 {
      constructor() {
        this.value = "valid";
      }
      dirty() {
        if (this.value === "valid")
          this.value = "dirty";
      }
      abort() {
        if (this.value !== "aborted")
          this.value = "aborted";
      }
      static mergeArray(status, results) {
        const arrayValue = [];
        for (const s of results) {
          if (s.status === "aborted")
            return INVALID2;
          if (s.status === "dirty")
            status.dirty();
          arrayValue.push(s.value);
        }
        return { status: status.value, value: arrayValue };
      }
      static async mergeObjectAsync(status, pairs) {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value
          });
        }
        return _ParseStatus2.mergeObjectSync(status, syncPairs);
      }
      static mergeObjectSync(status, pairs) {
        const finalObject = {};
        for (const pair of pairs) {
          const { key, value } = pair;
          if (key.status === "aborted")
            return INVALID2;
          if (value.status === "aborted")
            return INVALID2;
          if (key.status === "dirty")
            status.dirty();
          if (value.status === "dirty")
            status.dirty();
          if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
            finalObject[key.value] = value.value;
          }
        }
        return { status: status.value, value: finalObject };
      }
    };
    INVALID2 = Object.freeze({
      status: "aborted"
    });
    DIRTY2 = (value) => ({ status: "dirty", value });
    OK2 = (value) => ({ status: "valid", value });
    isAborted2 = (x) => x.status === "aborted";
    isDirty2 = (x) => x.status === "dirty";
    isValid2 = (x) => x.status === "valid";
    isAsync2 = (x) => typeof Promise !== "undefined" && x instanceof Promise;
  }
});

// ../../node_modules/zod/v3/helpers/typeAliases.js
var init_typeAliases = __esm({
  "../../node_modules/zod/v3/helpers/typeAliases.js"() {
    "use strict";
  }
});

// ../../node_modules/zod/v3/helpers/errorUtil.js
var errorUtil2;
var init_errorUtil = __esm({
  "../../node_modules/zod/v3/helpers/errorUtil.js"() {
    "use strict";
    (function(errorUtil3) {
      errorUtil3.errToObj = (message) => typeof message === "string" ? { message } : message || {};
      errorUtil3.toString = (message) => typeof message === "string" ? message : message?.message;
    })(errorUtil2 || (errorUtil2 = {}));
  }
});

// ../../node_modules/zod/v3/types.js
function processCreateParams2(params) {
  if (!params)
    return {};
  const { errorMap: errorMap3, invalid_type_error, required_error, description } = params;
  if (errorMap3 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap3)
    return { errorMap: errorMap3, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
function timeRegexSource2(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex2(args) {
  return new RegExp(`^${timeRegexSource2(args)}$`);
}
function datetimeRegex2(args) {
  let regex = `${dateRegexSource2}T${timeRegexSource2(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP2(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4Regex2.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6Regex2.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT2(jwt, alg) {
  if (!jwtRegex2.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base643 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base643));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr2(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4CidrRegex2.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6CidrRegex2.test(ip)) {
    return true;
  }
  return false;
}
function floatSafeRemainder2(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
function deepPartialify2(schema) {
  if (schema instanceof ZodObject2) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional2.create(deepPartialify2(fieldSchema));
    }
    return new ZodObject2({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray2) {
    return new ZodArray2({
      ...schema._def,
      type: deepPartialify2(schema.element)
    });
  } else if (schema instanceof ZodOptional2) {
    return ZodOptional2.create(deepPartialify2(schema.unwrap()));
  } else if (schema instanceof ZodNullable2) {
    return ZodNullable2.create(deepPartialify2(schema.unwrap()));
  } else if (schema instanceof ZodTuple2) {
    return ZodTuple2.create(schema.items.map((item) => deepPartialify2(item)));
  } else {
    return schema;
  }
}
function mergeValues2(a, b) {
  const aType = getParsedType2(a);
  const bType = getParsedType2(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType2.object && bType === ZodParsedType2.object) {
    const bKeys = util2.objectKeys(b);
    const sharedKeys = util2.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues2(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType2.array && bType === ZodParsedType2.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues2(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType2.date && bType === ZodParsedType2.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
function createZodEnum2(values, params) {
  return new ZodEnum2({
    values,
    typeName: ZodFirstPartyTypeKind2.ZodEnum,
    ...processCreateParams2(params)
  });
}
function cleanParams2(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom2(check, _params = {}, fatal) {
  if (check)
    return ZodAny2.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams2(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams2(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny2.create();
}
var ParseInputLazyPath2, handleResult2, ZodType2, cuidRegex2, cuid2Regex2, ulidRegex2, uuidRegex2, nanoidRegex2, jwtRegex2, durationRegex2, emailRegex2, _emojiRegex2, emojiRegex2, ipv4Regex2, ipv4CidrRegex2, ipv6Regex2, ipv6CidrRegex2, base64Regex2, base64urlRegex2, dateRegexSource2, dateRegex2, ZodString2, ZodNumber2, ZodBigInt2, ZodBoolean2, ZodDate2, ZodSymbol2, ZodUndefined2, ZodNull2, ZodAny2, ZodUnknown2, ZodNever2, ZodVoid2, ZodArray2, ZodObject2, ZodUnion2, getDiscriminator2, ZodDiscriminatedUnion2, ZodIntersection2, ZodTuple2, ZodRecord2, ZodMap2, ZodSet2, ZodFunction2, ZodLazy2, ZodLiteral2, ZodEnum2, ZodNativeEnum2, ZodPromise2, ZodEffects2, ZodOptional2, ZodNullable2, ZodDefault2, ZodCatch2, ZodNaN2, BRAND2, ZodBranded2, ZodPipeline2, ZodReadonly2, late2, ZodFirstPartyTypeKind2, instanceOfType2, stringType2, numberType2, nanType2, bigIntType2, booleanType2, dateType2, symbolType2, undefinedType2, nullType2, anyType2, unknownType2, neverType2, voidType2, arrayType2, objectType2, strictObjectType2, unionType2, discriminatedUnionType2, intersectionType2, tupleType2, recordType2, mapType2, setType2, functionType2, lazyType2, literalType2, enumType2, nativeEnumType2, promiseType2, effectsType2, optionalType2, nullableType2, preprocessType2, pipelineType2, ostring2, onumber2, oboolean2, coerce4, NEVER2;
var init_types2 = __esm({
  "../../node_modules/zod/v3/types.js"() {
    "use strict";
    init_ZodError();
    init_errors2();
    init_errorUtil();
    init_parseUtil();
    init_util();
    ParseInputLazyPath2 = class {
      constructor(parent, value, path, key) {
        this._cachedPath = [];
        this.parent = parent;
        this.data = value;
        this._path = path;
        this._key = key;
      }
      get path() {
        if (!this._cachedPath.length) {
          if (Array.isArray(this._key)) {
            this._cachedPath.push(...this._path, ...this._key);
          } else {
            this._cachedPath.push(...this._path, this._key);
          }
        }
        return this._cachedPath;
      }
    };
    handleResult2 = (ctx, result) => {
      if (isValid2(result)) {
        return { success: true, data: result.value };
      } else {
        if (!ctx.common.issues.length) {
          throw new Error("Validation failed but no issues detected.");
        }
        return {
          success: false,
          get error() {
            if (this._error)
              return this._error;
            const error = new ZodError2(ctx.common.issues);
            this._error = error;
            return this._error;
          }
        };
      }
    };
    ZodType2 = class {
      get description() {
        return this._def.description;
      }
      _getType(input) {
        return getParsedType2(input.data);
      }
      _getOrReturnCtx(input, ctx) {
        return ctx || {
          common: input.parent.common,
          data: input.data,
          parsedType: getParsedType2(input.data),
          schemaErrorMap: this._def.errorMap,
          path: input.path,
          parent: input.parent
        };
      }
      _processInputParams(input) {
        return {
          status: new ParseStatus2(),
          ctx: {
            common: input.parent.common,
            data: input.data,
            parsedType: getParsedType2(input.data),
            schemaErrorMap: this._def.errorMap,
            path: input.path,
            parent: input.parent
          }
        };
      }
      _parseSync(input) {
        const result = this._parse(input);
        if (isAsync2(result)) {
          throw new Error("Synchronous parse encountered promise.");
        }
        return result;
      }
      _parseAsync(input) {
        const result = this._parse(input);
        return Promise.resolve(result);
      }
      parse(data, params) {
        const result = this.safeParse(data, params);
        if (result.success)
          return result.data;
        throw result.error;
      }
      safeParse(data, params) {
        const ctx = {
          common: {
            issues: [],
            async: params?.async ?? false,
            contextualErrorMap: params?.errorMap
          },
          path: params?.path || [],
          schemaErrorMap: this._def.errorMap,
          parent: null,
          data,
          parsedType: getParsedType2(data)
        };
        const result = this._parseSync({ data, path: ctx.path, parent: ctx });
        return handleResult2(ctx, result);
      }
      "~validate"(data) {
        const ctx = {
          common: {
            issues: [],
            async: !!this["~standard"].async
          },
          path: [],
          schemaErrorMap: this._def.errorMap,
          parent: null,
          data,
          parsedType: getParsedType2(data)
        };
        if (!this["~standard"].async) {
          try {
            const result = this._parseSync({ data, path: [], parent: ctx });
            return isValid2(result) ? {
              value: result.value
            } : {
              issues: ctx.common.issues
            };
          } catch (err) {
            if (err?.message?.toLowerCase()?.includes("encountered")) {
              this["~standard"].async = true;
            }
            ctx.common = {
              issues: [],
              async: true
            };
          }
        }
        return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid2(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        });
      }
      async parseAsync(data, params) {
        const result = await this.safeParseAsync(data, params);
        if (result.success)
          return result.data;
        throw result.error;
      }
      async safeParseAsync(data, params) {
        const ctx = {
          common: {
            issues: [],
            contextualErrorMap: params?.errorMap,
            async: true
          },
          path: params?.path || [],
          schemaErrorMap: this._def.errorMap,
          parent: null,
          data,
          parsedType: getParsedType2(data)
        };
        const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
        const result = await (isAsync2(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
        return handleResult2(ctx, result);
      }
      refine(check, message) {
        const getIssueProperties = (val) => {
          if (typeof message === "string" || typeof message === "undefined") {
            return { message };
          } else if (typeof message === "function") {
            return message(val);
          } else {
            return message;
          }
        };
        return this._refinement((val, ctx) => {
          const result = check(val);
          const setError = () => ctx.addIssue({
            code: ZodIssueCode2.custom,
            ...getIssueProperties(val)
          });
          if (typeof Promise !== "undefined" && result instanceof Promise) {
            return result.then((data) => {
              if (!data) {
                setError();
                return false;
              } else {
                return true;
              }
            });
          }
          if (!result) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      refinement(check, refinementData) {
        return this._refinement((val, ctx) => {
          if (!check(val)) {
            ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
            return false;
          } else {
            return true;
          }
        });
      }
      _refinement(refinement) {
        return new ZodEffects2({
          schema: this,
          typeName: ZodFirstPartyTypeKind2.ZodEffects,
          effect: { type: "refinement", refinement }
        });
      }
      superRefine(refinement) {
        return this._refinement(refinement);
      }
      constructor(def) {
        this.spa = this.safeParseAsync;
        this._def = def;
        this.parse = this.parse.bind(this);
        this.safeParse = this.safeParse.bind(this);
        this.parseAsync = this.parseAsync.bind(this);
        this.safeParseAsync = this.safeParseAsync.bind(this);
        this.spa = this.spa.bind(this);
        this.refine = this.refine.bind(this);
        this.refinement = this.refinement.bind(this);
        this.superRefine = this.superRefine.bind(this);
        this.optional = this.optional.bind(this);
        this.nullable = this.nullable.bind(this);
        this.nullish = this.nullish.bind(this);
        this.array = this.array.bind(this);
        this.promise = this.promise.bind(this);
        this.or = this.or.bind(this);
        this.and = this.and.bind(this);
        this.transform = this.transform.bind(this);
        this.brand = this.brand.bind(this);
        this.default = this.default.bind(this);
        this.catch = this.catch.bind(this);
        this.describe = this.describe.bind(this);
        this.pipe = this.pipe.bind(this);
        this.readonly = this.readonly.bind(this);
        this.isNullable = this.isNullable.bind(this);
        this.isOptional = this.isOptional.bind(this);
        this["~standard"] = {
          version: 1,
          vendor: "zod",
          validate: (data) => this["~validate"](data)
        };
      }
      optional() {
        return ZodOptional2.create(this, this._def);
      }
      nullable() {
        return ZodNullable2.create(this, this._def);
      }
      nullish() {
        return this.nullable().optional();
      }
      array() {
        return ZodArray2.create(this);
      }
      promise() {
        return ZodPromise2.create(this, this._def);
      }
      or(option) {
        return ZodUnion2.create([this, option], this._def);
      }
      and(incoming) {
        return ZodIntersection2.create(this, incoming, this._def);
      }
      transform(transform) {
        return new ZodEffects2({
          ...processCreateParams2(this._def),
          schema: this,
          typeName: ZodFirstPartyTypeKind2.ZodEffects,
          effect: { type: "transform", transform }
        });
      }
      default(def) {
        const defaultValueFunc = typeof def === "function" ? def : () => def;
        return new ZodDefault2({
          ...processCreateParams2(this._def),
          innerType: this,
          defaultValue: defaultValueFunc,
          typeName: ZodFirstPartyTypeKind2.ZodDefault
        });
      }
      brand() {
        return new ZodBranded2({
          typeName: ZodFirstPartyTypeKind2.ZodBranded,
          type: this,
          ...processCreateParams2(this._def)
        });
      }
      catch(def) {
        const catchValueFunc = typeof def === "function" ? def : () => def;
        return new ZodCatch2({
          ...processCreateParams2(this._def),
          innerType: this,
          catchValue: catchValueFunc,
          typeName: ZodFirstPartyTypeKind2.ZodCatch
        });
      }
      describe(description) {
        const This = this.constructor;
        return new This({
          ...this._def,
          description
        });
      }
      pipe(target) {
        return ZodPipeline2.create(this, target);
      }
      readonly() {
        return ZodReadonly2.create(this);
      }
      isOptional() {
        return this.safeParse(void 0).success;
      }
      isNullable() {
        return this.safeParse(null).success;
      }
    };
    cuidRegex2 = /^c[^\s-]{8,}$/i;
    cuid2Regex2 = /^[0-9a-z]+$/;
    ulidRegex2 = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
    uuidRegex2 = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
    nanoidRegex2 = /^[a-z0-9_-]{21}$/i;
    jwtRegex2 = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
    durationRegex2 = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
    emailRegex2 = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
    _emojiRegex2 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
    ipv4Regex2 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
    ipv4CidrRegex2 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
    ipv6Regex2 = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
    ipv6CidrRegex2 = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
    base64Regex2 = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
    base64urlRegex2 = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
    dateRegexSource2 = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
    dateRegex2 = new RegExp(`^${dateRegexSource2}$`);
    ZodString2 = class _ZodString2 extends ZodType2 {
      _parse(input) {
        if (this._def.coerce) {
          input.data = String(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.string) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext2(ctx2, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.string,
            received: ctx2.parsedType
          });
          return INVALID2;
        }
        const status = new ParseStatus2();
        let ctx = void 0;
        for (const check of this._def.checks) {
          if (check.kind === "min") {
            if (input.data.length < check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_small,
                minimum: check.value,
                type: "string",
                inclusive: true,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            if (input.data.length > check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_big,
                maximum: check.value,
                type: "string",
                inclusive: true,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "length") {
            const tooBig = input.data.length > check.value;
            const tooSmall = input.data.length < check.value;
            if (tooBig || tooSmall) {
              ctx = this._getOrReturnCtx(input, ctx);
              if (tooBig) {
                addIssueToContext2(ctx, {
                  code: ZodIssueCode2.too_big,
                  maximum: check.value,
                  type: "string",
                  inclusive: true,
                  exact: true,
                  message: check.message
                });
              } else if (tooSmall) {
                addIssueToContext2(ctx, {
                  code: ZodIssueCode2.too_small,
                  minimum: check.value,
                  type: "string",
                  inclusive: true,
                  exact: true,
                  message: check.message
                });
              }
              status.dirty();
            }
          } else if (check.kind === "email") {
            if (!emailRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "email",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "emoji") {
            if (!emojiRegex2) {
              emojiRegex2 = new RegExp(_emojiRegex2, "u");
            }
            if (!emojiRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "emoji",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "uuid") {
            if (!uuidRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "uuid",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "nanoid") {
            if (!nanoidRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "nanoid",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "cuid") {
            if (!cuidRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "cuid",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "cuid2") {
            if (!cuid2Regex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "cuid2",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "ulid") {
            if (!ulidRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "ulid",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "url") {
            try {
              new URL(input.data);
            } catch {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "url",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "regex") {
            check.regex.lastIndex = 0;
            const testResult = check.regex.test(input.data);
            if (!testResult) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "regex",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "trim") {
            input.data = input.data.trim();
          } else if (check.kind === "includes") {
            if (!input.data.includes(check.value, check.position)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.invalid_string,
                validation: { includes: check.value, position: check.position },
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "toLowerCase") {
            input.data = input.data.toLowerCase();
          } else if (check.kind === "toUpperCase") {
            input.data = input.data.toUpperCase();
          } else if (check.kind === "startsWith") {
            if (!input.data.startsWith(check.value)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.invalid_string,
                validation: { startsWith: check.value },
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "endsWith") {
            if (!input.data.endsWith(check.value)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.invalid_string,
                validation: { endsWith: check.value },
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "datetime") {
            const regex = datetimeRegex2(check);
            if (!regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.invalid_string,
                validation: "datetime",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "date") {
            const regex = dateRegex2;
            if (!regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.invalid_string,
                validation: "date",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "time") {
            const regex = timeRegex2(check);
            if (!regex.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.invalid_string,
                validation: "time",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "duration") {
            if (!durationRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "duration",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "ip") {
            if (!isValidIP2(input.data, check.version)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "ip",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "jwt") {
            if (!isValidJWT2(input.data, check.alg)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "jwt",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "cidr") {
            if (!isValidCidr2(input.data, check.version)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "cidr",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "base64") {
            if (!base64Regex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "base64",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "base64url") {
            if (!base64urlRegex2.test(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                validation: "base64url",
                code: ZodIssueCode2.invalid_string,
                message: check.message
              });
              status.dirty();
            }
          } else {
            util2.assertNever(check);
          }
        }
        return { status: status.value, value: input.data };
      }
      _regex(regex, validation, message) {
        return this.refinement((data) => regex.test(data), {
          validation,
          code: ZodIssueCode2.invalid_string,
          ...errorUtil2.errToObj(message)
        });
      }
      _addCheck(check) {
        return new _ZodString2({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      email(message) {
        return this._addCheck({ kind: "email", ...errorUtil2.errToObj(message) });
      }
      url(message) {
        return this._addCheck({ kind: "url", ...errorUtil2.errToObj(message) });
      }
      emoji(message) {
        return this._addCheck({ kind: "emoji", ...errorUtil2.errToObj(message) });
      }
      uuid(message) {
        return this._addCheck({ kind: "uuid", ...errorUtil2.errToObj(message) });
      }
      nanoid(message) {
        return this._addCheck({ kind: "nanoid", ...errorUtil2.errToObj(message) });
      }
      cuid(message) {
        return this._addCheck({ kind: "cuid", ...errorUtil2.errToObj(message) });
      }
      cuid2(message) {
        return this._addCheck({ kind: "cuid2", ...errorUtil2.errToObj(message) });
      }
      ulid(message) {
        return this._addCheck({ kind: "ulid", ...errorUtil2.errToObj(message) });
      }
      base64(message) {
        return this._addCheck({ kind: "base64", ...errorUtil2.errToObj(message) });
      }
      base64url(message) {
        return this._addCheck({
          kind: "base64url",
          ...errorUtil2.errToObj(message)
        });
      }
      jwt(options) {
        return this._addCheck({ kind: "jwt", ...errorUtil2.errToObj(options) });
      }
      ip(options) {
        return this._addCheck({ kind: "ip", ...errorUtil2.errToObj(options) });
      }
      cidr(options) {
        return this._addCheck({ kind: "cidr", ...errorUtil2.errToObj(options) });
      }
      datetime(options) {
        if (typeof options === "string") {
          return this._addCheck({
            kind: "datetime",
            precision: null,
            offset: false,
            local: false,
            message: options
          });
        }
        return this._addCheck({
          kind: "datetime",
          precision: typeof options?.precision === "undefined" ? null : options?.precision,
          offset: options?.offset ?? false,
          local: options?.local ?? false,
          ...errorUtil2.errToObj(options?.message)
        });
      }
      date(message) {
        return this._addCheck({ kind: "date", message });
      }
      time(options) {
        if (typeof options === "string") {
          return this._addCheck({
            kind: "time",
            precision: null,
            message: options
          });
        }
        return this._addCheck({
          kind: "time",
          precision: typeof options?.precision === "undefined" ? null : options?.precision,
          ...errorUtil2.errToObj(options?.message)
        });
      }
      duration(message) {
        return this._addCheck({ kind: "duration", ...errorUtil2.errToObj(message) });
      }
      regex(regex, message) {
        return this._addCheck({
          kind: "regex",
          regex,
          ...errorUtil2.errToObj(message)
        });
      }
      includes(value, options) {
        return this._addCheck({
          kind: "includes",
          value,
          position: options?.position,
          ...errorUtil2.errToObj(options?.message)
        });
      }
      startsWith(value, message) {
        return this._addCheck({
          kind: "startsWith",
          value,
          ...errorUtil2.errToObj(message)
        });
      }
      endsWith(value, message) {
        return this._addCheck({
          kind: "endsWith",
          value,
          ...errorUtil2.errToObj(message)
        });
      }
      min(minLength, message) {
        return this._addCheck({
          kind: "min",
          value: minLength,
          ...errorUtil2.errToObj(message)
        });
      }
      max(maxLength, message) {
        return this._addCheck({
          kind: "max",
          value: maxLength,
          ...errorUtil2.errToObj(message)
        });
      }
      length(len, message) {
        return this._addCheck({
          kind: "length",
          value: len,
          ...errorUtil2.errToObj(message)
        });
      }
      /**
       * Equivalent to `.min(1)`
       */
      nonempty(message) {
        return this.min(1, errorUtil2.errToObj(message));
      }
      trim() {
        return new _ZodString2({
          ...this._def,
          checks: [...this._def.checks, { kind: "trim" }]
        });
      }
      toLowerCase() {
        return new _ZodString2({
          ...this._def,
          checks: [...this._def.checks, { kind: "toLowerCase" }]
        });
      }
      toUpperCase() {
        return new _ZodString2({
          ...this._def,
          checks: [...this._def.checks, { kind: "toUpperCase" }]
        });
      }
      get isDatetime() {
        return !!this._def.checks.find((ch) => ch.kind === "datetime");
      }
      get isDate() {
        return !!this._def.checks.find((ch) => ch.kind === "date");
      }
      get isTime() {
        return !!this._def.checks.find((ch) => ch.kind === "time");
      }
      get isDuration() {
        return !!this._def.checks.find((ch) => ch.kind === "duration");
      }
      get isEmail() {
        return !!this._def.checks.find((ch) => ch.kind === "email");
      }
      get isURL() {
        return !!this._def.checks.find((ch) => ch.kind === "url");
      }
      get isEmoji() {
        return !!this._def.checks.find((ch) => ch.kind === "emoji");
      }
      get isUUID() {
        return !!this._def.checks.find((ch) => ch.kind === "uuid");
      }
      get isNANOID() {
        return !!this._def.checks.find((ch) => ch.kind === "nanoid");
      }
      get isCUID() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid");
      }
      get isCUID2() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid2");
      }
      get isULID() {
        return !!this._def.checks.find((ch) => ch.kind === "ulid");
      }
      get isIP() {
        return !!this._def.checks.find((ch) => ch.kind === "ip");
      }
      get isCIDR() {
        return !!this._def.checks.find((ch) => ch.kind === "cidr");
      }
      get isBase64() {
        return !!this._def.checks.find((ch) => ch.kind === "base64");
      }
      get isBase64url() {
        return !!this._def.checks.find((ch) => ch.kind === "base64url");
      }
      get minLength() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min;
      }
      get maxLength() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max;
      }
    };
    ZodString2.create = (params) => {
      return new ZodString2({
        checks: [],
        typeName: ZodFirstPartyTypeKind2.ZodString,
        coerce: params?.coerce ?? false,
        ...processCreateParams2(params)
      });
    };
    ZodNumber2 = class _ZodNumber2 extends ZodType2 {
      constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
        this.step = this.multipleOf;
      }
      _parse(input) {
        if (this._def.coerce) {
          input.data = Number(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.number) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext2(ctx2, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.number,
            received: ctx2.parsedType
          });
          return INVALID2;
        }
        let ctx = void 0;
        const status = new ParseStatus2();
        for (const check of this._def.checks) {
          if (check.kind === "int") {
            if (!util2.isInteger(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.invalid_type,
                expected: "integer",
                received: "float",
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "min") {
            const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
            if (tooSmall) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_small,
                minimum: check.value,
                type: "number",
                inclusive: check.inclusive,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
            if (tooBig) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_big,
                maximum: check.value,
                type: "number",
                inclusive: check.inclusive,
                exact: false,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "multipleOf") {
            if (floatSafeRemainder2(input.data, check.value) !== 0) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.not_multiple_of,
                multipleOf: check.value,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "finite") {
            if (!Number.isFinite(input.data)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.not_finite,
                message: check.message
              });
              status.dirty();
            }
          } else {
            util2.assertNever(check);
          }
        }
        return { status: status.value, value: input.data };
      }
      gte(value, message) {
        return this.setLimit("min", value, true, errorUtil2.toString(message));
      }
      gt(value, message) {
        return this.setLimit("min", value, false, errorUtil2.toString(message));
      }
      lte(value, message) {
        return this.setLimit("max", value, true, errorUtil2.toString(message));
      }
      lt(value, message) {
        return this.setLimit("max", value, false, errorUtil2.toString(message));
      }
      setLimit(kind, value, inclusive, message) {
        return new _ZodNumber2({
          ...this._def,
          checks: [
            ...this._def.checks,
            {
              kind,
              value,
              inclusive,
              message: errorUtil2.toString(message)
            }
          ]
        });
      }
      _addCheck(check) {
        return new _ZodNumber2({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      int(message) {
        return this._addCheck({
          kind: "int",
          message: errorUtil2.toString(message)
        });
      }
      positive(message) {
        return this._addCheck({
          kind: "min",
          value: 0,
          inclusive: false,
          message: errorUtil2.toString(message)
        });
      }
      negative(message) {
        return this._addCheck({
          kind: "max",
          value: 0,
          inclusive: false,
          message: errorUtil2.toString(message)
        });
      }
      nonpositive(message) {
        return this._addCheck({
          kind: "max",
          value: 0,
          inclusive: true,
          message: errorUtil2.toString(message)
        });
      }
      nonnegative(message) {
        return this._addCheck({
          kind: "min",
          value: 0,
          inclusive: true,
          message: errorUtil2.toString(message)
        });
      }
      multipleOf(value, message) {
        return this._addCheck({
          kind: "multipleOf",
          value,
          message: errorUtil2.toString(message)
        });
      }
      finite(message) {
        return this._addCheck({
          kind: "finite",
          message: errorUtil2.toString(message)
        });
      }
      safe(message) {
        return this._addCheck({
          kind: "min",
          inclusive: true,
          value: Number.MIN_SAFE_INTEGER,
          message: errorUtil2.toString(message)
        })._addCheck({
          kind: "max",
          inclusive: true,
          value: Number.MAX_SAFE_INTEGER,
          message: errorUtil2.toString(message)
        });
      }
      get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min;
      }
      get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max;
      }
      get isInt() {
        return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util2.isInteger(ch.value));
      }
      get isFinite() {
        let max = null;
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
            return true;
          } else if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          } else if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return Number.isFinite(min) && Number.isFinite(max);
      }
    };
    ZodNumber2.create = (params) => {
      return new ZodNumber2({
        checks: [],
        typeName: ZodFirstPartyTypeKind2.ZodNumber,
        coerce: params?.coerce || false,
        ...processCreateParams2(params)
      });
    };
    ZodBigInt2 = class _ZodBigInt2 extends ZodType2 {
      constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
      }
      _parse(input) {
        if (this._def.coerce) {
          try {
            input.data = BigInt(input.data);
          } catch {
            return this._getInvalidInput(input);
          }
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.bigint) {
          return this._getInvalidInput(input);
        }
        let ctx = void 0;
        const status = new ParseStatus2();
        for (const check of this._def.checks) {
          if (check.kind === "min") {
            const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
            if (tooSmall) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_small,
                type: "bigint",
                minimum: check.value,
                inclusive: check.inclusive,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
            if (tooBig) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_big,
                type: "bigint",
                maximum: check.value,
                inclusive: check.inclusive,
                message: check.message
              });
              status.dirty();
            }
          } else if (check.kind === "multipleOf") {
            if (input.data % check.value !== BigInt(0)) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.not_multiple_of,
                multipleOf: check.value,
                message: check.message
              });
              status.dirty();
            }
          } else {
            util2.assertNever(check);
          }
        }
        return { status: status.value, value: input.data };
      }
      _getInvalidInput(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext2(ctx, {
          code: ZodIssueCode2.invalid_type,
          expected: ZodParsedType2.bigint,
          received: ctx.parsedType
        });
        return INVALID2;
      }
      gte(value, message) {
        return this.setLimit("min", value, true, errorUtil2.toString(message));
      }
      gt(value, message) {
        return this.setLimit("min", value, false, errorUtil2.toString(message));
      }
      lte(value, message) {
        return this.setLimit("max", value, true, errorUtil2.toString(message));
      }
      lt(value, message) {
        return this.setLimit("max", value, false, errorUtil2.toString(message));
      }
      setLimit(kind, value, inclusive, message) {
        return new _ZodBigInt2({
          ...this._def,
          checks: [
            ...this._def.checks,
            {
              kind,
              value,
              inclusive,
              message: errorUtil2.toString(message)
            }
          ]
        });
      }
      _addCheck(check) {
        return new _ZodBigInt2({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      positive(message) {
        return this._addCheck({
          kind: "min",
          value: BigInt(0),
          inclusive: false,
          message: errorUtil2.toString(message)
        });
      }
      negative(message) {
        return this._addCheck({
          kind: "max",
          value: BigInt(0),
          inclusive: false,
          message: errorUtil2.toString(message)
        });
      }
      nonpositive(message) {
        return this._addCheck({
          kind: "max",
          value: BigInt(0),
          inclusive: true,
          message: errorUtil2.toString(message)
        });
      }
      nonnegative(message) {
        return this._addCheck({
          kind: "min",
          value: BigInt(0),
          inclusive: true,
          message: errorUtil2.toString(message)
        });
      }
      multipleOf(value, message) {
        return this._addCheck({
          kind: "multipleOf",
          value,
          message: errorUtil2.toString(message)
        });
      }
      get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min;
      }
      get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max;
      }
    };
    ZodBigInt2.create = (params) => {
      return new ZodBigInt2({
        checks: [],
        typeName: ZodFirstPartyTypeKind2.ZodBigInt,
        coerce: params?.coerce ?? false,
        ...processCreateParams2(params)
      });
    };
    ZodBoolean2 = class extends ZodType2 {
      _parse(input) {
        if (this._def.coerce) {
          input.data = Boolean(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.boolean) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.boolean,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        return OK2(input.data);
      }
    };
    ZodBoolean2.create = (params) => {
      return new ZodBoolean2({
        typeName: ZodFirstPartyTypeKind2.ZodBoolean,
        coerce: params?.coerce || false,
        ...processCreateParams2(params)
      });
    };
    ZodDate2 = class _ZodDate2 extends ZodType2 {
      _parse(input) {
        if (this._def.coerce) {
          input.data = new Date(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.date) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext2(ctx2, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.date,
            received: ctx2.parsedType
          });
          return INVALID2;
        }
        if (Number.isNaN(input.data.getTime())) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext2(ctx2, {
            code: ZodIssueCode2.invalid_date
          });
          return INVALID2;
        }
        const status = new ParseStatus2();
        let ctx = void 0;
        for (const check of this._def.checks) {
          if (check.kind === "min") {
            if (input.data.getTime() < check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_small,
                message: check.message,
                inclusive: true,
                exact: false,
                minimum: check.value,
                type: "date"
              });
              status.dirty();
            }
          } else if (check.kind === "max") {
            if (input.data.getTime() > check.value) {
              ctx = this._getOrReturnCtx(input, ctx);
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.too_big,
                message: check.message,
                inclusive: true,
                exact: false,
                maximum: check.value,
                type: "date"
              });
              status.dirty();
            }
          } else {
            util2.assertNever(check);
          }
        }
        return {
          status: status.value,
          value: new Date(input.data.getTime())
        };
      }
      _addCheck(check) {
        return new _ZodDate2({
          ...this._def,
          checks: [...this._def.checks, check]
        });
      }
      min(minDate, message) {
        return this._addCheck({
          kind: "min",
          value: minDate.getTime(),
          message: errorUtil2.toString(message)
        });
      }
      max(maxDate, message) {
        return this._addCheck({
          kind: "max",
          value: maxDate.getTime(),
          message: errorUtil2.toString(message)
        });
      }
      get minDate() {
        let min = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "min") {
            if (min === null || ch.value > min)
              min = ch.value;
          }
        }
        return min != null ? new Date(min) : null;
      }
      get maxDate() {
        let max = null;
        for (const ch of this._def.checks) {
          if (ch.kind === "max") {
            if (max === null || ch.value < max)
              max = ch.value;
          }
        }
        return max != null ? new Date(max) : null;
      }
    };
    ZodDate2.create = (params) => {
      return new ZodDate2({
        checks: [],
        coerce: params?.coerce || false,
        typeName: ZodFirstPartyTypeKind2.ZodDate,
        ...processCreateParams2(params)
      });
    };
    ZodSymbol2 = class extends ZodType2 {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.symbol) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.symbol,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        return OK2(input.data);
      }
    };
    ZodSymbol2.create = (params) => {
      return new ZodSymbol2({
        typeName: ZodFirstPartyTypeKind2.ZodSymbol,
        ...processCreateParams2(params)
      });
    };
    ZodUndefined2 = class extends ZodType2 {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.undefined) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.undefined,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        return OK2(input.data);
      }
    };
    ZodUndefined2.create = (params) => {
      return new ZodUndefined2({
        typeName: ZodFirstPartyTypeKind2.ZodUndefined,
        ...processCreateParams2(params)
      });
    };
    ZodNull2 = class extends ZodType2 {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.null) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.null,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        return OK2(input.data);
      }
    };
    ZodNull2.create = (params) => {
      return new ZodNull2({
        typeName: ZodFirstPartyTypeKind2.ZodNull,
        ...processCreateParams2(params)
      });
    };
    ZodAny2 = class extends ZodType2 {
      constructor() {
        super(...arguments);
        this._any = true;
      }
      _parse(input) {
        return OK2(input.data);
      }
    };
    ZodAny2.create = (params) => {
      return new ZodAny2({
        typeName: ZodFirstPartyTypeKind2.ZodAny,
        ...processCreateParams2(params)
      });
    };
    ZodUnknown2 = class extends ZodType2 {
      constructor() {
        super(...arguments);
        this._unknown = true;
      }
      _parse(input) {
        return OK2(input.data);
      }
    };
    ZodUnknown2.create = (params) => {
      return new ZodUnknown2({
        typeName: ZodFirstPartyTypeKind2.ZodUnknown,
        ...processCreateParams2(params)
      });
    };
    ZodNever2 = class extends ZodType2 {
      _parse(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext2(ctx, {
          code: ZodIssueCode2.invalid_type,
          expected: ZodParsedType2.never,
          received: ctx.parsedType
        });
        return INVALID2;
      }
    };
    ZodNever2.create = (params) => {
      return new ZodNever2({
        typeName: ZodFirstPartyTypeKind2.ZodNever,
        ...processCreateParams2(params)
      });
    };
    ZodVoid2 = class extends ZodType2 {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.undefined) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.void,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        return OK2(input.data);
      }
    };
    ZodVoid2.create = (params) => {
      return new ZodVoid2({
        typeName: ZodFirstPartyTypeKind2.ZodVoid,
        ...processCreateParams2(params)
      });
    };
    ZodArray2 = class _ZodArray2 extends ZodType2 {
      _parse(input) {
        const { ctx, status } = this._processInputParams(input);
        const def = this._def;
        if (ctx.parsedType !== ZodParsedType2.array) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.array,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        if (def.exactLength !== null) {
          const tooBig = ctx.data.length > def.exactLength.value;
          const tooSmall = ctx.data.length < def.exactLength.value;
          if (tooBig || tooSmall) {
            addIssueToContext2(ctx, {
              code: tooBig ? ZodIssueCode2.too_big : ZodIssueCode2.too_small,
              minimum: tooSmall ? def.exactLength.value : void 0,
              maximum: tooBig ? def.exactLength.value : void 0,
              type: "array",
              inclusive: true,
              exact: true,
              message: def.exactLength.message
            });
            status.dirty();
          }
        }
        if (def.minLength !== null) {
          if (ctx.data.length < def.minLength.value) {
            addIssueToContext2(ctx, {
              code: ZodIssueCode2.too_small,
              minimum: def.minLength.value,
              type: "array",
              inclusive: true,
              exact: false,
              message: def.minLength.message
            });
            status.dirty();
          }
        }
        if (def.maxLength !== null) {
          if (ctx.data.length > def.maxLength.value) {
            addIssueToContext2(ctx, {
              code: ZodIssueCode2.too_big,
              maximum: def.maxLength.value,
              type: "array",
              inclusive: true,
              exact: false,
              message: def.maxLength.message
            });
            status.dirty();
          }
        }
        if (ctx.common.async) {
          return Promise.all([...ctx.data].map((item, i) => {
            return def.type._parseAsync(new ParseInputLazyPath2(ctx, item, ctx.path, i));
          })).then((result2) => {
            return ParseStatus2.mergeArray(status, result2);
          });
        }
        const result = [...ctx.data].map((item, i) => {
          return def.type._parseSync(new ParseInputLazyPath2(ctx, item, ctx.path, i));
        });
        return ParseStatus2.mergeArray(status, result);
      }
      get element() {
        return this._def.type;
      }
      min(minLength, message) {
        return new _ZodArray2({
          ...this._def,
          minLength: { value: minLength, message: errorUtil2.toString(message) }
        });
      }
      max(maxLength, message) {
        return new _ZodArray2({
          ...this._def,
          maxLength: { value: maxLength, message: errorUtil2.toString(message) }
        });
      }
      length(len, message) {
        return new _ZodArray2({
          ...this._def,
          exactLength: { value: len, message: errorUtil2.toString(message) }
        });
      }
      nonempty(message) {
        return this.min(1, message);
      }
    };
    ZodArray2.create = (schema, params) => {
      return new ZodArray2({
        type: schema,
        minLength: null,
        maxLength: null,
        exactLength: null,
        typeName: ZodFirstPartyTypeKind2.ZodArray,
        ...processCreateParams2(params)
      });
    };
    ZodObject2 = class _ZodObject2 extends ZodType2 {
      constructor() {
        super(...arguments);
        this._cached = null;
        this.nonstrict = this.passthrough;
        this.augment = this.extend;
      }
      _getCached() {
        if (this._cached !== null)
          return this._cached;
        const shape = this._def.shape();
        const keys = util2.objectKeys(shape);
        this._cached = { shape, keys };
        return this._cached;
      }
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.object) {
          const ctx2 = this._getOrReturnCtx(input);
          addIssueToContext2(ctx2, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.object,
            received: ctx2.parsedType
          });
          return INVALID2;
        }
        const { status, ctx } = this._processInputParams(input);
        const { shape, keys: shapeKeys } = this._getCached();
        const extraKeys = [];
        if (!(this._def.catchall instanceof ZodNever2 && this._def.unknownKeys === "strip")) {
          for (const key in ctx.data) {
            if (!shapeKeys.includes(key)) {
              extraKeys.push(key);
            }
          }
        }
        const pairs = [];
        for (const key of shapeKeys) {
          const keyValidator = shape[key];
          const value = ctx.data[key];
          pairs.push({
            key: { status: "valid", value: key },
            value: keyValidator._parse(new ParseInputLazyPath2(ctx, value, ctx.path, key)),
            alwaysSet: key in ctx.data
          });
        }
        if (this._def.catchall instanceof ZodNever2) {
          const unknownKeys = this._def.unknownKeys;
          if (unknownKeys === "passthrough") {
            for (const key of extraKeys) {
              pairs.push({
                key: { status: "valid", value: key },
                value: { status: "valid", value: ctx.data[key] }
              });
            }
          } else if (unknownKeys === "strict") {
            if (extraKeys.length > 0) {
              addIssueToContext2(ctx, {
                code: ZodIssueCode2.unrecognized_keys,
                keys: extraKeys
              });
              status.dirty();
            }
          } else if (unknownKeys === "strip") {
          } else {
            throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
          }
        } else {
          const catchall = this._def.catchall;
          for (const key of extraKeys) {
            const value = ctx.data[key];
            pairs.push({
              key: { status: "valid", value: key },
              value: catchall._parse(
                new ParseInputLazyPath2(ctx, value, ctx.path, key)
                //, ctx.child(key), value, getParsedType(value)
              ),
              alwaysSet: key in ctx.data
            });
          }
        }
        if (ctx.common.async) {
          return Promise.resolve().then(async () => {
            const syncPairs = [];
            for (const pair of pairs) {
              const key = await pair.key;
              const value = await pair.value;
              syncPairs.push({
                key,
                value,
                alwaysSet: pair.alwaysSet
              });
            }
            return syncPairs;
          }).then((syncPairs) => {
            return ParseStatus2.mergeObjectSync(status, syncPairs);
          });
        } else {
          return ParseStatus2.mergeObjectSync(status, pairs);
        }
      }
      get shape() {
        return this._def.shape();
      }
      strict(message) {
        errorUtil2.errToObj;
        return new _ZodObject2({
          ...this._def,
          unknownKeys: "strict",
          ...message !== void 0 ? {
            errorMap: (issue, ctx) => {
              const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
              if (issue.code === "unrecognized_keys")
                return {
                  message: errorUtil2.errToObj(message).message ?? defaultError
                };
              return {
                message: defaultError
              };
            }
          } : {}
        });
      }
      strip() {
        return new _ZodObject2({
          ...this._def,
          unknownKeys: "strip"
        });
      }
      passthrough() {
        return new _ZodObject2({
          ...this._def,
          unknownKeys: "passthrough"
        });
      }
      // const AugmentFactory =
      //   <Def extends ZodObjectDef>(def: Def) =>
      //   <Augmentation extends ZodRawShape>(
      //     augmentation: Augmentation
      //   ): ZodObject<
      //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
      //     Def["unknownKeys"],
      //     Def["catchall"]
      //   > => {
      //     return new ZodObject({
      //       ...def,
      //       shape: () => ({
      //         ...def.shape(),
      //         ...augmentation,
      //       }),
      //     }) as any;
      //   };
      extend(augmentation) {
        return new _ZodObject2({
          ...this._def,
          shape: () => ({
            ...this._def.shape(),
            ...augmentation
          })
        });
      }
      /**
       * Prior to zod@1.0.12 there was a bug in the
       * inferred type of merged objects. Please
       * upgrade if you are experiencing issues.
       */
      merge(merging) {
        const merged = new _ZodObject2({
          unknownKeys: merging._def.unknownKeys,
          catchall: merging._def.catchall,
          shape: () => ({
            ...this._def.shape(),
            ...merging._def.shape()
          }),
          typeName: ZodFirstPartyTypeKind2.ZodObject
        });
        return merged;
      }
      // merge<
      //   Incoming extends AnyZodObject,
      //   Augmentation extends Incoming["shape"],
      //   NewOutput extends {
      //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
      //       ? Augmentation[k]["_output"]
      //       : k extends keyof Output
      //       ? Output[k]
      //       : never;
      //   },
      //   NewInput extends {
      //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
      //       ? Augmentation[k]["_input"]
      //       : k extends keyof Input
      //       ? Input[k]
      //       : never;
      //   }
      // >(
      //   merging: Incoming
      // ): ZodObject<
      //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
      //   Incoming["_def"]["unknownKeys"],
      //   Incoming["_def"]["catchall"],
      //   NewOutput,
      //   NewInput
      // > {
      //   const merged: any = new ZodObject({
      //     unknownKeys: merging._def.unknownKeys,
      //     catchall: merging._def.catchall,
      //     shape: () =>
      //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
      //     typeName: ZodFirstPartyTypeKind.ZodObject,
      //   }) as any;
      //   return merged;
      // }
      setKey(key, schema) {
        return this.augment({ [key]: schema });
      }
      // merge<Incoming extends AnyZodObject>(
      //   merging: Incoming
      // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
      // ZodObject<
      //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
      //   Incoming["_def"]["unknownKeys"],
      //   Incoming["_def"]["catchall"]
      // > {
      //   // const mergedShape = objectUtil.mergeShapes(
      //   //   this._def.shape(),
      //   //   merging._def.shape()
      //   // );
      //   const merged: any = new ZodObject({
      //     unknownKeys: merging._def.unknownKeys,
      //     catchall: merging._def.catchall,
      //     shape: () =>
      //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
      //     typeName: ZodFirstPartyTypeKind.ZodObject,
      //   }) as any;
      //   return merged;
      // }
      catchall(index) {
        return new _ZodObject2({
          ...this._def,
          catchall: index
        });
      }
      pick(mask) {
        const shape = {};
        for (const key of util2.objectKeys(mask)) {
          if (mask[key] && this.shape[key]) {
            shape[key] = this.shape[key];
          }
        }
        return new _ZodObject2({
          ...this._def,
          shape: () => shape
        });
      }
      omit(mask) {
        const shape = {};
        for (const key of util2.objectKeys(this.shape)) {
          if (!mask[key]) {
            shape[key] = this.shape[key];
          }
        }
        return new _ZodObject2({
          ...this._def,
          shape: () => shape
        });
      }
      /**
       * @deprecated
       */
      deepPartial() {
        return deepPartialify2(this);
      }
      partial(mask) {
        const newShape = {};
        for (const key of util2.objectKeys(this.shape)) {
          const fieldSchema = this.shape[key];
          if (mask && !mask[key]) {
            newShape[key] = fieldSchema;
          } else {
            newShape[key] = fieldSchema.optional();
          }
        }
        return new _ZodObject2({
          ...this._def,
          shape: () => newShape
        });
      }
      required(mask) {
        const newShape = {};
        for (const key of util2.objectKeys(this.shape)) {
          if (mask && !mask[key]) {
            newShape[key] = this.shape[key];
          } else {
            const fieldSchema = this.shape[key];
            let newField = fieldSchema;
            while (newField instanceof ZodOptional2) {
              newField = newField._def.innerType;
            }
            newShape[key] = newField;
          }
        }
        return new _ZodObject2({
          ...this._def,
          shape: () => newShape
        });
      }
      keyof() {
        return createZodEnum2(util2.objectKeys(this.shape));
      }
    };
    ZodObject2.create = (shape, params) => {
      return new ZodObject2({
        shape: () => shape,
        unknownKeys: "strip",
        catchall: ZodNever2.create(),
        typeName: ZodFirstPartyTypeKind2.ZodObject,
        ...processCreateParams2(params)
      });
    };
    ZodObject2.strictCreate = (shape, params) => {
      return new ZodObject2({
        shape: () => shape,
        unknownKeys: "strict",
        catchall: ZodNever2.create(),
        typeName: ZodFirstPartyTypeKind2.ZodObject,
        ...processCreateParams2(params)
      });
    };
    ZodObject2.lazycreate = (shape, params) => {
      return new ZodObject2({
        shape,
        unknownKeys: "strip",
        catchall: ZodNever2.create(),
        typeName: ZodFirstPartyTypeKind2.ZodObject,
        ...processCreateParams2(params)
      });
    };
    ZodUnion2 = class extends ZodType2 {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const options = this._def.options;
        function handleResults(results) {
          for (const result of results) {
            if (result.result.status === "valid") {
              return result.result;
            }
          }
          for (const result of results) {
            if (result.result.status === "dirty") {
              ctx.common.issues.push(...result.ctx.common.issues);
              return result.result;
            }
          }
          const unionErrors = results.map((result) => new ZodError2(result.ctx.common.issues));
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_union,
            unionErrors
          });
          return INVALID2;
        }
        if (ctx.common.async) {
          return Promise.all(options.map(async (option) => {
            const childCtx = {
              ...ctx,
              common: {
                ...ctx.common,
                issues: []
              },
              parent: null
            };
            return {
              result: await option._parseAsync({
                data: ctx.data,
                path: ctx.path,
                parent: childCtx
              }),
              ctx: childCtx
            };
          })).then(handleResults);
        } else {
          let dirty = void 0;
          const issues = [];
          for (const option of options) {
            const childCtx = {
              ...ctx,
              common: {
                ...ctx.common,
                issues: []
              },
              parent: null
            };
            const result = option._parseSync({
              data: ctx.data,
              path: ctx.path,
              parent: childCtx
            });
            if (result.status === "valid") {
              return result;
            } else if (result.status === "dirty" && !dirty) {
              dirty = { result, ctx: childCtx };
            }
            if (childCtx.common.issues.length) {
              issues.push(childCtx.common.issues);
            }
          }
          if (dirty) {
            ctx.common.issues.push(...dirty.ctx.common.issues);
            return dirty.result;
          }
          const unionErrors = issues.map((issues2) => new ZodError2(issues2));
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_union,
            unionErrors
          });
          return INVALID2;
        }
      }
      get options() {
        return this._def.options;
      }
    };
    ZodUnion2.create = (types, params) => {
      return new ZodUnion2({
        options: types,
        typeName: ZodFirstPartyTypeKind2.ZodUnion,
        ...processCreateParams2(params)
      });
    };
    getDiscriminator2 = (type) => {
      if (type instanceof ZodLazy2) {
        return getDiscriminator2(type.schema);
      } else if (type instanceof ZodEffects2) {
        return getDiscriminator2(type.innerType());
      } else if (type instanceof ZodLiteral2) {
        return [type.value];
      } else if (type instanceof ZodEnum2) {
        return type.options;
      } else if (type instanceof ZodNativeEnum2) {
        return util2.objectValues(type.enum);
      } else if (type instanceof ZodDefault2) {
        return getDiscriminator2(type._def.innerType);
      } else if (type instanceof ZodUndefined2) {
        return [void 0];
      } else if (type instanceof ZodNull2) {
        return [null];
      } else if (type instanceof ZodOptional2) {
        return [void 0, ...getDiscriminator2(type.unwrap())];
      } else if (type instanceof ZodNullable2) {
        return [null, ...getDiscriminator2(type.unwrap())];
      } else if (type instanceof ZodBranded2) {
        return getDiscriminator2(type.unwrap());
      } else if (type instanceof ZodReadonly2) {
        return getDiscriminator2(type.unwrap());
      } else if (type instanceof ZodCatch2) {
        return getDiscriminator2(type._def.innerType);
      } else {
        return [];
      }
    };
    ZodDiscriminatedUnion2 = class _ZodDiscriminatedUnion2 extends ZodType2 {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType2.object) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.object,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        const discriminator = this.discriminator;
        const discriminatorValue = ctx.data[discriminator];
        const option = this.optionsMap.get(discriminatorValue);
        if (!option) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_union_discriminator,
            options: Array.from(this.optionsMap.keys()),
            path: [discriminator]
          });
          return INVALID2;
        }
        if (ctx.common.async) {
          return option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
        } else {
          return option._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
        }
      }
      get discriminator() {
        return this._def.discriminator;
      }
      get options() {
        return this._def.options;
      }
      get optionsMap() {
        return this._def.optionsMap;
      }
      /**
       * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
       * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
       * have a different value for each object in the union.
       * @param discriminator the name of the discriminator property
       * @param types an array of object schemas
       * @param params
       */
      static create(discriminator, options, params) {
        const optionsMap = /* @__PURE__ */ new Map();
        for (const type of options) {
          const discriminatorValues = getDiscriminator2(type.shape[discriminator]);
          if (!discriminatorValues.length) {
            throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
          }
          for (const value of discriminatorValues) {
            if (optionsMap.has(value)) {
              throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
            }
            optionsMap.set(value, type);
          }
        }
        return new _ZodDiscriminatedUnion2({
          typeName: ZodFirstPartyTypeKind2.ZodDiscriminatedUnion,
          discriminator,
          options,
          optionsMap,
          ...processCreateParams2(params)
        });
      }
    };
    ZodIntersection2 = class extends ZodType2 {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const handleParsed = (parsedLeft, parsedRight) => {
          if (isAborted2(parsedLeft) || isAborted2(parsedRight)) {
            return INVALID2;
          }
          const merged = mergeValues2(parsedLeft.value, parsedRight.value);
          if (!merged.valid) {
            addIssueToContext2(ctx, {
              code: ZodIssueCode2.invalid_intersection_types
            });
            return INVALID2;
          }
          if (isDirty2(parsedLeft) || isDirty2(parsedRight)) {
            status.dirty();
          }
          return { status: status.value, value: merged.data };
        };
        if (ctx.common.async) {
          return Promise.all([
            this._def.left._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            }),
            this._def.right._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            })
          ]).then(([left, right]) => handleParsed(left, right));
        } else {
          return handleParsed(this._def.left._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          }), this._def.right._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          }));
        }
      }
    };
    ZodIntersection2.create = (left, right, params) => {
      return new ZodIntersection2({
        left,
        right,
        typeName: ZodFirstPartyTypeKind2.ZodIntersection,
        ...processCreateParams2(params)
      });
    };
    ZodTuple2 = class _ZodTuple2 extends ZodType2 {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType2.array) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.array,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        if (ctx.data.length < this._def.items.length) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.too_small,
            minimum: this._def.items.length,
            inclusive: true,
            exact: false,
            type: "array"
          });
          return INVALID2;
        }
        const rest = this._def.rest;
        if (!rest && ctx.data.length > this._def.items.length) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.too_big,
            maximum: this._def.items.length,
            inclusive: true,
            exact: false,
            type: "array"
          });
          status.dirty();
        }
        const items = [...ctx.data].map((item, itemIndex) => {
          const schema = this._def.items[itemIndex] || this._def.rest;
          if (!schema)
            return null;
          return schema._parse(new ParseInputLazyPath2(ctx, item, ctx.path, itemIndex));
        }).filter((x) => !!x);
        if (ctx.common.async) {
          return Promise.all(items).then((results) => {
            return ParseStatus2.mergeArray(status, results);
          });
        } else {
          return ParseStatus2.mergeArray(status, items);
        }
      }
      get items() {
        return this._def.items;
      }
      rest(rest) {
        return new _ZodTuple2({
          ...this._def,
          rest
        });
      }
    };
    ZodTuple2.create = (schemas, params) => {
      if (!Array.isArray(schemas)) {
        throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
      }
      return new ZodTuple2({
        items: schemas,
        typeName: ZodFirstPartyTypeKind2.ZodTuple,
        rest: null,
        ...processCreateParams2(params)
      });
    };
    ZodRecord2 = class _ZodRecord2 extends ZodType2 {
      get keySchema() {
        return this._def.keyType;
      }
      get valueSchema() {
        return this._def.valueType;
      }
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType2.object) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.object,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        const pairs = [];
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        for (const key in ctx.data) {
          pairs.push({
            key: keyType._parse(new ParseInputLazyPath2(ctx, key, ctx.path, key)),
            value: valueType._parse(new ParseInputLazyPath2(ctx, ctx.data[key], ctx.path, key)),
            alwaysSet: key in ctx.data
          });
        }
        if (ctx.common.async) {
          return ParseStatus2.mergeObjectAsync(status, pairs);
        } else {
          return ParseStatus2.mergeObjectSync(status, pairs);
        }
      }
      get element() {
        return this._def.valueType;
      }
      static create(first, second, third) {
        if (second instanceof ZodType2) {
          return new _ZodRecord2({
            keyType: first,
            valueType: second,
            typeName: ZodFirstPartyTypeKind2.ZodRecord,
            ...processCreateParams2(third)
          });
        }
        return new _ZodRecord2({
          keyType: ZodString2.create(),
          valueType: first,
          typeName: ZodFirstPartyTypeKind2.ZodRecord,
          ...processCreateParams2(second)
        });
      }
    };
    ZodMap2 = class extends ZodType2 {
      get keySchema() {
        return this._def.keyType;
      }
      get valueSchema() {
        return this._def.valueType;
      }
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType2.map) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.map,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        const pairs = [...ctx.data.entries()].map(([key, value], index) => {
          return {
            key: keyType._parse(new ParseInputLazyPath2(ctx, key, ctx.path, [index, "key"])),
            value: valueType._parse(new ParseInputLazyPath2(ctx, value, ctx.path, [index, "value"]))
          };
        });
        if (ctx.common.async) {
          const finalMap = /* @__PURE__ */ new Map();
          return Promise.resolve().then(async () => {
            for (const pair of pairs) {
              const key = await pair.key;
              const value = await pair.value;
              if (key.status === "aborted" || value.status === "aborted") {
                return INVALID2;
              }
              if (key.status === "dirty" || value.status === "dirty") {
                status.dirty();
              }
              finalMap.set(key.value, value.value);
            }
            return { status: status.value, value: finalMap };
          });
        } else {
          const finalMap = /* @__PURE__ */ new Map();
          for (const pair of pairs) {
            const key = pair.key;
            const value = pair.value;
            if (key.status === "aborted" || value.status === "aborted") {
              return INVALID2;
            }
            if (key.status === "dirty" || value.status === "dirty") {
              status.dirty();
            }
            finalMap.set(key.value, value.value);
          }
          return { status: status.value, value: finalMap };
        }
      }
    };
    ZodMap2.create = (keyType, valueType, params) => {
      return new ZodMap2({
        valueType,
        keyType,
        typeName: ZodFirstPartyTypeKind2.ZodMap,
        ...processCreateParams2(params)
      });
    };
    ZodSet2 = class _ZodSet2 extends ZodType2 {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType2.set) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.set,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        const def = this._def;
        if (def.minSize !== null) {
          if (ctx.data.size < def.minSize.value) {
            addIssueToContext2(ctx, {
              code: ZodIssueCode2.too_small,
              minimum: def.minSize.value,
              type: "set",
              inclusive: true,
              exact: false,
              message: def.minSize.message
            });
            status.dirty();
          }
        }
        if (def.maxSize !== null) {
          if (ctx.data.size > def.maxSize.value) {
            addIssueToContext2(ctx, {
              code: ZodIssueCode2.too_big,
              maximum: def.maxSize.value,
              type: "set",
              inclusive: true,
              exact: false,
              message: def.maxSize.message
            });
            status.dirty();
          }
        }
        const valueType = this._def.valueType;
        function finalizeSet(elements2) {
          const parsedSet = /* @__PURE__ */ new Set();
          for (const element of elements2) {
            if (element.status === "aborted")
              return INVALID2;
            if (element.status === "dirty")
              status.dirty();
            parsedSet.add(element.value);
          }
          return { status: status.value, value: parsedSet };
        }
        const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath2(ctx, item, ctx.path, i)));
        if (ctx.common.async) {
          return Promise.all(elements).then((elements2) => finalizeSet(elements2));
        } else {
          return finalizeSet(elements);
        }
      }
      min(minSize, message) {
        return new _ZodSet2({
          ...this._def,
          minSize: { value: minSize, message: errorUtil2.toString(message) }
        });
      }
      max(maxSize, message) {
        return new _ZodSet2({
          ...this._def,
          maxSize: { value: maxSize, message: errorUtil2.toString(message) }
        });
      }
      size(size, message) {
        return this.min(size, message).max(size, message);
      }
      nonempty(message) {
        return this.min(1, message);
      }
    };
    ZodSet2.create = (valueType, params) => {
      return new ZodSet2({
        valueType,
        minSize: null,
        maxSize: null,
        typeName: ZodFirstPartyTypeKind2.ZodSet,
        ...processCreateParams2(params)
      });
    };
    ZodFunction2 = class _ZodFunction2 extends ZodType2 {
      constructor() {
        super(...arguments);
        this.validate = this.implement;
      }
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType2.function) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.function,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        function makeArgsIssue(args, error) {
          return makeIssue2({
            data: args,
            path: ctx.path,
            errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap2(), en_default2].filter((x) => !!x),
            issueData: {
              code: ZodIssueCode2.invalid_arguments,
              argumentsError: error
            }
          });
        }
        function makeReturnsIssue(returns, error) {
          return makeIssue2({
            data: returns,
            path: ctx.path,
            errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap2(), en_default2].filter((x) => !!x),
            issueData: {
              code: ZodIssueCode2.invalid_return_type,
              returnTypeError: error
            }
          });
        }
        const params = { errorMap: ctx.common.contextualErrorMap };
        const fn = ctx.data;
        if (this._def.returns instanceof ZodPromise2) {
          const me = this;
          return OK2(async function(...args) {
            const error = new ZodError2([]);
            const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
              error.addIssue(makeArgsIssue(args, e));
              throw error;
            });
            const result = await Reflect.apply(fn, this, parsedArgs);
            const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
              error.addIssue(makeReturnsIssue(result, e));
              throw error;
            });
            return parsedReturns;
          });
        } else {
          const me = this;
          return OK2(function(...args) {
            const parsedArgs = me._def.args.safeParse(args, params);
            if (!parsedArgs.success) {
              throw new ZodError2([makeArgsIssue(args, parsedArgs.error)]);
            }
            const result = Reflect.apply(fn, this, parsedArgs.data);
            const parsedReturns = me._def.returns.safeParse(result, params);
            if (!parsedReturns.success) {
              throw new ZodError2([makeReturnsIssue(result, parsedReturns.error)]);
            }
            return parsedReturns.data;
          });
        }
      }
      parameters() {
        return this._def.args;
      }
      returnType() {
        return this._def.returns;
      }
      args(...items) {
        return new _ZodFunction2({
          ...this._def,
          args: ZodTuple2.create(items).rest(ZodUnknown2.create())
        });
      }
      returns(returnType) {
        return new _ZodFunction2({
          ...this._def,
          returns: returnType
        });
      }
      implement(func) {
        const validatedFunc = this.parse(func);
        return validatedFunc;
      }
      strictImplement(func) {
        const validatedFunc = this.parse(func);
        return validatedFunc;
      }
      static create(args, returns, params) {
        return new _ZodFunction2({
          args: args ? args : ZodTuple2.create([]).rest(ZodUnknown2.create()),
          returns: returns || ZodUnknown2.create(),
          typeName: ZodFirstPartyTypeKind2.ZodFunction,
          ...processCreateParams2(params)
        });
      }
    };
    ZodLazy2 = class extends ZodType2 {
      get schema() {
        return this._def.getter();
      }
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const lazySchema = this._def.getter();
        return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
      }
    };
    ZodLazy2.create = (getter, params) => {
      return new ZodLazy2({
        getter,
        typeName: ZodFirstPartyTypeKind2.ZodLazy,
        ...processCreateParams2(params)
      });
    };
    ZodLiteral2 = class extends ZodType2 {
      _parse(input) {
        if (input.data !== this._def.value) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext2(ctx, {
            received: ctx.data,
            code: ZodIssueCode2.invalid_literal,
            expected: this._def.value
          });
          return INVALID2;
        }
        return { status: "valid", value: input.data };
      }
      get value() {
        return this._def.value;
      }
    };
    ZodLiteral2.create = (value, params) => {
      return new ZodLiteral2({
        value,
        typeName: ZodFirstPartyTypeKind2.ZodLiteral,
        ...processCreateParams2(params)
      });
    };
    ZodEnum2 = class _ZodEnum2 extends ZodType2 {
      _parse(input) {
        if (typeof input.data !== "string") {
          const ctx = this._getOrReturnCtx(input);
          const expectedValues = this._def.values;
          addIssueToContext2(ctx, {
            expected: util2.joinValues(expectedValues),
            received: ctx.parsedType,
            code: ZodIssueCode2.invalid_type
          });
          return INVALID2;
        }
        if (!this._cache) {
          this._cache = new Set(this._def.values);
        }
        if (!this._cache.has(input.data)) {
          const ctx = this._getOrReturnCtx(input);
          const expectedValues = this._def.values;
          addIssueToContext2(ctx, {
            received: ctx.data,
            code: ZodIssueCode2.invalid_enum_value,
            options: expectedValues
          });
          return INVALID2;
        }
        return OK2(input.data);
      }
      get options() {
        return this._def.values;
      }
      get enum() {
        const enumValues = {};
        for (const val of this._def.values) {
          enumValues[val] = val;
        }
        return enumValues;
      }
      get Values() {
        const enumValues = {};
        for (const val of this._def.values) {
          enumValues[val] = val;
        }
        return enumValues;
      }
      get Enum() {
        const enumValues = {};
        for (const val of this._def.values) {
          enumValues[val] = val;
        }
        return enumValues;
      }
      extract(values, newDef = this._def) {
        return _ZodEnum2.create(values, {
          ...this._def,
          ...newDef
        });
      }
      exclude(values, newDef = this._def) {
        return _ZodEnum2.create(this.options.filter((opt) => !values.includes(opt)), {
          ...this._def,
          ...newDef
        });
      }
    };
    ZodEnum2.create = createZodEnum2;
    ZodNativeEnum2 = class extends ZodType2 {
      _parse(input) {
        const nativeEnumValues = util2.getValidEnumValues(this._def.values);
        const ctx = this._getOrReturnCtx(input);
        if (ctx.parsedType !== ZodParsedType2.string && ctx.parsedType !== ZodParsedType2.number) {
          const expectedValues = util2.objectValues(nativeEnumValues);
          addIssueToContext2(ctx, {
            expected: util2.joinValues(expectedValues),
            received: ctx.parsedType,
            code: ZodIssueCode2.invalid_type
          });
          return INVALID2;
        }
        if (!this._cache) {
          this._cache = new Set(util2.getValidEnumValues(this._def.values));
        }
        if (!this._cache.has(input.data)) {
          const expectedValues = util2.objectValues(nativeEnumValues);
          addIssueToContext2(ctx, {
            received: ctx.data,
            code: ZodIssueCode2.invalid_enum_value,
            options: expectedValues
          });
          return INVALID2;
        }
        return OK2(input.data);
      }
      get enum() {
        return this._def.values;
      }
    };
    ZodNativeEnum2.create = (values, params) => {
      return new ZodNativeEnum2({
        values,
        typeName: ZodFirstPartyTypeKind2.ZodNativeEnum,
        ...processCreateParams2(params)
      });
    };
    ZodPromise2 = class extends ZodType2 {
      unwrap() {
        return this._def.type;
      }
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType2.promise && ctx.common.async === false) {
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.promise,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        const promisified = ctx.parsedType === ZodParsedType2.promise ? ctx.data : Promise.resolve(ctx.data);
        return OK2(promisified.then((data) => {
          return this._def.type.parseAsync(data, {
            path: ctx.path,
            errorMap: ctx.common.contextualErrorMap
          });
        }));
      }
    };
    ZodPromise2.create = (schema, params) => {
      return new ZodPromise2({
        type: schema,
        typeName: ZodFirstPartyTypeKind2.ZodPromise,
        ...processCreateParams2(params)
      });
    };
    ZodEffects2 = class extends ZodType2 {
      innerType() {
        return this._def.schema;
      }
      sourceType() {
        return this._def.schema._def.typeName === ZodFirstPartyTypeKind2.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
      }
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const effect = this._def.effect || null;
        const checkCtx = {
          addIssue: (arg) => {
            addIssueToContext2(ctx, arg);
            if (arg.fatal) {
              status.abort();
            } else {
              status.dirty();
            }
          },
          get path() {
            return ctx.path;
          }
        };
        checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
        if (effect.type === "preprocess") {
          const processed = effect.transform(ctx.data, checkCtx);
          if (ctx.common.async) {
            return Promise.resolve(processed).then(async (processed2) => {
              if (status.value === "aborted")
                return INVALID2;
              const result = await this._def.schema._parseAsync({
                data: processed2,
                path: ctx.path,
                parent: ctx
              });
              if (result.status === "aborted")
                return INVALID2;
              if (result.status === "dirty")
                return DIRTY2(result.value);
              if (status.value === "dirty")
                return DIRTY2(result.value);
              return result;
            });
          } else {
            if (status.value === "aborted")
              return INVALID2;
            const result = this._def.schema._parseSync({
              data: processed,
              path: ctx.path,
              parent: ctx
            });
            if (result.status === "aborted")
              return INVALID2;
            if (result.status === "dirty")
              return DIRTY2(result.value);
            if (status.value === "dirty")
              return DIRTY2(result.value);
            return result;
          }
        }
        if (effect.type === "refinement") {
          const executeRefinement = (acc) => {
            const result = effect.refinement(acc, checkCtx);
            if (ctx.common.async) {
              return Promise.resolve(result);
            }
            if (result instanceof Promise) {
              throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
            }
            return acc;
          };
          if (ctx.common.async === false) {
            const inner = this._def.schema._parseSync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            });
            if (inner.status === "aborted")
              return INVALID2;
            if (inner.status === "dirty")
              status.dirty();
            executeRefinement(inner.value);
            return { status: status.value, value: inner.value };
          } else {
            return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
              if (inner.status === "aborted")
                return INVALID2;
              if (inner.status === "dirty")
                status.dirty();
              return executeRefinement(inner.value).then(() => {
                return { status: status.value, value: inner.value };
              });
            });
          }
        }
        if (effect.type === "transform") {
          if (ctx.common.async === false) {
            const base4 = this._def.schema._parseSync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            });
            if (!isValid2(base4))
              return INVALID2;
            const result = effect.transform(base4.value, checkCtx);
            if (result instanceof Promise) {
              throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
            }
            return { status: status.value, value: result };
          } else {
            return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base4) => {
              if (!isValid2(base4))
                return INVALID2;
              return Promise.resolve(effect.transform(base4.value, checkCtx)).then((result) => ({
                status: status.value,
                value: result
              }));
            });
          }
        }
        util2.assertNever(effect);
      }
    };
    ZodEffects2.create = (schema, effect, params) => {
      return new ZodEffects2({
        schema,
        typeName: ZodFirstPartyTypeKind2.ZodEffects,
        effect,
        ...processCreateParams2(params)
      });
    };
    ZodEffects2.createWithPreprocess = (preprocess, schema, params) => {
      return new ZodEffects2({
        schema,
        effect: { type: "preprocess", transform: preprocess },
        typeName: ZodFirstPartyTypeKind2.ZodEffects,
        ...processCreateParams2(params)
      });
    };
    ZodOptional2 = class extends ZodType2 {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType2.undefined) {
          return OK2(void 0);
        }
        return this._def.innerType._parse(input);
      }
      unwrap() {
        return this._def.innerType;
      }
    };
    ZodOptional2.create = (type, params) => {
      return new ZodOptional2({
        innerType: type,
        typeName: ZodFirstPartyTypeKind2.ZodOptional,
        ...processCreateParams2(params)
      });
    };
    ZodNullable2 = class extends ZodType2 {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType2.null) {
          return OK2(null);
        }
        return this._def.innerType._parse(input);
      }
      unwrap() {
        return this._def.innerType;
      }
    };
    ZodNullable2.create = (type, params) => {
      return new ZodNullable2({
        innerType: type,
        typeName: ZodFirstPartyTypeKind2.ZodNullable,
        ...processCreateParams2(params)
      });
    };
    ZodDefault2 = class extends ZodType2 {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        let data = ctx.data;
        if (ctx.parsedType === ZodParsedType2.undefined) {
          data = this._def.defaultValue();
        }
        return this._def.innerType._parse({
          data,
          path: ctx.path,
          parent: ctx
        });
      }
      removeDefault() {
        return this._def.innerType;
      }
    };
    ZodDefault2.create = (type, params) => {
      return new ZodDefault2({
        innerType: type,
        typeName: ZodFirstPartyTypeKind2.ZodDefault,
        defaultValue: typeof params.default === "function" ? params.default : () => params.default,
        ...processCreateParams2(params)
      });
    };
    ZodCatch2 = class extends ZodType2 {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const newCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          }
        };
        const result = this._def.innerType._parse({
          data: newCtx.data,
          path: newCtx.path,
          parent: {
            ...newCtx
          }
        });
        if (isAsync2(result)) {
          return result.then((result2) => {
            return {
              status: "valid",
              value: result2.status === "valid" ? result2.value : this._def.catchValue({
                get error() {
                  return new ZodError2(newCtx.common.issues);
                },
                input: newCtx.data
              })
            };
          });
        } else {
          return {
            status: "valid",
            value: result.status === "valid" ? result.value : this._def.catchValue({
              get error() {
                return new ZodError2(newCtx.common.issues);
              },
              input: newCtx.data
            })
          };
        }
      }
      removeCatch() {
        return this._def.innerType;
      }
    };
    ZodCatch2.create = (type, params) => {
      return new ZodCatch2({
        innerType: type,
        typeName: ZodFirstPartyTypeKind2.ZodCatch,
        catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
        ...processCreateParams2(params)
      });
    };
    ZodNaN2 = class extends ZodType2 {
      _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType2.nan) {
          const ctx = this._getOrReturnCtx(input);
          addIssueToContext2(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: ZodParsedType2.nan,
            received: ctx.parsedType
          });
          return INVALID2;
        }
        return { status: "valid", value: input.data };
      }
    };
    ZodNaN2.create = (params) => {
      return new ZodNaN2({
        typeName: ZodFirstPartyTypeKind2.ZodNaN,
        ...processCreateParams2(params)
      });
    };
    BRAND2 = /* @__PURE__ */ Symbol("zod_brand");
    ZodBranded2 = class extends ZodType2 {
      _parse(input) {
        const { ctx } = this._processInputParams(input);
        const data = ctx.data;
        return this._def.type._parse({
          data,
          path: ctx.path,
          parent: ctx
        });
      }
      unwrap() {
        return this._def.type;
      }
    };
    ZodPipeline2 = class _ZodPipeline2 extends ZodType2 {
      _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.common.async) {
          const handleAsync = async () => {
            const inResult = await this._def.in._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: ctx
            });
            if (inResult.status === "aborted")
              return INVALID2;
            if (inResult.status === "dirty") {
              status.dirty();
              return DIRTY2(inResult.value);
            } else {
              return this._def.out._parseAsync({
                data: inResult.value,
                path: ctx.path,
                parent: ctx
              });
            }
          };
          return handleAsync();
        } else {
          const inResult = this._def.in._parseSync({
            data: ctx.data,
            path: ctx.path,
            parent: ctx
          });
          if (inResult.status === "aborted")
            return INVALID2;
          if (inResult.status === "dirty") {
            status.dirty();
            return {
              status: "dirty",
              value: inResult.value
            };
          } else {
            return this._def.out._parseSync({
              data: inResult.value,
              path: ctx.path,
              parent: ctx
            });
          }
        }
      }
      static create(a, b) {
        return new _ZodPipeline2({
          in: a,
          out: b,
          typeName: ZodFirstPartyTypeKind2.ZodPipeline
        });
      }
    };
    ZodReadonly2 = class extends ZodType2 {
      _parse(input) {
        const result = this._def.innerType._parse(input);
        const freeze = (data) => {
          if (isValid2(data)) {
            data.value = Object.freeze(data.value);
          }
          return data;
        };
        return isAsync2(result) ? result.then((data) => freeze(data)) : freeze(result);
      }
      unwrap() {
        return this._def.innerType;
      }
    };
    ZodReadonly2.create = (type, params) => {
      return new ZodReadonly2({
        innerType: type,
        typeName: ZodFirstPartyTypeKind2.ZodReadonly,
        ...processCreateParams2(params)
      });
    };
    late2 = {
      object: ZodObject2.lazycreate
    };
    (function(ZodFirstPartyTypeKind3) {
      ZodFirstPartyTypeKind3["ZodString"] = "ZodString";
      ZodFirstPartyTypeKind3["ZodNumber"] = "ZodNumber";
      ZodFirstPartyTypeKind3["ZodNaN"] = "ZodNaN";
      ZodFirstPartyTypeKind3["ZodBigInt"] = "ZodBigInt";
      ZodFirstPartyTypeKind3["ZodBoolean"] = "ZodBoolean";
      ZodFirstPartyTypeKind3["ZodDate"] = "ZodDate";
      ZodFirstPartyTypeKind3["ZodSymbol"] = "ZodSymbol";
      ZodFirstPartyTypeKind3["ZodUndefined"] = "ZodUndefined";
      ZodFirstPartyTypeKind3["ZodNull"] = "ZodNull";
      ZodFirstPartyTypeKind3["ZodAny"] = "ZodAny";
      ZodFirstPartyTypeKind3["ZodUnknown"] = "ZodUnknown";
      ZodFirstPartyTypeKind3["ZodNever"] = "ZodNever";
      ZodFirstPartyTypeKind3["ZodVoid"] = "ZodVoid";
      ZodFirstPartyTypeKind3["ZodArray"] = "ZodArray";
      ZodFirstPartyTypeKind3["ZodObject"] = "ZodObject";
      ZodFirstPartyTypeKind3["ZodUnion"] = "ZodUnion";
      ZodFirstPartyTypeKind3["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
      ZodFirstPartyTypeKind3["ZodIntersection"] = "ZodIntersection";
      ZodFirstPartyTypeKind3["ZodTuple"] = "ZodTuple";
      ZodFirstPartyTypeKind3["ZodRecord"] = "ZodRecord";
      ZodFirstPartyTypeKind3["ZodMap"] = "ZodMap";
      ZodFirstPartyTypeKind3["ZodSet"] = "ZodSet";
      ZodFirstPartyTypeKind3["ZodFunction"] = "ZodFunction";
      ZodFirstPartyTypeKind3["ZodLazy"] = "ZodLazy";
      ZodFirstPartyTypeKind3["ZodLiteral"] = "ZodLiteral";
      ZodFirstPartyTypeKind3["ZodEnum"] = "ZodEnum";
      ZodFirstPartyTypeKind3["ZodEffects"] = "ZodEffects";
      ZodFirstPartyTypeKind3["ZodNativeEnum"] = "ZodNativeEnum";
      ZodFirstPartyTypeKind3["ZodOptional"] = "ZodOptional";
      ZodFirstPartyTypeKind3["ZodNullable"] = "ZodNullable";
      ZodFirstPartyTypeKind3["ZodDefault"] = "ZodDefault";
      ZodFirstPartyTypeKind3["ZodCatch"] = "ZodCatch";
      ZodFirstPartyTypeKind3["ZodPromise"] = "ZodPromise";
      ZodFirstPartyTypeKind3["ZodBranded"] = "ZodBranded";
      ZodFirstPartyTypeKind3["ZodPipeline"] = "ZodPipeline";
      ZodFirstPartyTypeKind3["ZodReadonly"] = "ZodReadonly";
    })(ZodFirstPartyTypeKind2 || (ZodFirstPartyTypeKind2 = {}));
    instanceOfType2 = (cls, params = {
      message: `Input not instance of ${cls.name}`
    }) => custom2((data) => data instanceof cls, params);
    stringType2 = ZodString2.create;
    numberType2 = ZodNumber2.create;
    nanType2 = ZodNaN2.create;
    bigIntType2 = ZodBigInt2.create;
    booleanType2 = ZodBoolean2.create;
    dateType2 = ZodDate2.create;
    symbolType2 = ZodSymbol2.create;
    undefinedType2 = ZodUndefined2.create;
    nullType2 = ZodNull2.create;
    anyType2 = ZodAny2.create;
    unknownType2 = ZodUnknown2.create;
    neverType2 = ZodNever2.create;
    voidType2 = ZodVoid2.create;
    arrayType2 = ZodArray2.create;
    objectType2 = ZodObject2.create;
    strictObjectType2 = ZodObject2.strictCreate;
    unionType2 = ZodUnion2.create;
    discriminatedUnionType2 = ZodDiscriminatedUnion2.create;
    intersectionType2 = ZodIntersection2.create;
    tupleType2 = ZodTuple2.create;
    recordType2 = ZodRecord2.create;
    mapType2 = ZodMap2.create;
    setType2 = ZodSet2.create;
    functionType2 = ZodFunction2.create;
    lazyType2 = ZodLazy2.create;
    literalType2 = ZodLiteral2.create;
    enumType2 = ZodEnum2.create;
    nativeEnumType2 = ZodNativeEnum2.create;
    promiseType2 = ZodPromise2.create;
    effectsType2 = ZodEffects2.create;
    optionalType2 = ZodOptional2.create;
    nullableType2 = ZodNullable2.create;
    preprocessType2 = ZodEffects2.createWithPreprocess;
    pipelineType2 = ZodPipeline2.create;
    ostring2 = () => stringType2().optional();
    onumber2 = () => numberType2().optional();
    oboolean2 = () => booleanType2().optional();
    coerce4 = {
      string: ((arg) => ZodString2.create({ ...arg, coerce: true })),
      number: ((arg) => ZodNumber2.create({ ...arg, coerce: true })),
      boolean: ((arg) => ZodBoolean2.create({
        ...arg,
        coerce: true
      })),
      bigint: ((arg) => ZodBigInt2.create({ ...arg, coerce: true })),
      date: ((arg) => ZodDate2.create({ ...arg, coerce: true }))
    };
    NEVER2 = INVALID2;
  }
});

// ../../node_modules/zod/v3/external.js
var external_exports2 = {};
__export(external_exports2, {
  BRAND: () => BRAND2,
  DIRTY: () => DIRTY2,
  EMPTY_PATH: () => EMPTY_PATH2,
  INVALID: () => INVALID2,
  NEVER: () => NEVER2,
  OK: () => OK2,
  ParseStatus: () => ParseStatus2,
  Schema: () => ZodType2,
  ZodAny: () => ZodAny2,
  ZodArray: () => ZodArray2,
  ZodBigInt: () => ZodBigInt2,
  ZodBoolean: () => ZodBoolean2,
  ZodBranded: () => ZodBranded2,
  ZodCatch: () => ZodCatch2,
  ZodDate: () => ZodDate2,
  ZodDefault: () => ZodDefault2,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion2,
  ZodEffects: () => ZodEffects2,
  ZodEnum: () => ZodEnum2,
  ZodError: () => ZodError2,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind2,
  ZodFunction: () => ZodFunction2,
  ZodIntersection: () => ZodIntersection2,
  ZodIssueCode: () => ZodIssueCode2,
  ZodLazy: () => ZodLazy2,
  ZodLiteral: () => ZodLiteral2,
  ZodMap: () => ZodMap2,
  ZodNaN: () => ZodNaN2,
  ZodNativeEnum: () => ZodNativeEnum2,
  ZodNever: () => ZodNever2,
  ZodNull: () => ZodNull2,
  ZodNullable: () => ZodNullable2,
  ZodNumber: () => ZodNumber2,
  ZodObject: () => ZodObject2,
  ZodOptional: () => ZodOptional2,
  ZodParsedType: () => ZodParsedType2,
  ZodPipeline: () => ZodPipeline2,
  ZodPromise: () => ZodPromise2,
  ZodReadonly: () => ZodReadonly2,
  ZodRecord: () => ZodRecord2,
  ZodSchema: () => ZodType2,
  ZodSet: () => ZodSet2,
  ZodString: () => ZodString2,
  ZodSymbol: () => ZodSymbol2,
  ZodTransformer: () => ZodEffects2,
  ZodTuple: () => ZodTuple2,
  ZodType: () => ZodType2,
  ZodUndefined: () => ZodUndefined2,
  ZodUnion: () => ZodUnion2,
  ZodUnknown: () => ZodUnknown2,
  ZodVoid: () => ZodVoid2,
  addIssueToContext: () => addIssueToContext2,
  any: () => anyType2,
  array: () => arrayType2,
  bigint: () => bigIntType2,
  boolean: () => booleanType2,
  coerce: () => coerce4,
  custom: () => custom2,
  date: () => dateType2,
  datetimeRegex: () => datetimeRegex2,
  defaultErrorMap: () => en_default2,
  discriminatedUnion: () => discriminatedUnionType2,
  effect: () => effectsType2,
  enum: () => enumType2,
  function: () => functionType2,
  getErrorMap: () => getErrorMap2,
  getParsedType: () => getParsedType2,
  instanceof: () => instanceOfType2,
  intersection: () => intersectionType2,
  isAborted: () => isAborted2,
  isAsync: () => isAsync2,
  isDirty: () => isDirty2,
  isValid: () => isValid2,
  late: () => late2,
  lazy: () => lazyType2,
  literal: () => literalType2,
  makeIssue: () => makeIssue2,
  map: () => mapType2,
  nan: () => nanType2,
  nativeEnum: () => nativeEnumType2,
  never: () => neverType2,
  null: () => nullType2,
  nullable: () => nullableType2,
  number: () => numberType2,
  object: () => objectType2,
  objectUtil: () => objectUtil2,
  oboolean: () => oboolean2,
  onumber: () => onumber2,
  optional: () => optionalType2,
  ostring: () => ostring2,
  pipeline: () => pipelineType2,
  preprocess: () => preprocessType2,
  promise: () => promiseType2,
  quotelessJson: () => quotelessJson2,
  record: () => recordType2,
  set: () => setType2,
  setErrorMap: () => setErrorMap2,
  strictObject: () => strictObjectType2,
  string: () => stringType2,
  symbol: () => symbolType2,
  transformer: () => effectsType2,
  tuple: () => tupleType2,
  undefined: () => undefinedType2,
  union: () => unionType2,
  unknown: () => unknownType2,
  util: () => util2,
  void: () => voidType2
});
var init_external = __esm({
  "../../node_modules/zod/v3/external.js"() {
    "use strict";
    init_errors2();
    init_parseUtil();
    init_typeAliases();
    init_util();
    init_types2();
    init_ZodError();
  }
});

// ../../node_modules/zod/index.js
var init_zod = __esm({
  "../../node_modules/zod/index.js"() {
    "use strict";
    init_external();
    init_external();
  }
});

// src/lib/raw-encryption.ts
var init_raw_encryption = __esm({
  "src/lib/raw-encryption.ts"() {
    "use strict";
  }
});

// src/lib/owner-did.ts
import { ensureEip55 } from "@tinycloud/node-sdk-wasm";
var init_owner_did = __esm({
  "src/lib/owner-did.ts"() {
    "use strict";
    init_constants();
    init_errors();
  }
});

// src/share/publishing-manifest.ts
var init_publishing_manifest = __esm({
  "src/share/publishing-manifest.ts"() {
    "use strict";
  }
});

// src/lib/permissions.ts
import { appendFile, chmod as chmod2, readFile as readFile3 } from "fs/promises";
import { join as join5 } from "path";
import {
  buildPermissionRequestArtifact,
  isPermissionRequestArtifact
} from "@tinycloud/operations/artifacts";
import {
  additionalDelegationsPath as sharedAdditionalDelegationsPath,
  authRequestsPath as sharedAuthRequestsPath,
  profileStoreMetadataPath,
  readAdditionalDelegations,
  readAuthRequests,
  refuseWriteToDeletedProfile as refuseWriteToDeletedProfile2,
  updateProfileStore,
  withProfileLock as withProfileLock2,
  writeJsonAtomic
} from "@tinycloud/operations/state";
async function loadAdditionalDelegations(profile) {
  return readAdditionalDelegations(profile);
}
async function replayAdditionalDelegations(node, profile, options) {
  const {
    operationSpaceResolver,
    prepareStoredDelegationReplay,
    replayStoredDelegation,
    storedDelegationKind
  } = await import("@tinycloud/operations/delegation-binding");
  const activator = node;
  const migrated = await prepareStoredDelegationReplay(profile, activator, {
    host: options.host,
    migrate: options.migrate
  });
  const resolveSpace = operationSpaceResolver(node, options.ownerSpace);
  const entries = await loadAdditionalDelegations(profile);
  for (const stored of entries) {
    const kind = storedDelegationKind(stored);
    if (kind === "compact" || kind === "signed-login") {
      const installed = await replayStoredDelegation(activator, stored, {
        host: options.host,
        migrated,
        resolveSpace
      });
      if (installed === void 0 && process.env.TC_DEBUG_REPLAY === "1") {
        process.stderr.write("[replay] skipping a stored delegation refused by validation or its request binding\n");
      }
      continue;
    }
    if (kind === "refused") {
      if (process.env.TC_DEBUG_REPLAY === "1") {
        process.stderr.write("[replay] skipping a malformed stored record or one bound to a request it cannot be held to\n");
      }
      continue;
    }
    const entry = stored;
    const expiry = entry.delegation.expiry instanceof Date ? entry.delegation.expiry : new Date(entry.delegation.expiry);
    if (expiry.getTime() <= Date.now()) continue;
    try {
      await node.useRuntimeDelegation({
        ...entry.delegation,
        delegationHeader: { Authorization: entry.delegation.delegationHeader.Authorization },
        expiry
      });
    } catch (err) {
      if (process.env.TC_DEBUG_REPLAY === "1") {
        process.stderr.write(`[replay] skipping ${entry.delegation.cid}: ${err.message}
`);
      }
    }
  }
}
var init_permissions = __esm({
  "src/lib/permissions.ts"() {
    "use strict";
    init_constants();
    init_storage();
    init_profiles();
    init_errors();
    init_constants();
    init_space();
    init_raw_encryption();
    init_owner_did();
    init_publishing_manifest();
    init_types();
  }
});

// src/lib/sdk.ts
var sdk_exports = {};
__export(sdk_exports, {
  bootstrapDelegatedSession: () => bootstrapDelegatedSession,
  createSDKInstance: () => createSDKInstance,
  ensureAuthenticated: () => ensureAuthenticated,
  jwkHasPrivateParameter: () => jwkHasPrivateParameter,
  selectSignerJwk: () => selectSignerJwk
});
import { TinyCloudNode } from "@tinycloud/node-sdk";
function jwkHasPrivateParameter(jwk) {
  if (!jwk || typeof jwk !== "object") return false;
  const d = jwk.d;
  return typeof d === "string" && d.length > 0;
}
function selectSignerJwk(sessionJwk, key) {
  if (jwkHasPrivateParameter(sessionJwk)) {
    return sessionJwk;
  }
  return key ?? void 0;
}
function signerJwkForProfile(profileName, sessionJwk, key) {
  const jwk = selectSignerJwk(sessionJwk, key);
  if (jwkHasPrivateParameter(jwk)) {
    return jwk;
  }
  throw new CLIError(
    "AUTH_REQUIRED",
    `Profile "${profileName}" cannot restore its session because its private key material is missing.`,
    ExitCode.AUTH_REQUIRED,
    {
      hint: `Sign in again with: tc --profile ${profileName} auth login --method openkey`
    }
  );
}
async function createSDKInstance(ctx, options) {
  const profile = options?.privateKey ? await ProfileManager.getProfile(ctx.profile).catch(() => null) : await ProfileManager.getProfile(ctx.profile);
  const session = await ProfileManager.getSession(ctx.profile);
  const key = await ProfileManager.getKey(ctx.profile);
  const effectivePrivateKey = options?.privateKey ?? profile?.privateKey;
  if (!key && !effectivePrivateKey && !(profile?.authMethod === "openkey" && session !== null)) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `No key found for profile "${ctx.profile}". Run \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  if (profile?.authMethod === "local" && effectivePrivateKey) {
    const node2 = new TinyCloudNode({
      host: ctx.host,
      privateKey: effectivePrivateKey
    });
    let restoredOwnSession2 = false;
    if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
      await node2.restoreSession({
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId: session.spaceId,
        jwk: signerJwkForProfile(ctx.profile, session.jwk, key),
        verificationMethod: session.verificationMethod ?? profile?.sessionDid ?? profile?.did,
        address: session.address,
        chainId: session.chainId,
        siwe: session.siwe,
        signature: session.signature
      });
      restoredOwnSession2 = true;
    } else {
      await node2.signIn();
    }
    await replayAdditionalDelegations(node2, ctx.profile, {
      host: ctx.host,
      ownerSpace: profile.spaceId,
      migrate: restoredOwnSession2 && options?.privateKey === void 0
    });
    return node2;
  }
  const node = new TinyCloudNode({
    host: ctx.host,
    privateKey: options?.privateKey
  });
  let restoredOwnSession = false;
  if (options?.privateKey) {
    await node.signIn();
  } else if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
    await node.restoreSession({
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: session.spaceId,
      jwk: signerJwkForProfile(ctx.profile, session.jwk, key),
      verificationMethod: session.verificationMethod ?? profile?.did,
      address: session.address,
      chainId: session.chainId,
      siwe: session.siwe,
      signature: session.signature
    });
    restoredOwnSession = true;
  }
  await replayAdditionalDelegations(node, ctx.profile, {
    host: ctx.host,
    ownerSpace: profile?.spaceId,
    migrate: restoredOwnSession
  });
  return node;
}
async function bootstrapDelegatedSession(ctx, delegation) {
  const written = await ProfileManager.withLock(ctx.profile, async () => {
    const previousProfile = await ProfileManager.getProfile(ctx.profile);
    if (resolveProfilePosture(previousProfile) !== "delegate-session") {
      throw new CLIError(
        "AUTH_REQUIRED",
        `Profile "${ctx.profile}" is not a delegate-session profile.`,
        ExitCode.AUTH_REQUIRED
      );
    }
    const sessionDid = previousProfile.sessionDid ?? previousProfile.did;
    if (delegation.delegateDID.split("#", 1)[0] !== sessionDid.split("#", 1)[0]) {
      throw new CLIError(
        "DELEGATION_AUDIENCE_MISMATCH",
        `Delegation targets ${delegation.delegateDID}, but profile "${ctx.profile}" uses ${sessionDid}.`,
        ExitCode.PERMISSION_DENIED
      );
    }
    if (await ProfileManager.getSession(ctx.profile) !== null) {
      throw new CLIError(
        "PROFILE_CHANGED_DURING_IMPORT",
        `Profile "${ctx.profile}" gained a session (another login or import) after this import checked it. Nothing was saved; run the import again.`,
        ExitCode.ERROR
      );
    }
    const jwk = signerJwkForProfile(ctx.profile, void 0, await ProfileManager.getKey(ctx.profile));
    const session = {
      delegationHeader: delegation.delegationHeader,
      delegationCid: delegation.cid,
      spaceId: delegation.spaceId,
      jwk,
      verificationMethod: sessionDid
    };
    const profile = { ...previousProfile, sessionDid, spaceId: delegation.spaceId };
    try {
      await ProfileManager.setSession(ctx.profile, session);
      await ProfileManager.setProfile(ctx.profile, profile);
    } catch (error) {
      throw annotate(error, await restoreBeforeBootstrap(ctx.profile, previousProfile));
    }
    return { previousProfile, profile, session };
  });
  const abandon = async (cause) => {
    const note = await ProfileManager.withLock(ctx.profile, async () => {
      const profile = await ProfileManager.getProfile(ctx.profile).catch((error) => {
        if (error instanceof CLIError && error.code === "PROFILE_NOT_FOUND") return null;
        throw error;
      });
      const session = await ProfileManager.getSession(ctx.profile);
      if (profile === null || BOOTSTRAP_PROFILE_FIELDS.some((field) => profile[field] !== written.profile[field]) || JSON.stringify(session) !== JSON.stringify(written.session)) {
        return `Profile "${ctx.profile}" changed while the import was pending (another login, logout or profile update), so its newer state was kept and the provisional session was not rolled back.`;
      }
      return restoreBeforeBootstrap(ctx.profile, written.previousProfile);
    }, { timeoutMs: PROFILE_COMMIT_LOCK_TIMEOUT_MS }).catch((error) => (
      // The lock or a read failed: the import's error stays the one reported.
      `Rolling back the provisional session of profile "${ctx.profile}" could not run (${failureName(error)}); check \`tc --profile ${ctx.profile} context\`.`
    ));
    throw annotate(cause, note);
  };
  let node;
  try {
    node = await createSDKInstance(ctx);
  } catch (error) {
    return abandon(error);
  }
  return { node, abandon };
}
async function restoreBeforeBootstrap(profileName, previousProfile) {
  const failures = [];
  for (const write of [
    () => ProfileManager.clearSession(profileName),
    () => ProfileManager.updateProfile(profileName, (current) => {
      const restored = { ...current };
      for (const field of BOOTSTRAP_PROFILE_FIELDS) {
        if (previousProfile[field] === void 0) delete restored[field];
        else restored[field] = previousProfile[field];
      }
      return restored;
    })
  ]) {
    await write().catch((error) => {
      failures.push(failureName(error));
    });
  }
  if (failures.length === 0) return void 0;
  return `Rolling back the provisional session of profile "${profileName}" failed too (${failures.join("; ")}); check \`tc --profile ${profileName} context\`.`;
}
function failureName(error) {
  if (error instanceof SyntaxError) return "a profile file is not valid JSON";
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown error";
}
function annotate(error, note) {
  if (note === void 0) return error;
  const cause = wrapError(error);
  return new CLIError(cause.code, `${cause.message} ${note}`, cause.exitCode, cause.metadata);
}
async function ensureAuthenticated(ctx, options) {
  if (options?.privateKey) {
    return createSDKInstance(ctx, options);
  }
  const profile = await ProfileManager.getProfile(ctx.profile).catch(() => null);
  if (profile?.authMethod === "local" && profile.privateKey) {
    return createSDKInstance(ctx);
  }
  const session = await ProfileManager.getSession(ctx.profile);
  if (!session) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `Not authenticated. Run \`tc auth login\` or \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  return createSDKInstance(ctx, options);
}
var BOOTSTRAP_PROFILE_FIELDS;
var init_sdk = __esm({
  "src/lib/sdk.ts"() {
    "use strict";
    init_profiles();
    init_types();
    init_errors();
    init_constants();
    init_permissions();
    BOOTSTRAP_PROFILE_FIELDS = ["sessionDid", "spaceId"];
  }
});

// src/index.ts
init_errors();
import { readFileSync as readFileSync2 } from "fs";
import { Command } from "commander";

// src/output/banner.ts
init_formatter();

// src/output/taglines.ts
var HOLIDAY_TAGLINES = [
  { month: 1, day: 1, range: 1, tagline: "New year, new keys, same cloud." },
  { month: 2, day: 14, tagline: "We love your data as much as you do." },
  { month: 3, day: 14, tagline: "3.14159 reasons to encrypt everything." },
  { month: 5, day: 4, tagline: "May the fourth be with your keys." },
  { month: 10, day: 31, tagline: "Nothing scarier than plaintext secrets." },
  { month: 12, day: 25, range: 2, tagline: "Unwrap your data, not your keys." },
  { month: 12, day: 31, tagline: "Encrypt your resolutions." }
];
var TAGLINES = [
  // Professional
  "Your data, your keys, your cloud.",
  "Self-sovereign storage for the modern web.",
  "The cloud you actually own.",
  "Encrypted by default, decentralized by design.",
  "Where your data answers only to you.",
  "End-to-end encrypted. No exceptions.",
  "Like S3 but you hold the keys.",
  "Privacy isn't a feature. It's the architecture.",
  "Sovereign storage, zero knowledge.",
  "Your .env is safe here \u2014 we use real cryptography.",
  // Playful / nerdy
  "UCAN do anything.",
  "Keys generated, delegations granted, data liberated.",
  "Decentralized storage, centralized vibes.",
  "Trust nobody, delegate everything.",
  "sudo make me a sandwich, encrypted.",
  "Have you tried turning your keys off and on again?",
  "All your base are belong to you.",
  "In UCAN we trust.",
  "0 knowledge, 100% confidence.",
  "Keeping secrets since 2024."
];
function getHolidayTagline() {
  const now = /* @__PURE__ */ new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  for (const h of HOLIDAY_TAGLINES) {
    const range = h.range ?? 0;
    if (h.month === month && Math.abs(day - h.day) <= range) {
      return h.tagline;
    }
  }
  return null;
}
function pickTagline() {
  const holiday = getHolidayTagline();
  if (holiday) return holiday;
  return TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}

// src/output/banner.ts
init_theme();
import { execSync } from "child_process";
var bannerEmitted = false;
function resolveCommitHash() {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim() || null;
  } catch {
    return null;
  }
}
function formatBannerLine(version2) {
  const commit = resolveCommitHash();
  const tagline = pickTagline();
  const versionPart = `tc v${version2}`;
  const commitPart = commit ? ` (${commit})` : "";
  const separator = " \u2014 ";
  if (!isInteractive()) {
    return `${versionPart}${commitPart}${separator}${tagline}`;
  }
  return [
    theme.brand("\u2601\uFE0F  tc"),
    " ",
    theme.muted(`v${version2}`),
    commit ? theme.dim(` (${commit})`) : "",
    theme.dim(separator),
    theme.primary(tagline)
  ].join("");
}
function emitBanner(version2) {
  if (bannerEmitted) return;
  if (!isInteractive()) return;
  if (process.env.TC_HIDE_BANNER === "1") return;
  bannerEmitted = true;
  process.stderr.write(formatBannerLine(version2) + "\n\n");
}

// src/index.ts
init_theme();
init_formatter();
init_profiles();

// ../share-sdk/dist/index.js
init_sha2();

// ../../node_modules/@noble/curves/esm/ed25519.js
init_sha2();
init_utils();

// ../../node_modules/@noble/curves/esm/utils.js
init_utils();
init_utils();
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function _abool2(value, title = "") {
  if (typeof value !== "boolean") {
    const prefix = title && `"${title}"`;
    throw new Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function _abytes2(value, length4, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length4 !== void 0;
  if (!bytes || needsLen && len !== length4) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length4}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function hexToNumber(hex3) {
  if (typeof hex3 !== "string")
    throw new Error("hex string expected, got " + typeof hex3);
  return hex3 === "" ? _0n : BigInt("0x" + hex3);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  abytes(bytes);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex3, expectedLength) {
  let res;
  if (typeof hex3 === "string") {
    try {
      res = hexToBytes(hex3);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes(hex3)) {
    res = Uint8Array.from(hex3);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
function _validateObject(object3, fields, optFields = {}) {
  if (!object3 || typeof object3 !== "object")
    throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object3[fieldName];
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
  Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
}
var notImplemented = () => {
  throw new Error("not implemented");
};
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// ../../node_modules/@noble/curves/esm/abstract/modular.js
var _0n2 = BigInt(0);
var _1n2 = BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp2, root, n) {
  if (!Fp2.eql(Fp2.sqr(root), n))
    throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp2, n) {
  const p1div4 = (Fp2.ORDER + _1n2) / _4n;
  const root = Fp2.pow(n, p1div4);
  assertIsSquare(Fp2, root, n);
  return root;
}
function sqrt5mod8(Fp2, n) {
  const p5div8 = (Fp2.ORDER - _5n) / _8n;
  const n2 = Fp2.mul(n, _2n);
  const v = Fp2.pow(n2, p5div8);
  const nv = Fp2.mul(n, v);
  const i = Fp2.mul(Fp2.mul(nv, _2n), v);
  const root = Fp2.mul(nv, Fp2.sub(i, Fp2.ONE));
  assertIsSquare(Fp2, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp2, n) => {
    let tv1 = Fp2.pow(n, c4);
    let tv2 = Fp2.mul(tv1, c1);
    const tv3 = Fp2.mul(tv1, c2);
    const tv4 = Fp2.mul(tv1, c3);
    const e1 = Fp2.eql(Fp2.sqr(tv2), n);
    const e2 = Fp2.eql(Fp2.sqr(tv3), n);
    tv1 = Fp2.cmov(tv1, tv2, e1);
    tv2 = Fp2.cmov(tv4, tv3, e2);
    const e3 = Fp2.eql(Fp2.sqr(tv2), n);
    const root = Fp2.cmov(tv1, tv2, e3);
    assertIsSquare(Fp2, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp2, n) {
    if (Fp2.is0(n))
      return n;
    if (FpLegendre(Fp2, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp2.mul(Fp2.ONE, cc);
    let t = Fp2.pow(n, Q);
    let R = Fp2.pow(n, Q1div2);
    while (!Fp2.eql(t, Fp2.ONE)) {
      if (Fp2.is0(t))
        return Fp2.ZERO;
      let i = 1;
      let t_tmp = Fp2.sqr(t);
      while (!Fp2.eql(t_tmp, Fp2.ONE)) {
        i++;
        t_tmp = Fp2.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = Fp2.pow(c, exponent);
      M = i;
      c = Fp2.sqr(b);
      t = Fp2.mul(t, c);
      R = Fp2.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  _validateObject(field, opts);
  return field;
}
function FpPow(Fp2, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp2.ONE;
  if (power === _1n2)
    return num;
  let p = Fp2.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp2.mul(p, d);
    d = Fp2.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp2, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp2.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp2.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp2.mul(acc, num);
  }, Fp2.ONE);
  const invertedAcc = Fp2.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp2.is0(num))
      return acc;
    inverted[i] = Fp2.mul(acc, inverted[i]);
    return Fp2.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp2, n) {
  const p1mod2 = (Fp2.ORDER - _1n2) / _2n;
  const powered = Fp2.pow(n, p1mod2);
  const yes = Fp2.eql(powered, Fp2.ONE);
  const zero = Fp2.eql(powered, Fp2.ZERO);
  const no = Fp2.eql(powered, Fp2.neg(Fp2.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLenOrOpts, isLE2 = false, opts = {}) {
  if (ORDER <= _0n2)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  let _nbitLength = void 0;
  let _sqrt = void 0;
  let modFromBytes = false;
  let allowedLengths = void 0;
  if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
    if (opts.sqrt || isLE2)
      throw new Error("cannot specify opts in two arguments");
    const _opts = bitLenOrOpts;
    if (_opts.BITS)
      _nbitLength = _opts.BITS;
    if (_opts.sqrt)
      _sqrt = _opts.sqrt;
    if (typeof _opts.isLE === "boolean")
      isLE2 = _opts.isLE;
    if (typeof _opts.modFromBytes === "boolean")
      modFromBytes = _opts.modFromBytes;
    allowedLengths = _opts.allowedLengths;
  } else {
    if (typeof bitLenOrOpts === "number")
      _nbitLength = bitLenOrOpts;
    if (opts.sqrt)
      _sqrt = opts.sqrt;
  }
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE: isLE2,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n2,
    ONE: _1n2,
    allowedLengths,
    create: (num) => mod(num, ORDER),
    isValid: (num) => {
      if (typeof num !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < ORDER;
    },
    is0: (num) => num === _0n2,
    // is valid and invertible
    isValidNot0: (num) => !f.is0(num) && f.isValid(num),
    isOdd: (num) => (num & _1n2) === _1n2,
    neg: (num) => mod(-num, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num) => mod(num * num, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num, power) => FpPow(f, num, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num) => num * num,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num) => invert(num, ORDER),
    sqrt: _sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num) => isLE2 ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
    fromBytes: (bytes, skipValidation = true) => {
      if (allowedLengths) {
        if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
          throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
        }
        const padded = new Uint8Array(BYTES);
        padded.set(bytes, isLE2 ? 0 : padded.length - bytes.length);
        bytes = padded;
      }
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      let scalar = isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
      if (modFromBytes)
        scalar = mod(scalar, ORDER);
      if (!skipValidation) {
        if (!f.isValid(scalar))
          throw new Error("invalid field element: outside of range 0..ORDER");
      }
      return scalar;
    },
    // TODO: we don't need it here, move out to separate fn
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}

// ../../node_modules/@noble/curves/esm/abstract/curve.js
var _0n3 = BigInt(0);
var _1n3 = BigInt(1);
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw new Error("invalid wNAF");
}
var wNAF = class {
  // Parametrized with a given Point class (not individual point)
  constructor(Point, bits) {
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.Fn = Point.Fn;
    this.bits = bits;
  }
  // non-const time multiplication ladder
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3)
        p = p.add(d);
      d = d.double();
      n >>= _1n3;
    }
    return p;
  }
  /**
   * Creates a wNAF precomputation window. Used for caching.
   * Default window size is set by `utils.precompute()` and is equal to 8.
   * Number of precomputed points depends on the curve size:
   * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
   * - 𝑊 is the window size
   * - 𝑛 is the bitlength of the curve order.
   * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
   * @param point Point instance
   * @param W window size
   * @returns precomputed point tables flattened to a single array
   */
  precomputeWindow(point, W) {
    const { windows, windowSize } = calcWOpts(W, this.bits);
    const points = [];
    let p = point;
    let base4 = p;
    for (let window = 0; window < windows; window++) {
      base4 = p;
      points.push(base4);
      for (let i = 1; i < windowSize; i++) {
        base4 = base4.add(p);
        points.push(base4);
      }
      p = base4.double();
    }
    return points;
  }
  /**
   * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
   * More compact implementation:
   * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
   * @returns real and fake (for const-time) points
   */
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let p = this.ZERO;
    let f = this.BASE;
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      } else {
        p = p.add(negateCt(isNeg, precomputes[offset]));
      }
    }
    assert0(n);
    return { p, f };
  }
  /**
   * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
   * @param acc accumulator point to add result of multiplication
   * @returns point
   */
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      if (n === _0n3)
        break;
      const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        continue;
      } else {
        const item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    assert0(n);
    return acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      comp = this.precomputeWindow(point, W);
      if (W !== 1) {
        if (typeof transform === "function")
          comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    const W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    const W = getW(point);
    if (W === 1)
      return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  createCache(P, W) {
    validateW(W, this.bits);
    pointWindowSizes.set(P, W);
    pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
};
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  const plength = points.length;
  const slength = scalars.length;
  if (plength !== slength)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(plength));
  let windowSize = 1;
  if (wbits > 12)
    windowSize = wbits - 3;
  else if (wbits > 4)
    windowSize = wbits - 2;
  else if (wbits > 0)
    windowSize = 2;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < slength; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function createField(order, field, isLE2) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE: isLE2 });
  }
}
function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp2 = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn2 = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp2.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp: Fp2, Fn: Fn2 };
}

// ../../node_modules/@noble/curves/esm/abstract/edwards.js
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _8n2 = BigInt(8);
function isEdValidXY(Fp2, CURVE, x, y) {
  const x2 = Fp2.sqr(x);
  const y2 = Fp2.sqr(y);
  const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
  const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
  return Fp2.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  const validated = _createCurveFields("edwards", params, extraOpts, extraOpts.FpFnLE);
  const { Fp: Fp2, Fn: Fn2 } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  _validateObject(extraOpts, {}, { uvRatio: "function" });
  const MASK = _2n2 << BigInt(Fn2.BYTES * 8) - _1n4;
  const modP = (n) => Fp2.create(n);
  const uvRatio2 = extraOpts.uvRatio || ((u, v) => {
    try {
      return { isValid: true, value: Fp2.sqrt(Fp2.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  });
  if (!isEdValidXY(Fp2, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aextpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ExtendedPoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? _8n2 : Fp2.inv(Z);
    const x = modP(X * iz);
    const y = modP(Y * iz);
    const zz = Fp2.mul(Z, iz);
    if (is0)
      return { x: _0n4, y: _1n4 };
    if (zz !== _1n4)
      throw new Error("invZ was invalid");
    return { x, y };
  });
  const assertValidMemo = memoized((p) => {
    const { a, d } = CURVE;
    if (p.is0())
      throw new Error("bad point: ZERO");
    const { X, Y, Z, T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * modP(aX2 + Y2));
    const right = modP(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      throw new Error("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      throw new Error("bad point: equation left != right (2)");
    return true;
  });
  class Point {
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point(x, y, _1n4, modP(x * y));
    }
    // Uses algo from RFC8032 5.1.3.
    static fromBytes(bytes, zip215 = false) {
      const len = Fp2.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(_abytes2(bytes, len, "point"));
      _abool2(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp2.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = modP(y * y);
      const u = modP(y2 - _1n4);
      const v = modP(d * y2 - a);
      let { isValid: isValid3, value: x } = uvRatio2(u, v);
      if (!isValid3)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = (x & _1n4) === _1n4;
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && x === _0n4 && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = modP(-x);
      return Point.fromAffine({ x, y });
    }
    static fromHex(bytes, zip215 = false) {
      return Point.fromBytes(ensureBytes("point", bytes), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    // Useful in fromAffine() - not for fromBytes(), which always created valid points.
    assertValidity() {
      assertValidMemo(this);
    }
    // Compare one point to another.
    equals(other) {
      aextpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = modP(X1 * Z2);
      const X2Z1 = modP(X2 * Z1);
      const Y1Z2 = modP(Y1 * Z2);
      const Y2Z1 = modP(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(modP(-this.X), this.Y, this.Z, modP(-this.T));
    }
    // Fast algo for doubling Extended Point.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
    // Cost: 4M + 4S + 1*a + 6add + 1*2.
    double() {
      const { a } = CURVE;
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = modP(X1 * X1);
      const B = modP(Y1 * Y1);
      const C = modP(_2n2 * modP(Z1 * Z1));
      const D = modP(a * A);
      const x1y1 = X1 + Y1;
      const E = modP(modP(x1y1 * x1y1) - A - B);
      const G = D + B;
      const F = G - C;
      const H = D - B;
      const X3 = modP(E * F);
      const Y3 = modP(G * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G);
      return new Point(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aextpoint(other);
      const { a, d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = modP(X1 * X2);
      const B = modP(Y1 * Y2);
      const C = modP(T1 * d * T2);
      const D = modP(Z1 * Z2);
      const E = modP((X1 + Y1) * (X2 + Y2) - A - B);
      const F = D - C;
      const G = D + C;
      const H = modP(B - a * A);
      const X3 = modP(E * F);
      const Y3 = modP(G * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    // Constant-time multiplication.
    multiply(scalar) {
      if (!Fn2.isValidNot0(scalar))
        throw new Error("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.cached(this, scalar, (p2) => normalizeZ(Point, p2));
      return normalizeZ(Point, [p, f])[0];
    }
    // Non-constant-time multiplication. Uses double-and-add algorithm.
    // It's faster, but should only be used when you don't care about
    // an exposed private key e.g. sig verification.
    // Does NOT allow scalars higher than CURVE.n.
    // Accepts optional accumulator to merge with multiply (important for sparse scalars)
    multiplyUnsafe(scalar, acc = Point.ZERO) {
      if (!Fn2.isValid(scalar))
        throw new Error("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return Point.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.unsafe(this, scalar, (p) => normalizeZ(Point, p), acc);
    }
    // Checks if point is of small order.
    // If you add something to small order point, you will have "dirty"
    // point with torsion component.
    // Multiplies point by cofactor and checks if the result is 0.
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    // Multiplies point by curve order and checks if the result is 0.
    // Returns `false` is the point is dirty.
    isTorsionFree() {
      return wnaf.unsafe(this, CURVE.n).is0();
    }
    // Converts Extended point to default (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp2.toBytes(y);
      bytes[bytes.length - 1] |= x & _1n4 ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
    // TODO: remove
    get ex() {
      return this.X;
    }
    get ey() {
      return this.Y;
    }
    get ez() {
      return this.Z;
    }
    get et() {
      return this.T;
    }
    static normalizeZ(points) {
      return normalizeZ(Point, points);
    }
    static msm(points, scalars) {
      return pippenger(Point, Fn2, points, scalars);
    }
    _setWindowSize(windowSize) {
      this.precompute(windowSize);
    }
    toRawBytes() {
      return this.toBytes();
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, _1n4, modP(CURVE.Gx * CURVE.Gy));
  Point.ZERO = new Point(_0n4, _1n4, _1n4, _0n4);
  Point.Fp = Fp2;
  Point.Fn = Fn2;
  const wnaf = new wNAF(Point, Fn2.BITS);
  Point.BASE.precompute(8);
  return Point;
}
var PrimeEdwardsPoint = class {
  constructor(ep) {
    this.ep = ep;
  }
  // Static methods that must be implemented by subclasses
  static fromBytes(_bytes) {
    notImplemented();
  }
  static fromHex(_hex) {
    notImplemented();
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  // Common implementations
  clearCofactor() {
    return this;
  }
  assertValidity() {
    this.ep.assertValidity();
  }
  toAffine(invertedZ) {
    return this.ep.toAffine(invertedZ);
  }
  toHex() {
    return bytesToHex(this.toBytes());
  }
  toString() {
    return this.toHex();
  }
  isTorsionFree() {
    return true;
  }
  isSmallOrder() {
    return false;
  }
  add(other) {
    this.assertSame(other);
    return this.init(this.ep.add(other.ep));
  }
  subtract(other) {
    this.assertSame(other);
    return this.init(this.ep.subtract(other.ep));
  }
  multiply(scalar) {
    return this.init(this.ep.multiply(scalar));
  }
  multiplyUnsafe(scalar) {
    return this.init(this.ep.multiplyUnsafe(scalar));
  }
  double() {
    return this.init(this.ep.double());
  }
  negate() {
    return this.init(this.ep.negate());
  }
  precompute(windowSize, isLazy) {
    return this.init(this.ep.precompute(windowSize, isLazy));
  }
  /** @deprecated use `toBytes` */
  toRawBytes() {
    return this.toBytes();
  }
};
function eddsa(Point, cHash, eddsaOpts = {}) {
  if (typeof cHash !== "function")
    throw new Error('"hash" function param is required');
  _validateObject(eddsaOpts, {}, {
    adjustScalarBytes: "function",
    randomBytes: "function",
    domain: "function",
    prehash: "function",
    mapToCurve: "function"
  });
  const { prehash } = eddsaOpts;
  const { BASE, Fp: Fp2, Fn: Fn2 } = Point;
  const randomBytes3 = eddsaOpts.randomBytes || randomBytes;
  const adjustScalarBytes2 = eddsaOpts.adjustScalarBytes || ((bytes) => bytes);
  const domain = eddsaOpts.domain || ((data, ctx, phflag) => {
    _abool2(phflag, "phflag");
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  });
  function modN_LE(hash) {
    return Fn2.create(bytesToNumberLE(hash));
  }
  function getPrivateScalar(key) {
    const len = lengths.secretKey;
    key = ensureBytes("private key", key, len);
    const hashed = ensureBytes("hashed private key", cHash(key), 2 * len);
    const head = adjustScalarBytes2(hashed.slice(0, len));
    const prefix = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix, scalar };
  }
  function getExtendedPublicKey(secretKey) {
    const { head, prefix, scalar } = getPrivateScalar(secretKey);
    const point = BASE.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix, scalar, point, pointBytes };
  }
  function getPublicKey(secretKey) {
    return getExtendedPublicKey(secretKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes(...msgs);
    return modN_LE(cHash(domain(msg, ensureBytes("context", context), !!prehash)));
  }
  function sign(msg, secretKey, options = {}) {
    msg = ensureBytes("message", msg);
    if (prehash)
      msg = prehash(msg);
    const { prefix, scalar, pointBytes } = getExtendedPublicKey(secretKey);
    const r = hashDomainToScalar(options.context, prefix, msg);
    const R = BASE.multiply(r).toBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = Fn2.create(r + k * scalar);
    if (!Fn2.isValid(s))
      throw new Error("sign failed: invalid s");
    const rs = concatBytes(R, Fn2.toBytes(s));
    return _abytes2(rs, lengths.signature, "result");
  }
  const verifyOpts = { zip215: true };
  function verify(sig, msg, publicKey, options = verifyOpts) {
    const { context, zip215 } = options;
    const len = lengths.signature;
    sig = ensureBytes("signature", sig, len);
    msg = ensureBytes("message", msg);
    publicKey = ensureBytes("publicKey", publicKey, lengths.publicKey);
    if (zip215 !== void 0)
      _abool2(zip215, "zip215");
    if (prehash)
      msg = prehash(msg);
    const mid = len / 2;
    const r = sig.subarray(0, mid);
    const s = bytesToNumberLE(sig.subarray(mid, len));
    let A, R, SB;
    try {
      A = Point.fromBytes(publicKey, zip215);
      R = Point.fromBytes(r, zip215);
      SB = BASE.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, R.toBytes(), A.toBytes(), msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().is0();
  }
  const _size = Fp2.BYTES;
  const lengths = {
    secretKey: _size,
    publicKey: _size,
    signature: 2 * _size,
    seed: _size
  };
  function randomSecretKey(seed = randomBytes3(lengths.seed)) {
    return _abytes2(seed, lengths.seed, "seed");
  }
  function keygen(seed) {
    const secretKey = utils.randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  }
  function isValidSecretKey(key) {
    return isBytes(key) && key.length === Fn2.BYTES;
  }
  function isValidPublicKey(key, zip215) {
    try {
      return !!Point.fromBytes(key, zip215);
    } catch (error) {
      return false;
    }
  }
  const utils = {
    getExtendedPublicKey,
    randomSecretKey,
    isValidSecretKey,
    isValidPublicKey,
    /**
     * Converts ed public key to x public key. Uses formula:
     * - ed25519:
     *   - `(u, v) = ((1+y)/(1-y), sqrt(-486664)*u/x)`
     *   - `(x, y) = (sqrt(-486664)*u/v, (u-1)/(u+1))`
     * - ed448:
     *   - `(u, v) = ((y-1)/(y+1), sqrt(156324)*u/x)`
     *   - `(x, y) = (sqrt(156324)*u/v, (1+u)/(1-u))`
     */
    toMontgomery(publicKey) {
      const { y } = Point.fromBytes(publicKey);
      const size = lengths.publicKey;
      const is25519 = size === 32;
      if (!is25519 && size !== 57)
        throw new Error("only defined for 25519 and 448");
      const u = is25519 ? Fp2.div(_1n4 + y, _1n4 - y) : Fp2.div(y - _1n4, y + _1n4);
      return Fp2.toBytes(u);
    },
    toMontgomerySecret(secretKey) {
      const size = lengths.secretKey;
      _abytes2(secretKey, size);
      const hashed = cHash(secretKey.subarray(0, size));
      return adjustScalarBytes2(hashed).subarray(0, size);
    },
    /** @deprecated */
    randomPrivateKey: randomSecretKey,
    /** @deprecated */
    precompute(windowSize = 8, point = Point.BASE) {
      return point.precompute(windowSize, false);
    }
  };
  return Object.freeze({
    keygen,
    getPublicKey,
    sign,
    verify,
    utils,
    Point,
    lengths
  });
}
function _eddsa_legacy_opts_to_new(c) {
  const CURVE = {
    a: c.a,
    d: c.d,
    p: c.Fp.ORDER,
    n: c.n,
    h: c.h,
    Gx: c.Gx,
    Gy: c.Gy
  };
  const Fp2 = c.Fp;
  const Fn2 = Field(CURVE.n, c.nBitLength, true);
  const curveOpts = { Fp: Fp2, Fn: Fn2, uvRatio: c.uvRatio };
  const eddsaOpts = {
    randomBytes: c.randomBytes,
    adjustScalarBytes: c.adjustScalarBytes,
    domain: c.domain,
    prehash: c.prehash,
    mapToCurve: c.mapToCurve
  };
  return { CURVE, curveOpts, hash: c.hash, eddsaOpts };
}
function _eddsa_new_output_to_legacy(c, eddsa2) {
  const Point = eddsa2.Point;
  const legacy = Object.assign({}, eddsa2, {
    ExtendedPoint: Point,
    CURVE: c,
    nBitLength: Point.Fn.BITS,
    nByteLength: Point.Fn.BYTES
  });
  return legacy;
}
function twistedEdwards(c) {
  const { CURVE, curveOpts, hash, eddsaOpts } = _eddsa_legacy_opts_to_new(c);
  const Point = edwards(CURVE, curveOpts);
  const EDDSA = eddsa(Point, hash, eddsaOpts);
  return _eddsa_new_output_to_legacy(c, EDDSA);
}

// ../../node_modules/@noble/curves/esm/ed25519.js
var _0n5 = /* @__PURE__ */ BigInt(0);
var _1n5 = BigInt(1);
var _2n3 = BigInt(2);
var _3n2 = BigInt(3);
var _5n2 = BigInt(5);
var _8n3 = BigInt(8);
var ed25519_CURVE_p = BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
var ed25519_CURVE = /* @__PURE__ */ (() => ({
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
}))();
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n3, P) * b2 % P;
  const b5 = pow2(b4, _1n5, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n3, P) * x % P;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var Fp = /* @__PURE__ */ (() => Field(ed25519_CURVE.p, { isLE: true }))();
var Fn = /* @__PURE__ */ (() => Field(ed25519_CURVE.n, { isLE: true }))();
var ed25519Defaults = /* @__PURE__ */ (() => ({
  ...ed25519_CURVE,
  Fp,
  hash: sha512,
  adjustScalarBytes,
  // dom2
  // Ratio of u to v. Allows us to combine inversion and square root. Uses algo from RFC8032 5.1.3.
  // Constant-time, u/√v
  uvRatio
}))();
var ed25519 = /* @__PURE__ */ (() => twistedEdwards(ed25519Defaults))();
var SQRT_M1 = ED25519_SQRT_M1;
var SQRT_AD_MINUS_ONE = /* @__PURE__ */ BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235");
var INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
var ONE_MINUS_D_SQ = /* @__PURE__ */ BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838");
var D_MINUS_ONE_SQ = /* @__PURE__ */ BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952");
var invertSqrt = (number) => uvRatio(_1n5, number);
var MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
var bytes255ToNumberLE = (bytes) => ed25519.Point.Fp.create(bytesToNumberLE(bytes) & MAX_255B);
function calcElligatorRistrettoMap(r0) {
  const { d } = ed25519_CURVE;
  const P = ed25519_CURVE_p;
  const mod2 = (n) => Fp.create(n);
  const r = mod2(SQRT_M1 * r0 * r0);
  const Ns = mod2((r + _1n5) * ONE_MINUS_D_SQ);
  let c = BigInt(-1);
  const D = mod2((c - d * r) * mod2(r + d));
  let { isValid: Ns_D_is_sq, value: s } = uvRatio(Ns, D);
  let s_ = mod2(s * r0);
  if (!isNegativeLE(s_, P))
    s_ = mod2(-s_);
  if (!Ns_D_is_sq)
    s = s_;
  if (!Ns_D_is_sq)
    c = r;
  const Nt = mod2(c * (r - _1n5) * D_MINUS_ONE_SQ - D);
  const s2 = s * s;
  const W0 = mod2((s + s) * D);
  const W1 = mod2(Nt * SQRT_AD_MINUS_ONE);
  const W2 = mod2(_1n5 - s2);
  const W3 = mod2(_1n5 + s2);
  return new ed25519.Point(mod2(W0 * W3), mod2(W2 * W1), mod2(W1 * W3), mod2(W0 * W2));
}
function ristretto255_map(bytes) {
  abytes(bytes, 64);
  const r1 = bytes255ToNumberLE(bytes.subarray(0, 32));
  const R1 = calcElligatorRistrettoMap(r1);
  const r2 = bytes255ToNumberLE(bytes.subarray(32, 64));
  const R2 = calcElligatorRistrettoMap(r2);
  return new _RistrettoPoint(R1.add(R2));
}
var _RistrettoPoint = class __RistrettoPoint extends PrimeEdwardsPoint {
  constructor(ep) {
    super(ep);
  }
  static fromAffine(ap) {
    return new __RistrettoPoint(ed25519.Point.fromAffine(ap));
  }
  assertSame(other) {
    if (!(other instanceof __RistrettoPoint))
      throw new Error("RistrettoPoint expected");
  }
  init(ep) {
    return new __RistrettoPoint(ep);
  }
  /** @deprecated use `import { ristretto255_hasher } from '@noble/curves/ed25519.js';` */
  static hashToCurve(hex3) {
    return ristretto255_map(ensureBytes("ristrettoHash", hex3, 64));
  }
  static fromBytes(bytes) {
    abytes(bytes, 32);
    const { a, d } = ed25519_CURVE;
    const P = ed25519_CURVE_p;
    const mod2 = (n) => Fp.create(n);
    const s = bytes255ToNumberLE(bytes);
    if (!equalBytes(Fp.toBytes(s), bytes) || isNegativeLE(s, P))
      throw new Error("invalid ristretto255 encoding 1");
    const s2 = mod2(s * s);
    const u1 = mod2(_1n5 + a * s2);
    const u2 = mod2(_1n5 - a * s2);
    const u1_2 = mod2(u1 * u1);
    const u2_2 = mod2(u2 * u2);
    const v = mod2(a * d * u1_2 - u2_2);
    const { isValid: isValid3, value: I } = invertSqrt(mod2(v * u2_2));
    const Dx = mod2(I * u2);
    const Dy = mod2(I * Dx * v);
    let x = mod2((s + s) * Dx);
    if (isNegativeLE(x, P))
      x = mod2(-x);
    const y = mod2(u1 * Dy);
    const t = mod2(x * y);
    if (!isValid3 || isNegativeLE(t, P) || y === _0n5)
      throw new Error("invalid ristretto255 encoding 2");
    return new __RistrettoPoint(new ed25519.Point(x, y, _1n5, t));
  }
  /**
   * Converts ristretto-encoded string to ristretto point.
   * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-decode).
   * @param hex Ristretto-encoded 32 bytes. Not every 32-byte string is valid ristretto encoding
   */
  static fromHex(hex3) {
    return __RistrettoPoint.fromBytes(ensureBytes("ristrettoHex", hex3, 32));
  }
  static msm(points, scalars) {
    return pippenger(__RistrettoPoint, ed25519.Point.Fn, points, scalars);
  }
  /**
   * Encodes ristretto point to Uint8Array.
   * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-encode).
   */
  toBytes() {
    let { X, Y, Z, T } = this.ep;
    const P = ed25519_CURVE_p;
    const mod2 = (n) => Fp.create(n);
    const u1 = mod2(mod2(Z + Y) * mod2(Z - Y));
    const u2 = mod2(X * Y);
    const u2sq = mod2(u2 * u2);
    const { value: invsqrt } = invertSqrt(mod2(u1 * u2sq));
    const D1 = mod2(invsqrt * u1);
    const D2 = mod2(invsqrt * u2);
    const zInv = mod2(D1 * D2 * T);
    let D;
    if (isNegativeLE(T * zInv, P)) {
      let _x = mod2(Y * SQRT_M1);
      let _y = mod2(X * SQRT_M1);
      X = _x;
      Y = _y;
      D = mod2(D1 * INVSQRT_A_MINUS_D);
    } else {
      D = D2;
    }
    if (isNegativeLE(X * zInv, P))
      Y = mod2(-Y);
    let s = mod2((Z - Y) * D);
    if (isNegativeLE(s, P))
      s = mod2(-s);
    return Fp.toBytes(s);
  }
  /**
   * Compares two Ristretto points.
   * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-equals).
   */
  equals(other) {
    this.assertSame(other);
    const { X: X1, Y: Y1 } = this.ep;
    const { X: X2, Y: Y2 } = other.ep;
    const mod2 = (n) => Fp.create(n);
    const one = mod2(X1 * Y2) === mod2(Y1 * X2);
    const two = mod2(Y1 * Y2) === mod2(X1 * X2);
    return one || two;
  }
  is0() {
    return this.equals(__RistrettoPoint.ZERO);
  }
};
_RistrettoPoint.BASE = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.BASE))();
_RistrettoPoint.ZERO = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.ZERO))();
_RistrettoPoint.Fp = /* @__PURE__ */ (() => Fp)();
_RistrettoPoint.Fn = /* @__PURE__ */ (() => Fn)();

// ../../node_modules/@noble/hashes/esm/blake3.js
init_md();
init_u64();

// ../../node_modules/@noble/hashes/esm/_blake.js
init_utils();
function G1s(a, b, c, d, x) {
  a = a + b + x | 0;
  d = rotr(d ^ a, 16);
  c = c + d | 0;
  b = rotr(b ^ c, 12);
  return { a, b, c, d };
}
function G2s(a, b, c, d, x) {
  a = a + b + x | 0;
  d = rotr(d ^ a, 8);
  c = c + d | 0;
  b = rotr(b ^ c, 7);
  return { a, b, c, d };
}

// ../../node_modules/@noble/hashes/esm/blake2.js
init_utils();
var BLAKE2 = class extends Hash {
  constructor(blockLen, outputLen) {
    super();
    this.finished = false;
    this.destroyed = false;
    this.length = 0;
    this.pos = 0;
    anumber(blockLen);
    anumber(outputLen);
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.buffer = new Uint8Array(blockLen);
    this.buffer32 = u32(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { blockLen, buffer, buffer32 } = this;
    const len = data.length;
    const offset = data.byteOffset;
    const buf = data.buffer;
    for (let pos = 0; pos < len; ) {
      if (this.pos === blockLen) {
        swap32IfBE(buffer32);
        this.compress(buffer32, 0, false);
        swap32IfBE(buffer32);
        this.pos = 0;
      }
      const take = Math.min(blockLen - this.pos, len - pos);
      const dataOffset = offset + pos;
      if (take === blockLen && !(dataOffset % 4) && pos + take < len) {
        const data32 = new Uint32Array(buf, dataOffset, Math.floor((len - pos) / 4));
        swap32IfBE(data32);
        for (let pos32 = 0; pos + blockLen < len; pos32 += buffer32.length, pos += blockLen) {
          this.length += blockLen;
          this.compress(data32, pos32, false);
        }
        swap32IfBE(data32);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      this.length += take;
      pos += take;
    }
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    const { pos, buffer32 } = this;
    this.finished = true;
    clean(this.buffer.subarray(pos));
    swap32IfBE(buffer32);
    this.compress(buffer32, 0, true);
    swap32IfBE(buffer32);
    const out32 = u32(out);
    this.get().forEach((v, i) => out32[i] = swap8IfBE(v));
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    const { buffer, length: length4, finished, destroyed, outputLen, pos } = this;
    to || (to = new this.constructor({ dkLen: outputLen }));
    to.set(...this.get());
    to.buffer.set(buffer);
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length4;
    to.pos = pos;
    to.outputLen = outputLen;
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
function compress(s, offset, msg, rounds, v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15) {
  let j = 0;
  for (let i = 0; i < rounds; i++) {
    ({ a: v0, b: v4, c: v8, d: v12 } = G1s(v0, v4, v8, v12, msg[offset + s[j++]]));
    ({ a: v0, b: v4, c: v8, d: v12 } = G2s(v0, v4, v8, v12, msg[offset + s[j++]]));
    ({ a: v1, b: v5, c: v9, d: v13 } = G1s(v1, v5, v9, v13, msg[offset + s[j++]]));
    ({ a: v1, b: v5, c: v9, d: v13 } = G2s(v1, v5, v9, v13, msg[offset + s[j++]]));
    ({ a: v2, b: v6, c: v10, d: v14 } = G1s(v2, v6, v10, v14, msg[offset + s[j++]]));
    ({ a: v2, b: v6, c: v10, d: v14 } = G2s(v2, v6, v10, v14, msg[offset + s[j++]]));
    ({ a: v3, b: v7, c: v11, d: v15 } = G1s(v3, v7, v11, v15, msg[offset + s[j++]]));
    ({ a: v3, b: v7, c: v11, d: v15 } = G2s(v3, v7, v11, v15, msg[offset + s[j++]]));
    ({ a: v0, b: v5, c: v10, d: v15 } = G1s(v0, v5, v10, v15, msg[offset + s[j++]]));
    ({ a: v0, b: v5, c: v10, d: v15 } = G2s(v0, v5, v10, v15, msg[offset + s[j++]]));
    ({ a: v1, b: v6, c: v11, d: v12 } = G1s(v1, v6, v11, v12, msg[offset + s[j++]]));
    ({ a: v1, b: v6, c: v11, d: v12 } = G2s(v1, v6, v11, v12, msg[offset + s[j++]]));
    ({ a: v2, b: v7, c: v8, d: v13 } = G1s(v2, v7, v8, v13, msg[offset + s[j++]]));
    ({ a: v2, b: v7, c: v8, d: v13 } = G2s(v2, v7, v8, v13, msg[offset + s[j++]]));
    ({ a: v3, b: v4, c: v9, d: v14 } = G1s(v3, v4, v9, v14, msg[offset + s[j++]]));
    ({ a: v3, b: v4, c: v9, d: v14 } = G2s(v3, v4, v9, v14, msg[offset + s[j++]]));
  }
  return { v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15 };
}

// ../../node_modules/@noble/hashes/esm/blake3.js
init_utils();
var B3_Flags = {
  CHUNK_START: 1,
  CHUNK_END: 2,
  PARENT: 4,
  ROOT: 8,
  KEYED_HASH: 16,
  DERIVE_KEY_CONTEXT: 32,
  DERIVE_KEY_MATERIAL: 64
};
var B3_IV = SHA256_IV.slice();
var B3_SIGMA = /* @__PURE__ */ (() => {
  const Id = Array.from({ length: 16 }, (_, i) => i);
  const permute = (arr) => [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8].map((i) => arr[i]);
  const res = [];
  for (let i = 0, v = Id; i < 7; i++, v = permute(v))
    res.push(...v);
  return Uint8Array.from(res);
})();
var BLAKE3 = class _BLAKE3 extends BLAKE2 {
  constructor(opts = {}, flags = 0) {
    super(64, opts.dkLen === void 0 ? 32 : opts.dkLen);
    this.chunkPos = 0;
    this.chunksDone = 0;
    this.flags = 0 | 0;
    this.stack = [];
    this.posOut = 0;
    this.bufferOut32 = new Uint32Array(16);
    this.chunkOut = 0;
    this.enableXOF = true;
    const { key, context } = opts;
    const hasContext = context !== void 0;
    if (key !== void 0) {
      if (hasContext)
        throw new Error('Only "key" or "context" can be specified at same time');
      const k = toBytes(key).slice();
      abytes(k, 32);
      this.IV = u32(k);
      swap32IfBE(this.IV);
      this.flags = flags | B3_Flags.KEYED_HASH;
    } else if (hasContext) {
      const ctx = toBytes(context);
      const contextKey = new _BLAKE3({ dkLen: 32 }, B3_Flags.DERIVE_KEY_CONTEXT).update(ctx).digest();
      this.IV = u32(contextKey);
      swap32IfBE(this.IV);
      this.flags = flags | B3_Flags.DERIVE_KEY_MATERIAL;
    } else {
      this.IV = B3_IV.slice();
      this.flags = flags;
    }
    this.state = this.IV.slice();
    this.bufferOut = u8(this.bufferOut32);
  }
  // Unused
  get() {
    return [];
  }
  set() {
  }
  b2Compress(counter, flags, buf, bufPos = 0) {
    const { state: s, pos } = this;
    const { h, l } = fromBig(BigInt(counter), true);
    const { v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15 } = compress(B3_SIGMA, bufPos, buf, 7, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], B3_IV[0], B3_IV[1], B3_IV[2], B3_IV[3], h, l, pos, flags);
    s[0] = v0 ^ v8;
    s[1] = v1 ^ v9;
    s[2] = v2 ^ v10;
    s[3] = v3 ^ v11;
    s[4] = v4 ^ v12;
    s[5] = v5 ^ v13;
    s[6] = v6 ^ v14;
    s[7] = v7 ^ v15;
  }
  compress(buf, bufPos = 0, isLast = false) {
    let flags = this.flags;
    if (!this.chunkPos)
      flags |= B3_Flags.CHUNK_START;
    if (this.chunkPos === 15 || isLast)
      flags |= B3_Flags.CHUNK_END;
    if (!isLast)
      this.pos = this.blockLen;
    this.b2Compress(this.chunksDone, flags, buf, bufPos);
    this.chunkPos += 1;
    if (this.chunkPos === 16 || isLast) {
      let chunk = this.state;
      this.state = this.IV.slice();
      for (let last, chunks = this.chunksDone + 1; isLast || !(chunks & 1); chunks >>= 1) {
        if (!(last = this.stack.pop()))
          break;
        this.buffer32.set(last, 0);
        this.buffer32.set(chunk, 8);
        this.pos = this.blockLen;
        this.b2Compress(0, this.flags | B3_Flags.PARENT, this.buffer32, 0);
        chunk = this.state;
        this.state = this.IV.slice();
      }
      this.chunksDone++;
      this.chunkPos = 0;
      this.stack.push(chunk);
    }
    this.pos = 0;
  }
  _cloneInto(to) {
    to = super._cloneInto(to);
    const { IV, flags, state, chunkPos, posOut, chunkOut, stack, chunksDone } = this;
    to.state.set(state.slice());
    to.stack = stack.map((i) => Uint32Array.from(i));
    to.IV.set(IV);
    to.flags = flags;
    to.chunkPos = chunkPos;
    to.chunksDone = chunksDone;
    to.posOut = posOut;
    to.chunkOut = chunkOut;
    to.enableXOF = this.enableXOF;
    to.bufferOut32.set(this.bufferOut32);
    return to;
  }
  destroy() {
    this.destroyed = true;
    clean(this.state, this.buffer32, this.IV, this.bufferOut32);
    clean(...this.stack);
  }
  // Same as b2Compress, but doesn't modify state and returns 16 u32 array (instead of 8)
  b2CompressOut() {
    const { state: s, pos, flags, buffer32, bufferOut32: out32 } = this;
    const { h, l } = fromBig(BigInt(this.chunkOut++));
    swap32IfBE(buffer32);
    const { v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15 } = compress(B3_SIGMA, 0, buffer32, 7, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], B3_IV[0], B3_IV[1], B3_IV[2], B3_IV[3], l, h, pos, flags);
    out32[0] = v0 ^ v8;
    out32[1] = v1 ^ v9;
    out32[2] = v2 ^ v10;
    out32[3] = v3 ^ v11;
    out32[4] = v4 ^ v12;
    out32[5] = v5 ^ v13;
    out32[6] = v6 ^ v14;
    out32[7] = v7 ^ v15;
    out32[8] = s[0] ^ v8;
    out32[9] = s[1] ^ v9;
    out32[10] = s[2] ^ v10;
    out32[11] = s[3] ^ v11;
    out32[12] = s[4] ^ v12;
    out32[13] = s[5] ^ v13;
    out32[14] = s[6] ^ v14;
    out32[15] = s[7] ^ v15;
    swap32IfBE(buffer32);
    swap32IfBE(out32);
    this.posOut = 0;
  }
  finish() {
    if (this.finished)
      return;
    this.finished = true;
    clean(this.buffer.subarray(this.pos));
    let flags = this.flags | B3_Flags.ROOT;
    if (this.stack.length) {
      flags |= B3_Flags.PARENT;
      swap32IfBE(this.buffer32);
      this.compress(this.buffer32, 0, true);
      swap32IfBE(this.buffer32);
      this.chunksDone = 0;
      this.pos = this.blockLen;
    } else {
      flags |= (!this.chunkPos ? B3_Flags.CHUNK_START : 0) | B3_Flags.CHUNK_END;
    }
    this.flags = flags;
    this.b2CompressOut();
  }
  writeInto(out) {
    aexists(this, false);
    abytes(out);
    this.finish();
    const { blockLen, bufferOut } = this;
    for (let pos = 0, len = out.length; pos < len; ) {
      if (this.posOut >= blockLen)
        this.b2CompressOut();
      const take = Math.min(blockLen - this.posOut, len - pos);
      out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
      this.posOut += take;
      pos += take;
    }
    return out;
  }
  xofInto(out) {
    if (!this.enableXOF)
      throw new Error("XOF is not possible after digest call");
    return this.writeInto(out);
  }
  xof(bytes) {
    anumber(bytes);
    return this.xofInto(new Uint8Array(bytes));
  }
  digestInto(out) {
    aoutput(out, this);
    if (this.finished)
      throw new Error("digest() was already called");
    this.enableXOF = false;
    this.writeInto(out);
    this.destroy();
    return out;
  }
  digest() {
    return this.digestInto(new Uint8Array(this.outputLen));
  }
};
var blake3 = /* @__PURE__ */ createXOFer((opts) => new BLAKE3(opts));

// ../share-sdk/dist/index.js
init_sha256();
init_sha256();
var __defProp2 = Object.defineProperty;
var __export2 = (target, all) => {
  for (var name in all)
    __defProp2(target, name, { get: all[name], enumerable: true });
};
var UNSAFE_FILENAME_CODE_POINT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
function hasUnsafeFilenameCodePoint(value) {
  return UNSAFE_FILENAME_CODE_POINT.test(value);
}
function canonicalShareFilename(value) {
  const canonical = value.normalize("NFC");
  if (canonical.length === 0 || canonical === "." || canonical === ".." || canonical.includes("/") || canonical.includes("\\") || hasUnsafeFilenameCodePoint(canonical)) {
    throw new TypeError("share filename is unsafe");
  }
  return canonical;
}
var external_exports = {};
__export2(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});
var util;
(function(util22) {
  util22.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util22.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util22.assertNever = assertNever;
  util22.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util22.getValidEnumValues = (obj) => {
    const validKeys = util22.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util22.objectValues(filtered);
  };
  util22.objectValues = (obj) => {
    return util22.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util22.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object4) => {
    const keys = [];
    for (const key in object4) {
      if (Object.prototype.hasOwnProperty.call(object4, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util22.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util22.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util22.joinValues = joinValues;
  util22.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil22) {
  objectUtil22.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
var errorUtil;
(function(errorUtil22) {
  errorUtil22.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil22.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap22, invalid_type_error, required_error, description } = params;
  if (errorMap22 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap22)
    return { errorMap: errorMap22, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base6422 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base6422));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base33 = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base33))
          return INVALID;
        const result = effect.transform(base33.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base33) => {
          if (!isValid(base33))
            return INVALID;
          return Promise.resolve(effect.transform(base33.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind22) {
  ZodFirstPartyTypeKind22["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind22["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind22["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind22["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind22["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind22["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind22["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind22["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind22["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind22["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind22["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind22["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind22["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind22["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind22["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind22["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind22["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind22["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind22["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind22["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind22["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind22["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind22["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind22["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind22["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind22["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind22["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind22["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind22["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind22["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind22["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind22["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind22["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind22["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind22["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind22["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;
var empty = new Uint8Array(0);
function equals(aa, bb) {
  if (aa === bb) {
    return true;
  }
  if (aa.byteLength !== bb.byteLength) {
    return false;
  }
  for (let ii = 0; ii < aa.byteLength; ii++) {
    if (aa[ii] !== bb[ii]) {
      return false;
    }
  }
  return true;
}
function coerce2(o) {
  if (o instanceof Uint8Array && o.constructor.name === "Uint8Array") {
    return o;
  }
  if (o instanceof ArrayBuffer) {
    return new Uint8Array(o);
  }
  if (ArrayBuffer.isView(o)) {
    return new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
  }
  throw new Error("Unknown type, must be binary type");
}
function base(ALPHABET, name) {
  if (ALPHABET.length >= 255) {
    throw new TypeError("Alphabet too long");
  }
  var BASE_MAP = new Uint8Array(256);
  for (var j = 0; j < BASE_MAP.length; j++) {
    BASE_MAP[j] = 255;
  }
  for (var i = 0; i < ALPHABET.length; i++) {
    var x = ALPHABET.charAt(i);
    var xc = x.charCodeAt(0);
    if (BASE_MAP[xc] !== 255) {
      throw new TypeError(x + " is ambiguous");
    }
    BASE_MAP[xc] = i;
  }
  var BASE = ALPHABET.length;
  var LEADER = ALPHABET.charAt(0);
  var FACTOR = Math.log(BASE) / Math.log(256);
  var iFACTOR = Math.log(256) / Math.log(BASE);
  function encode32(source) {
    if (source instanceof Uint8Array)
      ;
    else if (ArrayBuffer.isView(source)) {
      source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else if (Array.isArray(source)) {
      source = Uint8Array.from(source);
    }
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("Expected Uint8Array");
    }
    if (source.length === 0) {
      return "";
    }
    var zeroes = 0;
    var length22 = 0;
    var pbegin = 0;
    var pend = source.length;
    while (pbegin !== pend && source[pbegin] === 0) {
      pbegin++;
      zeroes++;
    }
    var size = (pend - pbegin) * iFACTOR + 1 >>> 0;
    var b58 = new Uint8Array(size);
    while (pbegin !== pend) {
      var carry = source[pbegin];
      var i2 = 0;
      for (var it1 = size - 1; (carry !== 0 || i2 < length22) && it1 !== -1; it1--, i2++) {
        carry += 256 * b58[it1] >>> 0;
        b58[it1] = carry % BASE >>> 0;
        carry = carry / BASE >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length22 = i2;
      pbegin++;
    }
    var it2 = size - length22;
    while (it2 !== size && b58[it2] === 0) {
      it2++;
    }
    var str = LEADER.repeat(zeroes);
    for (; it2 < size; ++it2) {
      str += ALPHABET.charAt(b58[it2]);
    }
    return str;
  }
  function decodeUnsafe(source) {
    if (typeof source !== "string") {
      throw new TypeError("Expected String");
    }
    if (source.length === 0) {
      return new Uint8Array();
    }
    var psz = 0;
    if (source[psz] === " ") {
      return;
    }
    var zeroes = 0;
    var length22 = 0;
    while (source[psz] === LEADER) {
      zeroes++;
      psz++;
    }
    var size = (source.length - psz) * FACTOR + 1 >>> 0;
    var b256 = new Uint8Array(size);
    while (source[psz]) {
      var carry = BASE_MAP[source.charCodeAt(psz)];
      if (carry === 255) {
        return;
      }
      var i2 = 0;
      for (var it3 = size - 1; (carry !== 0 || i2 < length22) && it3 !== -1; it3--, i2++) {
        carry += BASE * b256[it3] >>> 0;
        b256[it3] = carry % 256 >>> 0;
        carry = carry / 256 >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length22 = i2;
      psz++;
    }
    if (source[psz] === " ") {
      return;
    }
    var it4 = size - length22;
    while (it4 !== size && b256[it4] === 0) {
      it4++;
    }
    var vch = new Uint8Array(zeroes + (size - it4));
    var j2 = zeroes;
    while (it4 !== size) {
      vch[j2++] = b256[it4++];
    }
    return vch;
  }
  function decode52(string) {
    var buffer = decodeUnsafe(string);
    if (buffer) {
      return buffer;
    }
    throw new Error(`Non-${name} character`);
  }
  return {
    encode: encode32,
    decodeUnsafe,
    decode: decode52
  };
}
var src = base;
var _brrp__multiformats_scope_baseX = src;
var base_x_default = _brrp__multiformats_scope_baseX;
var Encoder = class {
  name;
  prefix;
  baseEncode;
  constructor(name, prefix, baseEncode) {
    this.name = name;
    this.prefix = prefix;
    this.baseEncode = baseEncode;
  }
  encode(bytes3) {
    if (bytes3 instanceof Uint8Array) {
      return `${this.prefix}${this.baseEncode(bytes3)}`;
    } else {
      throw Error("Unknown type, must be binary type");
    }
  }
};
var Decoder = class {
  name;
  prefix;
  baseDecode;
  prefixCodePoint;
  constructor(name, prefix, baseDecode) {
    this.name = name;
    this.prefix = prefix;
    const prefixCodePoint = prefix.codePointAt(0);
    if (prefixCodePoint === void 0) {
      throw new Error("Invalid prefix character");
    }
    this.prefixCodePoint = prefixCodePoint;
    this.baseDecode = baseDecode;
  }
  decode(text) {
    if (typeof text === "string") {
      if (text.codePointAt(0) !== this.prefixCodePoint) {
        throw Error(`Unable to decode multibase string ${JSON.stringify(text)}, ${this.name} decoder only supports inputs prefixed with ${this.prefix}`);
      }
      return this.baseDecode(text.slice(this.prefix.length));
    } else {
      throw Error("Can only multibase decode strings");
    }
  }
  or(decoder) {
    return or(this, decoder);
  }
};
var ComposedDecoder = class {
  decoders;
  constructor(decoders) {
    this.decoders = decoders;
  }
  or(decoder) {
    return or(this, decoder);
  }
  decode(input) {
    const prefix = input[0];
    const decoder = this.decoders[prefix];
    if (decoder != null) {
      return decoder.decode(input);
    } else {
      throw RangeError(`Unable to decode multibase string ${JSON.stringify(input)}, only inputs prefixed with ${Object.keys(this.decoders)} are supported`);
    }
  }
};
function or(left, right) {
  return new ComposedDecoder({
    ...left.decoders ?? { [left.prefix]: left },
    ...right.decoders ?? { [right.prefix]: right }
  });
}
var Codec = class {
  name;
  prefix;
  baseEncode;
  baseDecode;
  encoder;
  decoder;
  constructor(name, prefix, baseEncode, baseDecode) {
    this.name = name;
    this.prefix = prefix;
    this.baseEncode = baseEncode;
    this.baseDecode = baseDecode;
    this.encoder = new Encoder(name, prefix, baseEncode);
    this.decoder = new Decoder(name, prefix, baseDecode);
  }
  encode(input) {
    return this.encoder.encode(input);
  }
  decode(input) {
    return this.decoder.decode(input);
  }
};
function from({ name, prefix, encode: encode32, decode: decode52 }) {
  return new Codec(name, prefix, encode32, decode52);
}
function baseX({ name, prefix, alphabet }) {
  const { encode: encode32, decode: decode52 } = base_x_default(alphabet, name);
  return from({
    prefix,
    name,
    encode: encode32,
    decode: (text) => coerce2(decode52(text))
  });
}
function decode(string, alphabetIdx, bitsPerChar, name) {
  let end = string.length;
  while (string[end - 1] === "=") {
    --end;
  }
  const out = new Uint8Array(end * bitsPerChar / 8 | 0);
  let bits = 0;
  let buffer = 0;
  let written = 0;
  for (let i = 0; i < end; ++i) {
    const value = alphabetIdx[string[i]];
    if (value === void 0) {
      throw new SyntaxError(`Non-${name} character`);
    }
    buffer = buffer << bitsPerChar | value;
    bits += bitsPerChar;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = 255 & buffer >> bits;
    }
  }
  if (bits >= bitsPerChar || (255 & buffer << 8 - bits) !== 0) {
    throw new SyntaxError("Unexpected end of data");
  }
  return out;
}
function encode(data, alphabet, bitsPerChar) {
  const pad = alphabet[alphabet.length - 1] === "=";
  const mask = (1 << bitsPerChar) - 1;
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < data.length; ++i) {
    buffer = buffer << 8 | data[i];
    bits += 8;
    while (bits > bitsPerChar) {
      bits -= bitsPerChar;
      out += alphabet[mask & buffer >> bits];
    }
  }
  if (bits !== 0) {
    out += alphabet[mask & buffer << bitsPerChar - bits];
  }
  if (pad) {
    while ((out.length * bitsPerChar & 7) !== 0) {
      out += "=";
    }
  }
  return out;
}
function createAlphabetIdx(alphabet) {
  const alphabetIdx = {};
  for (let i = 0; i < alphabet.length; ++i) {
    alphabetIdx[alphabet[i]] = i;
  }
  return alphabetIdx;
}
function rfc4648({ name, prefix, bitsPerChar, alphabet }) {
  const alphabetIdx = createAlphabetIdx(alphabet);
  return from({
    prefix,
    name,
    encode(input) {
      return encode(input, alphabet, bitsPerChar);
    },
    decode(input) {
      return decode(input, alphabetIdx, bitsPerChar, name);
    }
  });
}
var base32 = rfc4648({
  prefix: "b",
  name: "base32",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567",
  bitsPerChar: 5
});
var base32upper = rfc4648({
  prefix: "B",
  name: "base32upper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  bitsPerChar: 5
});
var base32pad = rfc4648({
  prefix: "c",
  name: "base32pad",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567=",
  bitsPerChar: 5
});
var base32padupper = rfc4648({
  prefix: "C",
  name: "base32padupper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=",
  bitsPerChar: 5
});
var base32hex = rfc4648({
  prefix: "v",
  name: "base32hex",
  alphabet: "0123456789abcdefghijklmnopqrstuv",
  bitsPerChar: 5
});
var base32hexupper = rfc4648({
  prefix: "V",
  name: "base32hexupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV",
  bitsPerChar: 5
});
var base32hexpad = rfc4648({
  prefix: "t",
  name: "base32hexpad",
  alphabet: "0123456789abcdefghijklmnopqrstuv=",
  bitsPerChar: 5
});
var base32hexpadupper = rfc4648({
  prefix: "T",
  name: "base32hexpadupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV=",
  bitsPerChar: 5
});
var base32z = rfc4648({
  prefix: "h",
  name: "base32z",
  alphabet: "ybndrfg8ejkmcpqxot1uwisza345h769",
  bitsPerChar: 5
});
var base36 = baseX({
  prefix: "k",
  name: "base36",
  alphabet: "0123456789abcdefghijklmnopqrstuvwxyz"
});
var base36upper = baseX({
  prefix: "K",
  name: "base36upper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
});
var base58btc = baseX({
  name: "base58btc",
  prefix: "z",
  alphabet: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
});
var base58flickr = baseX({
  name: "base58flickr",
  prefix: "Z",
  alphabet: "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
});
var encode_1 = encode2;
var MSB = 128;
var REST = 127;
var MSBALL = ~REST;
var INT = Math.pow(2, 31);
function encode2(num, out, offset) {
  out = out || [];
  offset = offset || 0;
  var oldOffset = offset;
  while (num >= INT) {
    out[offset++] = num & 255 | MSB;
    num /= 128;
  }
  while (num & MSBALL) {
    out[offset++] = num & 255 | MSB;
    num >>>= 7;
  }
  out[offset] = num | 0;
  encode2.bytes = offset - oldOffset + 1;
  return out;
}
var decode2 = read;
var MSB$1 = 128;
var REST$1 = 127;
function read(buf, offset) {
  var res = 0, offset = offset || 0, shift = 0, counter = offset, b, l = buf.length;
  do {
    if (counter >= l) {
      read.bytes = 0;
      throw new RangeError("Could not decode varint");
    }
    b = buf[counter++];
    res += shift < 28 ? (b & REST$1) << shift : (b & REST$1) * Math.pow(2, shift);
    shift += 7;
  } while (b >= MSB$1);
  read.bytes = counter - offset;
  return res;
}
var N1 = Math.pow(2, 7);
var N2 = Math.pow(2, 14);
var N3 = Math.pow(2, 21);
var N4 = Math.pow(2, 28);
var N5 = Math.pow(2, 35);
var N6 = Math.pow(2, 42);
var N7 = Math.pow(2, 49);
var N8 = Math.pow(2, 56);
var N9 = Math.pow(2, 63);
var length = function(value) {
  return value < N1 ? 1 : value < N2 ? 2 : value < N3 ? 3 : value < N4 ? 4 : value < N5 ? 5 : value < N6 ? 6 : value < N7 ? 7 : value < N8 ? 8 : value < N9 ? 9 : 10;
};
var varint = {
  encode: encode_1,
  decode: decode2,
  encodingLength: length
};
var _brrp_varint = varint;
var varint_default = _brrp_varint;
function decode3(data, offset = 0) {
  const code22 = varint_default.decode(data, offset);
  return [code22, varint_default.decode.bytes];
}
function encodeTo(int, target, offset = 0) {
  varint_default.encode(int, target, offset);
  return target;
}
function encodingLength(int) {
  return varint_default.encodingLength(int);
}
function create(code22, digest3) {
  const size = digest3.byteLength;
  const sizeOffset = encodingLength(code22);
  const digestOffset = sizeOffset + encodingLength(size);
  const bytes3 = new Uint8Array(digestOffset + size);
  encodeTo(code22, bytes3, 0);
  encodeTo(size, bytes3, sizeOffset);
  bytes3.set(digest3, digestOffset);
  return new Digest(code22, size, digest3, bytes3);
}
function decode4(multihash) {
  const bytes3 = coerce2(multihash);
  const [code22, sizeOffset] = decode3(bytes3);
  const [size, digestOffset] = decode3(bytes3.subarray(sizeOffset));
  const digest3 = bytes3.subarray(sizeOffset + digestOffset);
  if (digest3.byteLength !== size) {
    throw new Error("Incorrect length");
  }
  return new Digest(code22, size, digest3, bytes3);
}
function equals2(a, b) {
  if (a === b) {
    return true;
  } else {
    const data = b;
    return a.code === data.code && a.size === data.size && data.bytes instanceof Uint8Array && equals(a.bytes, data.bytes);
  }
}
var Digest = class {
  code;
  size;
  digest;
  bytes;
  /**
   * Creates a multihash digest.
   */
  constructor(code22, size, digest3, bytes3) {
    this.code = code22;
    this.size = size;
    this.digest = digest3;
    this.bytes = bytes3;
  }
};
function format(link2, base22) {
  const { bytes: bytes3, version: version2 } = link2;
  switch (version2) {
    case 0:
      return toStringV0(bytes3, baseCache(link2), base22 ?? base58btc.encoder);
    default:
      return toStringV1(bytes3, baseCache(link2), base22 ?? base32.encoder);
  }
}
var cache = /* @__PURE__ */ new WeakMap();
function baseCache(cid2) {
  const baseCache22 = cache.get(cid2);
  if (baseCache22 == null) {
    const baseCache32 = /* @__PURE__ */ new Map();
    cache.set(cid2, baseCache32);
    return baseCache32;
  }
  return baseCache22;
}
var CID = class _CID {
  code;
  version;
  multihash;
  bytes;
  "/";
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param multihash - (Multi)hash of the of the content.
   */
  constructor(version2, code22, multihash, bytes3) {
    this.code = code22;
    this.version = version2;
    this.multihash = multihash;
    this.bytes = bytes3;
    this["/"] = bytes3;
  }
  /**
   * Signalling `cid.asCID === cid` has been replaced with `cid['/'] === cid.bytes`
   * please either use `CID.asCID(cid)` or switch to new signalling mechanism
   *
   * @deprecated
   */
  get asCID() {
    return this;
  }
  // ArrayBufferView
  get byteOffset() {
    return this.bytes.byteOffset;
  }
  // ArrayBufferView
  get byteLength() {
    return this.bytes.byteLength;
  }
  toV0() {
    switch (this.version) {
      case 0: {
        return this;
      }
      case 1: {
        const { code: code22, multihash } = this;
        if (code22 !== DAG_PB_CODE) {
          throw new Error("Cannot convert a non dag-pb CID to CIDv0");
        }
        if (multihash.code !== SHA_256_CODE) {
          throw new Error("Cannot convert non sha2-256 multihash CID to CIDv0");
        }
        return _CID.createV0(multihash);
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 0. This is a bug please report`);
      }
    }
  }
  toV1() {
    switch (this.version) {
      case 0: {
        const { code: code22, digest: digest3 } = this.multihash;
        const multihash = create(code22, digest3);
        return _CID.createV1(this.code, multihash);
      }
      case 1: {
        return this;
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 1. This is a bug please report`);
      }
    }
  }
  equals(other) {
    return _CID.equals(this, other);
  }
  static equals(self, other) {
    const unknown = other;
    return unknown != null && self.code === unknown.code && self.version === unknown.version && equals2(self.multihash, unknown.multihash);
  }
  toString(base22) {
    return format(this, base22);
  }
  toJSON() {
    return { "/": format(this) };
  }
  link() {
    return this;
  }
  [Symbol.toStringTag] = "CID";
  // Legacy
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return `CID(${this.toString()})`;
  }
  /**
   * Takes any input `value` and returns a `CID` instance if it was
   * a `CID` otherwise returns `null`. If `value` is instanceof `CID`
   * it will return value back. If `value` is not instance of this CID
   * class, but is compatible CID it will return new instance of this
   * `CID` class. Otherwise returns null.
   *
   * This allows two different incompatible versions of CID library to
   * co-exist and interop as long as binary interface is compatible.
   */
  static asCID(input) {
    if (input == null) {
      return null;
    }
    const value = input;
    if (value instanceof _CID) {
      return value;
    } else if (value["/"] != null && value["/"] === value.bytes || value.asCID === value) {
      const { version: version2, code: code22, multihash, bytes: bytes3 } = value;
      return new _CID(version2, code22, multihash, bytes3 ?? encodeCID(version2, code22, multihash.bytes));
    } else if (value[cidSymbol] === true) {
      const { version: version2, multihash, code: code22 } = value;
      const digest3 = decode4(multihash);
      return _CID.create(version2, code22, digest3);
    } else {
      return null;
    }
  }
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param digest - (Multi)hash of the of the content.
   */
  static create(version2, code22, digest3) {
    if (typeof code22 !== "number") {
      throw new Error("String codecs are no longer supported");
    }
    if (!(digest3.bytes instanceof Uint8Array)) {
      throw new Error("Invalid digest");
    }
    switch (version2) {
      case 0: {
        if (code22 !== DAG_PB_CODE) {
          throw new Error(`Version 0 CID must use dag-pb (code: ${DAG_PB_CODE}) block encoding`);
        } else {
          return new _CID(version2, code22, digest3, digest3.bytes);
        }
      }
      case 1: {
        const bytes3 = encodeCID(version2, code22, digest3.bytes);
        return new _CID(version2, code22, digest3, bytes3);
      }
      default: {
        throw new Error("Invalid version");
      }
    }
  }
  /**
   * Simplified version of `create` for CIDv0.
   */
  static createV0(digest3) {
    return _CID.create(0, DAG_PB_CODE, digest3);
  }
  /**
   * Simplified version of `create` for CIDv1.
   *
   * @param code - Content encoding format code.
   * @param digest - Multihash of the content.
   */
  static createV1(code22, digest3) {
    return _CID.create(1, code22, digest3);
  }
  /**
   * Decoded a CID from its binary representation. The byte array must contain
   * only the CID with no additional bytes.
   *
   * An error will be thrown if the bytes provided do not contain a valid
   * binary representation of a CID.
   */
  static decode(bytes3) {
    const [cid2, remainder] = _CID.decodeFirst(bytes3);
    if (remainder.length !== 0) {
      throw new Error("Incorrect length");
    }
    return cid2;
  }
  /**
   * Decoded a CID from its binary representation at the beginning of a byte
   * array.
   *
   * Returns an array with the first element containing the CID and the second
   * element containing the remainder of the original byte array. The remainder
   * will be a zero-length byte array if the provided bytes only contained a
   * binary CID representation.
   */
  static decodeFirst(bytes3) {
    const specs = _CID.inspectBytes(bytes3);
    const prefixSize = specs.size - specs.multihashSize;
    const multihashBytes = coerce2(bytes3.subarray(prefixSize, prefixSize + specs.multihashSize));
    if (multihashBytes.byteLength !== specs.multihashSize) {
      throw new Error("Incorrect length");
    }
    const digestBytes3 = multihashBytes.subarray(specs.multihashSize - specs.digestSize);
    const digest3 = new Digest(specs.multihashCode, specs.digestSize, digestBytes3, multihashBytes);
    const cid2 = specs.version === 0 ? _CID.createV0(digest3) : _CID.createV1(specs.codec, digest3);
    return [cid2, bytes3.subarray(specs.size)];
  }
  /**
   * Inspect the initial bytes of a CID to determine its properties.
   *
   * Involves decoding up to 4 varints. Typically this will require only 4 to 6
   * bytes but for larger multicodec code values and larger multihash digest
   * lengths these varints can be quite large. It is recommended that at least
   * 10 bytes be made available in the `initialBytes` argument for a complete
   * inspection.
   */
  static inspectBytes(initialBytes) {
    let offset = 0;
    const next = () => {
      const [i, length22] = decode3(initialBytes.subarray(offset));
      offset += length22;
      return i;
    };
    let version2 = next();
    let codec = DAG_PB_CODE;
    if (version2 === 18) {
      version2 = 0;
      offset = 0;
    } else {
      codec = next();
    }
    if (version2 !== 0 && version2 !== 1) {
      throw new RangeError(`Invalid CID version ${version2}`);
    }
    const prefixSize = offset;
    const multihashCode = next();
    const digestSize = next();
    const size = offset + digestSize;
    const multihashSize = size - prefixSize;
    return { version: version2, codec, multihashCode, digestSize, multihashSize, size };
  }
  /**
   * Takes cid in a string representation and creates an instance. If `base`
   * decoder is not provided will use a default from the configuration. It will
   * throw an error if encoding of the CID is not compatible with supplied (or
   * a default decoder).
   */
  static parse(source, base22) {
    const [prefix, bytes3] = parseCIDtoBytes(source, base22);
    const cid2 = _CID.decode(bytes3);
    if (cid2.version === 0 && source[0] !== "Q") {
      throw Error("Version 0 CID string must not include multibase prefix");
    }
    baseCache(cid2).set(prefix, source);
    return cid2;
  }
};
function parseCIDtoBytes(source, base22) {
  switch (source[0]) {
    // CIDv0 is parsed differently
    case "Q": {
      const decoder = base22 ?? base58btc;
      return [
        base58btc.prefix,
        decoder.decode(`${base58btc.prefix}${source}`)
      ];
    }
    case base58btc.prefix: {
      const decoder = base22 ?? base58btc;
      return [base58btc.prefix, decoder.decode(source)];
    }
    case base32.prefix: {
      const decoder = base22 ?? base32;
      return [base32.prefix, decoder.decode(source)];
    }
    case base36.prefix: {
      const decoder = base22 ?? base36;
      return [base36.prefix, decoder.decode(source)];
    }
    default: {
      if (base22 == null) {
        throw Error("To parse non base32, base36 or base58btc encoded CID multibase decoder must be provided");
      }
      return [source[0], base22.decode(source)];
    }
  }
}
function toStringV0(bytes3, cache22, base22) {
  const { prefix } = base22;
  if (prefix !== base58btc.prefix) {
    throw Error(`Cannot string encode V0 in ${base22.name} encoding`);
  }
  const cid2 = cache22.get(prefix);
  if (cid2 == null) {
    const cid22 = base22.encode(bytes3).slice(1);
    cache22.set(prefix, cid22);
    return cid22;
  } else {
    return cid2;
  }
}
function toStringV1(bytes3, cache22, base22) {
  const { prefix } = base22;
  const cid2 = cache22.get(prefix);
  if (cid2 == null) {
    const cid22 = base22.encode(bytes3);
    cache22.set(prefix, cid22);
    return cid22;
  } else {
    return cid2;
  }
}
var DAG_PB_CODE = 112;
var SHA_256_CODE = 18;
function encodeCID(version2, code22, multihash) {
  const codeOffset = encodingLength(version2);
  const hashOffset = codeOffset + encodingLength(code22);
  const bytes3 = new Uint8Array(hashOffset + multihash.byteLength);
  encodeTo(version2, bytes3, 0);
  encodeTo(code22, bytes3, codeOffset);
  bytes3.set(multihash, hashOffset);
  return bytes3;
}
var cidSymbol = /* @__PURE__ */ Symbol.for("@ipld/js-cid/CID");
var code = 85;
var SHA256_CODE = 18;
async function computeCid(bytes3) {
  const digest3 = create(SHA256_CODE, sha256(new Uint8Array(bytes3)));
  return CID.create(1, code, digest3).toString();
}
function isCanonicalRawCid(cidString) {
  let cid2;
  try {
    cid2 = CID.parse(cidString);
  } catch {
    return false;
  }
  return cid2.version === 1 && cid2.code === code && cid2.multihash.code === SHA256_CODE && cid2.toString() === cidString;
}
var base64 = rfc4648({
  prefix: "m",
  name: "base64",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  bitsPerChar: 6
});
var base64pad = rfc4648({
  prefix: "M",
  name: "base64pad",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
  bitsPerChar: 6
});
var base64url = rfc4648({
  prefix: "u",
  name: "base64url",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  bitsPerChar: 6
});
var base64urlpad = rfc4648({
  prefix: "U",
  name: "base64urlpad",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=",
  bitsPerChar: 6
});
function toBase64Url(bytes3) {
  return base64url.baseEncode(bytes3);
}
function fromBase64Url(text) {
  const bytes3 = base64url.baseDecode(text);
  if (base64url.baseEncode(bytes3) !== text) {
    throw new TypeError("non-canonical base64url input");
  }
  return bytes3;
}
function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}
var ED25519_MULTICODEC_PREFIX = Uint8Array.of(237, 1);
var PUBLIC_KEY_LENGTH = 32;
function ed25519PublicKeyFromDidKey(did) {
  if (!did.startsWith("did:key:")) {
    throw new TypeError(`not a did:key: ${did}`);
  }
  const multibase = did.slice("did:key:".length);
  const prefixed = base58btc.decode(multibase);
  if (prefixed.length !== ED25519_MULTICODEC_PREFIX.length + PUBLIC_KEY_LENGTH || prefixed[0] !== ED25519_MULTICODEC_PREFIX[0] || prefixed[1] !== ED25519_MULTICODEC_PREFIX[1]) {
    throw new TypeError("did:key does not encode an ed25519 public key");
  }
  return prefixed.slice(ED25519_MULTICODEC_PREFIX.length);
}
function decodeBase64UrlOrNull(value) {
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
}
var base64UrlString = () => external_exports.string().refine((value) => decodeBase64UrlOrNull(value) !== null, {
  message: "expected strictly-decodable unpadded base64url"
});
function isCanonicalHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.origin === value;
}
var sessionJwkCommonFields = {
  alg: external_exports.string().min(1).optional(),
  use: external_exports.string().min(1).optional(),
  key_ops: external_exports.array(external_exports.string().min(1)).optional(),
  kid: external_exports.string().min(1).optional(),
  ext: external_exports.boolean().optional()
};
var okpPrivateJwkSchema = external_exports.object({
  kty: external_exports.literal("OKP"),
  crv: external_exports.string().min(1),
  x: base64UrlString(),
  d: base64UrlString(),
  ...sessionJwkCommonFields
}).strict();
var ecPrivateJwkSchema = external_exports.object({
  kty: external_exports.literal("EC"),
  crv: external_exports.string().min(1),
  x: base64UrlString(),
  y: base64UrlString(),
  d: base64UrlString(),
  ...sessionJwkCommonFields
}).strict();
var sessionJwkSchema = external_exports.discriminatedUnion("kty", [
  okpPrivateJwkSchema,
  ecPrivateJwkSchema
]);
var policyTargetSchema = external_exports.object({
  kind: external_exports.literal("policy"),
  policyCid: external_exports.string().min(1),
  /** Canonical policy bytes, base64url-encoded (bytes are not JSON). */
  policyBytes: base64UrlString()
}).strict();
var bearerKeyTargetSchema = external_exports.object({
  kind: external_exports.literal("bearerKey"),
  sessionJwk: sessionJwkSchema
}).strict();
var recipientDidTargetSchema = external_exports.object({
  kind: external_exports.literal("recipientDid"),
  did: external_exports.string().regex(/^did:[a-z0-9]+:.+$/, "expected a DID")
}).strict();
var authorizationTargetSchema = external_exports.discriminatedUnion("kind", [
  policyTargetSchema,
  bearerKeyTargetSchema,
  recipientDidTargetSchema
]);
function isCanonicalResourcePath(value) {
  if (value.length === 0) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (/%2f|%5c|%2e/i.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function isCanonicalPathSegment(value) {
  return isCanonicalResourcePath(value) && !value.includes("/");
}
var resourceSelectorSchema = external_exports.object({
  kind: external_exports.union([external_exports.literal("exact"), external_exports.literal("prefix")]),
  path: external_exports.string().min(1)
}).strict().superRefine((selector, ctx) => {
  const body = selector.kind === "prefix" && selector.path.endsWith("/") ? selector.path.slice(0, -1) : selector.path;
  if (!isCanonicalResourcePath(body)) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["path"],
      message: "expected a canonical resource path (non-empty segments, no . or .. segments, no //, no backslash, no %2f/%5c/%2e, no control chars)"
    });
  }
});
var targetSchema = external_exports.object({
  origin: external_exports.string().refine(isCanonicalHttpsOrigin, {
    message: "expected a canonical https origin (https://host[:port], nothing else)"
  }),
  nodeAudience: external_exports.string().min(1),
  spaceId: external_exports.string().refine(isCanonicalPathSegment, {
    message: "expected a single canonical path segment (spaceId joins the resource URI; separators/traversal would alias grants)"
  }),
  resource: resourceSelectorSchema
}).strict();
var displaySchema = external_exports.object({
  senderName: external_exports.string().optional(),
  filename: external_exports.string().optional(),
  recipientHint: external_exports.string().optional(),
  /**
   * Presentation preference only (viewer spec §1): may narrow, never widen;
   * capabilities always win.
   */
  mode: external_exports.union([external_exports.literal("document"), external_exports.literal("source"), external_exports.literal("folder")]).optional()
}).strict();
var contentPointerSchema = external_exports.object({
  cid: external_exports.string().refine(isCanonicalRawCid, {
    message: "expected a canonical CIDv1 raw sha2-256 base32 CID"
  }),
  key: external_exports.string().refine((value) => decodeBase64UrlOrNull(value)?.length === 32, {
    message: "expected base64url decoding to exactly 32 bytes"
  })
}).strict();
var signatureSchema = external_exports.object({
  /** did:key of the sender's ed25519 signing key. */
  signerDid: external_exports.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/, "expected a did:key"),
  algorithm: external_exports.literal("Ed25519"),
  /** base64url-encoded ed25519 signature over the JCS bytes of all other fields. */
  value: external_exports.string().refine((value) => decodeBase64UrlOrNull(value)?.length === 64, {
    message: "expected base64url decoding to exactly 64 bytes"
  })
}).strict();
var unsignedShareEnvelopeSchema = external_exports.object({
  version: external_exports.literal(1),
  shareId: external_exports.string().min(1),
  /** Full signed delegation chain, opaque serialized form. */
  delegation: external_exports.string().min(1),
  authorizationTarget: authorizationTargetSchema,
  target: targetSchema,
  display: displaySchema,
  /** ISO 8601 UTC datetime. Advisory here; enforcement is the delegation's. */
  expiry: external_exports.string().datetime(),
  /** Bearer-slice sealed-content pointer (see contentPointerSchema). */
  content: contentPointerSchema.optional()
}).strict();
var shareEnvelopeSchema = unsignedShareEnvelopeSchema.extend({ signature: signatureSchema }).strict();
var recipientMatcherSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("exactEmail"), value: external_exports.string().min(3).regex(/^[^@\s]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/) }).strict(),
  external_exports.object({ kind: external_exports.literal("emailDomain"), value: external_exports.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/) }).strict(),
  external_exports.object({ kind: external_exports.literal("recipientDid"), value: external_exports.string().regex(/^did:[a-z0-9]+:.+$/) }).strict(),
  external_exports.object({ kind: external_exports.literal("policyDigest"), value: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  external_exports.object({ kind: external_exports.literal("bearer") }).strict()
]);
var shareActionSchema = external_exports.union([external_exports.literal("read"), external_exports.literal("list"), external_exports.literal("edit")]);
var kvContentSourceSchema = external_exports.object({
  kind: external_exports.literal("kv"),
  space: external_exports.string().min(1),
  path: external_exports.string().min(1),
  action: external_exports.literal("tinycloud.kv/get")
}).strict();
var sqlContentSourceSchema = external_exports.object({
  kind: external_exports.literal("sql"),
  space: external_exports.string().min(1),
  database: external_exports.string().min(1),
  path: external_exports.string().min(1),
  statement: external_exports.string().min(1),
  arguments: external_exports.record(external_exports.string(), external_exports.number().int()),
  argumentsDigest: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/),
  action: external_exports.literal("tinycloud.sql/read")
}).strict();
var contentSourceSchema = external_exports.discriminatedUnion("kind", [kvContentSourceSchema, sqlContentSourceSchema]);
var v2TargetSchema = external_exports.object({
  origin: external_exports.string().refine(isCanonicalHttpsOrigin, { message: "expected a canonical https origin" }),
  nodeAudience: external_exports.string().min(1),
  spaceId: external_exports.string().refine(isCanonicalPathSegment, { message: "expected a canonical space id" })
}).strict();
var shareDecryptionSchema = external_exports.object({
  networkId: external_exports.string().min(1),
  action: external_exports.literal("tinycloud.encryption/decrypt")
}).strict();
var ownerAuthoritySchema = external_exports.object({
  registrationCid: external_exports.string().min(1),
  shareCid: external_exports.string().min(1),
  envelopeCid: external_exports.string().min(1),
  enforcementDelegation: external_exports.record(external_exports.string(), external_exports.unknown()),
  outerEnvelope: external_exports.record(external_exports.string(), external_exports.unknown()),
  /** Node-signed registration evidence; required by trusted policy adapters. */
  registrationReceipt: external_exports.object({
    registration: external_exports.record(external_exports.string(), external_exports.unknown()),
    proof: external_exports.record(external_exports.string(), external_exports.unknown())
  }).strict().optional()
}).strict();
var contentMetadataSchema = external_exports.object({
  mediaType: external_exports.string().min(1).max(128).optional(),
  byteLength: external_exports.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  filename: external_exports.string().min(1).max(255).optional(),
  encoding: external_exports.literal("utf-8").optional(),
  /** Encrypted presentation discriminator. The fixed entry point is index.html. */
  artifact: external_exports.literal("html").optional()
}).strict();
var deliveryEmailSchema = external_exports.string().email();
function isEnvelopeDeliveryEmail(value) {
  return deliveryEmailSchema.safeParse(value).success;
}
var unsignedShareEnvelopeV2BaseSchema = external_exports.object({
  version: external_exports.literal(2),
  shareId: external_exports.string().min(1),
  recipientMatcher: recipientMatcherSchema,
  deliveryEmail: deliveryEmailSchema.optional(),
  actions: external_exports.array(shareActionSchema).min(1).max(3),
  resource: resourceSelectorSchema,
  target: v2TargetSchema,
  delegationCid: external_exports.string().min(1),
  authorityMaterialHandle: external_exports.string().min(1),
  authorityMaterialDigest: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/),
  decryption: shareDecryptionSchema.optional(),
  contentSource: contentSourceSchema,
  contentSourceDigest: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/),
  authorizationTarget: authorizationTargetSchema,
  display: displaySchema,
  expiry: external_exports.string().datetime(),
  encrypted: external_exports.boolean(),
  content: contentPointerSchema.optional(),
  metadata: contentMetadataSchema,
  ownerAuthority: ownerAuthoritySchema.optional()
}).strict();
function validateV2Invariants(value, ctx) {
  const actions = [...value.actions];
  if (new Set(actions).size !== actions.length) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["actions"], message: "actions must be unique" });
  if (actions.some((action, index) => action !== ["read", "list", "edit"].filter((candidate) => actions.includes(candidate))[index])) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["actions"], message: "actions must be canonically ordered" });
  if (!value.encrypted && value.recipientMatcher.kind !== "policyDigest") ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["recipientMatcher"], message: "safe plaintext must carry only a matcher digest" });
  if (!value.encrypted && value.authorizationTarget.kind !== "policy") ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["encrypted"], message: "unencrypted content requires a policy target" });
  if (!value.encrypted && value.content !== void 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["content"], message: "policy-only plaintext cannot carry content" });
  if (value.encrypted && (value.metadata.mediaType === void 0 || value.metadata.filename === void 0 || value.metadata.byteLength === void 0)) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["metadata"], message: "encrypted shares must describe their content" });
  if (!value.encrypted && Object.keys(value.metadata).length !== 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["metadata"], message: "policy-only plaintext cannot describe content" });
  if (!value.encrypted && value.metadata.encoding !== void 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["metadata", "encoding"], message: "policy-only plaintext cannot carry content encoding" });
  if (value.metadata.artifact === "html" && (!value.encrypted || value.resource.kind !== "prefix" || !value.actions.includes("read") || !value.actions.includes("list"))) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["metadata", "artifact"], message: "html artifacts require an encrypted readable prefix" });
  if (!value.encrypted && (value.display.senderName !== void 0 || value.display.filename !== void 0 || value.display.recipientHint !== void 0)) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["display"], message: "policy-only plaintext cannot carry display metadata" });
  if (!value.encrypted && value.deliveryEmail !== void 0) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["deliveryEmail"], message: "policy-only plaintext cannot carry delivery metadata" });
  if (value.recipientMatcher.kind === "exactEmail" && value.deliveryEmail !== void 0 && value.deliveryEmail !== value.recipientMatcher.value) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["deliveryEmail"], message: "delivery email must match the exact matcher" });
  if (value.recipientMatcher.kind === "emailDomain" && value.deliveryEmail !== void 0 && value.deliveryEmail.toLowerCase().endsWith(`@${value.recipientMatcher.value}`) === false) ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["deliveryEmail"], message: "delivery email must belong to the matcher domain" });
  if (value.contentSource.kind === "kv" && value.contentSource.action !== "tinycloud.kv/get") ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["contentSource"], message: "source action mismatch" });
  if (value.contentSource.kind === "sql" && value.contentSource.action !== "tinycloud.sql/read") ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["contentSource"], message: "source action mismatch" });
}
var unsignedShareEnvelopeV2Schema = unsignedShareEnvelopeV2BaseSchema.superRefine(validateV2Invariants);
var shareEnvelopeV2Schema = unsignedShareEnvelopeV2BaseSchema.extend({ signature: signatureSchema }).strict().superRefine(validateV2Invariants);
var unifiedResourceSchema = external_exports.string().refine((value) => {
  const marker = value.indexOf("/kv/");
  if (marker < 1) return false;
  const space = value.slice(0, marker);
  const legacy = space.startsWith("tinycloud://");
  if (legacy ? /[:/?#%]/.test(space.slice("tinycloud://".length)) : !space.startsWith("tinycloud:") || /[/?#%]/.test(space)) return false;
  const path = value.slice(marker + 4);
  return !path.startsWith("/") && !path.endsWith("/") && !path.includes("//") && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, { message: "expected canonical TinyCloud KV resource" });
var unifiedEncryptionNetworkSchema = external_exports.string().refine((value) => {
  if (!value.startsWith("urn:tinycloud:encryption:")) return false;
  const rest = value.slice("urn:tinycloud:encryption:".length);
  const separator = rest.lastIndexOf(":");
  const owner = separator < 0 ? "" : rest.slice(0, separator);
  const network = separator < 0 ? "" : rest.slice(separator + 1);
  return owner.startsWith("did:") && owner.length > 4 && network.length > 0 && !/[:/%?#\s]/.test(network);
}, { message: "expected canonical TinyCloud encryption network" });
var unifiedKvCapabilitySchema = external_exports.object({
  kind: external_exports.literal("kv"),
  resource: unifiedResourceSchema,
  selector: external_exports.union([external_exports.literal("exact"), external_exports.literal("prefix")]),
  actions: external_exports.array(external_exports.union([
    external_exports.literal("tinycloud.kv/get"),
    external_exports.literal("tinycloud.kv/list"),
    external_exports.literal("tinycloud.kv/metadata"),
    external_exports.literal("tinycloud.kv/put")
  ])).min(1)
}).strict();
var unifiedEncryptionCapabilitySchema = external_exports.object({
  kind: external_exports.literal("encryption"),
  resource: unifiedEncryptionNetworkSchema,
  action: external_exports.literal("tinycloud.encryption/decrypt")
}).strict();
var unifiedCapabilitySchema = external_exports.union([unifiedKvCapabilitySchema, unifiedEncryptionCapabilitySchema]);
var unifiedContentSourceSchema = external_exports.object({
  shareId: external_exports.string().min(1),
  kvResource: unifiedResourceSchema,
  selector: external_exports.union([external_exports.literal("exact"), external_exports.literal("prefix")]),
  encryptionNetwork: unifiedEncryptionNetworkSchema,
  encryptedSymmetricKeyDigestHex: external_exports.string().regex(/^[0-9a-f]{64}$/),
  keyVersion: external_exports.number().int().positive(),
  mode: external_exports.union([external_exports.literal("mutable"), external_exports.literal("immutable")]),
  initialCiphertextDigestHex: external_exports.string().regex(/^[0-9a-f]{64}$/).optional()
}).strict();
var unifiedPolicyV1Schema = external_exports.object({
  schema: external_exports.literal("xyz.tinycloud.policy/policy/v1"),
  policyId: external_exports.string().regex(/^pol_[a-z2-7]+$/),
  ownerDid: external_exports.string().min(1),
  createdAt: external_exports.string().datetime({ offset: true }),
  expiresAt: external_exports.string().datetime({ offset: true }).optional(),
  contentSource: unifiedContentSourceSchema,
  capabilityCeiling: external_exports.array(unifiedCapabilitySchema).min(2),
  signature: external_exports.object({ suite: external_exports.string().min(1), signerDid: external_exports.string().min(1), value: external_exports.string().min(1) }).strict()
}).strict();
var policyCredentialRequirementV1Schema = external_exports.object({
  type: external_exports.literal("TinyCloudPolicyCredentialRequirement"),
  version: external_exports.literal(1),
  requirementDigest: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/),
  descriptorDigest: external_exports.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuerDid: external_exports.string().min(1),
  issuerKid: external_exports.string().min(1),
  profile: external_exports.object({ id: external_exports.string().min(1), version: external_exports.literal(1) }).strict(),
  credentialType: external_exports.object({ id: external_exports.string().min(1), version: external_exports.literal(1) }).strict()
}).strict();
var unifiedPolicyV2Schema = external_exports.object({
  schema: external_exports.literal("xyz.tinycloud.policy/policy/v2"),
  policyId: external_exports.string().regex(/^pol_[a-z2-7]+$/),
  ownerDid: external_exports.string().min(1),
  createdAt: external_exports.string().datetime({ offset: true }),
  expiresAt: external_exports.string().datetime({ offset: true }).optional(),
  contentSource: unifiedContentSourceSchema,
  capabilityCeiling: external_exports.array(unifiedCapabilitySchema).min(2),
  credentialRequirement: policyCredentialRequirementV1Schema,
  signature: external_exports.object({ suite: external_exports.literal("Ed25519"), signerDid: external_exports.string().min(1), value: external_exports.string().min(1) }).strict()
}).strict();
var unifiedPolicySchema = external_exports.discriminatedUnion("schema", [
  unifiedPolicyV1Schema,
  unifiedPolicyV2Schema
]);
var unifiedRootSchema = external_exports.object({
  cid: external_exports.string().min(1),
  authorization: external_exports.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  role: external_exports.union([external_exports.literal("policy-authority"), external_exports.literal("policy-enforcement")])
}).strict();
var attestedEnforcerBindingV2Schema = external_exports.object({
  schema: external_exports.literal("xyz.tinycloud.policy/attested-enforcer/v2"),
  enforcerDid: external_exports.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/),
  nodeAudience: external_exports.string().min(1),
  attestationBindingDigestHex: external_exports.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: external_exports.string().datetime({ offset: true }),
  expiresAt: external_exports.string().datetime({ offset: true }),
  signature: external_exports.object({ suite: external_exports.literal("Ed25519"), signerDid: external_exports.string().min(1), value: base64UrlString() }).strict()
}).strict();
var v3TargetSchema = external_exports.object({
  origin: external_exports.string().refine(isCanonicalHttpsOrigin, { message: "expected a canonical https origin" }),
  nodeAudience: external_exports.string().min(1),
  spaceId: external_exports.string().refine(isCanonicalPathSegment, { message: "expected a canonical space id" })
}).strict();
var unsignedShareEnvelopeV3BaseSchema = external_exports.object({
  version: external_exports.literal(3),
  shareId: external_exports.string().min(1),
  recipientMatcher: recipientMatcherSchema,
  deliveryEmail: deliveryEmailSchema.optional(),
  actions: external_exports.array(shareActionSchema).min(1).max(3),
  resource: resourceSelectorSchema,
  target: v3TargetSchema,
  policy: unifiedPolicySchema,
  policyCid: external_exports.string().min(1),
  policyRoot: unifiedRootSchema,
  enforcementRoot: unifiedRootSchema,
  attestedEnforcerBinding: attestedEnforcerBindingV2Schema,
  contentSource: unifiedContentSourceSchema,
  contentSourceDigestHex: external_exports.string().regex(/^[0-9a-f]{64}$/),
  encryptionNetwork: unifiedEncryptionNetworkSchema,
  expiry: external_exports.string().datetime({ offset: true }),
  display: displaySchema,
  encrypted: external_exports.literal(true),
  metadata: contentMetadataSchema
}).strict();
function validateV3Invariants(value, ctx) {
  const actions = [...value.actions];
  if (new Set(actions).size !== actions.length || actions.some((action, index) => action !== ["read", "list", "edit"].filter((candidate) => actions.includes(candidate))[index])) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["actions"], message: "actions must be unique and canonically ordered" });
  }
  if (value.policyRoot.role !== "policy-authority" || value.enforcementRoot.role !== "policy-enforcement") {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["policyRoot", "role"], message: "root roles are fixed" });
  }
  if (value.policyCid.length === 0 || value.policyCid === value.policyRoot.cid || value.policyCid === value.enforcementRoot.cid) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["policyCid"], message: "policy CID must be distinct from both roots" });
  }
  if (value.contentSource.encryptionNetwork !== value.encryptionNetwork) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["encryptionNetwork"], message: "encryption network is not bound to the source" });
  }
  if (value.attestedEnforcerBinding.nodeAudience !== value.target.nodeAudience || value.attestedEnforcerBinding.signature.signerDid !== value.attestedEnforcerBinding.nodeAudience || Date.parse(value.attestedEnforcerBinding.expiresAt) < Date.parse(value.expiry)) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["attestedEnforcerBinding"], message: "enforcer binding does not cover the target and share lifetime" });
  }
  if (value.policy.contentSource.shareId !== value.contentSource.shareId || value.policy.contentSource.kvResource !== value.contentSource.kvResource || value.policy.contentSource.selector !== value.contentSource.selector || value.policy.contentSource.encryptionNetwork !== value.encryptionNetwork || value.policy.contentSource.encryptedSymmetricKeyDigestHex !== value.contentSource.encryptedSymmetricKeyDigestHex || value.policy.contentSource.keyVersion !== value.contentSource.keyVersion || value.policy.contentSource.mode !== value.contentSource.mode || value.policy.contentSource.initialCiphertextDigestHex !== value.contentSource.initialCiphertextDigestHex) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["contentSource"], message: "content source is not bound to policy" });
  }
  if (value.policy.signature.suite !== "Ed25519" || value.policy.signature.signerDid !== value.policy.ownerDid) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["policy", "signature"], message: "policy must be signed by its owner" });
  }
  const kvCapabilities = value.policy.capabilityCeiling.filter((capability) => capability.kind === "kv");
  const decryptCapabilities = value.policy.capabilityCeiling.filter((capability) => capability.kind === "encryption" && capability.resource === value.encryptionNetwork && capability.action === "tinycloud.encryption/decrypt");
  if (value.policy.capabilityCeiling.length !== 2 || kvCapabilities.length !== 1 || decryptCapabilities.length !== 1 || kvCapabilities[0]?.resource !== value.contentSource.kvResource || kvCapabilities[0]?.selector !== value.contentSource.selector) {
    ctx.addIssue({ code: external_exports.ZodIssueCode.custom, path: ["policy", "capabilityCeiling"], message: "policy ceiling must contain exact decrypt network" });
  }
}
var unsignedShareEnvelopeV3Schema = unsignedShareEnvelopeV3BaseSchema.superRefine(validateV3Invariants);
var shareEnvelopeV3Schema = unsignedShareEnvelopeV3BaseSchema.extend({ signature: signatureSchema }).strict().superRefine(validateV3Invariants);
var ENVELOPE_AAD_LABEL = "tinycloud-share-envelope-v1";
var SEALED_BLOB_VERSION = 1;
var AAD = utf8Bytes(ENVELOPE_AAD_LABEL);
var KEY_LENGTH = 32;
var NONCE_LENGTH = 12;
var TAG_LENGTH = 16;
var HEADER_LENGTH = 1;
function assertKey(key32) {
  if (key32.length !== KEY_LENGTH) {
    throw new TypeError(`key must be ${KEY_LENGTH} bytes, got ${key32.length}`);
  }
}
async function importAesKey(key32, usage) {
  assertKey(key32);
  return globalThis.crypto.subtle.importKey(
    "raw",
    key32,
    "AES-GCM",
    false,
    [usage]
  );
}
function generateKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
}
async function seal(plaintextBytes, key32) {
  const { nonce, ciphertext } = await encryptEnvelope(plaintextBytes, key32);
  const blob = new Uint8Array(HEADER_LENGTH + nonce.length + ciphertext.length);
  blob[0] = SEALED_BLOB_VERSION;
  blob.set(nonce, HEADER_LENGTH);
  blob.set(ciphertext, HEADER_LENGTH + nonce.length);
  return { blob, cid: await computeCid(blob) };
}
async function open(blob, key32) {
  if (blob.length < HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH) {
    throw new TypeError(`sealed blob too short: ${blob.length} bytes`);
  }
  if (blob[0] !== SEALED_BLOB_VERSION) {
    throw new TypeError(`unknown sealed blob version: ${blob[0]}`);
  }
  const nonce = blob.subarray(HEADER_LENGTH, HEADER_LENGTH + NONCE_LENGTH);
  const ciphertext = blob.subarray(HEADER_LENGTH + NONCE_LENGTH);
  return decryptEnvelope(nonce, ciphertext, key32);
}
async function encryptEnvelope(plaintextBytes, key32) {
  const key = await importAesKey(key32, "encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: AAD },
      key,
      plaintextBytes
    )
  );
  return { nonce, ciphertext };
}
async function decryptEnvelope(nonce, ciphertext, key32) {
  if (nonce.length !== NONCE_LENGTH) {
    throw new TypeError(`nonce must be ${NONCE_LENGTH} bytes, got ${nonce.length}`);
  }
  const key = await importAesKey(key32, "decrypt");
  return new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: AAD },
      key,
      ciphertext
    )
  );
}
function isPlainRecord(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function assertNoLoneSurrogates(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 56320 && unit <= 57343) {
      throw new TypeError(
        `cannot canonicalize string with unpaired low surrogate at index ${i}`
      );
    }
    if (unit >= 55296 && unit <= 56319) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 56320 && next <= 57343)) {
        throw new TypeError(
          `cannot canonicalize string with unpaired high surrogate at index ${i}`
        );
      }
      i++;
    }
  }
}
function serializeString(text) {
  assertNoLoneSurrogates(text);
  return JSON.stringify(text);
}
function serialize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw new TypeError("cannot canonicalize non-plain object");
  }
  const keys = Object.keys(value).sort();
  const members = [];
  for (const key of keys) {
    const member = value[key];
    if (member === void 0) continue;
    members.push(`${serializeString(key)}:${serialize(member)}`);
  }
  return `{${members.join(",")}}`;
}
function canonicalize(value) {
  return serialize(value);
}
var LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function isCanonicalEmailDomain(value) {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^[0-9]+$/.test(labels.at(-1));
}
function canonicalMailbox(value) {
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return void 0;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9#$&'*+/=?^_`{|}~-]+(?:\.[a-z0-9#$&'*+/=?^_`{|}~-]+)*$/.test(local) || !isCanonicalEmailDomain(domain)) return void 0;
  return Object.freeze({ email, domain });
}
function verifyCompactUcanAuthorization(authorization, expectedCid) {
  if (/\s/.test(authorization)) throw new TypeError("compact Authorization contains whitespace");
  const segments = authorization.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) throw new TypeError("compact Authorization must contain three segments");
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  const headerBytes = fromBase64Url(headerSegment);
  const payloadBytes = fromBase64Url(payloadSegment);
  const signature = fromBase64Url(signatureSegment);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const header = JSON.parse(decoder.decode(headerBytes));
  const payload = JSON.parse(decoder.decode(payloadBytes));
  if (canonicalize(header) !== decoder.decode(headerBytes) || canonicalize(payload) !== decoder.decode(payloadBytes)) throw new TypeError("compact Authorization JSON is not canonical");
  assertExactKeys(header, ["alg", "jwk", "typ", "ucv"], "protected header");
  const jwk = object(header.jwk, "protected JWK");
  assertExactKeys(jwk, ["alg", "crv", "kty", "x"], "protected JWK");
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || header.ucv !== "0.10.0" || jwk.alg !== "EdDSA" || jwk.crv !== "Ed25519" || jwk.kty !== "OKP" || typeof jwk.x !== "string") throw new TypeError("compact Authorization header is invalid");
  assertExactKeys(payload, ["att", "aud", "exp", "fct", "iss", "nbf", "nnc", "prf"], "UCAN payload");
  if (typeof payload.iss !== "string" || typeof payload.aud !== "string" || typeof payload.nnc !== "string" || !Number.isInteger(payload.nbf) || !Number.isInteger(payload.exp) || payload.nbf >= payload.exp || !Array.isArray(payload.prf) || payload.prf.some((proof) => typeof proof !== "string") || !Array.isArray(payload.fct) || payload.fct.length !== 1) throw new TypeError("compact Authorization payload is invalid");
  const principal = payload.iss.split("#", 1)[0];
  const publicKey = ed25519PublicKeyFromDidKey(principal);
  if (!equal(publicKey, fromBase64Url(jwk.x))) throw new TypeError("compact Authorization JWK does not bind issuer");
  if (!ed25519.verify(signature, new TextEncoder().encode(`${headerSegment}.${payloadSegment}`), publicKey, { zip215: false })) throw new TypeError("compact Authorization signature is invalid");
  const cid2 = CID.createV1(85, create(30, blake3(new TextEncoder().encode(authorization)))).toString();
  if (expectedCid !== void 0 && cid2 !== expectedCid) throw new TypeError("compact Authorization CID mismatch");
  return { authorization, cid: cid2, header, payload };
}
function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function assertExactKeys(value, keys, label) {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(`${label} has unknown or missing fields`);
}
function equal(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
var ED25519_VERIFY_OPTS2 = { zip215: false };
var ENVELOPE_V3_SIGNATURE_DOMAIN = "xyz.tinycloud.share/envelope/v3\0";
var POLICY_V1_SIGNATURE_DOMAIN = "xyz.tinycloud.policy/policy/v1\0";
var POLICY_V2_SIGNATURE_DOMAIN = "xyz.tinycloud.policy/policy/v2\0";
var CONTENT_SOURCE_V1_DOMAIN = "xyz.tinycloud.policy/ContentSource/v1\0";
var POLICY_CAPABILITY_V1_DOMAIN = "xyz.tinycloud.policy/PolicyCapability/v1\0";
var NATIVE_PROJECTION_V1_DOMAIN = "xyz.tinycloud.policy/NativeProjection/v1\0";
var ATTESTED_ENFORCER_V2_DOMAIN = "xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0";
function signingBytesV3(unsigned) {
  const domain = utf8Bytes(ENVELOPE_V3_SIGNATURE_DOMAIN);
  const body = utf8Bytes(canonicalize(unsigned));
  const bytes3 = new Uint8Array(domain.length + body.length);
  bytes3.set(domain);
  bytes3.set(body, domain.length);
  return bytes3;
}
function verifyEnvelopeV3SignatureOnly(envelope) {
  const parsed = shareEnvelopeV3Schema.parse(envelope);
  const { signature, ...unsigned } = parsed;
  return ed25519.verify(fromBase64Url(signature.value), sha2562(signingBytesV3(unsigned)), ed25519PublicKeyFromDidKey(signature.signerDid), ED25519_VERIFY_OPTS2);
}
async function verifyEnvelopeV3(envelope, options) {
  const parsed = shareEnvelopeV3Schema.parse(envelope);
  if (parsed.signature.signerDid !== options.expectedSignerDid || parsed.signature.signerDid !== parsed.policy.ownerDid || !verifyEnvelopeV3SignatureOnly(parsed)) return false;
  const { policy } = parsed;
  const unsignedPolicy = { ...policy };
  delete unsignedPolicy.policyId;
  delete unsignedPolicy.signature;
  const policySignatureDomain = policy.schema === "xyz.tinycloud.policy/policy/v2" ? POLICY_V2_SIGNATURE_DOMAIN : POLICY_V1_SIGNATURE_DOMAIN;
  const policyDigest = sha2562(new TextEncoder().encode(`${policySignatureDomain}${canonicalize(unsignedPolicy)}`));
  const policySignature = policy.signature;
  if (policySignature.suite !== "Ed25519" || policySignature.signerDid !== policy.ownerDid) return false;
  let policyPublicKey;
  let policySignatureBytes;
  try {
    policyPublicKey = ed25519PublicKeyFromDidKey(policy.ownerDid);
    policySignatureBytes = fromBase64Url(policySignature.value);
  } catch {
    return false;
  }
  if (policySignatureBytes.length !== 64 || !ed25519.verify(policySignatureBytes, policyDigest, policyPublicKey, ED25519_VERIFY_OPTS2)) return false;
  const policyIdDigest = policyDigest;
  if (policy.policyId !== `pol_${base32Lower(policyIdDigest)}`) return false;
  const policyBytes = new TextEncoder().encode(canonicalize(policy));
  if (await computeCid(policyBytes) !== parsed.policyCid) return false;
  const sourceDigest = sha2562(new TextEncoder().encode(`${CONTENT_SOURCE_V1_DOMAIN}${canonicalize(policy.contentSource)}`));
  if (hex(sourceDigest) !== parsed.contentSourceDigestHex) return false;
  const sortedCapabilities = [...policy.capabilityCeiling].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  const capabilityCeilingHashHex = hex(sha2562(new TextEncoder().encode(`${POLICY_CAPABILITY_V1_DOMAIN}${canonicalize(sortedCapabilities)}`)));
  const nativeProjection2 = sortedCapabilities.map((capability) => capability.kind === "encryption" ? { service: "tinycloud.encryption", space: capability.resource, path: capability.resource, actions: [capability.action] } : { service: "tinycloud.kv", space: capability.resource.slice(0, capability.resource.indexOf("/kv/")), path: capability.resource.split("/kv/")[1], actions: [...capability.actions], caveat: { type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource } }).sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  const nativeProjectionHashHex = hex(sha2562(new TextEncoder().encode(`${NATIVE_PROJECTION_V1_DOMAIN}${canonicalize(nativeProjection2)}`)));
  const expectedAttenuation = Object.fromEntries(sortedCapabilities.map((capability) => capability.kind === "encryption" ? [capability.resource, { [capability.action]: [{}] }] : [capability.resource, Object.fromEntries(capability.actions.map((action) => [action, [{ kind: capability.selector, type: "xyz.tinycloud.resource/selector", value: capability.resource }]]))]));
  const kv = policy.capabilityCeiling.find((capability) => capability.kind === "kv");
  const expectedKvActions = parsed.actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]);
  const marker = parsed.contentSource.kvResource.indexOf("/kv/");
  const resourceSpace = marker < 1 ? "" : parsed.contentSource.kvResource.slice(0, marker);
  const resourcePath = marker < 1 ? "" : parsed.contentSource.kvResource.slice(marker + 4);
  if (parsed.shareId !== parsed.contentSource.shareId || resourceSpace !== parsed.target.spaceId || resourcePath !== parsed.resource.path.replace(/\/$/, "") || parsed.resource.kind !== parsed.contentSource.selector || kv?.kind !== "kv" || expectedKvActions.some((action) => !kv.actions.includes(action)) || parsed.encryptionNetwork !== parsed.contentSource.encryptionNetwork || parsed.contentSource.keyVersion <= 0 || policy.expiresAt !== void 0 && Date.parse(parsed.expiry) > Date.parse(policy.expiresAt)) return false;
  const binding = parsed.attestedEnforcerBinding;
  const { signature: bindingSignature, ...unsignedBinding } = binding;
  const expectedBindingDigestHex = hex(sha2562(new TextEncoder().encode(canonicalize({ enforcerDid: binding.enforcerDid, nodeAudience: binding.nodeAudience }))));
  if (binding.nodeAudience !== parsed.target.nodeAudience || binding.attestationBindingDigestHex !== expectedBindingDigestHex || bindingSignature.signerDid !== binding.nodeAudience || bindingSignature.suite !== "Ed25519" || Date.parse(binding.issuedAt) > Date.now() || Date.parse(binding.expiresAt) <= Date.now() || Date.parse(binding.expiresAt) < Date.parse(parsed.expiry)) return false;
  try {
    const digest3 = sha2562(new TextEncoder().encode(`${ATTESTED_ENFORCER_V2_DOMAIN}${canonicalize(unsignedBinding)}`));
    if (!ed25519.verify(fromBase64Url(bindingSignature.value), digest3, ed25519PublicKeyFromDidKey(binding.nodeAudience), ED25519_VERIFY_OPTS2)) return false;
  } catch {
    return false;
  }
  if (parsed.policyRoot.role !== "policy-authority" || parsed.enforcementRoot.role !== "policy-enforcement" || parsed.policyRoot.cid === parsed.enforcementRoot.cid) return false;
  try {
    const policyRoot = verifyCompactUcanAuthorization(parsed.policyRoot.authorization, parsed.policyRoot.cid);
    const enforcementRoot = verifyCompactUcanAuthorization(parsed.enforcementRoot.authorization, parsed.enforcementRoot.cid);
    const policyFact = policyRoot.payload.fct[0];
    const enforcementFact = enforcementRoot.payload.fct[0];
    const common = ["ownerDid", "policyId", "policyDigestHex", "policyCid", "contentSourceDigestHex", "capabilityCeilingHashHex", "nativeProjectionHashHex", "nodeAudience"];
    const policyKeys = [...common, "role", "mode"];
    const enforcementKeys = [...policyKeys, "enforcerDid"];
    if (Object.keys(policyFact).length !== policyKeys.length || policyKeys.some((key) => !(key in policyFact)) || Object.keys(enforcementFact).length !== enforcementKeys.length || enforcementKeys.some((key) => !(key in enforcementFact)) || policyRoot.payload.prf.length !== 0 || enforcementRoot.payload.prf.length !== 0 || policyRoot.payload.iss.split("#", 1)[0] !== policy.ownerDid || enforcementRoot.payload.iss.split("#", 1)[0] !== policy.ownerDid || policyRoot.payload.nbf !== enforcementRoot.payload.nbf || policyRoot.payload.exp !== enforcementRoot.payload.exp || canonicalize(policyRoot.payload.att) !== canonicalize(expectedAttenuation) || canonicalize(enforcementRoot.payload.att) !== canonicalize(expectedAttenuation) || policyFact.role !== "policy-authority" || policyFact.mode !== "policy-source" || "enforcerDid" in policyFact || enforcementFact.role !== "policy-enforcement" || enforcementFact.mode !== "conditional-mint" || policyRoot.payload.aud !== `did:tinycloud:policy:${hex(policyIdDigest)}` || enforcementRoot.payload.aud !== binding.enforcerDid || enforcementFact.enforcerDid !== binding.enforcerDid || common.some((key) => policyFact[key] !== enforcementFact[key]) || policyFact.ownerDid !== policy.ownerDid || policyFact.policyId !== policy.policyId || policyFact.policyDigestHex !== hex(policyIdDigest) || policyFact.policyCid !== parsed.policyCid || policyFact.contentSourceDigestHex !== parsed.contentSourceDigestHex || policyFact.capabilityCeilingHashHex !== capabilityCeilingHashHex || policyFact.nativeProjectionHashHex !== nativeProjectionHashHex || policyFact.nodeAudience !== binding.nodeAudience || policyRoot.payload.exp * 1e3 < Date.parse(parsed.expiry)) return false;
  } catch {
    return false;
  }
  return true;
}
function hex(bytes3) {
  return [...bytes3].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base32Lower(bytes3) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes3) {
    buffer = buffer << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[buffer >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[buffer << 5 - bits & 31];
  return output;
}
var KEY_LENGTH2 = 32;
var MAX_INLINE_BYTES = 256 * 1024;
function assertCanonicalCid(cidString) {
  const cid2 = CID.parse(cidString);
  if (cid2.version !== 1 || cid2.code !== code || cid2.multihash.code !== 18 || // sha2-256 (0x12) only, at the link layer too
  cid2.toString() !== cidString) {
    throw new TypeError(`not a canonical CIDv1 raw sha2-256 base32 CID: ${cidString}`);
  }
}
async function encodeSealedInlineShareUrl(parts) {
  if (!isCanonicalHttpsOrigin(parts.origin)) throw new TypeError("origin must be a canonical https origin");
  if (parts.ciphertext.byteLength === 0 || parts.ciphertext.byteLength > MAX_INLINE_BYTES) throw new RangeError("inline ciphertext is outside the allowed size");
  if (parts.key32.byteLength !== KEY_LENGTH2) throw new TypeError("inline key must be 32 bytes");
  const ciphertextCid = await computeCid(parts.ciphertext);
  const payload = canonicalize({
    v: 2,
    c: toBase64Url(parts.ciphertext),
    cid: ciphertextCid,
    k: toBase64Url(parts.key32)
  });
  const payloadBytes = new TextEncoder().encode(payload);
  if (payloadBytes.byteLength > MAX_INLINE_BYTES * 2) throw new RangeError("inline URL is too large");
  return `${parts.origin}/s/inline#v=2&p=${toBase64Url(payloadBytes)}`;
}
async function parseSealedInlineShareUrl(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new TypeError("sealed inline share URL must be canonical HTTPS without userinfo");
  if (!isCanonicalHttpsOrigin(parsed.origin) || options.expectedOrigin !== void 0 && parsed.origin !== options.expectedOrigin) throw new TypeError("sealed inline share URL origin is not trusted");
  if (parsed.pathname !== "/s/inline" || parsed.search !== "") throw new TypeError("not a Node sealed-inline share URL");
  if (url !== `${parsed.origin}/s/inline${parsed.hash}`) throw new TypeError("sealed inline share URL is not lexically canonical");
  const prefix = "#v=2&p=";
  if (!parsed.hash.startsWith(prefix)) throw new TypeError("sealed inline URL is missing its canonical fragment");
  const encoded = parsed.hash.slice(prefix.length);
  if (encoded.length === 0 || parsed.hash !== `${prefix}${encoded}`) throw new TypeError("sealed inline URL fragment is not canonical");
  let payloadBytes;
  try {
    payloadBytes = fromBase64Url(encoded);
  } catch {
    throw new TypeError("sealed inline payload is not canonical base64url");
  }
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_INLINE_BYTES * 2) throw new TypeError("sealed inline payload is too large");
  const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  let value;
  try {
    value = JSON.parse(payloadText);
  } catch {
    throw new TypeError("sealed inline payload is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || canonicalize(value) !== payloadText) throw new TypeError("sealed inline payload is not canonical JSON");
  const record = value;
  if (Object.keys(record).length !== 4 || record.v !== 2 || typeof record.c !== "string" || typeof record.cid !== "string" || typeof record.k !== "string") throw new TypeError("sealed inline payload has invalid fields");
  let ciphertext;
  let key32;
  try {
    ciphertext = fromBase64Url(record.c);
    key32 = fromBase64Url(record.k);
  } catch {
    throw new TypeError("sealed inline payload has invalid base64url material");
  }
  if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_INLINE_BYTES) throw new TypeError("sealed inline ciphertext is outside the allowed size");
  if (key32.byteLength !== KEY_LENGTH2) throw new TypeError("sealed inline key must be 32 bytes");
  assertCanonicalCid(record.cid);
  if (await computeCid(ciphertext) !== record.cid) throw new TypeError("sealed inline ciphertext does not match its CID");
  return { kind: "inline", ciphertextCid: record.cid, ciphertext, key32 };
}
var SHARE_RESULT_VERSION = 1;
var DEFAULT_MAX_SEALED_BLOB_BYTES = 100 * 1024 * 1024 + 29;
var ShareReceiveError = class extends Error {
  code;
  details;
  constructor(code3, message, details) {
    super(message);
    this.name = "ShareReceiveError";
    this.code = code3;
    this.details = details;
  }
  toJSON() {
    return { protocol: "tinycloud-share", version: SHARE_RESULT_VERSION, error: { code: this.code } };
  }
};
function metadataFor(envelope, origin) {
  const kind = envelope.recipientMatcher.kind === "recipientDid" ? "recipientDid" : envelope.recipientMatcher.kind === "exactEmail" ? "email" : "emailDomain";
  return {
    protocol: "tinycloud-share",
    version: 1,
    shareId: envelope.shareId,
    origin,
    target: { ...envelope.target, kind },
    resource: { ...envelope.resource },
    actions: [...envelope.actions],
    expiresAt: envelope.expiry,
    display: {
      ...envelope.display.senderName === void 0 ? {} : { senderName: envelope.display.senderName },
      ...envelope.display.filename === void 0 ? {} : { filename: envelope.display.filename },
      ...envelope.display.mode === void 0 ? {} : { mode: envelope.display.mode }
    }
  };
}
async function resolvePolicyShare(link2, options) {
  options.signal?.throwIfAborted();
  let url;
  let parsed;
  try {
    url = new URL(link2);
    parsed = await parseSealedInlineShareUrl(link2, { ...options.expectedOrigin === void 0 ? {} : { expectedOrigin: options.expectedOrigin } });
  } catch {
    throw new ShareReceiveError("invalid-link", "share link format is invalid");
  }
  const limit = options.maxSealedBlobBytes ?? DEFAULT_MAX_SEALED_BLOB_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || parsed.ciphertext.byteLength > limit) throw new ShareReceiveError("max-bytes-exceeded", "sealed policy envelope exceeds the configured byte limit");
  if (await computeCid(parsed.ciphertext) !== parsed.ciphertextCid) throw new ShareReceiveError("cid-mismatch", "sealed envelope bytes do not match the link CID");
  options.signal?.throwIfAborted();
  let envelope;
  try {
    const encoded = new TextDecoder("utf-8", { fatal: true }).decode(await open(parsed.ciphertext, parsed.key32));
    const value = JSON.parse(encoded);
    if (canonicalize(value) !== encoded) throw new Error("non-canonical envelope");
    envelope = shareEnvelopeV3Schema.parse(value);
  } catch {
    throw new ShareReceiveError("envelope-invalid", "share envelope is invalid");
  }
  try {
    if (!await verifyEnvelopeV3(envelope, { expectedSignerDid: envelope.policy.ownerDid })) throw new Error("signature");
  } catch {
    throw new ShareReceiveError("signature-invalid", "share signature is invalid");
  }
  options.signal?.throwIfAborted();
  const expiry = Date.parse(envelope.expiry);
  if (!Number.isFinite(expiry)) throw new ShareReceiveError("envelope-invalid", "share expiry is invalid");
  if (expiry <= (options.now?.() ?? Date.now())) throw new ShareReceiveError("expired", "share has expired", { expiresAt: envelope.expiry });
  options.onResolvedAddressedEnvelope?.(envelope, parsed.ciphertextCid);
  return { envelope, origin: url.origin, cid: parsed.ciphertextCid };
}
async function inspectShare(link2, options = {}) {
  const resolved = await resolvePolicyShare(link2, options);
  return { metadata: metadataFor(resolved.envelope, resolved.origin), link: { origin: resolved.origin, cid: resolved.cid, kind: "policy" } };
}
async function receiveShare(link2, options = {}) {
  const resolved = await resolvePolicyShare(link2, options);
  return { state: "authorization-required", method: resolved.envelope.recipientMatcher.kind === "recipientDid" ? "openkey-device" : "email-claim" };
}
var SHARE_CONTENT_LIMIT = 100 * 1024 * 1024;
var SHARE_PUBLISH_RESULT_VERSION = 1;
var DEFAULT_SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1e3;
function redactPublishedShare(result) {
  return {
    protocol: "tinycloud-share",
    version: SHARE_PUBLISH_RESULT_VERSION,
    link: { ...result.link },
    metadata: {
      protocol: "tinycloud-share",
      version: 1,
      shareId: result.metadata.shareId,
      origin: result.metadata.origin,
      target: { ...result.metadata.target },
      resource: { ...result.metadata.resource },
      actions: [...result.metadata.actions],
      ...result.metadata.expiryClamped === void 0 ? {} : { expiryClamped: result.metadata.expiryClamped },
      expiresAt: result.metadata.expiresAt,
      display: { ...result.metadata.display }
    }
  };
}
var SharePublishError = class extends Error {
  code;
  constructor(code3, message) {
    super(message);
    this.name = "SharePublishError";
    this.code = code3;
  }
};
function authorizationMethodForTarget(target) {
  if (target.kind === "recipientDid") return "openkey-device";
  if (target.kind === "email") return "email-claim";
  if (target.kind === "emailDomain") return "email-claim";
  return void 0;
}
var empty2 = new Uint8Array(0);
function equals3(aa, bb) {
  if (aa === bb) {
    return true;
  }
  if (aa.byteLength !== bb.byteLength) {
    return false;
  }
  for (let ii = 0; ii < aa.byteLength; ii++) {
    if (aa[ii] !== bb[ii]) {
      return false;
    }
  }
  return true;
}
function coerce3(o) {
  if (o instanceof Uint8Array && o.constructor.name === "Uint8Array") {
    return o;
  }
  if (o instanceof ArrayBuffer) {
    return new Uint8Array(o);
  }
  if (ArrayBuffer.isView(o)) {
    return new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
  }
  throw new Error("Unknown type, must be binary type");
}
function base2(ALPHABET, name) {
  if (ALPHABET.length >= 255) {
    throw new TypeError("Alphabet too long");
  }
  var BASE_MAP = new Uint8Array(256);
  for (var j = 0; j < BASE_MAP.length; j++) {
    BASE_MAP[j] = 255;
  }
  for (var i = 0; i < ALPHABET.length; i++) {
    var x = ALPHABET.charAt(i);
    var xc = x.charCodeAt(0);
    if (BASE_MAP[xc] !== 255) {
      throw new TypeError(x + " is ambiguous");
    }
    BASE_MAP[xc] = i;
  }
  var BASE = ALPHABET.length;
  var LEADER = ALPHABET.charAt(0);
  var FACTOR = Math.log(BASE) / Math.log(256);
  var iFACTOR = Math.log(256) / Math.log(BASE);
  function encode52(source) {
    if (source instanceof Uint8Array)
      ;
    else if (ArrayBuffer.isView(source)) {
      source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else if (Array.isArray(source)) {
      source = Uint8Array.from(source);
    }
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("Expected Uint8Array");
    }
    if (source.length === 0) {
      return "";
    }
    var zeroes = 0;
    var length32 = 0;
    var pbegin = 0;
    var pend = source.length;
    while (pbegin !== pend && source[pbegin] === 0) {
      pbegin++;
      zeroes++;
    }
    var size = (pend - pbegin) * iFACTOR + 1 >>> 0;
    var b58 = new Uint8Array(size);
    while (pbegin !== pend) {
      var carry = source[pbegin];
      var i2 = 0;
      for (var it1 = size - 1; (carry !== 0 || i2 < length32) && it1 !== -1; it1--, i2++) {
        carry += 256 * b58[it1] >>> 0;
        b58[it1] = carry % BASE >>> 0;
        carry = carry / BASE >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length32 = i2;
      pbegin++;
    }
    var it2 = size - length32;
    while (it2 !== size && b58[it2] === 0) {
      it2++;
    }
    var str = LEADER.repeat(zeroes);
    for (; it2 < size; ++it2) {
      str += ALPHABET.charAt(b58[it2]);
    }
    return str;
  }
  function decodeUnsafe(source) {
    if (typeof source !== "string") {
      throw new TypeError("Expected String");
    }
    if (source.length === 0) {
      return new Uint8Array();
    }
    var psz = 0;
    if (source[psz] === " ") {
      return;
    }
    var zeroes = 0;
    var length32 = 0;
    while (source[psz] === LEADER) {
      zeroes++;
      psz++;
    }
    var size = (source.length - psz) * FACTOR + 1 >>> 0;
    var b256 = new Uint8Array(size);
    while (source[psz]) {
      var carry = BASE_MAP[source.charCodeAt(psz)];
      if (carry === 255) {
        return;
      }
      var i2 = 0;
      for (var it3 = size - 1; (carry !== 0 || i2 < length32) && it3 !== -1; it3--, i2++) {
        carry += BASE * b256[it3] >>> 0;
        b256[it3] = carry % 256 >>> 0;
        carry = carry / 256 >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length32 = i2;
      psz++;
    }
    if (source[psz] === " ") {
      return;
    }
    var it4 = size - length32;
    while (it4 !== size && b256[it4] === 0) {
      it4++;
    }
    var vch = new Uint8Array(zeroes + (size - it4));
    var j2 = zeroes;
    while (it4 !== size) {
      vch[j2++] = b256[it4++];
    }
    return vch;
  }
  function decode92(string) {
    var buffer = decodeUnsafe(string);
    if (buffer) {
      return buffer;
    }
    throw new Error(`Non-${name} character`);
  }
  return {
    encode: encode52,
    decodeUnsafe,
    decode: decode92
  };
}
var src2 = base2;
var _brrp__multiformats_scope_baseX2 = src2;
var base_x_default2 = _brrp__multiformats_scope_baseX2;
var Encoder2 = class {
  name;
  prefix;
  baseEncode;
  constructor(name, prefix, baseEncode) {
    this.name = name;
    this.prefix = prefix;
    this.baseEncode = baseEncode;
  }
  encode(bytes3) {
    if (bytes3 instanceof Uint8Array) {
      return `${this.prefix}${this.baseEncode(bytes3)}`;
    } else {
      throw Error("Unknown type, must be binary type");
    }
  }
};
var Decoder2 = class {
  name;
  prefix;
  baseDecode;
  prefixCodePoint;
  constructor(name, prefix, baseDecode) {
    this.name = name;
    this.prefix = prefix;
    const prefixCodePoint = prefix.codePointAt(0);
    if (prefixCodePoint === void 0) {
      throw new Error("Invalid prefix character");
    }
    this.prefixCodePoint = prefixCodePoint;
    this.baseDecode = baseDecode;
  }
  decode(text) {
    if (typeof text === "string") {
      if (text.codePointAt(0) !== this.prefixCodePoint) {
        throw Error(`Unable to decode multibase string ${JSON.stringify(text)}, ${this.name} decoder only supports inputs prefixed with ${this.prefix}`);
      }
      return this.baseDecode(text.slice(this.prefix.length));
    } else {
      throw Error("Can only multibase decode strings");
    }
  }
  or(decoder) {
    return or2(this, decoder);
  }
};
var ComposedDecoder2 = class {
  decoders;
  constructor(decoders) {
    this.decoders = decoders;
  }
  or(decoder) {
    return or2(this, decoder);
  }
  decode(input) {
    const prefix = input[0];
    const decoder = this.decoders[prefix];
    if (decoder != null) {
      return decoder.decode(input);
    } else {
      throw RangeError(`Unable to decode multibase string ${JSON.stringify(input)}, only inputs prefixed with ${Object.keys(this.decoders)} are supported`);
    }
  }
};
function or2(left, right) {
  return new ComposedDecoder2({
    ...left.decoders ?? { [left.prefix]: left },
    ...right.decoders ?? { [right.prefix]: right }
  });
}
var Codec2 = class {
  name;
  prefix;
  baseEncode;
  baseDecode;
  encoder;
  decoder;
  constructor(name, prefix, baseEncode, baseDecode) {
    this.name = name;
    this.prefix = prefix;
    this.baseEncode = baseEncode;
    this.baseDecode = baseDecode;
    this.encoder = new Encoder2(name, prefix, baseEncode);
    this.decoder = new Decoder2(name, prefix, baseDecode);
  }
  encode(input) {
    return this.encoder.encode(input);
  }
  decode(input) {
    return this.decoder.decode(input);
  }
};
function from2({ name, prefix, encode: encode52, decode: decode92 }) {
  return new Codec2(name, prefix, encode52, decode92);
}
function baseX2({ name, prefix, alphabet }) {
  const { encode: encode52, decode: decode92 } = base_x_default2(alphabet, name);
  return from2({
    prefix,
    name,
    encode: encode52,
    decode: (text) => coerce3(decode92(text))
  });
}
function decode5(string, alphabetIdx, bitsPerChar, name) {
  let end = string.length;
  while (string[end - 1] === "=") {
    --end;
  }
  const out = new Uint8Array(end * bitsPerChar / 8 | 0);
  let bits = 0;
  let buffer = 0;
  let written = 0;
  for (let i = 0; i < end; ++i) {
    const value = alphabetIdx[string[i]];
    if (value === void 0) {
      throw new SyntaxError(`Non-${name} character`);
    }
    buffer = buffer << bitsPerChar | value;
    bits += bitsPerChar;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = 255 & buffer >> bits;
    }
  }
  if (bits >= bitsPerChar || (255 & buffer << 8 - bits) !== 0) {
    throw new SyntaxError("Unexpected end of data");
  }
  return out;
}
function encode3(data, alphabet, bitsPerChar) {
  const pad = alphabet[alphabet.length - 1] === "=";
  const mask = (1 << bitsPerChar) - 1;
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < data.length; ++i) {
    buffer = buffer << 8 | data[i];
    bits += 8;
    while (bits > bitsPerChar) {
      bits -= bitsPerChar;
      out += alphabet[mask & buffer >> bits];
    }
  }
  if (bits !== 0) {
    out += alphabet[mask & buffer << bitsPerChar - bits];
  }
  if (pad) {
    while ((out.length * bitsPerChar & 7) !== 0) {
      out += "=";
    }
  }
  return out;
}
function createAlphabetIdx2(alphabet) {
  const alphabetIdx = {};
  for (let i = 0; i < alphabet.length; ++i) {
    alphabetIdx[alphabet[i]] = i;
  }
  return alphabetIdx;
}
function rfc46482({ name, prefix, bitsPerChar, alphabet }) {
  const alphabetIdx = createAlphabetIdx2(alphabet);
  return from2({
    prefix,
    name,
    encode(input) {
      return encode3(input, alphabet, bitsPerChar);
    },
    decode(input) {
      return decode5(input, alphabetIdx, bitsPerChar, name);
    }
  });
}
var base58btc2 = baseX2({
  name: "base58btc",
  prefix: "z",
  alphabet: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
});
var base58flickr2 = baseX2({
  name: "base58flickr",
  prefix: "Z",
  alphabet: "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
});
function validRecipientDid(value) {
  if (value.length === 0 || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  const parts = value.split(":");
  if (parts.length < 3 || parts[0] !== "did" || !/^[a-z0-9]+$/.test(parts[1] ?? "")) return false;
  const identifier = parts.slice(2);
  if (identifier.some((part) => part.length === 0)) return false;
  if (parts[1] === "web") {
    const host = identifier[0] ?? "";
    if (host.length > 253 || host.split(".").some((label) => !label || label.length > 63 || !/^[A-Za-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-"))) return false;
    return identifier.slice(1).every((part) => /^[A-Za-z0-9._%-]+$/.test(part));
  }
  if (parts[1] === "pkh") return identifier.length >= 3 && identifier.every((part) => /^[A-Za-z0-9._%-]+$/.test(part));
  if (parts[1] === "key") {
    try {
      const bytes3 = base58btc2.decode(identifier.join(":"));
      return bytes3.length === 34 && bytes3[0] === 237 && bytes3[1] === 1;
    } catch {
      return false;
    }
  }
  return false;
}
function normalizeShareTarget(target) {
  if (target.kind === "bearer") return target;
  if (target.kind === "recipientDid") {
    if (!validRecipientDid(target.did)) throw new TypeError("recipient DID is invalid");
    return { kind: target.kind, did: target.did };
  }
  if (target.kind === "email") {
    const mailbox = canonicalMailbox(target.address);
    if (mailbox === void 0) throw new TypeError("recipient email is invalid");
    return { kind: target.kind, address: mailbox.email };
  }
  const domain = target.domain.toLowerCase();
  if (!isCanonicalEmailDomain(domain)) throw new TypeError("recipient email domain is invalid");
  return { kind: target.kind, domain };
}
function targetAuthorizationMethod(target) {
  return authorizationMethodForTarget(target);
}
function publishFilename(value) {
  try {
    return canonicalShareFilename(value);
  } catch {
    throw new SharePublishError("invalid-argument", hasUnsafeFilenameCodePoint(value) ? "filename contains control or invisible characters" : "filename must be one safe path segment");
  }
}
async function publishTargetShare(input) {
  const target = normalizeShareTarget(input.target);
  const filename = publishFilename(input.filename);
  const files = input.files?.map((file) => ({ ...file, filename: publishFilename(file.filename) }));
  if (input.targetAdapter === void 0) {
    if (target.kind === "bearer") throw new SharePublishError("authority-required", "native bearer publication requires an authenticated TinyCloud node");
    return {
      state: "authorization-required",
      method: targetAuthorizationMethod(target)
    };
  }
  const source = input.source instanceof Uint8Array ? input.source.slice() : await (async () => {
    const chunks = [];
    let size = 0;
    for await (const chunk of input.source) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError("share publication source yielded invalid bytes");
      size += chunk.byteLength;
      if (size > (input.maxBytes ?? SHARE_CONTENT_LIMIT)) throw new SharePublishError("max-bytes-exceeded", "share publication exceeds maxBytes");
      chunks.push(chunk.slice());
    }
    const bytes3 = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes3.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes3;
  })();
  if (source.byteLength === 0) throw new SharePublishError("invalid-argument", "share content is empty");
  if (target.kind === "bearer" && input.allowBinary !== true) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      throw new SharePublishError("invalid-argument", "Markdown input must be valid UTF-8");
    }
  }
  const publishFiles = files === void 0 || files.length === 0 ? [{ bytes: source }] : files;
  const limit = input.maxBytes ?? SHARE_CONTENT_LIMIT;
  let totalBytes = 0;
  for (const file of publishFiles) {
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limit) {
      throw new SharePublishError("max-bytes-exceeded", "share publication exceeds the combined byte limit");
    }
  }
  const nowMs = input.now?.() ?? Date.now();
  const expiresAt = input.expiresAt ?? new Date(nowMs + DEFAULT_SHARE_LIFETIME_MS);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) throw new SharePublishError("invalid-argument", "expiresAt must be a valid future time");
  return input.targetAdapter.publish({
    source,
    filename,
    ...files === void 0 ? {} : { files },
    ...input.mediaType === void 0 ? {} : { mediaType: input.mediaType },
    ...input.resourceKind === void 0 ? {} : { resourceKind: input.resourceKind },
    ...input.actions === void 0 ? {} : { actions: input.actions },
    target,
    expiresAt,
    expiryWasExplicit: input.expiryWasExplicit ?? input.expiresAt !== void 0,
    origin: input.origin,
    ...input.notify === void 0 ? {} : { notify: input.notify }
  });
}
var POLICY_V1_DOMAIN = "xyz.tinycloud.policy/policy/v1\0";
var POLICY_V2_DOMAIN = "xyz.tinycloud.policy/policy/v2\0";
var POLICY_CAPABILITY_V1_DOMAIN2 = "xyz.tinycloud.policy/PolicyCapability/v1\0";
var CONTENT_SOURCE_V1_DOMAIN2 = "xyz.tinycloud.policy/ContentSource/v1\0";
var NATIVE_PROJECTION_V1_DOMAIN2 = "xyz.tinycloud.policy/NativeProjection/v1\0";
var ENVELOPE_V3_DOMAIN = "xyz.tinycloud.share/envelope/v3\0";
var textEncoder = new TextEncoder();
function targetMatcher(target) {
  if (target.kind === "recipientDid") return { kind: "recipientDid", value: target.did };
  if (target.kind === "email") return { kind: "exactEmail", value: target.address };
  return { kind: "emailDomain", value: target.domain };
}
function targetKind(target) {
  return target.kind;
}
var OWNER_SHARE_ACTIONS = /* @__PURE__ */ new Set(["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/metadata", "tinycloud.kv/put"]);
function assertSafeInput(input) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.shareId)) throw new TypeError("addressed share id is invalid");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > SHARE_CONTENT_LIMIT) throw new TypeError("addressed content length is invalid");
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()) throw new TypeError("addressed share expiry must be in the future");
  if (input.artifact === "html" && (input.resource.kind !== "prefix" || !input.actions.includes("read") || !input.actions.includes("list"))) throw new TypeError("html artifacts require a readable prefix");
  if (input.contentSource.shareId !== input.shareId || input.contentSource.selector !== input.resource.kind) throw new TypeError("addressed content source is not bound to the share");
}
function hex2(bytes3) {
  return [...bytes3].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function digestHex(value, domain) {
  return hex2(sha2562(textEncoder.encode(`${domain}${canonicalize(value)}`)));
}
function sortCanonical(values) {
  return [...values].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
}
function base32Lower2(bytes3) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes3) {
    buffer = buffer << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[buffer >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[buffer << 5 - bits & 31];
  return output;
}
function rfc3339Seconds(value) {
  return new Date(Math.floor(value.getTime() / 1e3) * 1e3).toISOString().replace(".000Z", "Z");
}
function nativeProjection(capabilities) {
  return sortCanonical(capabilities.map((capability) => capability.kind === "encryption" ? { service: "tinycloud.encryption", space: capability.resource, path: capability.resource, actions: [capability.action] } : {
    service: "tinycloud.kv",
    space: capability.resource.slice(0, capability.resource.indexOf("/kv/")),
    path: capability.resource.slice(capability.resource.indexOf("/kv/") + 4),
    actions: [...capability.actions],
    caveat: { type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource }
  }));
}
async function createPolicy(options, capabilities) {
  const fields = {
    ownerDid: options.authority.ownerDid,
    createdAt: rfc3339Seconds(/* @__PURE__ */ new Date()),
    expiresAt: rfc3339Seconds(options.expiresAt),
    contentSource: options.contentSource,
    capabilityCeiling: [...capabilities]
  };
  const unsigned = options.credentialRequirement === void 0 ? { schema: "xyz.tinycloud.policy/policy/v1", ...fields } : { schema: "xyz.tinycloud.policy/policy/v2", ...fields, credentialRequirement: options.credentialRequirement };
  const domain = options.credentialRequirement === void 0 ? POLICY_V1_DOMAIN : POLICY_V2_DOMAIN;
  const policyDigestHex = digestHex(unsigned, domain);
  const signature = await options.authority.sign(sha2562(textEncoder.encode(`${domain}${canonicalize(unsigned)}`)));
  if (signature.byteLength !== 64) throw new TypeError("policy signature must be Ed25519");
  const policy = {
    ...unsigned,
    policyId: `pol_${base32Lower2(Uint8Array.from(policyDigestHex.match(/../g), (byte) => Number.parseInt(byte, 16)))}`,
    signature: { suite: "Ed25519", signerDid: options.authority.ownerDid, value: toBase64Url(signature) }
  };
  return { policy, policyCid: await computeCid(textEncoder.encode(canonicalize(policy))), policyDigestHex };
}
function publicationResult(input) {
  const result = {
    protocol: "tinycloud-share",
    version: SHARE_PUBLISH_RESULT_VERSION,
    url: input.url,
    link: { kind: "policy", cid: input.envelopeCid },
    metadata: {
      protocol: "tinycloud-share",
      version: 1,
      shareId: input.options.shareId,
      origin: input.options.shareOrigin,
      target: { kind: targetKind(input.options.target), origin: input.options.nodeOrigin, nodeAudience: input.enforcerDid, spaceId: input.options.spaceId },
      resource: { ...input.options.resource },
      actions: [...input.options.actions],
      expiresAt: input.expiry,
      display: { filename: input.options.filename },
      recipientMatcher: { ...input.matcher },
      policyCid: input.policyCid,
      ownerDelegationCid: input.policyRootCid,
      enforcementDelegationCid: input.enforcementRootCid,
      ownerDid: input.options.authority.ownerDid,
      enforcerDid: input.enforcerDid,
      envelopeCid: input.envelopeCid,
      shareCid: input.envelopeCid
    }
  };
  Object.defineProperty(result, "toJSON", { enumerable: false, value: () => redactPublishedShare(result) });
  Object.defineProperty(result, "url", { enumerable: false, value: input.url });
  Object.defineProperty(result, "deliveryMaterial", { enumerable: false, value: input.deliveryMaterial });
  return result;
}
var EMAIL_PROFILE = { id: "tinycloud.email-proof/v1", version: 1 };
var EMAIL_DOMAIN_PROFILE = { id: "tinycloud.email-domain-proof/v1", version: 1 };
var EMAIL_CREDENTIAL_TYPE = { id: "opencredentials.email/v1", version: 1 };
var EMAIL_DESCRIPTOR_DIGEST = "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0";
var EMAIL_DOMAIN_DESCRIPTOR_DIGEST = "33X5mAkZZgApdD3xh_T-3KS5moop0J2Nloi2nqWsdWY";
var EMAIL_CREDENTIAL_ISSUER_DID = "did:web:issuer.credentials.org";
var EMAIL_CREDENTIAL_ISSUER_KID = `${EMAIL_CREDENTIAL_ISSUER_DID}#controller`;
function mailboxCredentialCommitment(target) {
  const profile = target.kind === "email" ? EMAIL_PROFILE : EMAIL_DOMAIN_PROFILE;
  const requirement = target.kind === "email" ? { type: "TinyCloudCredentialRequirement", version: 1, profile, credentialType: EMAIL_CREDENTIAL_TYPE, claims: { email: target.address }, maxAgeSeconds: 3600 } : { type: "TinyCloudCredentialRequirement", version: 1, profile, credentialType: EMAIL_CREDENTIAL_TYPE, claims: { emailDomain: target.domain }, maxAgeSeconds: 300 };
  return {
    type: "TinyCloudPolicyCredentialRequirement",
    version: 1,
    requirementDigest: toBase64Url(sha2562(textEncoder.encode(canonicalize(requirement)))),
    descriptorDigest: target.kind === "email" ? EMAIL_DESCRIPTOR_DIGEST : EMAIL_DOMAIN_DESCRIPTOR_DIGEST,
    issuerDid: EMAIL_CREDENTIAL_ISSUER_DID,
    issuerKid: EMAIL_CREDENTIAL_ISSUER_KID,
    profile,
    credentialType: EMAIL_CREDENTIAL_TYPE
  };
}
function prepareAddressedShare(request) {
  try {
    canonicalShareFilename(request.filename);
  } catch {
    throw new TypeError("addressed filename is invalid");
  }
  if (request.actions.length === 0 || request.policyActions.length === 0) throw new TypeError("addressed share actions are empty");
  if (request.policyActions.some((action) => !OWNER_SHARE_ACTIONS.has(action))) throw new TypeError("addressed share action is not supported");
  if (request.deliveryEmail !== void 0 && !isEnvelopeDeliveryEmail(request.deliveryEmail)) throw new TypeError("delivery email is not a valid envelope address");
  const target = normalizeShareTarget(request.target);
  if (target.kind === "bearer") throw new TypeError("addressed target is required");
  if (target.kind === "recipientDid") return { target };
  if (target.kind === "emailDomain" && request.deliveryEmail !== void 0 && (request.deliveryEmail !== request.deliveryEmail.toLowerCase() || !request.deliveryEmail.endsWith(`@${target.domain}`))) {
    throw new TypeError("email-domain delivery address must be a lowercase mailbox at the domain");
  }
  return { target, credentialRequirement: mailboxCredentialCommitment(target) };
}
function assertMailboxCommitment(commitment, target) {
  const label = target.kind === "email" ? "email" : "email-domain";
  if (commitment === void 0) throw new TypeError(`${label} shares require a credential requirement`);
  const expected = mailboxCredentialCommitment(target);
  if (canonicalize(commitment.profile) !== canonicalize(expected.profile) || canonicalize(commitment.credentialType) !== canonicalize(expected.credentialType) || commitment.descriptorDigest !== expected.descriptorDigest || commitment.issuerDid !== expected.issuerDid || commitment.issuerKid !== expected.issuerKid) throw new TypeError(`${label} shares require the ${label} credential profile`);
  if (commitment.requirementDigest !== expected.requirementDigest) throw new TypeError(`credential requirement is not bound to the email ${target.kind === "email" ? "address" : "domain"}`);
}
async function publishAddressedShare(input) {
  assertSafeInput(input);
  const { target } = prepareAddressedShare(input);
  const options = { ...input, filename: canonicalShareFilename(input.filename) };
  if (target.kind !== "recipientDid") assertMailboxCommitment(options.credentialRequirement, target);
  const expiry = rfc3339Seconds(options.expiresAt);
  const matcher = targetMatcher(target);
  const capabilities = sortCanonical([
    { kind: "kv", resource: options.contentSource.kvResource, selector: options.resource.kind, actions: [...options.policyActions] },
    { kind: "encryption", resource: options.contentSource.encryptionNetwork, action: "tinycloud.encryption/decrypt" }
  ]);
  const created = await createPolicy(options, capabilities);
  const contentSourceDigestHex = digestHex(options.contentSource, CONTENT_SOURCE_V1_DOMAIN2);
  const capabilityCeilingHashHex = digestHex(capabilities, POLICY_CAPABILITY_V1_DOMAIN2);
  const nativeProjectionHashHex = digestHex(nativeProjection(capabilities), NATIVE_PROJECTION_V1_DOMAIN2);
  const commonRoot = {
    ownerDid: options.authority.ownerDid,
    policyId: created.policy.policyId,
    policyDigestHex: created.policyDigestHex,
    policyCid: created.policyCid,
    contentSourceDigestHex,
    capabilityCeilingHashHex,
    nativeProjectionHashHex,
    notBefore: new Date(created.policy.createdAt),
    expiresAt: new Date(expiry),
    nodeAudience: options.nodeAudience,
    capabilities
  };
  const policyRootReceipt = await options.authority.createOwnerRoot({ ...commonRoot, role: "policy-authority", audienceDid: `did:tinycloud:policy:${created.policyDigestHex}` });
  const enforcementRootReceipt = await options.authority.createOwnerRoot({ ...commonRoot, role: "policy-enforcement", audienceDid: options.enforcerDid });
  const policyRoot = { cid: policyRootReceipt.cid, authorization: policyRootReceipt.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), role: "policy-authority" };
  const enforcementRoot = { cid: enforcementRootReceipt.cid, authorization: enforcementRootReceipt.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), role: "policy-enforcement" };
  const registration = await options.authority.registerPolicy({
    policyCid: created.policyCid,
    policy: created.policy,
    policyRoot,
    enforcementRoot,
    contentSourceDigestHex,
    nativeProjectionHashHex,
    rootExpiresAt: expiry,
    enforcerDid: options.enforcerDid,
    expectedNodeAudience: options.nodeAudience
  });
  if (registration.policyCid !== created.policyCid || registration.policyRootCid !== policyRoot.cid || registration.enforcementRootCid !== enforcementRoot.cid) throw new Error("Policy/v3 registration receipt is not bound to the published roots");
  const unsigned = {
    version: 3,
    shareId: options.shareId,
    recipientMatcher: matcher,
    ...options.deliveryEmail === void 0 ? {} : { deliveryEmail: options.deliveryEmail },
    actions: [...options.actions],
    resource: { ...options.resource },
    target: { origin: options.nodeOrigin, nodeAudience: registration.attestedEnforcerBinding.enforcerDid, spaceId: options.spaceId },
    policy: created.policy,
    policyCid: created.policyCid,
    policyRoot,
    enforcementRoot,
    attestedEnforcerBinding: registration.attestedEnforcerBinding,
    contentSource: options.contentSource,
    contentSourceDigestHex,
    encryptionNetwork: options.contentSource.encryptionNetwork,
    expiry,
    display: { filename: options.filename },
    encrypted: true,
    metadata: {
      mediaType: options.mediaType,
      byteLength: options.byteLength,
      filename: options.filename,
      ...options.mediaType.startsWith("text/") ? { encoding: "utf-8" } : {},
      ...options.artifact === void 0 ? {} : { artifact: options.artifact }
    }
  };
  unsignedShareEnvelopeV3Schema.parse(unsigned);
  const envelopeSignature = await options.authority.sign(sha2562(textEncoder.encode(`${ENVELOPE_V3_DOMAIN}${canonicalize(unsigned)}`)));
  if (envelopeSignature.byteLength !== 64) throw new TypeError("v3 envelope signature must be Ed25519");
  const envelope = { ...unsigned, signature: { signerDid: options.authority.ownerDid, algorithm: "Ed25519", value: toBase64Url(envelopeSignature) } };
  shareEnvelopeV3Schema.parse(envelope);
  const envelopeBytes = textEncoder.encode(canonicalize(envelope));
  const envelopeKeyBytes = generateKey();
  const sealed = await seal(envelopeBytes, envelopeKeyBytes);
  const envelopeKey = toBase64Url(envelopeKeyBytes);
  const url = await encodeSealedInlineShareUrl({
    origin: options.shareOrigin,
    ciphertext: sealed.blob,
    key32: envelopeKeyBytes
  });
  const deliveryMaterial = {
    envelope,
    shareCid: sealed.cid,
    sealedEnvelope: toBase64Url(sealed.blob),
    envelopeKey
  };
  options.onDeliveryMaterial?.(deliveryMaterial);
  return publicationResult({
    options,
    url,
    envelopeCid: sealed.cid,
    matcher,
    policyCid: created.policyCid,
    policyRootCid: policyRoot.cid,
    enforcementRootCid: enforcementRoot.cid,
    enforcerDid: registration.attestedEnforcerBinding.enforcerDid,
    expiry,
    deliveryMaterial
  });
}
var base322 = rfc46482({
  prefix: "b",
  name: "base32",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567",
  bitsPerChar: 5
});
var base32upper2 = rfc46482({
  prefix: "B",
  name: "base32upper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  bitsPerChar: 5
});
var base32pad2 = rfc46482({
  prefix: "c",
  name: "base32pad",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567=",
  bitsPerChar: 5
});
var base32padupper2 = rfc46482({
  prefix: "C",
  name: "base32padupper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=",
  bitsPerChar: 5
});
var base32hex2 = rfc46482({
  prefix: "v",
  name: "base32hex",
  alphabet: "0123456789abcdefghijklmnopqrstuv",
  bitsPerChar: 5
});
var base32hexupper2 = rfc46482({
  prefix: "V",
  name: "base32hexupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV",
  bitsPerChar: 5
});
var base32hexpad2 = rfc46482({
  prefix: "t",
  name: "base32hexpad",
  alphabet: "0123456789abcdefghijklmnopqrstuv=",
  bitsPerChar: 5
});
var base32hexpadupper2 = rfc46482({
  prefix: "T",
  name: "base32hexpadupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV=",
  bitsPerChar: 5
});
var base32z2 = rfc46482({
  prefix: "h",
  name: "base32z",
  alphabet: "ybndrfg8ejkmcpqxot1uwisza345h769",
  bitsPerChar: 5
});
var base362 = baseX2({
  prefix: "k",
  name: "base36",
  alphabet: "0123456789abcdefghijklmnopqrstuvwxyz"
});
var base36upper2 = baseX2({
  prefix: "K",
  name: "base36upper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
});
var encode_12 = encode4;
var MSB2 = 128;
var REST2 = 127;
var MSBALL2 = ~REST2;
var INT2 = Math.pow(2, 31);
function encode4(num, out, offset) {
  out = out || [];
  offset = offset || 0;
  var oldOffset = offset;
  while (num >= INT2) {
    out[offset++] = num & 255 | MSB2;
    num /= 128;
  }
  while (num & MSBALL2) {
    out[offset++] = num & 255 | MSB2;
    num >>>= 7;
  }
  out[offset] = num | 0;
  encode4.bytes = offset - oldOffset + 1;
  return out;
}
var decode6 = read2;
var MSB$12 = 128;
var REST$12 = 127;
function read2(buf, offset) {
  var res = 0, offset = offset || 0, shift = 0, counter = offset, b, l = buf.length;
  do {
    if (counter >= l) {
      read2.bytes = 0;
      throw new RangeError("Could not decode varint");
    }
    b = buf[counter++];
    res += shift < 28 ? (b & REST$12) << shift : (b & REST$12) * Math.pow(2, shift);
    shift += 7;
  } while (b >= MSB$12);
  read2.bytes = counter - offset;
  return res;
}
var N12 = Math.pow(2, 7);
var N22 = Math.pow(2, 14);
var N32 = Math.pow(2, 21);
var N42 = Math.pow(2, 28);
var N52 = Math.pow(2, 35);
var N62 = Math.pow(2, 42);
var N72 = Math.pow(2, 49);
var N82 = Math.pow(2, 56);
var N92 = Math.pow(2, 63);
var length2 = function(value) {
  return value < N12 ? 1 : value < N22 ? 2 : value < N32 ? 3 : value < N42 ? 4 : value < N52 ? 5 : value < N62 ? 6 : value < N72 ? 7 : value < N82 ? 8 : value < N92 ? 9 : 10;
};
var varint2 = {
  encode: encode_12,
  decode: decode6,
  encodingLength: length2
};
var _brrp_varint2 = varint2;
var varint_default2 = _brrp_varint2;
function decode7(data, offset = 0) {
  const code3 = varint_default2.decode(data, offset);
  return [code3, varint_default2.decode.bytes];
}
function encodeTo2(int, target, offset = 0) {
  varint_default2.encode(int, target, offset);
  return target;
}
function encodingLength2(int) {
  return varint_default2.encodingLength(int);
}
function create2(code3, digest3) {
  const size = digest3.byteLength;
  const sizeOffset = encodingLength2(code3);
  const digestOffset = sizeOffset + encodingLength2(size);
  const bytes3 = new Uint8Array(digestOffset + size);
  encodeTo2(code3, bytes3, 0);
  encodeTo2(size, bytes3, sizeOffset);
  bytes3.set(digest3, digestOffset);
  return new Digest2(code3, size, digest3, bytes3);
}
function decode8(multihash) {
  const bytes3 = coerce3(multihash);
  const [code3, sizeOffset] = decode7(bytes3);
  const [size, digestOffset] = decode7(bytes3.subarray(sizeOffset));
  const digest3 = bytes3.subarray(sizeOffset + digestOffset);
  if (digest3.byteLength !== size) {
    throw new Error("Incorrect length");
  }
  return new Digest2(code3, size, digest3, bytes3);
}
function equals4(a, b) {
  if (a === b) {
    return true;
  } else {
    const data = b;
    return a.code === data.code && a.size === data.size && data.bytes instanceof Uint8Array && equals3(a.bytes, data.bytes);
  }
}
var Digest2 = class {
  code;
  size;
  digest;
  bytes;
  /**
   * Creates a multihash digest.
   */
  constructor(code3, size, digest3, bytes3) {
    this.code = code3;
    this.size = size;
    this.digest = digest3;
    this.bytes = bytes3;
  }
};
function format2(link2, base33) {
  const { bytes: bytes3, version: version2 } = link2;
  switch (version2) {
    case 0:
      return toStringV02(bytes3, baseCache2(link2), base33 ?? base58btc2.encoder);
    default:
      return toStringV12(bytes3, baseCache2(link2), base33 ?? base322.encoder);
  }
}
var cache2 = /* @__PURE__ */ new WeakMap();
function baseCache2(cid2) {
  const baseCache32 = cache2.get(cid2);
  if (baseCache32 == null) {
    const baseCache4 = /* @__PURE__ */ new Map();
    cache2.set(cid2, baseCache4);
    return baseCache4;
  }
  return baseCache32;
}
var CID2 = class _CID2 {
  code;
  version;
  multihash;
  bytes;
  "/";
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param multihash - (Multi)hash of the of the content.
   */
  constructor(version2, code3, multihash, bytes3) {
    this.code = code3;
    this.version = version2;
    this.multihash = multihash;
    this.bytes = bytes3;
    this["/"] = bytes3;
  }
  /**
   * Signalling `cid.asCID === cid` has been replaced with `cid['/'] === cid.bytes`
   * please either use `CID.asCID(cid)` or switch to new signalling mechanism
   *
   * @deprecated
   */
  get asCID() {
    return this;
  }
  // ArrayBufferView
  get byteOffset() {
    return this.bytes.byteOffset;
  }
  // ArrayBufferView
  get byteLength() {
    return this.bytes.byteLength;
  }
  toV0() {
    switch (this.version) {
      case 0: {
        return this;
      }
      case 1: {
        const { code: code3, multihash } = this;
        if (code3 !== DAG_PB_CODE2) {
          throw new Error("Cannot convert a non dag-pb CID to CIDv0");
        }
        if (multihash.code !== SHA_256_CODE2) {
          throw new Error("Cannot convert non sha2-256 multihash CID to CIDv0");
        }
        return _CID2.createV0(multihash);
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 0. This is a bug please report`);
      }
    }
  }
  toV1() {
    switch (this.version) {
      case 0: {
        const { code: code3, digest: digest3 } = this.multihash;
        const multihash = create2(code3, digest3);
        return _CID2.createV1(this.code, multihash);
      }
      case 1: {
        return this;
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 1. This is a bug please report`);
      }
    }
  }
  equals(other) {
    return _CID2.equals(this, other);
  }
  static equals(self, other) {
    const unknown = other;
    return unknown != null && self.code === unknown.code && self.version === unknown.version && equals4(self.multihash, unknown.multihash);
  }
  toString(base33) {
    return format2(this, base33);
  }
  toJSON() {
    return { "/": format2(this) };
  }
  link() {
    return this;
  }
  [Symbol.toStringTag] = "CID";
  // Legacy
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return `CID(${this.toString()})`;
  }
  /**
   * Takes any input `value` and returns a `CID` instance if it was
   * a `CID` otherwise returns `null`. If `value` is instanceof `CID`
   * it will return value back. If `value` is not instance of this CID
   * class, but is compatible CID it will return new instance of this
   * `CID` class. Otherwise returns null.
   *
   * This allows two different incompatible versions of CID library to
   * co-exist and interop as long as binary interface is compatible.
   */
  static asCID(input) {
    if (input == null) {
      return null;
    }
    const value = input;
    if (value instanceof _CID2) {
      return value;
    } else if (value["/"] != null && value["/"] === value.bytes || value.asCID === value) {
      const { version: version2, code: code3, multihash, bytes: bytes3 } = value;
      return new _CID2(version2, code3, multihash, bytes3 ?? encodeCID2(version2, code3, multihash.bytes));
    } else if (value[cidSymbol2] === true) {
      const { version: version2, multihash, code: code3 } = value;
      const digest3 = decode8(multihash);
      return _CID2.create(version2, code3, digest3);
    } else {
      return null;
    }
  }
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param digest - (Multi)hash of the of the content.
   */
  static create(version2, code3, digest3) {
    if (typeof code3 !== "number") {
      throw new Error("String codecs are no longer supported");
    }
    if (!(digest3.bytes instanceof Uint8Array)) {
      throw new Error("Invalid digest");
    }
    switch (version2) {
      case 0: {
        if (code3 !== DAG_PB_CODE2) {
          throw new Error(`Version 0 CID must use dag-pb (code: ${DAG_PB_CODE2}) block encoding`);
        } else {
          return new _CID2(version2, code3, digest3, digest3.bytes);
        }
      }
      case 1: {
        const bytes3 = encodeCID2(version2, code3, digest3.bytes);
        return new _CID2(version2, code3, digest3, bytes3);
      }
      default: {
        throw new Error("Invalid version");
      }
    }
  }
  /**
   * Simplified version of `create` for CIDv0.
   */
  static createV0(digest3) {
    return _CID2.create(0, DAG_PB_CODE2, digest3);
  }
  /**
   * Simplified version of `create` for CIDv1.
   *
   * @param code - Content encoding format code.
   * @param digest - Multihash of the content.
   */
  static createV1(code3, digest3) {
    return _CID2.create(1, code3, digest3);
  }
  /**
   * Decoded a CID from its binary representation. The byte array must contain
   * only the CID with no additional bytes.
   *
   * An error will be thrown if the bytes provided do not contain a valid
   * binary representation of a CID.
   */
  static decode(bytes3) {
    const [cid2, remainder] = _CID2.decodeFirst(bytes3);
    if (remainder.length !== 0) {
      throw new Error("Incorrect length");
    }
    return cid2;
  }
  /**
   * Decoded a CID from its binary representation at the beginning of a byte
   * array.
   *
   * Returns an array with the first element containing the CID and the second
   * element containing the remainder of the original byte array. The remainder
   * will be a zero-length byte array if the provided bytes only contained a
   * binary CID representation.
   */
  static decodeFirst(bytes3) {
    const specs = _CID2.inspectBytes(bytes3);
    const prefixSize = specs.size - specs.multihashSize;
    const multihashBytes = coerce3(bytes3.subarray(prefixSize, prefixSize + specs.multihashSize));
    if (multihashBytes.byteLength !== specs.multihashSize) {
      throw new Error("Incorrect length");
    }
    const digestBytes3 = multihashBytes.subarray(specs.multihashSize - specs.digestSize);
    const digest3 = new Digest2(specs.multihashCode, specs.digestSize, digestBytes3, multihashBytes);
    const cid2 = specs.version === 0 ? _CID2.createV0(digest3) : _CID2.createV1(specs.codec, digest3);
    return [cid2, bytes3.subarray(specs.size)];
  }
  /**
   * Inspect the initial bytes of a CID to determine its properties.
   *
   * Involves decoding up to 4 varints. Typically this will require only 4 to 6
   * bytes but for larger multicodec code values and larger multihash digest
   * lengths these varints can be quite large. It is recommended that at least
   * 10 bytes be made available in the `initialBytes` argument for a complete
   * inspection.
   */
  static inspectBytes(initialBytes) {
    let offset = 0;
    const next = () => {
      const [i, length32] = decode7(initialBytes.subarray(offset));
      offset += length32;
      return i;
    };
    let version2 = next();
    let codec = DAG_PB_CODE2;
    if (version2 === 18) {
      version2 = 0;
      offset = 0;
    } else {
      codec = next();
    }
    if (version2 !== 0 && version2 !== 1) {
      throw new RangeError(`Invalid CID version ${version2}`);
    }
    const prefixSize = offset;
    const multihashCode = next();
    const digestSize = next();
    const size = offset + digestSize;
    const multihashSize = size - prefixSize;
    return { version: version2, codec, multihashCode, digestSize, multihashSize, size };
  }
  /**
   * Takes cid in a string representation and creates an instance. If `base`
   * decoder is not provided will use a default from the configuration. It will
   * throw an error if encoding of the CID is not compatible with supplied (or
   * a default decoder).
   */
  static parse(source, base33) {
    const [prefix, bytes3] = parseCIDtoBytes2(source, base33);
    const cid2 = _CID2.decode(bytes3);
    if (cid2.version === 0 && source[0] !== "Q") {
      throw Error("Version 0 CID string must not include multibase prefix");
    }
    baseCache2(cid2).set(prefix, source);
    return cid2;
  }
};
function parseCIDtoBytes2(source, base33) {
  switch (source[0]) {
    // CIDv0 is parsed differently
    case "Q": {
      const decoder = base33 ?? base58btc2;
      return [
        base58btc2.prefix,
        decoder.decode(`${base58btc2.prefix}${source}`)
      ];
    }
    case base58btc2.prefix: {
      const decoder = base33 ?? base58btc2;
      return [base58btc2.prefix, decoder.decode(source)];
    }
    case base322.prefix: {
      const decoder = base33 ?? base322;
      return [base322.prefix, decoder.decode(source)];
    }
    case base362.prefix: {
      const decoder = base33 ?? base362;
      return [base362.prefix, decoder.decode(source)];
    }
    default: {
      if (base33 == null) {
        throw Error("To parse non base32, base36 or base58btc encoded CID multibase decoder must be provided");
      }
      return [source[0], base33.decode(source)];
    }
  }
}
function toStringV02(bytes3, cache32, base33) {
  const { prefix } = base33;
  if (prefix !== base58btc2.prefix) {
    throw Error(`Cannot string encode V0 in ${base33.name} encoding`);
  }
  const cid2 = cache32.get(prefix);
  if (cid2 == null) {
    const cid3 = base33.encode(bytes3).slice(1);
    cache32.set(prefix, cid3);
    return cid3;
  } else {
    return cid2;
  }
}
function toStringV12(bytes3, cache32, base33) {
  const { prefix } = base33;
  const cid2 = cache32.get(prefix);
  if (cid2 == null) {
    const cid3 = base33.encode(bytes3);
    cache32.set(prefix, cid3);
    return cid3;
  } else {
    return cid2;
  }
}
var DAG_PB_CODE2 = 112;
var SHA_256_CODE2 = 18;
function encodeCID2(version2, code3, multihash) {
  const codeOffset = encodingLength2(version2);
  const hashOffset = codeOffset + encodingLength2(code3);
  const bytes3 = new Uint8Array(hashOffset + multihash.byteLength);
  encodeTo2(version2, bytes3, 0);
  encodeTo2(code3, bytes3, codeOffset);
  bytes3.set(multihash, hashOffset);
  return bytes3;
}
var cidSymbol2 = /* @__PURE__ */ Symbol.for("@ipld/js-cid/CID");
var MAX_CONTENT_BYTES = 100 * 1024 * 1024;
function historyRecordForPublishedShare(result, now = /* @__PURE__ */ new Date()) {
  const target = result.metadata.target.kind;
  const supplied = result.metadata.recipientMatcher;
  let matcher;
  if (supplied?.kind === "recipientDid" && typeof supplied.value === "string") matcher = { kind: "recipientDid", value: supplied.value };
  else if (supplied?.kind === "exactEmail" && typeof supplied.value === "string") matcher = { kind: "exactEmail", value: supplied.value };
  else if (supplied?.kind === "emailDomain" && typeof supplied.value === "string") matcher = { kind: "emailDomain", value: supplied.value };
  else if (target !== "bearer") throw new TypeError("addressed publication is missing its recipient binding");
  else matcher = { kind: "bearer" };
  return {
    shareId: result.metadata.shareId,
    target: result.metadata.target,
    resource: result.metadata.resource,
    actions: result.metadata.actions.map(
      (action) => action === "read" ? "tinycloud.kv/get" : action === "list" ? "tinycloud.kv/list" : action === "edit" ? "tinycloud.kv/put" : action
    ),
    recipientMatcher: matcher,
    targetKind: target,
    ...result.metadata.registrationCid === void 0 ? {} : { registrationCid: result.metadata.registrationCid },
    ...result.metadata.policyCid === void 0 ? {} : { policyCid: result.metadata.policyCid },
    ...result.metadata.ownerDelegationCid === void 0 ? {} : { ownerDelegationCid: result.metadata.ownerDelegationCid },
    ...result.metadata.enforcementDelegationCid === void 0 ? {} : { enforcementDelegationCid: result.metadata.enforcementDelegationCid },
    ...result.metadata.ownerDid === void 0 ? {} : { ownerDid: result.metadata.ownerDid },
    ...result.metadata.shareKeyDid === void 0 ? {} : { shareKeyDid: result.metadata.shareKeyDid },
    ...result.metadata.enforcerDid === void 0 ? {} : { enforcerDid: result.metadata.enforcerDid },
    ...result.metadata.envelopeCid === void 0 ? {} : { envelopeCid: result.metadata.envelopeCid },
    ...result.metadata.shareCid === void 0 ? {} : { shareCid: result.metadata.shareCid },
    registeredAt: now.toISOString(),
    expiresAt: result.metadata.expiresAt,
    link: result.url,
    ...result.deliveryMaterial === void 0 ? {} : { deliveryMaterial: result.deliveryMaterial },
    ...result.metadata.display.filename === void 0 ? {} : { filename: result.metadata.display.filename }
  };
}
var ShareNotifyError = class extends Error {
  constructor(message = "share delivery did not complete", reason) {
    super(message);
    this.reason = reason;
    this.name = "ShareNotifyError";
  }
  code = "delivery-failed";
};
function recipientMatchesShareRecord(record, recipient) {
  const matcher = record.recipientMatcher;
  const mailbox = canonicalMailbox(recipient);
  if (mailbox === void 0) return false;
  if (matcher.kind === "exactEmail") return canonicalMailbox(matcher.value)?.email === mailbox.email;
  if (matcher.kind === "emailDomain") return mailbox.domain === matcher.value;
  return false;
}
function shareDeliveryWindowExpiresAt(record) {
  const expiresAt = Math.min(Date.parse(record.expiresAt), Date.parse(record.registeredAt) + 5 * 60 * 1e3);
  if (!Number.isFinite(expiresAt)) throw new ShareNotifyError("share delivery history has invalid timestamps");
  return expiresAt;
}
async function notifyShare(input) {
  const mailbox = canonicalMailbox(input.recipient);
  if (!input.shareId || mailbox === void 0) throw new ShareNotifyError("recipient is invalid");
  const recipient = mailbox.email;
  if (input.record !== void 0 && !recipientMatchesShareRecord(input.record, recipient)) {
    throw new ShareNotifyError("recipient does not match the stored share target");
  }
  const idempotencyKey = input.idempotencyKey ?? await defaultIdempotencyKey(input.shareId, recipient);
  const attemptsLimit = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attemptsLimit) || attemptsLimit < 1 || attemptsLimit > 8) throw new ShareNotifyError("maxAttempts is invalid");
  if (input.signal?.aborted) throw new ShareNotifyError("share delivery was cancelled");
  if (input.checkDeliveryWindow && input.record !== void 0 && shareDeliveryWindowExpiresAt(input.record) <= Date.now()) {
    return {
      protocol: "tinycloud-share",
      version: 1,
      shareId: input.shareId,
      state: "partial-failure",
      idempotencyKey,
      attempts: 1,
      retryable: false,
      reason: "delivery-window-expired"
    };
  }
  let attempts = 0;
  while (attempts < attemptsLimit) {
    if (input.signal?.aborted) throw new ShareNotifyError("share delivery was cancelled");
    attempts += 1;
    try {
      const state = await input.adapter.deliver({ shareId: input.shareId, recipient, idempotencyKey, ...input.record === void 0 ? {} : { record: input.record }, ...input.signal === void 0 ? {} : { signal: input.signal } });
      return {
        protocol: "tinycloud-share",
        version: 1,
        shareId: input.shareId,
        state: state === "delivered" && input.record?.deliveredRecipients?.includes(recipient) ? "already-delivered" : state,
        idempotencyKey,
        attempts
      };
    } catch (error) {
      if (error instanceof ShareNotifyError && error.reason === "delivery-window-expired") {
        return {
          protocol: "tinycloud-share",
          version: 1,
          shareId: input.shareId,
          state: "partial-failure",
          idempotencyKey,
          attempts,
          retryable: false,
          reason: "delivery-window-expired"
        };
      }
      if (error !== null && typeof error === "object" && "status" in error && (error.status === 401 || error.status === 403)) {
        return {
          protocol: "tinycloud-share",
          version: 1,
          shareId: input.shareId,
          state: "partial-failure",
          idempotencyKey,
          attempts,
          retryable: false
        };
      }
    }
  }
  return { protocol: "tinycloud-share", version: 1, shareId: input.shareId, state: "partial-failure", idempotencyKey, attempts, retryable: true };
}
async function defaultIdempotencyKey(shareId, recipient) {
  const canonicalRecipient = canonicalize(recipient.trim().toLowerCase());
  const digest3 = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalRecipient)
  ));
  return `tinycloud-share:${shareId}:${toBase64Url(digest3)}`;
}
var CredentialInvitationError = class extends Error {
  constructor(code3, message) {
    super(message);
    this.code = code3;
    this.name = "CredentialInvitationError";
  }
};
function canonicalOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CredentialInvitationError(
      "invalid-origin",
      "credential invitation origin is invalid"
    );
  }
  if (url.origin !== value || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.protocol !== "https:")
    throw new CredentialInvitationError(
      "invalid-origin",
      "credential invitation origin is invalid"
    );
  return url.origin;
}
function object2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function validateReceipt(receipt, shareUrl) {
  if (!object2(receipt) || !object2(receipt.request) || !object2(receipt.admission) || !object2(receipt.proof)) {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation receipt is invalid"
    );
  }
  if (receipt.request.returnLink !== shareUrl) {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation is not bound to the share link"
    );
  }
  let link2;
  try {
    link2 = new URL(shareUrl);
  } catch {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation share link is invalid"
    );
  }
  if (link2.search !== "" || link2.pathname !== "/s/inline") {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation share link must be sealed inline"
    );
  }
  try {
    await parseSealedInlineShareUrl(shareUrl);
  } catch {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation share link is invalid"
    );
  }
}
async function deliverCredentialInvitation(input) {
  const credentialsOrigin = canonicalOrigin(input.credentialsOrigin);
  await validateReceipt(input.receipt, input.shareUrl);
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  let response;
  try {
    response = await fetchFn(`${credentialsOrigin}/v1/credential-invitations`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(input.receipt),
      ...input.signal === void 0 ? {} : { signal: input.signal }
    });
  } catch {
    throw new CredentialInvitationError(
      "transport",
      "credential invitation delivery is unavailable"
    );
  }
  if (response.status !== 202) {
    throw new CredentialInvitationError(
      "rejected",
      "credential invitation delivery was not accepted"
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new CredentialInvitationError(
      "invalid-response",
      "credential invitation response is invalid"
    );
  }
  if (!object2(body) || Object.keys(body).length !== 1 || body.status !== "accepted") {
    throw new CredentialInvitationError(
      "invalid-response",
      "credential invitation response is invalid"
    );
  }
  return { status: "accepted" };
}
function targetKind2(record) {
  if (record.targetKind !== void 0) return record.targetKind;
  return record.recipientMatcher.kind === "exactEmail" ? "email" : record.recipientMatcher.kind === "emailDomain" ? "emailDomain" : record.recipientMatcher.kind === "recipientDid" ? "recipientDid" : "bearer";
}
function policyNodeAudience(record) {
  const envelope = record.deliveryMaterial?.envelope;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return record.target.nodeAudience;
  const binding = envelope.attestedEnforcerBinding;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return record.target.nodeAudience;
  const nodeAudience = binding.nodeAudience;
  return typeof nodeAudience === "string" ? nodeAudience : record.target.nodeAudience;
}
async function revokeShare(input) {
  const target = targetKind2(input.record);
  if (input.adapter === void 0) return { state: "unsupported", target, reason: "node revocation authority is required", code: "unsupported-target" };
  const scope = input.scope ?? "direct";
  const delegationCid = scope === "ancestor" ? input.record.ownerDelegationCid : input.record.enforcementDelegationCid;
  if (delegationCid === void 0) return { state: "unsupported", target, reason: "share has no node-enforced delegation receipt", code: "unsupported-target" };
  if (target === "bearer") {
    if (input.adapter.revokeDelegation === void 0) return { state: "unsupported", target, reason: "native delegation revocation authority is required", code: "unsupported-target" };
    await input.adapter.revokeDelegation({ delegationCid, scope });
  } else {
    if (input.record.ownerDid === void 0) return { state: "unsupported", target, reason: "share has no Policy/v3 owner receipt", code: "unsupported-target" };
    if (input.adapter.revokePolicyRoot === void 0) return { state: "unsupported", target, reason: "Policy/v3 root revocation authority is required", code: "unsupported-target" };
    await input.adapter.revokePolicyRoot({
      rootCid: delegationCid,
      targetRole: scope === "ancestor" ? "policy-authority" : "policy-enforcement",
      ownerDid: input.record.ownerDid,
      nodeOrigin: input.record.target.origin,
      nodeAudience: policyNodeAudience(input.record)
    });
  }
  const revokedAt = (input.now?.() ?? /* @__PURE__ */ new Date()).toISOString();
  if (input.records?.update !== void 0) {
    await input.records.update(input.record.shareId, (record) => ({ ...record, revokedAt }));
  } else if (input.records !== void 0) {
    await input.records.put({ ...input.record, revokedAt });
  }
  return { state: "revoked", target, delegationCid, revokedAt };
}
function redactRecord(record, revealLink, link2) {
  const matcher = record.recipientMatcher;
  const revealedLink = revealLink ? link2 ?? record.link : void 0;
  return {
    shareId: record.shareId,
    target: matcher.kind === "exactEmail" ? "email" : matcher.kind === "emailDomain" ? "email-domain" : matcher.kind === "recipientDid" ? "recipient-did" : "bearer",
    ...matcher.kind === "exactEmail" ? { recipient: matcher.value } : matcher.kind === "emailDomain" ? { recipient: `*@${matcher.value}` } : matcher.kind === "recipientDid" ? { recipient: matcher.value } : {},
    expiresAt: record.expiresAt,
    revoked: record.revokedAt !== void 0,
    ...revealedLink === void 0 ? {} : { link: revealedLink }
  };
}
async function listShares(storage) {
  const records = await storage.list();
  return records.map((record) => redactRecord(record, false));
}
async function showShare(input) {
  const record = await input.storage.get(input.shareId);
  if (record === void 0) throw new Error("share not found");
  return redactRecord(record, input.revealLink === true, input.link);
}
var SHARE_V2_PROTOCOL = Object.freeze({
  challengeDomain: "xyz.tinycloud.share/policy-challenge/v2\0",
  sessionDomain: "xyz.tinycloud.share/policy-session/v2\0",
  invocationDomain: "xyz.tinycloud.share/invocation/v2\0",
  readResponseDomain: "xyz.tinycloud.share/read-response/v2\0",
  holderBindingDomain: "xyz.tinycloud.share/email-claim-holder-binding/v1\0",
  holderBindingName: "holderBinding",
  holderBindingType: "TinyCloudEmailClaimHolderBinding",
  holderBindingVersion: 1
});
var DOMAIN = SHARE_V2_PROTOCOL.challengeDomain;
var PRESENTATION_DOMAIN = SHARE_V2_PROTOCOL.sessionDomain;
var SESSION_DOMAIN = SHARE_V2_PROTOCOL.sessionDomain;
var INVOCATION_DOMAIN = SHARE_V2_PROTOCOL.invocationDomain;
var NATIVE_SHARE_FRAGMENT_PARAMETER = "tc1";
function canonicalViewerUrl(viewerOrigin) {
  const url = new URL(viewerOrigin);
  if (url.protocol !== "https:" || url.origin !== viewerOrigin || url.pathname !== "/" || url.search || url.hash) throw new TypeError("viewer origin must be a canonical HTTPS origin");
  url.pathname = "/viewer";
  return url;
}
async function createNativeShare(sharing, input) {
  if (!input.path || input.path.startsWith("/") || input.path.endsWith("/") || input.path.includes("..") || input.path.includes("//")) throw new TypeError("native share path must be one canonical TinyCloud KV key");
  const generated = await sharing.generate({ path: input.path, actions: ["tinycloud.kv/get"], expiry: input.expiresAt });
  if (generated.ok !== true) {
    const error = new Error(typeof generated.error?.message === "string" ? generated.error.message : "TinyCloud sharing service rejected delegation generation");
    if (typeof generated.error?.code === "string") Object.assign(error, { code: generated.error.code });
    throw error;
  }
  if (typeof generated.data?.token !== "string" || typeof generated.data.delegation?.cid !== "string" || !(generated.data.expiresAt instanceof Date)) throw new Error("TinyCloud sharing service returned incomplete delegation metadata");
  const delegation = sharing.decodeLink(generated.data.token);
  if (typeof delegation.spaceId !== "string" || delegation.spaceId.length === 0 || typeof delegation.path !== "string" || delegation.path.length === 0) throw new Error("TinyCloud sharing service returned a non-canonical delegation authority");
  const url = canonicalViewerUrl(input.viewerOrigin);
  url.hash = `${NATIVE_SHARE_FRAGMENT_PARAMETER}=${encodeURIComponent(generated.data.token)}`;
  return { url: url.toString(), delegationCid: generated.data.delegation.cid, expiresAt: generated.data.expiresAt, spaceId: delegation.spaceId };
}
function parseNativeShareUrl(value) {
  const url = new URL(value);
  if (url.search || url.pathname !== "/viewer") throw new TypeError("native shares must carry tc1 only in the /viewer URL fragment");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get(NATIVE_SHARE_FRAGMENT_PARAMETER);
  if (!token || fragment.size !== 1) throw new TypeError("missing native share fragment");
  return token;
}

// ../share-envelope/dist/index.js
init_zod();
var empty3 = new Uint8Array(0);
function equals5(aa, bb) {
  if (aa === bb) {
    return true;
  }
  if (aa.byteLength !== bb.byteLength) {
    return false;
  }
  for (let ii = 0; ii < aa.byteLength; ii++) {
    if (aa[ii] !== bb[ii]) {
      return false;
    }
  }
  return true;
}
function coerce5(o) {
  if (o instanceof Uint8Array && o.constructor.name === "Uint8Array") {
    return o;
  }
  if (o instanceof ArrayBuffer) {
    return new Uint8Array(o);
  }
  if (ArrayBuffer.isView(o)) {
    return new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
  }
  throw new Error("Unknown type, must be binary type");
}
function base3(ALPHABET, name) {
  if (ALPHABET.length >= 255) {
    throw new TypeError("Alphabet too long");
  }
  var BASE_MAP = new Uint8Array(256);
  for (var j = 0; j < BASE_MAP.length; j++) {
    BASE_MAP[j] = 255;
  }
  for (var i = 0; i < ALPHABET.length; i++) {
    var x = ALPHABET.charAt(i);
    var xc = x.charCodeAt(0);
    if (BASE_MAP[xc] !== 255) {
      throw new TypeError(x + " is ambiguous");
    }
    BASE_MAP[xc] = i;
  }
  var BASE = ALPHABET.length;
  var LEADER = ALPHABET.charAt(0);
  var FACTOR = Math.log(BASE) / Math.log(256);
  var iFACTOR = Math.log(256) / Math.log(BASE);
  function encode32(source) {
    if (source instanceof Uint8Array)
      ;
    else if (ArrayBuffer.isView(source)) {
      source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else if (Array.isArray(source)) {
      source = Uint8Array.from(source);
    }
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("Expected Uint8Array");
    }
    if (source.length === 0) {
      return "";
    }
    var zeroes = 0;
    var length22 = 0;
    var pbegin = 0;
    var pend = source.length;
    while (pbegin !== pend && source[pbegin] === 0) {
      pbegin++;
      zeroes++;
    }
    var size = (pend - pbegin) * iFACTOR + 1 >>> 0;
    var b58 = new Uint8Array(size);
    while (pbegin !== pend) {
      var carry = source[pbegin];
      var i2 = 0;
      for (var it1 = size - 1; (carry !== 0 || i2 < length22) && it1 !== -1; it1--, i2++) {
        carry += 256 * b58[it1] >>> 0;
        b58[it1] = carry % BASE >>> 0;
        carry = carry / BASE >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length22 = i2;
      pbegin++;
    }
    var it2 = size - length22;
    while (it2 !== size && b58[it2] === 0) {
      it2++;
    }
    var str = LEADER.repeat(zeroes);
    for (; it2 < size; ++it2) {
      str += ALPHABET.charAt(b58[it2]);
    }
    return str;
  }
  function decodeUnsafe(source) {
    if (typeof source !== "string") {
      throw new TypeError("Expected String");
    }
    if (source.length === 0) {
      return new Uint8Array();
    }
    var psz = 0;
    if (source[psz] === " ") {
      return;
    }
    var zeroes = 0;
    var length22 = 0;
    while (source[psz] === LEADER) {
      zeroes++;
      psz++;
    }
    var size = (source.length - psz) * FACTOR + 1 >>> 0;
    var b256 = new Uint8Array(size);
    while (source[psz]) {
      var carry = BASE_MAP[source.charCodeAt(psz)];
      if (carry === 255) {
        return;
      }
      var i2 = 0;
      for (var it3 = size - 1; (carry !== 0 || i2 < length22) && it3 !== -1; it3--, i2++) {
        carry += BASE * b256[it3] >>> 0;
        b256[it3] = carry % 256 >>> 0;
        carry = carry / 256 >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length22 = i2;
      psz++;
    }
    if (source[psz] === " ") {
      return;
    }
    var it4 = size - length22;
    while (it4 !== size && b256[it4] === 0) {
      it4++;
    }
    var vch = new Uint8Array(zeroes + (size - it4));
    var j2 = zeroes;
    while (it4 !== size) {
      vch[j2++] = b256[it4++];
    }
    return vch;
  }
  function decode52(string) {
    var buffer = decodeUnsafe(string);
    if (buffer) {
      return buffer;
    }
    throw new Error(`Non-${name} character`);
  }
  return {
    encode: encode32,
    decodeUnsafe,
    decode: decode52
  };
}
var src3 = base3;
var _brrp__multiformats_scope_baseX3 = src3;
var base_x_default3 = _brrp__multiformats_scope_baseX3;
var Encoder3 = class {
  name;
  prefix;
  baseEncode;
  constructor(name, prefix, baseEncode) {
    this.name = name;
    this.prefix = prefix;
    this.baseEncode = baseEncode;
  }
  encode(bytes) {
    if (bytes instanceof Uint8Array) {
      return `${this.prefix}${this.baseEncode(bytes)}`;
    } else {
      throw Error("Unknown type, must be binary type");
    }
  }
};
var Decoder3 = class {
  name;
  prefix;
  baseDecode;
  prefixCodePoint;
  constructor(name, prefix, baseDecode) {
    this.name = name;
    this.prefix = prefix;
    const prefixCodePoint = prefix.codePointAt(0);
    if (prefixCodePoint === void 0) {
      throw new Error("Invalid prefix character");
    }
    this.prefixCodePoint = prefixCodePoint;
    this.baseDecode = baseDecode;
  }
  decode(text) {
    if (typeof text === "string") {
      if (text.codePointAt(0) !== this.prefixCodePoint) {
        throw Error(`Unable to decode multibase string ${JSON.stringify(text)}, ${this.name} decoder only supports inputs prefixed with ${this.prefix}`);
      }
      return this.baseDecode(text.slice(this.prefix.length));
    } else {
      throw Error("Can only multibase decode strings");
    }
  }
  or(decoder) {
    return or3(this, decoder);
  }
};
var ComposedDecoder3 = class {
  decoders;
  constructor(decoders) {
    this.decoders = decoders;
  }
  or(decoder) {
    return or3(this, decoder);
  }
  decode(input) {
    const prefix = input[0];
    const decoder = this.decoders[prefix];
    if (decoder != null) {
      return decoder.decode(input);
    } else {
      throw RangeError(`Unable to decode multibase string ${JSON.stringify(input)}, only inputs prefixed with ${Object.keys(this.decoders)} are supported`);
    }
  }
};
function or3(left, right) {
  return new ComposedDecoder3({
    ...left.decoders ?? { [left.prefix]: left },
    ...right.decoders ?? { [right.prefix]: right }
  });
}
var Codec3 = class {
  name;
  prefix;
  baseEncode;
  baseDecode;
  encoder;
  decoder;
  constructor(name, prefix, baseEncode, baseDecode) {
    this.name = name;
    this.prefix = prefix;
    this.baseEncode = baseEncode;
    this.baseDecode = baseDecode;
    this.encoder = new Encoder3(name, prefix, baseEncode);
    this.decoder = new Decoder3(name, prefix, baseDecode);
  }
  encode(input) {
    return this.encoder.encode(input);
  }
  decode(input) {
    return this.decoder.decode(input);
  }
};
function from3({ name, prefix, encode: encode32, decode: decode52 }) {
  return new Codec3(name, prefix, encode32, decode52);
}
function baseX3({ name, prefix, alphabet }) {
  const { encode: encode32, decode: decode52 } = base_x_default3(alphabet, name);
  return from3({
    prefix,
    name,
    encode: encode32,
    decode: (text) => coerce5(decode52(text))
  });
}
function decode9(string, alphabetIdx, bitsPerChar, name) {
  let end = string.length;
  while (string[end - 1] === "=") {
    --end;
  }
  const out = new Uint8Array(end * bitsPerChar / 8 | 0);
  let bits = 0;
  let buffer = 0;
  let written = 0;
  for (let i = 0; i < end; ++i) {
    const value = alphabetIdx[string[i]];
    if (value === void 0) {
      throw new SyntaxError(`Non-${name} character`);
    }
    buffer = buffer << bitsPerChar | value;
    bits += bitsPerChar;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = 255 & buffer >> bits;
    }
  }
  if (bits >= bitsPerChar || (255 & buffer << 8 - bits) !== 0) {
    throw new SyntaxError("Unexpected end of data");
  }
  return out;
}
function encode5(data, alphabet, bitsPerChar) {
  const pad = alphabet[alphabet.length - 1] === "=";
  const mask = (1 << bitsPerChar) - 1;
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < data.length; ++i) {
    buffer = buffer << 8 | data[i];
    bits += 8;
    while (bits > bitsPerChar) {
      bits -= bitsPerChar;
      out += alphabet[mask & buffer >> bits];
    }
  }
  if (bits !== 0) {
    out += alphabet[mask & buffer << bitsPerChar - bits];
  }
  if (pad) {
    while ((out.length * bitsPerChar & 7) !== 0) {
      out += "=";
    }
  }
  return out;
}
function createAlphabetIdx3(alphabet) {
  const alphabetIdx = {};
  for (let i = 0; i < alphabet.length; ++i) {
    alphabetIdx[alphabet[i]] = i;
  }
  return alphabetIdx;
}
function rfc46483({ name, prefix, bitsPerChar, alphabet }) {
  const alphabetIdx = createAlphabetIdx3(alphabet);
  return from3({
    prefix,
    name,
    encode(input) {
      return encode5(input, alphabet, bitsPerChar);
    },
    decode(input) {
      return decode9(input, alphabetIdx, bitsPerChar, name);
    }
  });
}
var base323 = rfc46483({
  prefix: "b",
  name: "base32",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567",
  bitsPerChar: 5
});
var base32upper3 = rfc46483({
  prefix: "B",
  name: "base32upper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  bitsPerChar: 5
});
var base32pad3 = rfc46483({
  prefix: "c",
  name: "base32pad",
  alphabet: "abcdefghijklmnopqrstuvwxyz234567=",
  bitsPerChar: 5
});
var base32padupper3 = rfc46483({
  prefix: "C",
  name: "base32padupper",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=",
  bitsPerChar: 5
});
var base32hex3 = rfc46483({
  prefix: "v",
  name: "base32hex",
  alphabet: "0123456789abcdefghijklmnopqrstuv",
  bitsPerChar: 5
});
var base32hexupper3 = rfc46483({
  prefix: "V",
  name: "base32hexupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV",
  bitsPerChar: 5
});
var base32hexpad3 = rfc46483({
  prefix: "t",
  name: "base32hexpad",
  alphabet: "0123456789abcdefghijklmnopqrstuv=",
  bitsPerChar: 5
});
var base32hexpadupper3 = rfc46483({
  prefix: "T",
  name: "base32hexpadupper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUV=",
  bitsPerChar: 5
});
var base32z3 = rfc46483({
  prefix: "h",
  name: "base32z",
  alphabet: "ybndrfg8ejkmcpqxot1uwisza345h769",
  bitsPerChar: 5
});
var base363 = baseX3({
  prefix: "k",
  name: "base36",
  alphabet: "0123456789abcdefghijklmnopqrstuvwxyz"
});
var base36upper3 = baseX3({
  prefix: "K",
  name: "base36upper",
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
});
var base58btc3 = baseX3({
  name: "base58btc",
  prefix: "z",
  alphabet: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
});
var base58flickr3 = baseX3({
  name: "base58flickr",
  prefix: "Z",
  alphabet: "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
});
var encode_13 = encode22;
var MSB3 = 128;
var REST3 = 127;
var MSBALL3 = ~REST3;
var INT3 = Math.pow(2, 31);
function encode22(num, out, offset) {
  out = out || [];
  offset = offset || 0;
  var oldOffset = offset;
  while (num >= INT3) {
    out[offset++] = num & 255 | MSB3;
    num /= 128;
  }
  while (num & MSBALL3) {
    out[offset++] = num & 255 | MSB3;
    num >>>= 7;
  }
  out[offset] = num | 0;
  encode22.bytes = offset - oldOffset + 1;
  return out;
}
var decode22 = read3;
var MSB$13 = 128;
var REST$13 = 127;
function read3(buf, offset) {
  var res = 0, offset = offset || 0, shift = 0, counter = offset, b, l = buf.length;
  do {
    if (counter >= l) {
      read3.bytes = 0;
      throw new RangeError("Could not decode varint");
    }
    b = buf[counter++];
    res += shift < 28 ? (b & REST$13) << shift : (b & REST$13) * Math.pow(2, shift);
    shift += 7;
  } while (b >= MSB$13);
  read3.bytes = counter - offset;
  return res;
}
var N13 = Math.pow(2, 7);
var N23 = Math.pow(2, 14);
var N33 = Math.pow(2, 21);
var N43 = Math.pow(2, 28);
var N53 = Math.pow(2, 35);
var N63 = Math.pow(2, 42);
var N73 = Math.pow(2, 49);
var N83 = Math.pow(2, 56);
var N93 = Math.pow(2, 63);
var length3 = function(value) {
  return value < N13 ? 1 : value < N23 ? 2 : value < N33 ? 3 : value < N43 ? 4 : value < N53 ? 5 : value < N63 ? 6 : value < N73 ? 7 : value < N83 ? 8 : value < N93 ? 9 : 10;
};
var varint3 = {
  encode: encode_13,
  decode: decode22,
  encodingLength: length3
};
var _brrp_varint3 = varint3;
var varint_default3 = _brrp_varint3;
function decode32(data, offset = 0) {
  const code22 = varint_default3.decode(data, offset);
  return [code22, varint_default3.decode.bytes];
}
function encodeTo3(int, target, offset = 0) {
  varint_default3.encode(int, target, offset);
  return target;
}
function encodingLength3(int) {
  return varint_default3.encodingLength(int);
}
function create3(code22, digest) {
  const size = digest.byteLength;
  const sizeOffset = encodingLength3(code22);
  const digestOffset = sizeOffset + encodingLength3(size);
  const bytes = new Uint8Array(digestOffset + size);
  encodeTo3(code22, bytes, 0);
  encodeTo3(size, bytes, sizeOffset);
  bytes.set(digest, digestOffset);
  return new Digest3(code22, size, digest, bytes);
}
function decode42(multihash) {
  const bytes = coerce5(multihash);
  const [code22, sizeOffset] = decode32(bytes);
  const [size, digestOffset] = decode32(bytes.subarray(sizeOffset));
  const digest = bytes.subarray(sizeOffset + digestOffset);
  if (digest.byteLength !== size) {
    throw new Error("Incorrect length");
  }
  return new Digest3(code22, size, digest, bytes);
}
function equals22(a, b) {
  if (a === b) {
    return true;
  } else {
    const data = b;
    return a.code === data.code && a.size === data.size && data.bytes instanceof Uint8Array && equals5(a.bytes, data.bytes);
  }
}
var Digest3 = class {
  code;
  size;
  digest;
  bytes;
  /**
   * Creates a multihash digest.
   */
  constructor(code22, size, digest, bytes) {
    this.code = code22;
    this.size = size;
    this.digest = digest;
    this.bytes = bytes;
  }
};
function format3(link2, base22) {
  const { bytes, version: version2 } = link2;
  switch (version2) {
    case 0:
      return toStringV03(bytes, baseCache3(link2), base22 ?? base58btc3.encoder);
    default:
      return toStringV13(bytes, baseCache3(link2), base22 ?? base323.encoder);
  }
}
var cache3 = /* @__PURE__ */ new WeakMap();
function baseCache3(cid) {
  const baseCache22 = cache3.get(cid);
  if (baseCache22 == null) {
    const baseCache32 = /* @__PURE__ */ new Map();
    cache3.set(cid, baseCache32);
    return baseCache32;
  }
  return baseCache22;
}
var CID3 = class _CID3 {
  code;
  version;
  multihash;
  bytes;
  "/";
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param multihash - (Multi)hash of the of the content.
   */
  constructor(version2, code22, multihash, bytes) {
    this.code = code22;
    this.version = version2;
    this.multihash = multihash;
    this.bytes = bytes;
    this["/"] = bytes;
  }
  /**
   * Signalling `cid.asCID === cid` has been replaced with `cid['/'] === cid.bytes`
   * please either use `CID.asCID(cid)` or switch to new signalling mechanism
   *
   * @deprecated
   */
  get asCID() {
    return this;
  }
  // ArrayBufferView
  get byteOffset() {
    return this.bytes.byteOffset;
  }
  // ArrayBufferView
  get byteLength() {
    return this.bytes.byteLength;
  }
  toV0() {
    switch (this.version) {
      case 0: {
        return this;
      }
      case 1: {
        const { code: code22, multihash } = this;
        if (code22 !== DAG_PB_CODE3) {
          throw new Error("Cannot convert a non dag-pb CID to CIDv0");
        }
        if (multihash.code !== SHA_256_CODE3) {
          throw new Error("Cannot convert non sha2-256 multihash CID to CIDv0");
        }
        return _CID3.createV0(multihash);
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 0. This is a bug please report`);
      }
    }
  }
  toV1() {
    switch (this.version) {
      case 0: {
        const { code: code22, digest } = this.multihash;
        const multihash = create3(code22, digest);
        return _CID3.createV1(this.code, multihash);
      }
      case 1: {
        return this;
      }
      default: {
        throw Error(`Can not convert CID version ${this.version} to version 1. This is a bug please report`);
      }
    }
  }
  equals(other) {
    return _CID3.equals(this, other);
  }
  static equals(self, other) {
    const unknown = other;
    return unknown != null && self.code === unknown.code && self.version === unknown.version && equals22(self.multihash, unknown.multihash);
  }
  toString(base22) {
    return format3(this, base22);
  }
  toJSON() {
    return { "/": format3(this) };
  }
  link() {
    return this;
  }
  [Symbol.toStringTag] = "CID";
  // Legacy
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return `CID(${this.toString()})`;
  }
  /**
   * Takes any input `value` and returns a `CID` instance if it was
   * a `CID` otherwise returns `null`. If `value` is instanceof `CID`
   * it will return value back. If `value` is not instance of this CID
   * class, but is compatible CID it will return new instance of this
   * `CID` class. Otherwise returns null.
   *
   * This allows two different incompatible versions of CID library to
   * co-exist and interop as long as binary interface is compatible.
   */
  static asCID(input) {
    if (input == null) {
      return null;
    }
    const value = input;
    if (value instanceof _CID3) {
      return value;
    } else if (value["/"] != null && value["/"] === value.bytes || value.asCID === value) {
      const { version: version2, code: code22, multihash, bytes } = value;
      return new _CID3(version2, code22, multihash, bytes ?? encodeCID3(version2, code22, multihash.bytes));
    } else if (value[cidSymbol3] === true) {
      const { version: version2, multihash, code: code22 } = value;
      const digest = decode42(multihash);
      return _CID3.create(version2, code22, digest);
    } else {
      return null;
    }
  }
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param digest - (Multi)hash of the of the content.
   */
  static create(version2, code22, digest) {
    if (typeof code22 !== "number") {
      throw new Error("String codecs are no longer supported");
    }
    if (!(digest.bytes instanceof Uint8Array)) {
      throw new Error("Invalid digest");
    }
    switch (version2) {
      case 0: {
        if (code22 !== DAG_PB_CODE3) {
          throw new Error(`Version 0 CID must use dag-pb (code: ${DAG_PB_CODE3}) block encoding`);
        } else {
          return new _CID3(version2, code22, digest, digest.bytes);
        }
      }
      case 1: {
        const bytes = encodeCID3(version2, code22, digest.bytes);
        return new _CID3(version2, code22, digest, bytes);
      }
      default: {
        throw new Error("Invalid version");
      }
    }
  }
  /**
   * Simplified version of `create` for CIDv0.
   */
  static createV0(digest) {
    return _CID3.create(0, DAG_PB_CODE3, digest);
  }
  /**
   * Simplified version of `create` for CIDv1.
   *
   * @param code - Content encoding format code.
   * @param digest - Multihash of the content.
   */
  static createV1(code22, digest) {
    return _CID3.create(1, code22, digest);
  }
  /**
   * Decoded a CID from its binary representation. The byte array must contain
   * only the CID with no additional bytes.
   *
   * An error will be thrown if the bytes provided do not contain a valid
   * binary representation of a CID.
   */
  static decode(bytes) {
    const [cid, remainder] = _CID3.decodeFirst(bytes);
    if (remainder.length !== 0) {
      throw new Error("Incorrect length");
    }
    return cid;
  }
  /**
   * Decoded a CID from its binary representation at the beginning of a byte
   * array.
   *
   * Returns an array with the first element containing the CID and the second
   * element containing the remainder of the original byte array. The remainder
   * will be a zero-length byte array if the provided bytes only contained a
   * binary CID representation.
   */
  static decodeFirst(bytes) {
    const specs = _CID3.inspectBytes(bytes);
    const prefixSize = specs.size - specs.multihashSize;
    const multihashBytes = coerce5(bytes.subarray(prefixSize, prefixSize + specs.multihashSize));
    if (multihashBytes.byteLength !== specs.multihashSize) {
      throw new Error("Incorrect length");
    }
    const digestBytes = multihashBytes.subarray(specs.multihashSize - specs.digestSize);
    const digest = new Digest3(specs.multihashCode, specs.digestSize, digestBytes, multihashBytes);
    const cid = specs.version === 0 ? _CID3.createV0(digest) : _CID3.createV1(specs.codec, digest);
    return [cid, bytes.subarray(specs.size)];
  }
  /**
   * Inspect the initial bytes of a CID to determine its properties.
   *
   * Involves decoding up to 4 varints. Typically this will require only 4 to 6
   * bytes but for larger multicodec code values and larger multihash digest
   * lengths these varints can be quite large. It is recommended that at least
   * 10 bytes be made available in the `initialBytes` argument for a complete
   * inspection.
   */
  static inspectBytes(initialBytes) {
    let offset = 0;
    const next = () => {
      const [i, length22] = decode32(initialBytes.subarray(offset));
      offset += length22;
      return i;
    };
    let version2 = next();
    let codec = DAG_PB_CODE3;
    if (version2 === 18) {
      version2 = 0;
      offset = 0;
    } else {
      codec = next();
    }
    if (version2 !== 0 && version2 !== 1) {
      throw new RangeError(`Invalid CID version ${version2}`);
    }
    const prefixSize = offset;
    const multihashCode = next();
    const digestSize = next();
    const size = offset + digestSize;
    const multihashSize = size - prefixSize;
    return { version: version2, codec, multihashCode, digestSize, multihashSize, size };
  }
  /**
   * Takes cid in a string representation and creates an instance. If `base`
   * decoder is not provided will use a default from the configuration. It will
   * throw an error if encoding of the CID is not compatible with supplied (or
   * a default decoder).
   */
  static parse(source, base22) {
    const [prefix, bytes] = parseCIDtoBytes3(source, base22);
    const cid = _CID3.decode(bytes);
    if (cid.version === 0 && source[0] !== "Q") {
      throw Error("Version 0 CID string must not include multibase prefix");
    }
    baseCache3(cid).set(prefix, source);
    return cid;
  }
};
function parseCIDtoBytes3(source, base22) {
  switch (source[0]) {
    // CIDv0 is parsed differently
    case "Q": {
      const decoder = base22 ?? base58btc3;
      return [
        base58btc3.prefix,
        decoder.decode(`${base58btc3.prefix}${source}`)
      ];
    }
    case base58btc3.prefix: {
      const decoder = base22 ?? base58btc3;
      return [base58btc3.prefix, decoder.decode(source)];
    }
    case base323.prefix: {
      const decoder = base22 ?? base323;
      return [base323.prefix, decoder.decode(source)];
    }
    case base363.prefix: {
      const decoder = base22 ?? base363;
      return [base363.prefix, decoder.decode(source)];
    }
    default: {
      if (base22 == null) {
        throw Error("To parse non base32, base36 or base58btc encoded CID multibase decoder must be provided");
      }
      return [source[0], base22.decode(source)];
    }
  }
}
function toStringV03(bytes, cache22, base22) {
  const { prefix } = base22;
  if (prefix !== base58btc3.prefix) {
    throw Error(`Cannot string encode V0 in ${base22.name} encoding`);
  }
  const cid = cache22.get(prefix);
  if (cid == null) {
    const cid2 = base22.encode(bytes).slice(1);
    cache22.set(prefix, cid2);
    return cid2;
  } else {
    return cid;
  }
}
function toStringV13(bytes, cache22, base22) {
  const { prefix } = base22;
  const cid = cache22.get(prefix);
  if (cid == null) {
    const cid2 = base22.encode(bytes);
    cache22.set(prefix, cid2);
    return cid2;
  } else {
    return cid;
  }
}
var DAG_PB_CODE3 = 112;
var SHA_256_CODE3 = 18;
function encodeCID3(version2, code22, multihash) {
  const codeOffset = encodingLength3(version2);
  const hashOffset = codeOffset + encodingLength3(code22);
  const bytes = new Uint8Array(hashOffset + multihash.byteLength);
  encodeTo3(version2, bytes, 0);
  encodeTo3(code22, bytes, codeOffset);
  bytes.set(multihash, hashOffset);
  return bytes;
}
var cidSymbol3 = /* @__PURE__ */ Symbol.for("@ipld/js-cid/CID");
var code2 = 85;
var SHA256_CODE2 = 18;
function isCanonicalRawCid2(cidString) {
  let cid;
  try {
    cid = CID3.parse(cidString);
  } catch {
    return false;
  }
  return cid.version === 1 && cid.code === code2 && cid.multihash.code === SHA256_CODE2 && cid.toString() === cidString;
}
var base642 = rfc46483({
  prefix: "m",
  name: "base64",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  bitsPerChar: 6
});
var base64pad2 = rfc46483({
  prefix: "M",
  name: "base64pad",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
  bitsPerChar: 6
});
var base64url2 = rfc46483({
  prefix: "u",
  name: "base64url",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  bitsPerChar: 6
});
var base64urlpad2 = rfc46483({
  prefix: "U",
  name: "base64urlpad",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=",
  bitsPerChar: 6
});
function fromBase64Url2(text) {
  const bytes = base64url2.baseDecode(text);
  if (base64url2.baseEncode(bytes) !== text) {
    throw new TypeError("non-canonical base64url input");
  }
  return bytes;
}
function utf8Bytes2(text) {
  return new TextEncoder().encode(text);
}
var ED25519_MULTICODEC_PREFIX2 = Uint8Array.of(237, 1);
function decodeBase64UrlOrNull2(value) {
  try {
    return fromBase64Url2(value);
  } catch {
    return null;
  }
}
var base64UrlString2 = () => external_exports2.string().refine((value) => decodeBase64UrlOrNull2(value) !== null, {
  message: "expected strictly-decodable unpadded base64url"
});
function isCanonicalHttpsOrigin2(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.origin === value;
}
var sessionJwkCommonFields2 = {
  alg: external_exports2.string().min(1).optional(),
  use: external_exports2.string().min(1).optional(),
  key_ops: external_exports2.array(external_exports2.string().min(1)).optional(),
  kid: external_exports2.string().min(1).optional(),
  ext: external_exports2.boolean().optional()
};
var okpPrivateJwkSchema2 = external_exports2.object({
  kty: external_exports2.literal("OKP"),
  crv: external_exports2.string().min(1),
  x: base64UrlString2(),
  d: base64UrlString2(),
  ...sessionJwkCommonFields2
}).strict();
var ecPrivateJwkSchema2 = external_exports2.object({
  kty: external_exports2.literal("EC"),
  crv: external_exports2.string().min(1),
  x: base64UrlString2(),
  y: base64UrlString2(),
  d: base64UrlString2(),
  ...sessionJwkCommonFields2
}).strict();
var sessionJwkSchema2 = external_exports2.discriminatedUnion("kty", [
  okpPrivateJwkSchema2,
  ecPrivateJwkSchema2
]);
var policyTargetSchema2 = external_exports2.object({
  kind: external_exports2.literal("policy"),
  policyCid: external_exports2.string().min(1),
  /** Canonical policy bytes, base64url-encoded (bytes are not JSON). */
  policyBytes: base64UrlString2()
}).strict();
var bearerKeyTargetSchema2 = external_exports2.object({
  kind: external_exports2.literal("bearerKey"),
  sessionJwk: sessionJwkSchema2
}).strict();
var recipientDidTargetSchema2 = external_exports2.object({
  kind: external_exports2.literal("recipientDid"),
  did: external_exports2.string().regex(/^did:[a-z0-9]+:.+$/, "expected a DID")
}).strict();
var authorizationTargetSchema2 = external_exports2.discriminatedUnion("kind", [
  policyTargetSchema2,
  bearerKeyTargetSchema2,
  recipientDidTargetSchema2
]);
function isCanonicalResourcePath2(value) {
  if (value.length === 0) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (/%2f|%5c|%2e/i.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function isCanonicalPathSegment2(value) {
  return isCanonicalResourcePath2(value) && !value.includes("/");
}
var resourceSelectorSchema2 = external_exports2.object({
  kind: external_exports2.union([external_exports2.literal("exact"), external_exports2.literal("prefix")]),
  path: external_exports2.string().min(1)
}).strict().superRefine((selector, ctx) => {
  const body = selector.kind === "prefix" && selector.path.endsWith("/") ? selector.path.slice(0, -1) : selector.path;
  if (!isCanonicalResourcePath2(body)) {
    ctx.addIssue({
      code: external_exports2.ZodIssueCode.custom,
      path: ["path"],
      message: "expected a canonical resource path (non-empty segments, no . or .. segments, no //, no backslash, no %2f/%5c/%2e, no control chars)"
    });
  }
});
var targetSchema2 = external_exports2.object({
  origin: external_exports2.string().refine(isCanonicalHttpsOrigin2, {
    message: "expected a canonical https origin (https://host[:port], nothing else)"
  }),
  nodeAudience: external_exports2.string().min(1),
  spaceId: external_exports2.string().refine(isCanonicalPathSegment2, {
    message: "expected a single canonical path segment (spaceId joins the resource URI; separators/traversal would alias grants)"
  }),
  resource: resourceSelectorSchema2
}).strict();
var displaySchema2 = external_exports2.object({
  senderName: external_exports2.string().optional(),
  filename: external_exports2.string().optional(),
  recipientHint: external_exports2.string().optional(),
  /**
   * Presentation preference only (viewer spec §1): may narrow, never widen;
   * capabilities always win.
   */
  mode: external_exports2.union([external_exports2.literal("document"), external_exports2.literal("source"), external_exports2.literal("folder")]).optional()
}).strict();
var contentPointerSchema2 = external_exports2.object({
  cid: external_exports2.string().refine(isCanonicalRawCid2, {
    message: "expected a canonical CIDv1 raw sha2-256 base32 CID"
  }),
  key: external_exports2.string().refine((value) => decodeBase64UrlOrNull2(value)?.length === 32, {
    message: "expected base64url decoding to exactly 32 bytes"
  })
}).strict();
var signatureSchema2 = external_exports2.object({
  /** did:key of the sender's ed25519 signing key. */
  signerDid: external_exports2.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/, "expected a did:key"),
  algorithm: external_exports2.literal("Ed25519"),
  /** base64url-encoded ed25519 signature over the JCS bytes of all other fields. */
  value: external_exports2.string().refine((value) => decodeBase64UrlOrNull2(value)?.length === 64, {
    message: "expected base64url decoding to exactly 64 bytes"
  })
}).strict();
var unsignedShareEnvelopeSchema2 = external_exports2.object({
  version: external_exports2.literal(1),
  shareId: external_exports2.string().min(1),
  /** Full signed delegation chain, opaque serialized form. */
  delegation: external_exports2.string().min(1),
  authorizationTarget: authorizationTargetSchema2,
  target: targetSchema2,
  display: displaySchema2,
  /** ISO 8601 UTC datetime. Advisory here; enforcement is the delegation's. */
  expiry: external_exports2.string().datetime(),
  /** Bearer-slice sealed-content pointer (see contentPointerSchema). */
  content: contentPointerSchema2.optional()
}).strict();
var shareEnvelopeSchema2 = unsignedShareEnvelopeSchema2.extend({ signature: signatureSchema2 }).strict();
var recipientMatcherSchema2 = external_exports2.discriminatedUnion("kind", [
  external_exports2.object({ kind: external_exports2.literal("exactEmail"), value: external_exports2.string().min(3).regex(/^[^@\s]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/) }).strict(),
  external_exports2.object({ kind: external_exports2.literal("emailDomain"), value: external_exports2.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/) }).strict(),
  external_exports2.object({ kind: external_exports2.literal("recipientDid"), value: external_exports2.string().regex(/^did:[a-z0-9]+:.+$/) }).strict(),
  external_exports2.object({ kind: external_exports2.literal("policyDigest"), value: external_exports2.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  external_exports2.object({ kind: external_exports2.literal("bearer") }).strict()
]);
var shareActionSchema2 = external_exports2.union([external_exports2.literal("read"), external_exports2.literal("list"), external_exports2.literal("edit")]);
var kvContentSourceSchema2 = external_exports2.object({
  kind: external_exports2.literal("kv"),
  space: external_exports2.string().min(1),
  path: external_exports2.string().min(1),
  action: external_exports2.literal("tinycloud.kv/get")
}).strict();
var sqlContentSourceSchema2 = external_exports2.object({
  kind: external_exports2.literal("sql"),
  space: external_exports2.string().min(1),
  database: external_exports2.string().min(1),
  path: external_exports2.string().min(1),
  statement: external_exports2.string().min(1),
  arguments: external_exports2.record(external_exports2.string(), external_exports2.number().int()),
  argumentsDigest: external_exports2.string().regex(/^[A-Za-z0-9_-]{43}$/),
  action: external_exports2.literal("tinycloud.sql/read")
}).strict();
var contentSourceSchema2 = external_exports2.discriminatedUnion("kind", [kvContentSourceSchema2, sqlContentSourceSchema2]);
var v2TargetSchema2 = external_exports2.object({
  origin: external_exports2.string().refine(isCanonicalHttpsOrigin2, { message: "expected a canonical https origin" }),
  nodeAudience: external_exports2.string().min(1),
  spaceId: external_exports2.string().refine(isCanonicalPathSegment2, { message: "expected a canonical space id" })
}).strict();
var shareDecryptionSchema2 = external_exports2.object({
  networkId: external_exports2.string().min(1),
  action: external_exports2.literal("tinycloud.encryption/decrypt")
}).strict();
var ownerAuthoritySchema2 = external_exports2.object({
  registrationCid: external_exports2.string().min(1),
  shareCid: external_exports2.string().min(1),
  envelopeCid: external_exports2.string().min(1),
  enforcementDelegation: external_exports2.record(external_exports2.string(), external_exports2.unknown()),
  outerEnvelope: external_exports2.record(external_exports2.string(), external_exports2.unknown()),
  /** Node-signed registration evidence; required by trusted policy adapters. */
  registrationReceipt: external_exports2.object({
    registration: external_exports2.record(external_exports2.string(), external_exports2.unknown()),
    proof: external_exports2.record(external_exports2.string(), external_exports2.unknown())
  }).strict().optional()
}).strict();
var contentMetadataSchema2 = external_exports2.object({
  mediaType: external_exports2.string().min(1).max(128).optional(),
  byteLength: external_exports2.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  filename: external_exports2.string().min(1).max(255).optional(),
  encoding: external_exports2.literal("utf-8").optional(),
  /** Encrypted presentation discriminator. The fixed entry point is index.html. */
  artifact: external_exports2.literal("html").optional()
}).strict();
var deliveryEmailSchema2 = external_exports2.string().email();
function isEnvelopeDeliveryEmail2(value) {
  return deliveryEmailSchema2.safeParse(value).success;
}
var unsignedShareEnvelopeV2BaseSchema2 = external_exports2.object({
  version: external_exports2.literal(2),
  shareId: external_exports2.string().min(1),
  recipientMatcher: recipientMatcherSchema2,
  deliveryEmail: deliveryEmailSchema2.optional(),
  actions: external_exports2.array(shareActionSchema2).min(1).max(3),
  resource: resourceSelectorSchema2,
  target: v2TargetSchema2,
  delegationCid: external_exports2.string().min(1),
  authorityMaterialHandle: external_exports2.string().min(1),
  authorityMaterialDigest: external_exports2.string().regex(/^[A-Za-z0-9_-]{43}$/),
  decryption: shareDecryptionSchema2.optional(),
  contentSource: contentSourceSchema2,
  contentSourceDigest: external_exports2.string().regex(/^[A-Za-z0-9_-]{43}$/),
  authorizationTarget: authorizationTargetSchema2,
  display: displaySchema2,
  expiry: external_exports2.string().datetime(),
  encrypted: external_exports2.boolean(),
  content: contentPointerSchema2.optional(),
  metadata: contentMetadataSchema2,
  ownerAuthority: ownerAuthoritySchema2.optional()
}).strict();
function validateV2Invariants2(value, ctx) {
  const actions = [...value.actions];
  if (new Set(actions).size !== actions.length) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["actions"], message: "actions must be unique" });
  if (actions.some((action, index) => action !== ["read", "list", "edit"].filter((candidate) => actions.includes(candidate))[index])) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["actions"], message: "actions must be canonically ordered" });
  if (!value.encrypted && value.recipientMatcher.kind !== "policyDigest") ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["recipientMatcher"], message: "safe plaintext must carry only a matcher digest" });
  if (!value.encrypted && value.authorizationTarget.kind !== "policy") ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["encrypted"], message: "unencrypted content requires a policy target" });
  if (!value.encrypted && value.content !== void 0) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["content"], message: "policy-only plaintext cannot carry content" });
  if (value.encrypted && (value.metadata.mediaType === void 0 || value.metadata.filename === void 0 || value.metadata.byteLength === void 0)) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["metadata"], message: "encrypted shares must describe their content" });
  if (!value.encrypted && Object.keys(value.metadata).length !== 0) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["metadata"], message: "policy-only plaintext cannot describe content" });
  if (!value.encrypted && value.metadata.encoding !== void 0) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["metadata", "encoding"], message: "policy-only plaintext cannot carry content encoding" });
  if (value.metadata.artifact === "html" && (!value.encrypted || value.resource.kind !== "prefix" || !value.actions.includes("read") || !value.actions.includes("list"))) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["metadata", "artifact"], message: "html artifacts require an encrypted readable prefix" });
  if (!value.encrypted && (value.display.senderName !== void 0 || value.display.filename !== void 0 || value.display.recipientHint !== void 0)) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["display"], message: "policy-only plaintext cannot carry display metadata" });
  if (!value.encrypted && value.deliveryEmail !== void 0) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["deliveryEmail"], message: "policy-only plaintext cannot carry delivery metadata" });
  if (value.recipientMatcher.kind === "exactEmail" && value.deliveryEmail !== void 0 && value.deliveryEmail !== value.recipientMatcher.value) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["deliveryEmail"], message: "delivery email must match the exact matcher" });
  if (value.recipientMatcher.kind === "emailDomain" && value.deliveryEmail !== void 0 && value.deliveryEmail.toLowerCase().endsWith(`@${value.recipientMatcher.value}`) === false) ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["deliveryEmail"], message: "delivery email must belong to the matcher domain" });
  if (value.contentSource.kind === "kv" && value.contentSource.action !== "tinycloud.kv/get") ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["contentSource"], message: "source action mismatch" });
  if (value.contentSource.kind === "sql" && value.contentSource.action !== "tinycloud.sql/read") ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["contentSource"], message: "source action mismatch" });
}
var unsignedShareEnvelopeV2Schema2 = unsignedShareEnvelopeV2BaseSchema2.superRefine(validateV2Invariants2);
var shareEnvelopeV2Schema2 = unsignedShareEnvelopeV2BaseSchema2.extend({ signature: signatureSchema2 }).strict().superRefine(validateV2Invariants2);
var unifiedResourceSchema2 = external_exports2.string().refine((value) => {
  const marker = value.indexOf("/kv/");
  if (marker < 1) return false;
  const space = value.slice(0, marker);
  const legacy = space.startsWith("tinycloud://");
  if (legacy ? /[:/?#%]/.test(space.slice("tinycloud://".length)) : !space.startsWith("tinycloud:") || /[/?#%]/.test(space)) return false;
  const path = value.slice(marker + 4);
  return !path.startsWith("/") && !path.endsWith("/") && !path.includes("//") && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, { message: "expected canonical TinyCloud KV resource" });
var unifiedEncryptionNetworkSchema2 = external_exports2.string().refine((value) => {
  if (!value.startsWith("urn:tinycloud:encryption:")) return false;
  const rest = value.slice("urn:tinycloud:encryption:".length);
  const separator = rest.lastIndexOf(":");
  const owner = separator < 0 ? "" : rest.slice(0, separator);
  const network = separator < 0 ? "" : rest.slice(separator + 1);
  return owner.startsWith("did:") && owner.length > 4 && network.length > 0 && !/[:/%?#\s]/.test(network);
}, { message: "expected canonical TinyCloud encryption network" });
var unifiedKvCapabilitySchema2 = external_exports2.object({
  kind: external_exports2.literal("kv"),
  resource: unifiedResourceSchema2,
  selector: external_exports2.union([external_exports2.literal("exact"), external_exports2.literal("prefix")]),
  actions: external_exports2.array(external_exports2.union([
    external_exports2.literal("tinycloud.kv/get"),
    external_exports2.literal("tinycloud.kv/list"),
    external_exports2.literal("tinycloud.kv/metadata"),
    external_exports2.literal("tinycloud.kv/put")
  ])).min(1)
}).strict();
var unifiedEncryptionCapabilitySchema2 = external_exports2.object({
  kind: external_exports2.literal("encryption"),
  resource: unifiedEncryptionNetworkSchema2,
  action: external_exports2.literal("tinycloud.encryption/decrypt")
}).strict();
var unifiedCapabilitySchema2 = external_exports2.union([unifiedKvCapabilitySchema2, unifiedEncryptionCapabilitySchema2]);
var unifiedContentSourceSchema2 = external_exports2.object({
  shareId: external_exports2.string().min(1),
  kvResource: unifiedResourceSchema2,
  selector: external_exports2.union([external_exports2.literal("exact"), external_exports2.literal("prefix")]),
  encryptionNetwork: unifiedEncryptionNetworkSchema2,
  encryptedSymmetricKeyDigestHex: external_exports2.string().regex(/^[0-9a-f]{64}$/),
  keyVersion: external_exports2.number().int().positive(),
  mode: external_exports2.union([external_exports2.literal("mutable"), external_exports2.literal("immutable")]),
  initialCiphertextDigestHex: external_exports2.string().regex(/^[0-9a-f]{64}$/).optional()
}).strict();
var unifiedPolicyV1Schema2 = external_exports2.object({
  schema: external_exports2.literal("xyz.tinycloud.policy/policy/v1"),
  policyId: external_exports2.string().regex(/^pol_[a-z2-7]+$/),
  ownerDid: external_exports2.string().min(1),
  createdAt: external_exports2.string().datetime({ offset: true }),
  expiresAt: external_exports2.string().datetime({ offset: true }).optional(),
  contentSource: unifiedContentSourceSchema2,
  capabilityCeiling: external_exports2.array(unifiedCapabilitySchema2).min(2),
  signature: external_exports2.object({ suite: external_exports2.string().min(1), signerDid: external_exports2.string().min(1), value: external_exports2.string().min(1) }).strict()
}).strict();
var policyCredentialRequirementV1Schema2 = external_exports2.object({
  type: external_exports2.literal("TinyCloudPolicyCredentialRequirement"),
  version: external_exports2.literal(1),
  requirementDigest: external_exports2.string().regex(/^[A-Za-z0-9_-]{43}$/),
  descriptorDigest: external_exports2.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuerDid: external_exports2.string().min(1),
  issuerKid: external_exports2.string().min(1),
  profile: external_exports2.object({ id: external_exports2.string().min(1), version: external_exports2.literal(1) }).strict(),
  credentialType: external_exports2.object({ id: external_exports2.string().min(1), version: external_exports2.literal(1) }).strict()
}).strict();
var unifiedPolicyV2Schema2 = external_exports2.object({
  schema: external_exports2.literal("xyz.tinycloud.policy/policy/v2"),
  policyId: external_exports2.string().regex(/^pol_[a-z2-7]+$/),
  ownerDid: external_exports2.string().min(1),
  createdAt: external_exports2.string().datetime({ offset: true }),
  expiresAt: external_exports2.string().datetime({ offset: true }).optional(),
  contentSource: unifiedContentSourceSchema2,
  capabilityCeiling: external_exports2.array(unifiedCapabilitySchema2).min(2),
  credentialRequirement: policyCredentialRequirementV1Schema2,
  signature: external_exports2.object({ suite: external_exports2.literal("Ed25519"), signerDid: external_exports2.string().min(1), value: external_exports2.string().min(1) }).strict()
}).strict();
var unifiedPolicySchema2 = external_exports2.discriminatedUnion("schema", [
  unifiedPolicyV1Schema2,
  unifiedPolicyV2Schema2
]);
var unifiedRootSchema2 = external_exports2.object({
  cid: external_exports2.string().min(1),
  authorization: external_exports2.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  role: external_exports2.union([external_exports2.literal("policy-authority"), external_exports2.literal("policy-enforcement")])
}).strict();
var attestedEnforcerBindingV2Schema2 = external_exports2.object({
  schema: external_exports2.literal("xyz.tinycloud.policy/attested-enforcer/v2"),
  enforcerDid: external_exports2.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/),
  nodeAudience: external_exports2.string().min(1),
  attestationBindingDigestHex: external_exports2.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: external_exports2.string().datetime({ offset: true }),
  expiresAt: external_exports2.string().datetime({ offset: true }),
  signature: external_exports2.object({ suite: external_exports2.literal("Ed25519"), signerDid: external_exports2.string().min(1), value: base64UrlString2() }).strict()
}).strict();
var v3TargetSchema2 = external_exports2.object({
  origin: external_exports2.string().refine(isCanonicalHttpsOrigin2, { message: "expected a canonical https origin" }),
  nodeAudience: external_exports2.string().min(1),
  spaceId: external_exports2.string().refine(isCanonicalPathSegment2, { message: "expected a canonical space id" })
}).strict();
var unsignedShareEnvelopeV3BaseSchema2 = external_exports2.object({
  version: external_exports2.literal(3),
  shareId: external_exports2.string().min(1),
  recipientMatcher: recipientMatcherSchema2,
  deliveryEmail: deliveryEmailSchema2.optional(),
  actions: external_exports2.array(shareActionSchema2).min(1).max(3),
  resource: resourceSelectorSchema2,
  target: v3TargetSchema2,
  policy: unifiedPolicySchema2,
  policyCid: external_exports2.string().min(1),
  policyRoot: unifiedRootSchema2,
  enforcementRoot: unifiedRootSchema2,
  attestedEnforcerBinding: attestedEnforcerBindingV2Schema2,
  contentSource: unifiedContentSourceSchema2,
  contentSourceDigestHex: external_exports2.string().regex(/^[0-9a-f]{64}$/),
  encryptionNetwork: unifiedEncryptionNetworkSchema2,
  expiry: external_exports2.string().datetime({ offset: true }),
  display: displaySchema2,
  encrypted: external_exports2.literal(true),
  metadata: contentMetadataSchema2
}).strict();
function validateV3Invariants2(value, ctx) {
  const actions = [...value.actions];
  if (new Set(actions).size !== actions.length || actions.some((action, index) => action !== ["read", "list", "edit"].filter((candidate) => actions.includes(candidate))[index])) {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["actions"], message: "actions must be unique and canonically ordered" });
  }
  if (value.policyRoot.role !== "policy-authority" || value.enforcementRoot.role !== "policy-enforcement") {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["policyRoot", "role"], message: "root roles are fixed" });
  }
  if (value.policyCid.length === 0 || value.policyCid === value.policyRoot.cid || value.policyCid === value.enforcementRoot.cid) {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["policyCid"], message: "policy CID must be distinct from both roots" });
  }
  if (value.contentSource.encryptionNetwork !== value.encryptionNetwork) {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["encryptionNetwork"], message: "encryption network is not bound to the source" });
  }
  if (value.attestedEnforcerBinding.nodeAudience !== value.target.nodeAudience || value.attestedEnforcerBinding.signature.signerDid !== value.attestedEnforcerBinding.nodeAudience || Date.parse(value.attestedEnforcerBinding.expiresAt) < Date.parse(value.expiry)) {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["attestedEnforcerBinding"], message: "enforcer binding does not cover the target and share lifetime" });
  }
  if (value.policy.contentSource.shareId !== value.contentSource.shareId || value.policy.contentSource.kvResource !== value.contentSource.kvResource || value.policy.contentSource.selector !== value.contentSource.selector || value.policy.contentSource.encryptionNetwork !== value.encryptionNetwork || value.policy.contentSource.encryptedSymmetricKeyDigestHex !== value.contentSource.encryptedSymmetricKeyDigestHex || value.policy.contentSource.keyVersion !== value.contentSource.keyVersion || value.policy.contentSource.mode !== value.contentSource.mode || value.policy.contentSource.initialCiphertextDigestHex !== value.contentSource.initialCiphertextDigestHex) {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["contentSource"], message: "content source is not bound to policy" });
  }
  if (value.policy.signature.suite !== "Ed25519" || value.policy.signature.signerDid !== value.policy.ownerDid) {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["policy", "signature"], message: "policy must be signed by its owner" });
  }
  const kvCapabilities = value.policy.capabilityCeiling.filter((capability) => capability.kind === "kv");
  const decryptCapabilities = value.policy.capabilityCeiling.filter((capability) => capability.kind === "encryption" && capability.resource === value.encryptionNetwork && capability.action === "tinycloud.encryption/decrypt");
  if (value.policy.capabilityCeiling.length !== 2 || kvCapabilities.length !== 1 || decryptCapabilities.length !== 1 || kvCapabilities[0]?.resource !== value.contentSource.kvResource || kvCapabilities[0]?.selector !== value.contentSource.selector) {
    ctx.addIssue({ code: external_exports2.ZodIssueCode.custom, path: ["policy", "capabilityCeiling"], message: "policy ceiling must contain exact decrypt network" });
  }
}
var unsignedShareEnvelopeV3Schema2 = unsignedShareEnvelopeV3BaseSchema2.superRefine(validateV3Invariants2);
var shareEnvelopeV3Schema2 = unsignedShareEnvelopeV3BaseSchema2.extend({ signature: signatureSchema2 }).strict().superRefine(validateV3Invariants2);
var ENVELOPE_AAD_LABEL2 = "tinycloud-share-envelope-v1";
var AAD2 = utf8Bytes2(ENVELOPE_AAD_LABEL2);
function isPlainRecord2(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function assertNoLoneSurrogates2(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 56320 && unit <= 57343) {
      throw new TypeError(
        `cannot canonicalize string with unpaired low surrogate at index ${i}`
      );
    }
    if (unit >= 55296 && unit <= 56319) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 56320 && next <= 57343)) {
        throw new TypeError(
          `cannot canonicalize string with unpaired high surrogate at index ${i}`
        );
      }
      i++;
    }
  }
}
function serializeString2(text) {
  assertNoLoneSurrogates2(text);
  return JSON.stringify(text);
}
function serialize2(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return JSON.stringify(value);
    case "string":
      return serializeString2(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize2(item)).join(",")}]`;
  }
  if (!isPlainRecord2(value)) {
    throw new TypeError("cannot canonicalize non-plain object");
  }
  const keys = Object.keys(value).sort();
  const members = [];
  for (const key of keys) {
    const member = value[key];
    if (member === void 0) continue;
    members.push(`${serializeString2(key)}:${serialize2(member)}`);
  }
  return `{${members.join(",")}}`;
}
function canonicalize2(value) {
  return serialize2(value);
}
var LABEL2 = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function isCanonicalEmailDomain2(value) {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL2.test(label)) && !/^[0-9]+$/.test(labels.at(-1));
}
function canonicalMailbox2(value) {
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return void 0;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9#$&'*+/=?^_`{|}~-]+(?:\.[a-z0-9#$&'*+/=?^_`{|}~-]+)*$/.test(local) || !isCanonicalEmailDomain2(domain)) return void 0;
  return Object.freeze({ email, domain });
}
var MAX_INLINE_BYTES2 = 256 * 1024;

// src/commands/share.ts
import { ProfileLockTimeoutError as ProfileLockTimeoutError2 } from "@tinycloud/operations/state";

// src/lib/duration.ts
function parseDuration(input) {
  const match = input.match(/^(\d+)(m|h|d|w)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers = {
      m: 60 * 1e3,
      h: 60 * 60 * 1e3,
      d: 24 * 60 * 60 * 1e3,
      w: 7 * 24 * 60 * 60 * 1e3
    };
    return value * multipliers[unit];
  }
  const date = new Date(input);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    if (ms <= 0) {
      throw new Error(`Expiry date "${input}" is in the past`);
    }
    return ms;
  }
  throw new Error(`Invalid duration: "${input}". Use format like "1h", "7d", or an ISO date.`);
}

// src/commands/share.ts
init_formatter();
init_errors();

// src/share/output.ts
function writeJson2(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
function authorizationRequiredJson(result) {
  return {
    state: "authorization-required",
    method: result.method,
    next: "complete authorization through the configured authority adapter, then retry with the required proof"
  };
}
function publishHuman(result) {
  process.stdout.write(`${result.url}
`);
}
function inspectHuman(result) {
  const metadata = result.metadata;
  process.stdout.write([
    `Share ${metadata.shareId}`,
    `File: ${metadata.display.filename ?? "unnamed"}`,
    `Target: ${metadata.target.kind === "bearer" ? "bearer (anyone with the complete link can read)" : metadata.target.kind}`,
    `Expires: ${metadata.expiresAt}`,
    `Resource: ${metadata.resource.path}`,
    `Link format: ${result.link.kind}`
  ].join("\n") + "\n");
}
function receiveHuman(path) {
  process.stdout.write(`${path}
`);
}
function receiveJson(result, path) {
  writeJson2({ protocol: "tinycloud-share", version: 1, path, metadata: result.metadata });
}

// src/share/io.ts
import { constants } from "fs";
import { lstat as lstat2, mkdir as mkdir2, mkdtemp, open as open2, readFile as readFile2, realpath, stat as stat2, link, rename as rename2, rm as rm3, unlink } from "fs/promises";
import { randomBytes as randomBytes2 } from "crypto";
import { basename as basename2, join as join4, resolve, sep } from "path";
init_errors();
var MAX_SHARE_STDIN_BYTES = 100 * 1024 * 1024;
var MAX_SHARE_URL_BYTES = 64 * 1024;
async function readBoundedStdin(limit = MAX_SHARE_STDIN_BYTES) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("MAX_BYTES_EXCEEDED");
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.byteLength;
    if (total > limit) throw new Error("MAX_BYTES_EXCEEDED");
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}
async function readBoundedUrlStdin() {
  const bytes = await readBoundedStdin(MAX_SHARE_URL_BYTES);
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (value.length === 0 || /\s/.test(value)) throw new Error("INVALID_ARGUMENT");
  return value;
}
function safeFilename(value) {
  return shareFilename(value);
}
function shareFilename(value) {
  try {
    return canonicalShareFilename(value);
  } catch {
    throw new CLIError(
      "UNSAFE_FILENAME",
      hasUnsafeFilenameCodePoint(value) ? "filename contains control or invisible characters" : "filename must be one safe path segment",
      8
    );
  }
}
function shareInputFilename(input, name) {
  return shareFilename(name ?? (input === "-" ? "stdin.md" : basename2(resolve(input))));
}
async function readShareInput(input, name, limit = MAX_SHARE_STDIN_BYTES) {
  const filename = shareInputFilename(input, name);
  if (input === "-") return { bytes: await readBoundedStdin(limit), filename };
  const path = resolve(input);
  const info = await stat2(path);
  if (!info.isFile() || info.size > limit) throw new Error("MAX_BYTES_EXCEEDED");
  const bytes = new Uint8Array(await readFile2(path));
  if (bytes.byteLength > limit) throw new Error("MAX_BYTES_EXCEEDED");
  return { bytes, filename };
}
async function assertDirectory(path) {
  const absolute = resolve(path);
  const segments = absolute.split(sep).filter(Boolean);
  let current = absolute.startsWith(sep) ? sep : "";
  for (const segment of segments) {
    current = current === sep ? join4(current, segment) : join4(current, segment);
    try {
      const info = await lstat2(current);
      if (info.isSymbolicLink()) {
        const canonical = await realpath(current);
        if (current !== "/tmp" && current !== "/var") throw new Error("OUTPUT_EXISTS");
        if (canonical !== `/private${current}`) throw new Error("OUTPUT_EXISTS");
      } else if (!info.isDirectory()) throw new Error("OUTPUT_EXISTS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir2(current, { mode: 448 });
      const created = await lstat2(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("OUTPUT_EXISTS");
    }
  }
}
async function writeShareOutput(directory, filename, bytes, force) {
  const outputDirectory = resolve(directory);
  await assertDirectory(outputDirectory);
  const safeName = safeFilename(filename);
  const directoryHandle = await open2(outputDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const stableDirectory = await realpath(outputDirectory);
  const outputPath = join4(stableDirectory, safeName);
  const directoryIdentity = await directoryHandle.stat();
  const assertStableDirectory = async () => {
    const current = await stat2(stableDirectory);
    if (current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) throw new Error("OUTPUT_EXISTS");
  };
  await assertStableDirectory();
  const stagingDirectory = await mkdtemp(join4(stableDirectory, ".tinycloud-share-stage-"));
  const stagingInfo = await lstat2(stagingDirectory);
  if (!stagingInfo.isDirectory() || (stagingInfo.mode & 511) !== 448) throw new Error("OUTPUT_EXISTS");
  const stagingPath = join4(stagingDirectory, `.tinycloud-share-${randomBytes2(16).toString("hex")}.tmp`);
  let temporaryPath;
  let handle;
  try {
    await assertStableDirectory();
    try {
      const existing = await lstat2(outputPath);
      if (existing.isSymbolicLink()) throw new Error("UNSAFE_FILENAME");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    temporaryPath = stagingPath;
    handle = await open2(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 384);
    await handle.writeFile(bytes);
    await handle.close();
    handle = void 0;
    await assertStableDirectory();
    if (force) {
      await rename2(temporaryPath, outputPath);
    } else {
      await link(temporaryPath, outputPath);
      await unlink(temporaryPath);
    }
    await assertStableDirectory();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("OUTPUT_EXISTS");
    if (error.code === "ELOOP") throw new Error("UNSAFE_FILENAME");
    throw error;
  } finally {
    await handle?.close();
    try {
      if (temporaryPath !== void 0) await unlink(temporaryPath);
    } catch {
    }
    await rm3(stagingDirectory, { recursive: true, force: true });
    await directoryHandle.close();
  }
  return join4(outputDirectory, safeName);
}

// src/share/errors.ts
var SharePublishAuthorityError = class extends Error {
  constructor(failure) {
    super(failure.kind);
    this.failure = failure;
    this.name = "SharePublishAuthorityError";
  }
};
var ShareHistoryRetryError = class extends Error {
  constructor(profile) {
    super("sender history changed during the operation");
    this.profile = profile;
    this.name = "ShareHistoryRetryError";
  }
  code = "SHARE_HISTORY_RETRY";
};

// src/commands/share.ts
var SHARE_ORIGIN = "https://share.tinycloud.xyz";
var NOTIFY_WINDOW_MESSAGE = "Share notification authorization expired (at share expiry or 5 minutes after publication); publish a new share and invite the recipient then.\n";
var shareServices = {};
function configureShareCommandServices(services) {
  shareServices = services;
}
function parseShareTarget(value) {
  if (value === "anyone" || value === "bearer") return { kind: "bearer" };
  if (value.startsWith("did:")) return { kind: "recipientDid", did: value };
  if (value.startsWith("domain:")) return canonicalMailboxTarget({ kind: "emailDomain", domain: value.slice("domain:".length) });
  if (value.startsWith("email:")) return canonicalMailboxTarget({ kind: "email", address: value.slice("email:".length) });
  if (value.includes("@")) return canonicalMailboxTarget({ kind: "email", address: value });
  throw new CLIError("INVALID_ARGUMENT", "--to must be anyone, a did:, an email address, or domain:example.com", 2);
}
function canonicalMailboxTarget(target) {
  try {
    return normalizeShareTarget(target);
  } catch (error) {
    throw new CLIError("INVALID_ARGUMENT", error instanceof TypeError ? error.message : "share recipient is invalid", 2);
  }
}
function shareCliError(error, operation = "publish") {
  if (error instanceof CLIError) return error;
  if (error instanceof ProfileLockTimeoutError2) return wrapError(error);
  if (error instanceof ShareHistoryRetryError) {
    return new CLIError(
      "SHARE_HISTORY_RETRY",
      `sender history for profile ${JSON.stringify(error.profile)} changed or disappeared during this command`,
      1,
      { hint: `Retry this command with --profile ${JSON.stringify(error.profile)}. If this was a revoke, check its node state first: revocation may already have succeeded.` }
    );
  }
  if (error instanceof SharePublishAuthorityError) {
    const failure = error.failure;
    const profileName = "profileName" in failure ? failure.profileName : void 0;
    const localKey = "localKey" in failure && failure.localKey === true;
    const profileHint = profileName === void 0 ? "" : `--profile ${profileName} `;
    const loginHint = localKey ? `\`tc ${profileHint}auth login --method local\`` : `\`tc ${profileHint}auth login --device --manifest builtin:share-publishing\` (or \`tc ${profileHint}enable share\`)`;
    if (failure.kind === "caveated-session") {
      const holder = profileName === void 0 ? "this session" : `profile ${profileName}'s session`;
      return new CLIError(
        "PERMISSION_DENIED",
        `${holder} carries signed restrictions (caveats) on the authority an anyone-with-link share needs, so it cannot create the share link; nothing was shared. Approve Share publishing without restrictions on a new, dedicated profile (any unused name): \`tc init --name publisher --key-only && tc --profile publisher enable share\``,
        5
      );
    }
    if (failure.kind === "owner-space-unresolved") {
      return new CLIError("AUTH_REQUIRED", `a valid signed TinyCloud session is required; run ${loginHint}`, 3);
    }
    if (failure.kind === "scope-denied") {
      const requiredAction = failure.requiredAction === void 0 ? "" : ` (${failure.requiredAction})`;
      const renew = localKey ? `renew it with ${loginHint} using the required capability` : `verify the session includes the builtin:share-publishing scope; if it does not, request it with ${loginHint}`;
      return new CLIError("PERMISSION_DENIED", `the session lacks ${failure.capability} authority${requiredAction}; ${renew}`, 5);
    }
    if (failure.kind === "lifetime-exceeds-session") {
      const expiresAt = failure.sessionExpiresAt.toISOString();
      if (failure.reason === "session-too-close") {
        return new CLIError("AUTH_REQUIRED", `the signed session expires too soon (${expiresAt}); log in again with ${loginHint}`, 3);
      }
      if (failure.reason === "below-minimum") {
        return new CLIError("SESSION_LIFETIME_EXCEEDED", "share expiry must be at least 60 seconds from now; use a longer --expires value", 2);
      }
      return new CLIError("SESSION_LIFETIME_EXCEEDED", `requested share lifetime exceeds session expiry ${expiresAt}; use a shorter --expires value or renew the session with ${loginHint}`, 2);
    }
    if (failure.kind === "origin-mismatch") {
      return new CLIError("ORIGIN_MISMATCH", "share origin does not match the configured service", 2);
    }
    if (failure.kind === "invalid-request") {
      return new CLIError("INVALID_ARGUMENT", failure.reason, 2);
    }
    if (failure.kind === "registry-unavailable") {
      return new CLIError("UNAVAILABLE", "the TinyCloud location registry could not be reached, so nothing was shared; try again shortly", 4);
    }
    if (failure.kind === "node-info-unavailable") {
      const outcome = operation === "publish" ? "nothing was shared and no invitation was sent" : "no invitation was sent";
      return new CLIError("UNAVAILABLE", `could not verify TinyCloud node 1.17.3 domain delivery support; ${outcome}. Check the node and retry`, 4);
    }
    if (failure.kind === "registry-rejected") {
      return new CLIError("REGISTRY_REJECTED", "the TinyCloud location registry rejected this session's location record, so nothing was shared; retrying will not help. Log in again, and report the problem if it persists", 6);
    }
    if (failure.kind === "storage-quota-exceeded") {
      const sizes = failure.usedBytes === void 0 || failure.limitBytes === void 0 ? "" : ` (${formatBytes(failure.usedBytes)} used of ${formatBytes(failure.limitBytes)} limit)`;
      return new CLIError("STORAGE_QUOTA_EXCEEDED", `storage quota exceeded${sizes}; nothing was shared`, 4);
    }
    if (failure.kind === "upload-failed") {
      return new CLIError("UPLOAD_FAILED", "share source upload failed; nothing was shared", 4);
    }
  }
  if (error instanceof ShareNotifyError) {
    return new CLIError("INVALID_ARGUMENT", error.message, 2);
  }
  if (error instanceof SharePublishError) {
    const exit = error.code === "authority-required" ? 3 : error.code === "max-bytes-exceeded" ? 7 : 2;
    const code3 = error.code === "authority-required" ? "AUTH_REQUIRED" : error.code === "max-bytes-exceeded" ? "MAX_BYTES_EXCEEDED" : "INVALID_ARGUMENT";
    return new CLIError(code3, error.message, exit);
  }
  if (error instanceof ShareReceiveError) {
    const verification = /* @__PURE__ */ new Set(["cid-mismatch", "decrypt-failed", "envelope-invalid", "origin-mismatch", "signature-invalid", "capability-invalid", "content-integrity-failed"]);
    const exit = error.code === "max-bytes-exceeded" ? 7 : verification.has(error.code) ? 5 : error.code === "expired" || error.code === "fetch-failed" ? 4 : error.code === "invalid-link" || error.code === "unsupported-target" ? 2 : 2;
    const code3 = error.code === "fetch-failed" ? "NOT_FOUND" : error.code.replaceAll("-", "_").toUpperCase();
    return new CLIError(code3, error.message, exit);
  }
  const message = error instanceof Error ? error.message : String(error);
  const nodeCode = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
  const known = {
    MAX_BYTES_EXCEEDED: { code: "MAX_BYTES_EXCEEDED", exit: 7 },
    UNSAFE_FILENAME: { code: "UNSAFE_FILENAME", exit: 8 },
    OUTPUT_EXISTS: { code: "OUTPUT_EXISTS", exit: 8 },
    INVALID_ARGUMENT: { code: "INVALID_ARGUMENT", exit: 2 },
    "share not found": { code: "NOT_FOUND", exit: 4 },
    AUTH_REQUIRED: { code: "AUTH_REQUIRED", exit: 3 },
    UNAVAILABLE: { code: "UNAVAILABLE", exit: 4 }
  };
  if (nodeCode === "ENOENT") return new CLIError("INVALID_ARGUMENT", "share input was not found", 2);
  if (nodeCode === "EISDIR") return new CLIError("INVALID_ARGUMENT", "share input must be a Markdown file", 2);
  if (error instanceof TypeError) return new CLIError("INVALID_ARGUMENT", "share input is invalid", 2);
  const mapped = typeof nodeCode === "string" && known[nodeCode] !== void 0 ? known[nodeCode] : known[message];
  return new CLIError(mapped?.code ?? "INVALID_ARGUMENT", mapped ? mapped.code : "share operation failed", mapped?.exit ?? 2);
}
function inputUrl(value, stdin) {
  if (stdin || value === "-") return readBoundedUrlStdin();
  if (value === void 0 || value.length === 0) throw new CLIError("INVALID_ARGUMENT", "a share URL or - is required", 2);
  return Promise.resolve(value);
}
async function inspectShareInputOnce(value, stdin, expectedOrigin, dependencies = {}) {
  const link2 = stdin || value === "-" ? await (dependencies.read ?? readBoundedUrlStdin)() : await inputUrl(value, false);
  try {
    parseNativeShareUrl(link2);
  } catch {
    return (dependencies.inspect ?? inspectShare)(link2, { expectedOrigin });
  }
  throw new CLIError("UNSUPPORTED_LINK", "native bearer links are opaque; receive the link to verify access", 2);
}
function jsonOutput(options, command) {
  return options.json === true || command.optsWithGlobals().json === true;
}
function expires(value) {
  try {
    return new Date(Date.now() + parseDuration(value));
  } catch {
    throw new CLIError("INVALID_ARGUMENT", "invalid expiry duration", 2);
  }
}
async function rememberPublishedShare(result) {
  const record = historyRecordForPublishedShare(result);
  if (shareServices.records === void 0) return { record, recorded: false };
  try {
    await shareServices.records.put(record);
    return { record, recorded: true };
  } catch {
    process.stderr.write("Warning: share was published but not recorded in sender history; future share list, share notify, and share revoke by ID will not find it.\n");
    return { record, recorded: false };
  }
}
async function notifyRecordedShare(record, recipient, adapter, storage) {
  const result = await notifyShare({ shareId: record.shareId, recipient, record, adapter, checkDeliveryWindow: true });
  if (result.state !== "partial-failure" && storage !== void 0) {
    const mailbox = canonicalMailbox2(recipient).email;
    if (!record.deliveredRecipients?.includes(mailbox)) {
      try {
        if (storage.update === void 0) throw new Error("atomic sender history update is unavailable");
        const updated = await storage.update(record.shareId, (current) => ({
          ...current,
          deliveredRecipients: current.deliveredRecipients?.includes(mailbox) ? current.deliveredRecipients : [...current.deliveredRecipients ?? [], mailbox]
        }));
        if (updated === void 0) throw new Error("sender history record was removed");
      } catch {
        process.stderr.write("Warning: delivery succeeded, but could not record its confirmation in sender history.\n");
      }
    }
  }
  return result;
}
function byteLimit(value) {
  if (value === void 0) return void 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_SHARE_STDIN_BYTES) throw new CLIError("MAX_BYTES_EXCEEDED", "max-bytes must be between 1 and 100 MiB", 7);
  return parsed;
}
function mediaTypeFor(filename) {
  const extension = filename.toLowerCase().split(".").at(-1);
  return extension === "md" || extension === "markdown" ? "text/markdown" : extension === "txt" ? "text/plain" : extension === "html" || extension === "htm" ? "text/html" : extension === "json" ? "application/json" : extension === "css" ? "text/css" : extension === "js" ? "text/javascript" : "application/octet-stream";
}
function requestedActions(values) {
  const actions = values === void 0 || values.length === 0 ? ["read"] : values;
  if (actions.some((value) => value !== "read" && value !== "list" && value !== "edit")) throw new CLIError("INVALID_ARGUMENT", "--action must be read, list, or edit", 2);
  return [...new Set(actions)];
}
function assertAggregateInputLimit(inputs, maxBytes) {
  const limit = maxBytes ?? MAX_SHARE_STDIN_BYTES;
  let total = 0;
  for (const input of inputs) {
    total += input.bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > limit) throw new CLIError("MAX_BYTES_EXCEEDED", "combined share input exceeds the configured byte limit", 7);
  }
}
function registerShareCommand(program2) {
  const share = program2.command("share").description("Publish and consume TinyCloud Share links");
  share.command("publish <files...>").description("Publish one or more bounded files as a Share").option("--name <filename>", "Filename for stdin input").option("--to <target>", "Share target", "anyone").option("--notify", "Email an exact-email recipient, or a domain mailbox on node 1.17.3+").option("--notify-to <address>", "Mailbox to invite for --to domain:<name> --notify (node 1.17.3+)").option("--expires <duration>", "Share lifetime").option("--max-bytes <bytes>", "Bound input bytes").option("--media-type <type>", "Media type for a single input").option("--action <actions...>", "Addressed permission: read, list, or edit").option("--prefix", "Publish multiple inputs beneath one addressed prefix").option("--binary", "Allow non-UTF-8 bearer content").option("--json", "Print versioned redacted JSON").option("--viewer-origin <origin>", "Canonical HTTPS viewer origin", SHARE_ORIGIN).action(async (files, options, command) => {
    try {
      const json = jsonOutput(options, command);
      const maxBytes = byteLimit(options.maxBytes);
      if (files.length === 0 || files.includes("-") && files.length > 1) throw new CLIError("INVALID_ARGUMENT", "stdin must be the only publish input", 2);
      const name = files.length === 1 ? options.name : void 0;
      for (const file of files) shareInputFilename(file, name);
      const inputs = await Promise.all(files.map((file) => readShareInput(file, name, maxBytes)));
      assertAggregateInputLimit(inputs, maxBytes);
      const target = parseShareTarget(options.to);
      const actions = requestedActions(options.action);
      if (options.prefix && target.kind === "bearer") throw new CLIError("INVALID_ARGUMENT", "--prefix requires an addressed target", 2);
      if (inputs.length > 1 && target.kind === "bearer") throw new CLIError("UNSUPPORTED_LINK", "multiple files require an addressed target", 2);
      if (inputs.length > 1 && !options.prefix) throw new CLIError("INVALID_ARGUMENT", "multiple files require --prefix", 2);
      if (options.notify === true && !actions.includes("read")) throw new CLIError("INVALID_ARGUMENT", "--notify requires the read action; nothing was shared", 2);
      if (options.notifyTo !== void 0 && (options.notify !== true || target.kind !== "emailDomain")) {
        throw new CLIError("INVALID_ARGUMENT", "--notify-to requires --to domain:<name> --notify", 2);
      }
      let notifyRecipient;
      if (options.notify === true && target.kind === "email") notifyRecipient = target.address;
      else if (options.notify === true && target.kind === "emailDomain") {
        const mailbox = options.notifyTo === void 0 ? void 0 : canonicalMailbox2(options.notifyTo);
        if (mailbox === void 0 || mailbox.domain !== target.domain) {
          throw new CLIError("INVALID_ARGUMENT", "--to domain:<name> --notify requires --notify-to <email> at that exact domain (node 1.17.3+)", 2);
        }
        notifyRecipient = mailbox.email;
      } else if (options.notify === true) {
        throw new CLIError("INVALID_ARGUMENT", "--notify requires an email target, or a domain target with --notify-to on node 1.17.3+", 2);
      }
      const result = await publishTargetShare({
        source: inputs[0].bytes,
        filename: inputs[0].filename,
        files: inputs.map((input) => ({ bytes: input.bytes, filename: input.filename, mediaType: mediaTypeFor(input.filename) })),
        mediaType: options.mediaType ?? mediaTypeFor(inputs[0].filename),
        allowBinary: options.binary === true,
        target,
        resourceKind: options.prefix || inputs.length > 1 ? "prefix" : "exact",
        actions,
        expiresAt: expires(options.expires ?? "7d"),
        expiryWasExplicit: options.expires !== void 0,
        origin: options.viewerOrigin,
        ...maxBytes === void 0 ? {} : { maxBytes },
        notify: options.notify === true,
        targetAdapter: shareServices.targetAdapter
      });
      if ("state" in result) {
        if (json) {
          writeJson2({ protocol: "tinycloud-share", version: 1, authorization: authorizationRequiredJson(result) });
          process.exitCode = 6;
          return;
        }
        throw new CLIError(result.method === "openkey-device" ? "DEVICE_AUTH_REQUIRED" : "CLAIM_REQUIRED", "recipient authorization is required; continue through the configured authority adapter", 6);
      }
      const { record, recorded } = await rememberPublishedShare(result);
      let notification;
      if (notifyRecipient !== void 0) {
        if (shareServices.delivery === void 0) throw new CLIError("AUTH_REQUIRED", "delivery authority is not configured", 3);
        notification = await notifyRecordedShare(record, notifyRecipient, shareServices.delivery, recorded ? shareServices.records : void 0);
        if (notification.state === "partial-failure") process.exitCode = 9;
        if (notification.reason === "delivery-window-expired") process.stderr.write(NOTIFY_WINDOW_MESSAGE);
      }
      if (result.metadata.expiryClamped === true) process.stderr.write(`Share expiry clamped to session expiry (${result.metadata.expiresAt}).
`);
      if (json) writeJson2({ ...redactPublishedShare(result), expiryClamped: result.metadata.expiryClamped === true, ...notification === void 0 ? {} : { notification } });
      else publishHuman(result);
    } catch (error) {
      handleError(shareCliError(error));
    }
  });
  share.command("inspect [url]").description("Verify a share link and print safe metadata").option("--stdin", "Read the complete URL from stdin").option("--json", "Print versioned redacted JSON").option("--viewer-origin <origin>", "Require this canonical Share origin", SHARE_ORIGIN).action(async (url, options, command) => {
    try {
      const json = jsonOutput(options, command);
      const result = await inspectShareInputOnce(url, options.stdin === true, options.viewerOrigin);
      if (json) writeJson2(result);
      else inspectHuman(result);
    } catch (error) {
      handleError(shareCliError(error));
    }
  });
  share.command("receive [url]").description("Verify and receive a share link").option("--stdin", "Read the complete URL from stdin").option("--output <directory>", "Create the file in this directory").option("--stdout", "Write verified plaintext bytes to stdout").option("--force", "Allow replacing an existing non-symlink output").option("--max-bytes <bytes>", "Bound received content bytes").option("--json", "Print versioned redacted JSON").option("--viewer-origin <origin>", "Require this canonical Share origin", SHARE_ORIGIN).action(async (url, options, command) => {
    try {
      const json = jsonOutput(options, command);
      if (options.stdout && json) throw new CLIError("INVALID_ARGUMENT", "--stdout and --json are mutually exclusive", 2);
      const maxBytes = byteLimit(options.maxBytes);
      const link2 = await inputUrl(url, options.stdin === true);
      let nativeLink = false;
      try {
        parseNativeShareUrl(link2);
        nativeLink = true;
      } catch {
      }
      if (nativeLink) {
        if (shareServices.nativeReader === void 0) throw new CLIError("AUTH_REQUIRED", "native TinyCloud receive is not configured", 3);
        const native = await shareServices.nativeReader(link2);
        if (maxBytes !== void 0 && native.bytes.byteLength > maxBytes) throw new CLIError("MAX_BYTES_EXCEEDED", "shared content exceeds max-bytes", 7);
        if (options.stdout) {
          process.stdout.write(Buffer.from(native.bytes));
          return;
        }
        const output2 = await writeShareOutput(options.output ?? ".", native.filename, native.bytes, options.force === true);
        if (json) writeJson2({ protocol: "tinycloud-share", version: 1, path: output2, transport: "native" });
        else receiveHuman(output2);
        return;
      }
      const result = await receiveShare(link2, {
        expectedOrigin: options.viewerOrigin,
        ...maxBytes === void 0 ? {} : { maxContentBlobBytes: maxBytes }
      });
      if ("state" in result) {
        if (json) {
          writeJson2({ protocol: "tinycloud-share", version: 1, authorization: authorizationRequiredJson(result) });
          process.exitCode = 6;
          return;
        }
        throw new CLIError(result.method === "openkey-device" ? "DEVICE_AUTH_REQUIRED" : "CLAIM_REQUIRED", "recipient authorization is required; resume through the configured authority adapter", 6);
      }
      if (options.stdout) {
        process.stdout.write(Buffer.from(result.bytes));
        return;
      }
      const output = await writeShareOutput(options.output ?? ".", result.metadata.display.filename ?? "share.md", result.bytes, options.force === true);
      if (json) receiveJson(result, output);
      else receiveHuman(output);
    } catch (error) {
      handleError(shareCliError(error));
    }
  });
  share.command("list").description("List encrypted sender history without complete bearer URLs").option("--json", "Print versioned redacted JSON").action(async (options, command) => {
    try {
      const json = jsonOutput(options, command);
      if (shareServices.records === void 0) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
      const result = await listShares(shareServices.records);
      if (json) writeJson2({ protocol: "tinycloud-share", version: 1, shares: result });
      else process.stdout.write(result.map((item) => `${item.shareId}	${item.target}	${item.expiresAt}`).join("\n") + (result.length ? "\n" : ""));
    } catch (error) {
      handleError(shareCliError(error));
    }
  });
  share.command("show <id>").description("Show one redacted sender-history record").option("--reveal-link", "Explicitly include the complete link").option("--json", "Print versioned redacted JSON").action(async (id, options, command) => {
    try {
      const json = jsonOutput(options, command);
      if (options.revealLink && json) throw new CLIError("INVALID_ARGUMENT", "--reveal-link cannot be combined with --json", 2);
      if (shareServices.records === void 0) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
      const result = await showShare({ storage: shareServices.records, shareId: id, revealLink: options.revealLink === true, link: options.revealLink ? await shareServices.linkFor?.(id) : void 0 });
      if (json) writeJson2({ protocol: "tinycloud-share", version: 1, share: result });
      else writeJson2(result);
    } catch (error) {
      handleError(shareCliError(error));
    }
  });
  share.command("notify <id>").description("Retry idempotent delivery within 5 minutes of publication; after that publish a new share").requiredOption("--to <address>", "Recipient email").option("--json", "Print versioned JSON").action(async (id, options, command) => {
    try {
      const json = jsonOutput(options, command);
      if (shareServices.delivery === void 0) throw new CLIError("AUTH_REQUIRED", "delivery authority is not configured", 3);
      if (shareServices.records === void 0) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
      const record = await shareServices.records.get(id);
      if (record === void 0) throw new CLIError("NOT_FOUND", "share not found", 4);
      if (!record.actions.includes("tinycloud.kv/get")) {
        throw new CLIError("INVALID_ARGUMENT", "share notify requires a stored share with the read action; no invitation was sent", 2);
      }
      const mailbox = canonicalMailbox2(options.to);
      if (mailbox === void 0) throw new ShareNotifyError("recipient is invalid");
      if (!recipientMatchesShareRecord(record, mailbox.email)) throw new ShareNotifyError("recipient does not match the stored share target");
      if (record.recipientMatcher.kind === "emailDomain" && shareDeliveryWindowExpiresAt(record) > Date.now()) {
        if (shareServices.assertDomainDelivery === void 0) throw new CLIError("UNAVAILABLE", "could not verify TinyCloud node 1.17.3 domain delivery support; no invitation was sent", 4);
        await shareServices.assertDomainDelivery();
      }
      const result = await notifyRecordedShare(record, options.to, shareServices.delivery, shareServices.records);
      if (json) writeJson2(result);
      else process.stdout.write(`${result.state}
`);
      if (result.reason === "delivery-window-expired") process.stderr.write(NOTIFY_WINDOW_MESSAGE);
      if (result.state === "partial-failure") process.exitCode = 9;
    } catch (error) {
      handleError(shareCliError(error, "notify"));
    }
  });
  share.command("revoke <id>").description("Revoke addressed shares; report bearer retention honestly").option("--ancestor", "Revoke the owner delegation ancestry").option("--json", "Print versioned JSON").action(async (id, options, command) => {
    try {
      const json = jsonOutput(options, command);
      if (shareServices.records === void 0) throw new CLIError("AUTH_REQUIRED", "sender history storage is not configured", 3);
      const record = shareServices.getRecord ? await shareServices.getRecord(id) : await shareServices.records.get(id);
      if (record === void 0) throw new CLIError("NOT_FOUND", "share not found", 4);
      const result = await revokeShare({ record, records: shareServices.records, adapter: shareServices.revocation, scope: options.ancestor ? "ancestor" : "direct" });
      if (result.state === "unsupported") {
        throw new CLIError("UNSUPPORTED_TARGET", result.reason, 2);
      }
      if (json) writeJson2({ protocol: "tinycloud-share", version: 1, result });
      else process.stdout.write(`${result.state}
`);
    } catch (error) {
      handleError(shareCliError(error));
    }
  });
}

// src/share/adapters.ts
init_profiles();
init_constants();
import { readFile as readFile4 } from "fs/promises";
import { join as join6 } from "path";
import { createHash } from "crypto";
import { writeJsonAtomic as writeJsonAtomic2 } from "@tinycloud/operations/state";
import { LocationRecordValidationError, LocationRegistryHttpError, revokePolicyRootV3 } from "@tinycloud/sdk-core";
import { extractSiweExpiration, InvalidRestoredSessionError } from "@tinycloud/node-sdk";
function requiredKvAction(meta) {
  if (meta === null || typeof meta !== "object" || !("requiredAction" in meta)) return void 0;
  const action = meta.requiredAction;
  return action === "tinycloud.kv/put" || action === "tinycloud.kv/get" ? action : void 0;
}
function isByteCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function throwKvUploadFailure(error) {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "STORAGE_QUOTA_EXCEEDED") {
    const meta = "meta" in error && typeof error.meta === "object" && error.meta !== null ? error.meta : {};
    const { usedBytes, limitBytes } = meta;
    throw new SharePublishAuthorityError(isByteCount(usedBytes) && isByteCount(limitBytes) ? { kind: "storage-quota-exceeded", usedBytes, limitBytes } : { kind: "storage-quota-exceeded" });
  }
  throw new SharePublishAuthorityError({ kind: "upload-failed" });
}
var DEFAULT_SHARE_ORIGIN = "https://share.tinycloud.xyz";
var MIN_DOMAIN_DELIVERY_VERSION = "1.17.3";
function supportsDomainDelivery(version2) {
  if (typeof version2 !== "string") return false;
  const normalized = version2.trim();
  if (normalized.length > 128) return false;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(normalized);
  if (match === null) return false;
  if (match[4] !== void 0 && /(?:^|\.)0[0-9]+(?:\.|$)/.test(match[4])) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return false;
  if (major !== 1) return major > 1;
  if (minor !== 17) return minor > 17;
  if (patch !== 3) return patch > 3;
  return match[4] === void 0;
}
function displayedNodeVersion(version2) {
  if (typeof version2 !== "string") return "(unrecognized)";
  const trimmed = version2.trim();
  return /^[A-Za-z0-9.+_-]{1,64}$/.test(trimmed) ? trimmed : "(unrecognized)";
}
var URI_SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function safeStorageFilename(filename) {
  if (URI_SAFE_FILENAME.test(filename) && !filename.includes("..")) return filename;
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 && /^[A-Za-z0-9]{1,16}$/.test(filename.slice(dot + 1)) ? filename.slice(dot + 1) : "";
  const stem = (extension === "" ? filename : filename.slice(0, dot)).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(extension === "" ? /[^A-Za-z0-9_-]+/g : /[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/-{2,}/g, "-").slice(0, 100).replace(/^[^A-Za-z0-9]+|[-.]+$/g, "");
  return `${stem === "" ? "share" : stem}${extension === "" ? "" : `.${extension}`}`;
}
function createEncryptedSessionHistory() {
  const records = /* @__PURE__ */ new Map();
  let operation = Promise.resolve();
  const serial = (action) => {
    const next = operation.then(action, action);
    operation = next.then(() => void 0, () => void 0);
    return next;
  };
  let keyPromise;
  const key = async () => keyPromise ??= crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const encode6 = async (record) => {
    const secret = new TextEncoder().encode(JSON.stringify(record));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), secret));
    const value = new Uint8Array(iv.length + encrypted.length);
    value.set(iv);
    value.set(encrypted, iv.length);
    return value;
  };
  const decode10 = async (value) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: value.slice(0, 12) }, await key(), value.slice(12))));
  return {
    async put(record) {
      return serial(async () => {
        records.set(record.shareId, await encode6(record));
      });
    },
    async update(shareId, change) {
      return serial(async () => {
        const value = records.get(shareId);
        if (value === void 0) return void 0;
        const updated = await change(await decode10(value));
        records.set(shareId, await encode6(updated));
        return updated;
      });
    },
    async list() {
      return serial(() => Promise.all([...records.values()].map(decode10)));
    },
    async get(shareId) {
      return serial(async () => {
        const value = records.get(shareId);
        return value === void 0 ? void 0 : decode10(value);
      });
    },
    async delete(shareId) {
      return serial(async () => {
        records.delete(shareId);
      });
    }
  };
}
function createEncryptedProfileHistory(profileName, sessionSigner) {
  const HISTORY_VERSION = 2;
  const identityChanged = new Error("share history profile or key changed");
  const saltChanged = new Error("share history salt changed");
  let operation = Promise.resolve();
  const observedProfiles = /* @__PURE__ */ new Set();
  let preparedKeys;
  let preparedKey;
  const path = async (profile) => join6(await ProfileManager.getCacheDir(profile), "share-history-v2.json");
  const legacyPath = async (profile) => join6(await ProfileManager.getCacheDir(profile), "share-history-v1.bin");
  const b64 = (value) => Buffer.from(value).toString("base64url");
  const unb64 = (value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("share history is unavailable");
    const bytes = new Uint8Array(Buffer.from(value, "base64url"));
    if (b64(bytes) !== value) throw new Error("share history is unavailable");
    return bytes;
  };
  const isStoredRecord = (value) => typeof value === "object" && value !== null && "shareId" in value && typeof value.shareId === "string";
  const identity = async (profile) => {
    const config = await ProfileManager.getProfile(profile);
    const localKey = typeof config.privateKey === "string" && config.privateKey.length > 0;
    const [key, session] = localKey ? [null, null] : await Promise.all([ProfileManager.getKey(profile), ProfileManager.getSession(profile)]);
    const sessionJwk = session !== null && "jwk" in session ? session.jwk : void 0;
    const signerJwk = sessionJwk !== null && typeof sessionJwk === "object" && "d" in sessionJwk && typeof sessionJwk.d === "string" && sessionJwk.d.length > 0 ? sessionJwk : key;
    const method = session !== null && "verificationMethod" in session ? session.verificationMethod ?? config.did : config.did;
    const fingerprint = createHash("sha256").update(JSON.stringify(localKey ? ["local", config.privateKey] : ["openkey", sessionJwk, signerJwk, method])).digest("hex");
    return { config, fingerprint };
  };
  const prepareKeys = async (profile, snapshot) => {
    if (preparedKeys?.profile === profile && preparedKeys.identity === snapshot.fingerprint) return preparedKeys;
    let secret;
    if (typeof snapshot.config.privateKey === "string" && snapshot.config.privateKey.length > 0) {
      secret = new TextEncoder().encode(snapshot.config.privateKey);
    } else {
      if (sessionSigner === void 0) throw new Error("share history requires an initialized profile");
      secret = await sessionSigner(new TextEncoder().encode("xyz.tinycloud.share/history-key/v1"), profile);
    }
    if ((await identity(profile)).fingerprint !== snapshot.fingerprint) throw identityChanged;
    const material = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]);
    const digest = await crypto.subtle.digest("SHA-256", secret);
    const legacyKey = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
    return preparedKeys = { profile, identity: snapshot.fingerprint, material, legacyKey };
  };
  const preparedSalt = async (profile) => {
    try {
      const envelope = JSON.parse(await readFile4(await path(profile), "utf8"));
      if (envelope.version !== HISTORY_VERSION) throw new Error("share history is unavailable");
      const salt = unb64(envelope.kdfSalt);
      if (salt.length < 16) throw new Error("share history is unavailable");
      return salt;
    } catch (error) {
      if (error.code === "ENOENT") return crypto.getRandomValues(new Uint8Array(16));
      throw new Error("share history is unavailable");
    }
  };
  const read4 = async (profile, ready) => {
    try {
      const envelope = JSON.parse(await readFile4(await path(profile), "utf8"));
      if (envelope.version !== HISTORY_VERSION) throw new Error("share history is unavailable");
      if (envelope.kdfSalt !== b64(ready.salt)) throw saltChanged;
      const iv = unb64(envelope.iv);
      const ciphertext = unb64(envelope.ciphertext);
      if (iv.length !== 12 || ciphertext.length <= 16) throw new Error("share history is unavailable");
      const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ready.key, ciphertext);
      const values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return Array.isArray(values) ? values.filter(isStoredRecord) : [];
    } catch (error) {
      if (error === saltChanged) throw error;
      if (error.code !== "ENOENT") throw new Error("share history is unavailable");
      try {
        const legacy = new Uint8Array(await readFile4(await legacyPath(profile)));
        if (legacy.length <= 12) return [];
        const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: legacy.slice(0, 12) }, ready.legacyKey, legacy.slice(12));
        const values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return Array.isArray(values) ? values.filter(isStoredRecord) : [];
      } catch (legacyError) {
        if (legacyError.code === "ENOENT") return [];
        throw new Error("share history is unavailable");
      }
    }
  };
  const write = async (profile, values, ready) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(values));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ready.key, bytes));
    await writeJsonAtomic2(await path(profile), { version: HISTORY_VERSION, kdfSalt: b64(ready.salt), iv: b64(iv), ciphertext: b64(encrypted) });
  };
  const serial = (action) => {
    const next = operation.then(action, action);
    operation = next.then(() => void 0, () => void 0);
    return next;
  };
  const locked = (action, writing = false) => serial(async () => {
    const profile = await profileName();
    let warned = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const snapshot = await identity(profile);
        observedProfiles.add(profile);
        const keys = await prepareKeys(profile, snapshot);
        const salt = await preparedSalt(profile);
        const saltId = b64(salt);
        const key = preparedKey?.profile === profile && preparedKey.identity === snapshot.fingerprint && preparedKey.salt === saltId ? preparedKey.key : await crypto.subtle.deriveKey(
          { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
          keys.material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
        preparedKey = { profile, identity: snapshot.fingerprint, salt: saltId, key };
        const warning = writing ? setTimeout(() => {
          if (!warned) {
            warned = true;
            process.stderr.write(`Waiting for profile lock for ${JSON.stringify(profile)} before updating sender history.
`);
          }
        }, 2e3) : void 0;
        warning?.unref();
        try {
          return await ProfileManager.withLock(profile, async () => {
            clearTimeout(warning);
            if ((await identity(profile)).fingerprint !== snapshot.fingerprint) throw identityChanged;
            return action(profile, { salt, key, legacyKey: keys.legacyKey });
          }, writing ? { timeoutMs: PROFILE_COMMIT_LOCK_TIMEOUT_MS } : void 0);
        } finally {
          clearTimeout(warning);
        }
      } catch (error) {
        if (error === saltChanged || error === identityChanged) continue;
        if (observedProfiles.has(profile) && typeof error === "object" && error !== null && "code" in error && error.code === "PROFILE_NOT_FOUND") {
          throw new ShareHistoryRetryError(profile);
        }
        throw error;
      }
    }
    throw new ShareHistoryRetryError(profile);
  });
  return {
    async put(record) {
      return locked(async (profile, ready) => {
        const values = await read4(profile, ready);
        const index = values.findIndex((value) => value.shareId === record.shareId);
        if (index >= 0) values[index] = record;
        else values.push(record);
        await write(profile, values, ready);
      }, true);
    },
    async update(shareId, change) {
      return locked(async (profile, ready) => {
        const values = await read4(profile, ready);
        const index = values.findIndex((record) => record.shareId === shareId);
        if (index < 0) return void 0;
        const updated = await change(values[index]);
        values[index] = updated;
        await write(profile, values, ready);
        return updated;
      }, true);
    },
    async list() {
      return locked((profile, ready) => read4(profile, ready));
    },
    async get(shareId) {
      return locked(async (profile, ready) => (await read4(profile, ready)).find((record) => record.shareId === shareId));
    },
    async delete(shareId) {
      return locked(async (profile, ready) => {
        await write(profile, (await read4(profile, ready)).filter((record) => record.shareId !== shareId), ready);
      }, true);
    }
  };
}
function createShareAuthorityAdapters(input = {}) {
  const origin = input.origin ?? DEFAULT_SHARE_ORIGIN;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  let selectedProfile;
  const profileName = () => selectedProfile ??= input.profileName?.() ?? selectedProfileName();
  const canonicalOrigin2 = (value, label) => {
    if (typeof value !== "string") throw new Error(`share ${label} is unavailable`);
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:") || parsed.origin !== value) throw new Error(`share ${label} is invalid`);
    return value;
  };
  let configPromise;
  const publicConfig = async () => configPromise ??= (async () => {
    const response = await fetchFn(`${origin}/.well-known/tinycloud-share/config.json`, {
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    if (!response.ok) throw new Error("share public config is unavailable");
    const value = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("share public config is invalid");
    const object3 = value;
    if (object3.version !== "tinycloud.share/config-v2") throw new Error("share public config version is unsupported");
    return {
      shareOrigin: canonicalOrigin2(object3.shareOrigin, "origin"),
      registryOrigin: canonicalOrigin2(object3.registryOrigin, "registry origin"),
      credentialsOrigin: canonicalOrigin2(input.credentialsOrigin ?? object3.credentialsOrigin, "credentials origin")
    };
  })();
  let nodePromise;
  let activeProfileName2;
  const authenticatedNode = async () => nodePromise ??= (async () => {
    const profile = await profileName();
    activeProfileName2 = profile;
    const context = await ProfileManager.resolveContext({ profile, ...input.nodeOrigin === void 0 ? {} : { host: input.nodeOrigin } });
    const { ensureAuthenticated: ensureAuthenticated2 } = await Promise.resolve().then(() => (init_sdk(), sdk_exports));
    try {
      return await ensureAuthenticated2(context);
    } catch (error) {
      const profileConfig = await ProfileManager.getProfile(profile).catch(() => void 0);
      const code3 = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
      if (error instanceof InvalidRestoredSessionError || code3 === "AUTH_EXPIRED") {
        throw new SharePublishAuthorityError({
          kind: "owner-space-unresolved",
          localKey: profileConfig?.authMethod === "local",
          profileName: profile
        });
      }
      throw error;
    }
  })();
  const assertDomainDeliveryForOrigin = async (nodeOrigin, operation) => {
    let response;
    try {
      response = await fetchFn(`${nodeOrigin}/info`, { signal: AbortSignal.timeout(5e3) });
    } catch {
      throw new SharePublishAuthorityError({ kind: "node-info-unavailable" });
    }
    if (!response.ok) throw new SharePublishAuthorityError({ kind: "node-info-unavailable" });
    let body;
    try {
      body = await response.text();
    } catch {
      throw new SharePublishAuthorityError({ kind: "node-info-unavailable" });
    }
    let info;
    try {
      info = JSON.parse(body);
    } catch {
      info = void 0;
    }
    const version2 = typeof info === "object" && info !== null && "version" in info ? info.version : void 0;
    if (!supportsDomainDelivery(version2)) {
      throw new SharePublishAuthorityError({
        kind: "invalid-request",
        reason: `domain notifications require tinycloud-node ${MIN_DOMAIN_DELIVERY_VERSION} or later; node reports version ${displayedNodeVersion(version2)}. Upgrade the node before inviting; ${operation === "publish" ? "nothing was shared and no invitation was sent" : "no invitation was sent"}`
      });
    }
  };
  const assertDomainDelivery = async () => {
    const node = await authenticatedNode();
    await assertDomainDeliveryForOrigin((await node.activeNodeIdentity()).origin, "notify");
  };
  const targetAdapter = { async publish(targetInput) {
    if (input.publishTarget !== void 0) return input.publishTarget(targetInput);
    const [config, node] = await Promise.all([publicConfig(), authenticatedNode()]);
    const session = node.restorableSession;
    const ownerSpaceId = session?.spaceId;
    const localKey = !node.isSessionOnly;
    let sessionExpiresAt;
    try {
      sessionExpiresAt = node.isSessionOnly && session?.siwe ? extractSiweExpiration(session.siwe) : void 0;
    } catch {
      throw new SharePublishAuthorityError({ kind: "owner-space-unresolved", localKey, profileName: activeProfileName2 });
    }
    if (ownerSpaceId === void 0 || node.isSessionOnly && (!session?.siwe || !session.signature || sessionExpiresAt === void 0)) {
      throw new SharePublishAuthorityError({ kind: "owner-space-unresolved", localKey, profileName: activeProfileName2 });
    }
    if (targetInput.origin !== config.shareOrigin) throw new SharePublishAuthorityError({ kind: "origin-mismatch" });
    if (node.isSessionOnly && sessionExpiresAt !== void 0) {
      const roundedSessionExpiry = new Date(Math.floor(sessionExpiresAt.getTime() / 1e3) * 1e3);
      if (roundedSessionExpiry.getTime() <= Date.now() + 6e4) {
        throw new SharePublishAuthorityError({
          kind: "lifetime-exceeds-session",
          sessionExpiresAt,
          reason: "session-too-close",
          localKey,
          profileName: activeProfileName2
        });
      }
    }
    const expiryClamped = node.isSessionOnly && sessionExpiresAt !== void 0 && targetInput.expiresAt > sessionExpiresAt;
    if (expiryClamped && targetInput.expiryWasExplicit) {
      throw new SharePublishAuthorityError({
        kind: "lifetime-exceeds-session",
        sessionExpiresAt,
        reason: "beyond-session",
        localKey,
        profileName: activeProfileName2
      });
    }
    const effectiveExpiry = expiryClamped ? sessionExpiresAt : targetInput.expiresAt;
    const expiresAt = new Date(Math.floor(effectiveExpiry.getTime() / 1e3) * 1e3);
    if (expiresAt.getTime() <= Date.now() + 6e4) {
      throw new SharePublishAuthorityError({
        kind: "lifetime-exceeds-session",
        sessionExpiresAt: sessionExpiresAt ?? expiresAt,
        reason: node.isSessionOnly && expiryClamped && !targetInput.expiryWasExplicit ? "session-too-close" : "below-minimum",
        localKey,
        profileName: activeProfileName2
      });
    }
    const activeNode = await node.activeNodeIdentity();
    if (targetInput.notify === true && targetInput.target.kind === "emailDomain") {
      await assertDomainDeliveryForOrigin(activeNode.origin, "publish");
    }
    const shareId = crypto.randomUUID().replaceAll("-", "");
    const files = targetInput.files === void 0 || targetInput.files.length === 0 ? [{ bytes: targetInput.source, filename: targetInput.filename, mediaType: targetInput.mediaType }] : targetInput.files;
    const resourceKind = targetInput.resourceKind ?? "exact";
    if (targetInput.target.kind === "bearer") {
      if (resourceKind !== "exact" || files.length !== 1) throw new Error("native bearer publication requires one exact source file");
      const file2 = files[0];
      const resourcePath2 = `xyz.tinycloud.share/shares/${shareId}/${safeStorageFilename(targetInput.filename)}`;
      if (node.isSessionOnly) {
        const authority = node.sharing.preflightGenerate({ path: resourcePath2, actions: ["tinycloud.kv/get"], expiry: expiresAt });
        if (authority === "caveated") {
          throw new SharePublishAuthorityError({ kind: "caveated-session", profileName: activeProfileName2 });
        }
        if (authority === "not-covered") {
          throw new SharePublishAuthorityError({ kind: "scope-denied", capability: "sharing delegation", localKey, profileName: activeProfileName2 });
        }
      }
      const written = await node.kvForSpace(ownerSpaceId).put(resourcePath2, file2.bytes.slice(), {
        contentType: targetInput.mediaType ?? file2.mediaType ?? "application/octet-stream"
      });
      if (!written.ok) {
        const code3 = typeof written.error === "object" && written.error !== null && "code" in written.error ? written.error.code : void 0;
        if (code3 === "AUTH_UNAUTHORIZED" || code3 === "PERMISSION_DENIED") {
          const requiredAction = requiredKvAction(written.error.meta);
          throw new SharePublishAuthorityError({
            kind: "scope-denied",
            capability: "KV upload",
            ...requiredAction === void 0 ? {} : { requiredAction },
            localKey,
            profileName: activeProfileName2
          });
        }
        throwKvUploadFailure(written.error);
      }
      let native;
      try {
        native = await createNativeShare(node.sharing, {
          path: resourcePath2,
          expiresAt,
          viewerOrigin: config.shareOrigin
        });
      } catch (error) {
        const code3 = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
        if (code3 === "AUTH_UNAUTHORIZED" || code3 === "PERMISSION_DENIED") {
          throw new SharePublishAuthorityError({
            kind: "scope-denied",
            capability: "sharing delegation",
            localKey,
            profileName: activeProfileName2
          });
        }
        throw error;
      }
      if (native.spaceId !== ownerSpaceId) throw new Error("native bearer delegation authority does not match the authenticated owner space");
      const result = {
        protocol: "tinycloud-share",
        version: SHARE_PUBLISH_RESULT_VERSION,
        url: native.url,
        link: { kind: "native", cid: native.delegationCid },
        metadata: {
          protocol: "tinycloud-share",
          version: 1,
          shareId: native.delegationCid,
          origin: config.shareOrigin,
          target: { kind: "bearer", origin: activeNode.origin, nodeAudience: activeNode.nodeDid, spaceId: native.spaceId },
          resource: { kind: "exact", path: resourcePath2 },
          actions: ["read"],
          ...expiryClamped ? { expiryClamped: true } : {},
          expiresAt: native.expiresAt.toISOString(),
          display: { filename: targetInput.filename },
          recipientMatcher: { kind: "bearer" },
          enforcementDelegationCid: native.delegationCid
        }
      };
      Object.defineProperty(result, "toJSON", { enumerable: false, value: () => redactPublishedShare(result) });
      Object.defineProperty(result, "url", { enumerable: false, value: native.url });
      return result;
    }
    if (resourceKind !== "exact" || files.length !== 1) throw new Error("addressed publication requires a single exact source file");
    const file = files[0];
    const resourcePath = `shares/${shareId}/${safeStorageFilename(targetInput.filename)}`;
    const byteLength = file.bytes.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > 100 * 1024 * 1024) throw new Error("addressed publication exceeds the combined byte limit");
    const mediaType = targetInput.mediaType ?? file.mediaType ?? "application/octet-stream";
    const actions = targetInput.actions === void 0 || targetInput.actions.length === 0 ? ["read"] : targetInput.actions;
    const policyActions = [...new Set(actions.flatMap((action) => action === "read" ? ["tinycloud.kv/get", "tinycloud.kv/metadata"] : action === "list" ? ["tinycloud.kv/list"] : ["tinycloud.kv/put"]))];
    let prepared;
    try {
      prepared = prepareAddressedShare({ target: targetInput.target, actions, policyActions, filename: targetInput.filename });
    } catch (error) {
      throw new SharePublishAuthorityError({ kind: "invalid-request", reason: error instanceof TypeError ? error.message : "addressed share request is invalid" });
    }
    try {
      await node.publishActiveNodeLocation(config.registryOrigin, fetchFn);
    } catch (error) {
      const rejected = error instanceof LocationRecordValidationError || error instanceof LocationRegistryHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      throw new SharePublishAuthorityError({ kind: rejected ? "registry-rejected" : "registry-unavailable" });
    }
    const encryptionNetwork = node.getEncryptionNetworkIdForSpace(ownerSpaceId);
    const encrypted = await node.encryption.encryptToNetwork(encryptionNetwork, file.bytes, { metadata: { contentType: mediaType } });
    if (!encrypted.ok) throw new Error("addressed source encryption was rejected");
    const storedBytes = new TextEncoder().encode(canonicalize2(encrypted.data));
    const stored = await node.kvForSpace(ownerSpaceId).put(resourcePath, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
    if (!stored.ok) {
      const code3 = typeof stored.error === "object" && stored.error !== null && "code" in stored.error ? stored.error.code : void 0;
      if (code3 === "AUTH_UNAUTHORIZED" || code3 === "PERMISSION_DENIED") {
        const requiredAction = requiredKvAction(stored.error.meta);
        throw new SharePublishAuthorityError({
          kind: "scope-denied",
          capability: "KV upload",
          ...requiredAction === void 0 ? {} : { requiredAction },
          localKey,
          profileName: activeProfileName2
        });
      }
      throwKvUploadFailure(stored.error);
    }
    const contentSource = {
      shareId,
      kvResource: `${ownerSpaceId}/kv/${resourcePath}`,
      selector: resourceKind,
      encryptionNetwork: encrypted.data.networkId,
      encryptedSymmetricKeyDigestHex: encrypted.data.encryptedSymmetricKeyHash,
      keyVersion: encrypted.data.keyVersion,
      mode: "immutable",
      initialCiphertextDigestHex: createHash("sha256").update(storedBytes).digest("hex")
    };
    const published = await publishAddressedShare({
      shareId,
      shareOrigin: config.shareOrigin,
      nodeOrigin: activeNode.origin,
      nodeAudience: activeNode.nodeDid,
      enforcerDid: activeNode.nodeDid,
      spaceId: ownerSpaceId,
      target: prepared.target,
      resource: { kind: resourceKind, path: resourcePath },
      actions,
      policyActions,
      contentSource,
      ...prepared.credentialRequirement === void 0 ? {} : { credentialRequirement: prepared.credentialRequirement },
      // tinycloud-node 1.17.2 signs a delivery receipt only for the envelope's
      // own signed delivery address (1.17.3 accepts it and no longer requires
      // it), so an exact-email share pins its canonical mailbox for `--notify`
      // and `tc share notify`. A mailbox the envelope's `deliveryEmail` rule
      // rejects (deployed viewers validate with it) is published unpinned.
      ...prepared.target.kind === "email" && isEnvelopeDeliveryEmail2(prepared.target.address) ? { deliveryEmail: prepared.target.address } : {},
      filename: targetInput.filename,
      mediaType,
      byteLength,
      expiresAt,
      // App-neutral owner authority: the Node SDK owns every Policy/v3
      // transport hop, so the CLI supplies only owner signing material.
      authority: {
        ownerDid: node.credentialHolderDid,
        createOwnerRoot: (request) => node.createUnifiedOwnerRoot(request),
        sign: (bytes) => node.signSessionBytes(bytes),
        registerPolicy: (request) => node.registerPolicy(request)
      }
    });
    if (expiryClamped) Object.defineProperty(published.metadata, "expiryClamped", { value: true, enumerable: true });
    return published;
  } };
  const delivery = { deliver: input.deliver ?? (async (request) => {
    const record = request.record;
    if (record === void 0 || record.link === void 0 || record.deliveryMaterial === void 0 || request.idempotencyKey === void 0) throw new Error("share delivery history is incomplete");
    const expiry = shareDeliveryWindowExpiresAt(record);
    if (expiry <= Date.now()) throw new ShareNotifyError("share delivery authorization window has expired", "delivery-window-expired");
    const authorizationExpiresAt = new Date(expiry).toISOString();
    const [config, node] = await Promise.all([publicConfig(), authenticatedNode()]);
    const receipt = await node.authorizeShareDeliveryV3({
      envelope: record.deliveryMaterial.envelope,
      sealedEnvelope: record.deliveryMaterial.sealedEnvelope,
      envelopeKey: record.deliveryMaterial.envelopeKey,
      shareCid: record.deliveryMaterial.shareCid,
      resourcePath: record.resource.path,
      recipientEmail: request.recipient,
      shareUrl: record.link,
      documentName: record.filename ?? "share.md",
      expiresAt: authorizationExpiresAt,
      deliveryAudience: config.credentialsOrigin,
      idempotencyKey: request.idempotencyKey
    });
    await deliverCredentialInvitation({
      credentialsOrigin: config.credentialsOrigin,
      receipt,
      shareUrl: record.link,
      fetchFn,
      signal: request.signal
    });
    return "delivered";
  }) };
  const revocation = {
    revokeDelegation: input.revokeDelegation ?? (async (request) => {
      const result = await (await authenticatedNode()).revokeDelegation(request.delegationCid);
      if (!result.ok) throw new Error("share delegation revocation was rejected");
    }),
    revokePolicyRoot: input.revokePolicyRoot ?? (async (request) => {
      const node = await authenticatedNode();
      const activeNode = await node.activeNodeIdentity();
      if (request.nodeOrigin !== activeNode.origin || request.nodeAudience !== activeNode.nodeDid || request.ownerDid !== node.credentialHolderDid) {
        throw new Error("share Policy/v3 revocation is not bound to the active owner node");
      }
      await revokePolicyRootV3({
        nodeOrigin: activeNode.origin,
        rootCid: request.rootCid,
        targetRole: request.targetRole,
        ownerDid: node.credentialHolderDid,
        issuerDid: node.credentialHolderDid,
        nodeAudience: activeNode.nodeDid,
        reason: "share revoked",
        sign: (digest) => node.signSessionBytes(digest)
      });
    })
  };
  const nativeReader = async (link2) => {
    const { TinyCloudNode: TinyCloudNode2 } = await import("@tinycloud/node-sdk");
    const token = parseNativeShareUrl(link2);
    const decoder = new TinyCloudNode2({ autoDiscoverLocalNode: false });
    const decoded = decoder.sharing.decodeLink(token);
    if (typeof decoded.host !== "string") throw new Error("native share has no owner Node");
    const client = new TinyCloudNode2({ host: canonicalOrigin2(decoded.host, "owner node origin"), autoDiscoverLocalNode: false });
    const received = await client.sharing.receive(token, { autoSubdelegate: false, useSessionKey: false });
    if (!received.ok) throw new Error("native share could not be verified");
    const value = await received.data.kv.get("", { binary: true });
    if (!value.ok || !(value.data.data instanceof Uint8Array)) throw new Error("native share content could not be read");
    return { bytes: value.data.data.slice(), filename: received.data.path.split("/").at(-1) || "share.md" };
  };
  return {
    targetAdapter,
    records: input.profileName === void 0 ? createEncryptedSessionHistory() : createEncryptedProfileHistory(profileName, async (bytes, profile) => {
      const context = await ProfileManager.resolveContext({ profile });
      if (context.profile !== profile) throw new ShareHistoryRetryError(profile);
      const { ensureAuthenticated: ensureAuthenticated2 } = await Promise.resolve().then(() => (init_sdk(), sdk_exports));
      const signer = await ensureAuthenticated2(context);
      return signer.signSessionBytes(bytes);
    }),
    delivery,
    revocation,
    assertDomainDelivery,
    nativeReader
  };
}
async function selectedProfileName() {
  const config = await ProfileManager.getConfig();
  return process.env.TC_PROFILE ?? config.defaultProfile;
}

// src/index.ts
var { version } = JSON.parse(
  readFileSync2(new URL("../package.json", import.meta.url), "utf-8")
);
var program = new Command();
var shareAuthority = createShareAuthorityAdapters({
  profileName: async () => selectedShareProfile() ?? (await ProfileManager.getConfig()).defaultProfile,
  fetchFn: globalThis.fetch
});
function selectedShareProfile() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--profile" || value === "-p") return args[index + 1];
    if (value?.startsWith("--profile=")) return value.slice("--profile=".length);
  }
  return process.env.TC_PROFILE;
}
program.name("tc").description("TinyCloud CLI \u2014 self-sovereign storage from the terminal").version(version).option("-p, --profile <name>", "Profile to use").option("-H, --host <url>", "TinyCloud node URL").option("-v, --verbose", "Enable verbose output").option("--no-cache", "Disable caching").option("-q, --quiet", "Suppress non-essential output").option("--json", "Force JSON output");
program.hook("preAction", async (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  const parentName = thisCommand.parent?.name();
  const isShareCommand = parentName === "share" || thisCommand.name() === "share";
  if (!opts.quiet && !isShareCommand) {
    emitBanner(version);
  }
  const commandName = thisCommand.name();
  const fullCommand = parentName && parentName !== "tc" ? `${parentName} ${commandName}` : commandName;
  const skipGuard = ["tc", "init", "doctor", "completion", "help", "upgrade", "status"].includes(commandName) || fullCommand === "profile create";
  if (!skipGuard && !opts.quiet && isInteractive()) {
    try {
      const config = await ProfileManager.getConfig();
      const profileName = opts.profile || config.defaultProfile;
      const hasProfile = await ProfileManager.profileExists(profileName);
      if (!hasProfile) {
        process.stderr.write(theme.warn("\u26A0 No profile configured.") + " " + theme.muted("Run: tc init") + "\n\n");
      } else {
        const key = await ProfileManager.getKey(profileName);
        if (!key) {
          process.stderr.write(theme.warn("\u26A0 No key found.") + " " + theme.muted("Run: tc init") + "\n\n");
        }
      }
    } catch {
    }
  }
});
configureShareCommandServices({
  targetAdapter: shareAuthority.targetAdapter,
  records: shareAuthority.records,
  delivery: shareAuthority.delivery,
  assertDomainDelivery: shareAuthority.assertDomainDelivery,
  revocation: shareAuthority.revocation,
  nativeReader: shareAuthority.nativeReader
});
var argv = process.argv.slice(2);
var globalOptionsWithValues = /* @__PURE__ */ new Set(["--profile", "-p", "--host", "-H"]);
function firstCommandToken(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") return values[index + 1];
    if (globalOptionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--profile=") || value.startsWith("--host=")) continue;
    if (value === "--verbose" || value === "--no-cache" || value === "-q" || value === "--quiet" || value === "--json") continue;
    if (value.startsWith("-")) continue;
    return value;
  }
  return void 0;
}
var isShareInvocation = firstCommandToken(argv) === "share";
if (isShareInvocation) {
  registerShareCommand(program);
} else {
  const loadLegacy = new Function("specifier", "return import(specifier)");
  const { registerTinyCloudCommands } = await loadLegacy(new URL("./legacy-entry.js", import.meta.url).href);
  registerTinyCloudCommands(program);
}
program.addHelpText("before", () => `${theme.label("Version:")} ${theme.value(version)}
`);
program.addHelpText("afterAll", () => {
  if (!process.stdout.isTTY) return "";
  return `
${theme.heading("Examples:")}
  ${theme.command("tc init")}                              ${theme.muted("Set up a profile and generate keys")}
  ${theme.command("tc auth login")}                        ${theme.muted("Authenticate via browser")}
  ${theme.command('tc kv put greeting "Hello"')}           ${theme.muted("Store a value")}
  ${theme.command("tc kv list")}                           ${theme.muted("List all keys")}
  ${theme.command("tc secrets network init")}              ${theme.muted("Create the default secrets network")}
  ${theme.command("tc account apps list")}                 ${theme.muted("List registered account apps")}
  ${theme.command("tc delegation create --to did:pkh:...")}  ${theme.muted("Grant access to another user")}
  ${theme.command("tc space list")}                        ${theme.muted("Show your spaces")}

${theme.muted("Docs:")} ${theme.accent("https://docs.tinycloud.xyz/cli")}
${theme.muted("Repo:")} ${theme.accent("https://github.com/tinycloudlabs/web-sdk")}
`;
});
try {
  await program.parseAsync(process.argv);
} catch (error) {
  handleError(error);
}
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/utils.js:
@noble/curves/esm/abstract/modular.js:
@noble/curves/esm/abstract/curve.js:
@noble/curves/esm/abstract/edwards.js:
@noble/curves/esm/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
//# sourceMappingURL=index.js.map
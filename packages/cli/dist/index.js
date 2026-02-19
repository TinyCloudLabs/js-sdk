// src/index.ts
import { Command } from "commander";

// src/config/constants.ts
import { homedir } from "os";
import { join } from "path";
var CONFIG_DIR = join(homedir(), ".tinycloud");
var PROFILES_DIR = join(CONFIG_DIR, "profiles");
var CONFIG_FILE = join(CONFIG_DIR, "config.json");
var DEFAULT_HOST = "https://node.tinycloud.xyz";
var DEFAULT_PROFILE = "default";
var DEFAULT_CHAIN_ID = 1;
var ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE_ERROR: 2,
  AUTH_REQUIRED: 3,
  NOT_FOUND: 4,
  PERMISSION_DENIED: 5,
  NETWORK_ERROR: 6,
  NODE_ERROR: 7
};

// src/output/formatter.ts
import ora from "ora";
function outputJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}
function outputError(code, message) {
  process.stderr.write(
    JSON.stringify({ error: { code, message } }, null, 2) + "\n"
  );
}
function isInteractive() {
  return Boolean(process.stdout.isTTY);
}
async function withSpinner(label, fn) {
  if (!isInteractive()) {
    return fn();
  }
  const spinner = ora(label).start();
  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

// src/output/errors.ts
var CLIError = class extends Error {
  constructor(code, message, exitCode = ExitCode.ERROR) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.name = "CLIError";
  }
};
function wrapError(error) {
  if (error instanceof CLIError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Not signed in") || message.includes("AUTH_EXPIRED") || message.includes("Session expired")) {
    return new CLIError("AUTH_REQUIRED", message, ExitCode.AUTH_REQUIRED);
  }
  if (message.includes("NOT_FOUND") || message.includes("KV_NOT_FOUND")) {
    return new CLIError("NOT_FOUND", message, ExitCode.NOT_FOUND);
  }
  if (message.includes("PERMISSION_DENIED")) {
    return new CLIError("PERMISSION_DENIED", message, ExitCode.PERMISSION_DENIED);
  }
  if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("fetch failed")) {
    return new CLIError("NETWORK_ERROR", message, ExitCode.NETWORK_ERROR);
  }
  return new CLIError("ERROR", message, ExitCode.ERROR);
}
function handleError(error) {
  const cliError = wrapError(error);
  outputError(cliError.code, cliError.message);
  process.exit(cliError.exitCode);
}

// src/config/profiles.ts
import { join as join2 } from "path";
import { rm as rm2 } from "fs/promises";

// src/config/storage.ts
import { readFile, writeFile, stat, mkdir, rm, readdir } from "fs/promises";
import { dirname } from "path";
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
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
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
  await mkdir(dirPath, { recursive: true });
}
async function removeDir(dirPath) {
  await rm(dirPath, { recursive: true, force: true });
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

// src/config/profiles.ts
var ProfileManager = class _ProfileManager {
  // ── Initialization ──────────────────────────────────────────────────
  /**
   * Creates ~/.tinycloud/ and ~/.tinycloud/profiles/ if they don't exist.
   */
  static async ensureConfigDir() {
    await ensureDir(CONFIG_DIR);
    await ensureDir(PROFILES_DIR);
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
    const profilePath = join2(PROFILES_DIR, name, "profile.json");
    const profile = await readJson(profilePath);
    if (!profile) {
      throw new CLIError(
        "PROFILE_NOT_FOUND",
        `Profile "${name}" does not exist. Run \`tc init\` or \`tc profile create ${name}\` first.`
      );
    }
    return profile;
  }
  /**
   * Saves a profile config, creating the profile directory if needed.
   */
  static async setProfile(name, data) {
    const profileDir = join2(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join2(profileDir, "profile.json"), data);
  }
  /**
   * Returns true if a profile directory exists.
   */
  static async profileExists(name) {
    return fileExists(join2(PROFILES_DIR, name, "profile.json"));
  }
  /**
   * Returns an array of profile directory names.
   */
  static async listProfiles() {
    return listDirs(PROFILES_DIR);
  }
  /**
   * Deletes a profile directory.
   * Throws if trying to delete the current default profile.
   */
  static async deleteProfile(name) {
    const config = await _ProfileManager.getConfig();
    if (config.defaultProfile === name) {
      throw new CLIError(
        "PROFILE_DELETE_DEFAULT",
        `Cannot delete the default profile "${name}". Change the default first with \`tc profile default <other>\`.`
      );
    }
    const profileDir = join2(PROFILES_DIR, name);
    await removeDir(profileDir);
  }
  // ── Key management ──────────────────────────────────────────────────
  /**
   * Returns the parsed JWK for a profile, or null if no key exists.
   */
  static async getKey(name) {
    return readJson(join2(PROFILES_DIR, name, "key.json"));
  }
  /**
   * Saves a JWK key for a profile.
   */
  static async setKey(name, jwk) {
    const profileDir = join2(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join2(profileDir, "key.json"), jwk);
  }
  // ── Session management ──────────────────────────────────────────────
  /**
   * Returns the parsed session for a profile, or null if none exists.
   */
  static async getSession(name) {
    return readJson(join2(PROFILES_DIR, name, "session.json"));
  }
  /**
   * Saves session data for a profile.
   */
  static async setSession(name, session) {
    const profileDir = join2(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join2(profileDir, "session.json"), session);
  }
  /**
   * Removes the session file for a profile.
   */
  static async clearSession(name) {
    const sessionPath = join2(PROFILES_DIR, name, "session.json");
    try {
      await rm2(sessionPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }
  // ── Cache management ────────────────────────────────────────────────
  /**
   * Returns the path to the profile's cache directory, creating it if needed.
   */
  static async getCacheDir(name) {
    const cacheDir = join2(PROFILES_DIR, name, "cache");
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
  static async resolveContext(options) {
    const config = await _ProfileManager.getConfig();
    const profile = options.profile ?? process.env.TC_PROFILE ?? config.defaultProfile ?? DEFAULT_PROFILE;
    let profileHost;
    try {
      const profileConfig = await _ProfileManager.getProfile(profile);
      profileHost = profileConfig.host;
    } catch {
    }
    const host = options.host ?? process.env.TC_HOST ?? profileHost ?? DEFAULT_HOST;
    return {
      profile,
      host,
      verbose: options.verbose ?? false,
      noCache: options.noCache ?? false,
      quiet: options.quiet ?? false
    };
  }
};

// src/auth/local-key.ts
import { TCWSessionManager, initPanicHook } from "@tinycloud/node-sdk-wasm";
var wasmInitialized = false;
function ensureWasm() {
  if (!wasmInitialized) {
    initPanicHook();
    wasmInitialized = true;
  }
}
function generateKey() {
  ensureWasm();
  const mgr = new TCWSessionManager();
  const keyId = mgr.createSessionKey("cli");
  const jwkStr = mgr.jwk(keyId);
  if (!jwkStr) throw new Error("Failed to generate key");
  const jwk = JSON.parse(jwkStr);
  const did = mgr.getDID(keyId);
  return { jwk, did };
}

// src/auth/browser-auth.ts
import { createServer } from "http";
import { createInterface } from "readline";
var OPENKEY_BASE = "https://openkey.cloud";
async function startAuthFlow(did, options = {}) {
  if (options.paste) {
    return pasteFlow(did);
  }
  try {
    return await callbackFlow(did);
  } catch {
    if (isInteractive()) {
      console.error("Could not open browser. Falling back to manual paste mode.");
      return pasteFlow(did);
    }
    throw new Error("Cannot open browser in non-interactive mode. Use --paste flag.");
  }
}
async function callbackFlow(did) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            });
            res.end(JSON.stringify({ success: true }));
            server.close();
            resolve(data);
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            reject(new Error("Invalid delegation data received"));
          }
        });
      } else if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start callback server"));
        return;
      }
      const port = addr.port;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const authUrl = `${OPENKEY_BASE}/delegate?did=${encodeURIComponent(did)}&callback=${encodeURIComponent(callbackUrl)}`;
      if (isInteractive()) {
        console.error(`Opening browser for authentication...`);
        console.error(`If the browser doesn't open, visit: ${authUrl}`);
      }
      try {
        const open = (await import("open")).default;
        await open(authUrl);
      } catch {
        server.close();
        throw new Error("Failed to open browser");
      }
    });
    setTimeout(() => {
      server.close();
      reject(new Error("Authentication timed out after 5 minutes"));
    }, 5 * 60 * 1e3);
  });
}
async function pasteFlow(did) {
  const authUrl = `${OPENKEY_BASE}/delegate?did=${encodeURIComponent(did)}`;
  console.error(`
Open this URL in a browser to authenticate:
`);
  console.error(`  ${authUrl}
`);
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr
  });
  return new Promise((resolve, reject) => {
    rl.question("Paste delegation code: ", (input) => {
      rl.close();
      try {
        const data = JSON.parse(input.trim());
        resolve(data);
      } catch {
        try {
          const decoded = Buffer.from(input.trim(), "base64").toString("utf-8");
          const data = JSON.parse(decoded);
          resolve(data);
        } catch {
          reject(new Error("Invalid delegation code. Expected JSON or base64-encoded JSON."));
        }
      }
    });
  });
}

// src/commands/init.ts
function registerInitCommand(program2) {
  program2.command("init").description("Initialize a new TinyCloud profile").option("--name <profile>", "Profile name", "default").option("--key-only", "Only generate key, skip authentication").option("--host <url>", "TinyCloud node URL").option("--paste", "Use manual paste mode for authentication").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const profileName = options.name;
      const host = options.host ?? globalOpts.host ?? DEFAULT_HOST;
      if (await ProfileManager.profileExists(profileName)) {
        throw new CLIError(
          "PROFILE_EXISTS",
          `Profile "${profileName}" already exists. Use \`tc profile delete ${profileName}\` first or choose a different name.`,
          ExitCode.ERROR
        );
      }
      await ProfileManager.ensureConfigDir();
      const { jwk, did } = await withSpinner("Generating key...", async () => {
        return generateKey();
      });
      await ProfileManager.setKey(profileName, jwk);
      const profileConfig = {
        name: profileName,
        host,
        chainId: DEFAULT_CHAIN_ID,
        spaceName: "default",
        did,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await ProfileManager.setProfile(profileName, profileConfig);
      const config = await ProfileManager.getConfig();
      if (profileName === "default" || !await ProfileManager.profileExists(config.defaultProfile)) {
        await ProfileManager.setConfig({ ...config, defaultProfile: profileName });
      }
      if (options.keyOnly) {
        outputJson({
          profile: profileName,
          did,
          host,
          authenticated: false
        });
        return;
      }
      const delegationData = await startAuthFlow(did, { paste: options.paste });
      await ProfileManager.setSession(profileName, delegationData);
      await ProfileManager.setProfile(profileName, {
        ...profileConfig,
        spaceId: delegationData.spaceId,
        primaryDid: delegationData.primaryDid
      });
      outputJson({
        profile: profileName,
        did,
        host,
        spaceId: delegationData.spaceId,
        authenticated: true
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/auth.ts
function registerAuthCommand(program2) {
  const auth = program2.command("auth").description("Authentication management");
  auth.command("login").description("Authenticate with OpenKey").option("--paste", "Use manual paste mode instead of browser callback").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const key = await ProfileManager.getKey(ctx.profile);
      if (!key) {
        throw new CLIError(
          "NO_KEY",
          `No key found for profile "${ctx.profile}". Run \`tc init\` first.`,
          ExitCode.AUTH_REQUIRED
        );
      }
      const profile = await ProfileManager.getProfile(ctx.profile);
      const delegationData = await startAuthFlow(profile.did, {
        paste: options.paste
      });
      await ProfileManager.setSession(ctx.profile, delegationData);
      if (delegationData.spaceId) {
        await ProfileManager.setProfile(ctx.profile, {
          ...profile,
          spaceId: delegationData.spaceId,
          primaryDid: delegationData.primaryDid
        });
      }
      outputJson({
        authenticated: true,
        profile: ctx.profile,
        did: profile.did,
        spaceId: delegationData.spaceId
      });
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("logout").description("Clear session (keep key)").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      await ProfileManager.clearSession(ctx.profile);
      outputJson({ profile: ctx.profile, authenticated: false });
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("status").description("Show current authentication state").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const hasKey = await ProfileManager.getKey(ctx.profile);
      const session = await ProfileManager.getSession(ctx.profile);
      let profile;
      try {
        profile = await ProfileManager.getProfile(ctx.profile);
      } catch {
        profile = null;
      }
      outputJson({
        authenticated: session !== null,
        did: profile?.did ?? null,
        primaryDid: profile?.primaryDid ?? null,
        spaceId: profile?.spaceId ?? null,
        host: ctx.host,
        profile: ctx.profile,
        hasKey: hasKey !== null
      });
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("whoami").description("Show identity information").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profile = await ProfileManager.getProfile(ctx.profile);
      const session = await ProfileManager.getSession(ctx.profile);
      outputJson({
        profile: ctx.profile,
        did: profile.did,
        primaryDid: profile.primaryDid ?? null,
        spaceId: profile.spaceId ?? null,
        host: profile.host,
        authenticated: session !== null
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/kv.ts
import { readFile as readFile2 } from "fs/promises";
import { writeFile as writeFile2 } from "fs/promises";

// src/lib/sdk.ts
import { TinyCloudNode } from "@tinycloud/node-sdk";
async function createSDKInstance(ctx) {
  const profile = await ProfileManager.getProfile(ctx.profile);
  const session = await ProfileManager.getSession(ctx.profile);
  const key = await ProfileManager.getKey(ctx.profile);
  if (!key) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `No key found for profile "${ctx.profile}". Run \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  const node = new TinyCloudNode({
    host: ctx.host
  });
  return node;
}
async function ensureAuthenticated(ctx) {
  const session = await ProfileManager.getSession(ctx.profile);
  if (!session) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `Not authenticated. Run \`tc auth login\` or \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  return createSDKInstance(ctx);
}

// src/commands/kv.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
function registerKvCommand(program2) {
  const kv = program2.command("kv").description("Key-value store operations");
  kv.command("get <key>").description("Get a value by key").option("--raw", "Output raw value (no JSON wrapping)").option("-o, --output <file>", "Write value to file").action(async (key, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await withSpinner(`Getting ${key}...`, () => node.kv.get(key));
      if (!result.ok) {
        if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
          throw new CLIError("NOT_FOUND", `Key "${key}" not found`, ExitCode.NOT_FOUND);
        }
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const data = result.data.data;
      const metadata = result.data.headers ?? {};
      if (options.output) {
        const content = typeof data === "string" ? data : JSON.stringify(data);
        await writeFile2(options.output, content);
        outputJson({ key, written: options.output });
        return;
      }
      if (options.raw) {
        const content = typeof data === "string" ? data : JSON.stringify(data);
        process.stdout.write(content);
        return;
      }
      outputJson({
        key,
        data,
        metadata
      });
    } catch (error) {
      handleError(error);
    }
  });
  kv.command("put <key> [value]").description("Set a value").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").action(async (key, value, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      let putValue;
      const sources = [value !== void 0, !!options.file, !!options.stdin].filter(Boolean);
      if (sources.length === 0) {
        throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (sources.length > 1) {
        throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (options.file) {
        putValue = await readFile2(options.file);
      } else if (options.stdin) {
        putValue = await readStdin();
      } else {
        try {
          putValue = JSON.parse(value);
        } catch {
          putValue = value;
        }
      }
      const result = await withSpinner(`Writing ${key}...`, () => node.kv.put(key, putValue));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ key, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  kv.command("delete <key>").description("Delete a key").action(async (key, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await withSpinner(`Deleting ${key}...`, () => node.kv.delete(key));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ key, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
  kv.command("list").description("List keys").option("--prefix <prefix>", "Filter by key prefix").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const listOptions = options.prefix ? { prefix: options.prefix } : void 0;
      const result = await withSpinner("Listing keys...", () => node.kv.list(listOptions));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const keys = result.data.data ?? result.data;
      const keyList = Array.isArray(keys) ? keys : [];
      outputJson({
        keys: keyList,
        count: keyList.length,
        prefix: options.prefix ?? null
      });
    } catch (error) {
      handleError(error);
    }
  });
  kv.command("head <key>").description("Get metadata for a key (no body)").action(async (key, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await withSpinner(`Checking ${key}...`, () => node.kv.head(key));
      if (!result.ok) {
        if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
          outputJson({ key, exists: false, metadata: {} });
          return;
        }
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({
        key,
        exists: true,
        metadata: result.data.headers ?? {}
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/space.ts
function registerSpaceCommand(program2) {
  const space = program2.command("space").description("Space management");
  space.command("list").description("List spaces").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await node.spaces.list();
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ spaces: result.data, count: result.data.length });
    } catch (error) {
      handleError(error);
    }
  });
  space.command("create <name>").description("Create a new space").action(async (name, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await node.spaces.create(name);
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ spaceId: result.data.id, name });
    } catch (error) {
      handleError(error);
    }
  });
  space.command("info [space-id]").description("Get space info").action(async (spaceId, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const targetId = spaceId ?? node.spaceId;
      if (!targetId) {
        throw new CLIError("NO_SPACE", "No space ID specified and no active space", ExitCode.ERROR);
      }
      const profile = await ProfileManager.getProfile(ctx.profile);
      outputJson({
        spaceId: targetId,
        name: profile.spaceName,
        owner: node.did,
        host: ctx.host
      });
    } catch (error) {
      handleError(error);
    }
  });
  space.command("switch <name>").description("Switch active space").action(async (name, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profile = await ProfileManager.getProfile(ctx.profile);
      await ProfileManager.setProfile(ctx.profile, { ...profile, spaceName: name });
      outputJson({ profile: ctx.profile, spaceName: name, switched: true });
    } catch (error) {
      handleError(error);
    }
  });
}

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
function parseExpiry(input) {
  return new Date(Date.now() + parseDuration(input));
}

// src/commands/delegation.ts
function registerDelegationCommand(program2) {
  const delegation = program2.command("delegation").description("Manage delegations");
  delegation.command("create").description("Create a delegation").requiredOption("--to <did>", "Recipient DID").requiredOption("--path <path>", "KV path scope").requiredOption("--actions <actions>", "Comma-separated actions (e.g., kv/get,kv/list)").option("--expiry <duration>", "Expiry duration (e.g., 1h, 7d, ISO date)", "1h").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const actions = options.actions.split(",").map((a) => {
        const trimmed = a.trim();
        return trimmed.startsWith("tinycloud.") ? trimmed : `tinycloud.${trimmed}`;
      });
      const expiry = parseExpiry(options.expiry);
      const result = await node.delegationManager.create({
        delegateDID: options.to,
        path: options.path,
        actions,
        expiry
      });
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({
        cid: result.data.cid,
        delegateDid: options.to,
        path: options.path,
        actions,
        expiry: expiry.toISOString()
      });
    } catch (error) {
      handleError(error);
    }
  });
  delegation.command("list").description("List delegations").option("--granted", "Show only delegations I've granted").option("--received", "Show only delegations I've received").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await node.delegationManager.list();
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      let delegations = result.data;
      if (options.granted) {
        const myDid = node.did;
        delegations = delegations.filter((d) => d.delegatorDID === myDid);
      } else if (options.received) {
        const myDid = node.did;
        delegations = delegations.filter((d) => d.delegateDID === myDid || d.delegateDID?.includes(myDid));
      }
      outputJson({
        delegations: delegations.map((d) => ({
          cid: d.cid,
          delegatee: d.delegateDID,
          delegator: d.delegatorDID,
          path: d.path,
          actions: d.actions,
          expiry: d.expiry instanceof Date ? d.expiry.toISOString() : d.expiry
        })),
        count: delegations.length
      });
    } catch (error) {
      handleError(error);
    }
  });
  delegation.command("info <cid>").description("Get delegation details").action(async (cid, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await node.delegationManager.get(cid);
      if (!result.ok) {
        throw new CLIError("NOT_FOUND", `Delegation "${cid}" not found`, ExitCode.NOT_FOUND);
      }
      outputJson(result.data);
    } catch (error) {
      handleError(error);
    }
  });
  delegation.command("revoke <cid>").description("Revoke a delegation").action(async (cid, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await node.delegationManager.revoke(cid);
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ cid, revoked: true });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/share.ts
function registerShareCommand(program2) {
  const share = program2.command("share").description("Share data with others");
  share.command("create").description("Create a share link").requiredOption("--path <path>", "KV path scope").option("--actions <actions>", "Comma-separated actions", "kv/get").option("--expiry <duration>", "Expiry duration", "7d").option("--web-link", "Generate a web UI link for non-technical recipients").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const actions = options.actions.split(",").map((a) => {
        const trimmed = a.trim();
        return trimmed.startsWith("tinycloud.") ? trimmed : `tinycloud.${trimmed}`;
      });
      const expiry = parseExpiry(options.expiry);
      const result = await node.sharing.generate({
        path: options.path,
        actions,
        expiry
      });
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const output = {
        token: result.data.token ?? result.data.cid,
        shareData: result.data.encodedData ?? result.data.url,
        path: options.path,
        actions,
        expiry: expiry.toISOString()
      };
      if (options.webLink) {
        const shareData = result.data.encodedData ?? result.data.url ?? "";
        output.webLink = `https://openkey.cloud/share?data=${encodeURIComponent(shareData)}`;
      }
      outputJson(output);
    } catch (error) {
      handleError(error);
    }
  });
  share.command("receive [data]").description("Receive a share").option("--stdin", "Read share data from stdin").action(async (data, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      let shareData;
      if (options.stdin) {
        const chunks = [];
        for await (const chunk of process.stdin) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        shareData = Buffer.concat(chunks).toString("utf-8").trim();
      } else if (data) {
        shareData = data;
      } else {
        throw new CLIError("USAGE_ERROR", "Must provide share data or use --stdin", ExitCode.USAGE_ERROR);
      }
      const result = await node.sharing.receive(shareData);
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({
        received: true,
        spaceId: result.data.spaceId,
        path: result.data.path,
        actions: result.data.actions
      });
    } catch (error) {
      handleError(error);
    }
  });
  share.command("list").description("List active shares").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await node.sharing.list();
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ shares: result.data, count: result.data.length });
    } catch (error) {
      handleError(error);
    }
  });
  share.command("revoke <token>").description("Revoke a share").action(async (token, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await node.sharing.revoke(token);
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ token, revoked: true });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/node.ts
function registerNodeCommand(program2) {
  const node = program2.command("node").description("Node health and info");
  node.command("health").description("Check node health").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const start = Date.now();
      const response = await fetch(`${ctx.host}/healthz`);
      const latencyMs = Date.now() - start;
      outputJson({
        healthy: response.ok,
        host: ctx.host,
        latencyMs
      });
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        outputJson({ healthy: false, host: (await ProfileManager.resolveContext(cmd.optsWithGlobals())).host, error: "Connection refused" });
      } else {
        handleError(error);
      }
    }
  });
  node.command("version").description("Get node version").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const response = await fetch(`${ctx.host}/version`);
      if (!response.ok) {
        throw new CLIError("NODE_ERROR", `Node returned ${response.status}`, ExitCode.NODE_ERROR);
      }
      const data = await response.json();
      outputJson({ ...data, host: ctx.host });
    } catch (error) {
      handleError(error);
    }
  });
  node.command("status").description("Combined health and version info").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const start = Date.now();
      const [healthRes, versionRes] = await Promise.allSettled([
        fetch(`${ctx.host}/healthz`),
        fetch(`${ctx.host}/version`)
      ]);
      const latencyMs = Date.now() - start;
      const healthy = healthRes.status === "fulfilled" && healthRes.value.ok;
      let versionData = {};
      if (versionRes.status === "fulfilled" && versionRes.value.ok) {
        versionData = await versionRes.value.json();
      }
      outputJson({
        healthy,
        host: ctx.host,
        latencyMs,
        ...versionData
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/profile.ts
import { createInterface as createInterface2 } from "readline";
function registerProfileCommand(program2) {
  const profile = program2.command("profile").description("Profile management");
  profile.command("list").description("List all profiles").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const config = await ProfileManager.getConfig();
      const names = await ProfileManager.listProfiles();
      const profiles = await Promise.all(
        names.map(async (name) => {
          try {
            const p = await ProfileManager.getProfile(name);
            return {
              name: p.name,
              host: p.host,
              did: p.did,
              active: name === config.defaultProfile
            };
          } catch {
            return { name, host: null, did: null, active: name === config.defaultProfile };
          }
        })
      );
      outputJson({
        profiles,
        defaultProfile: config.defaultProfile
      });
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("create <name>").description("Create a new profile").option("--host <url>", "TinyCloud node URL").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const host = options.host ?? globalOpts.host ?? "https://node.tinycloud.xyz";
      if (await ProfileManager.profileExists(name)) {
        throw new CLIError("PROFILE_EXISTS", `Profile "${name}" already exists`, ExitCode.ERROR);
      }
      await ProfileManager.ensureConfigDir();
      const { jwk, did } = generateKey();
      await ProfileManager.setKey(name, jwk);
      await ProfileManager.setProfile(name, {
        name,
        host,
        chainId: 1,
        spaceName: "default",
        did,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      outputJson({ profile: name, did, host, created: true });
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("show [name]").description("Show profile details").action(async (name, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profileName = name ?? ctx.profile;
      const p = await ProfileManager.getProfile(profileName);
      const hasKey = await ProfileManager.getKey(profileName) !== null;
      const hasSession = await ProfileManager.getSession(profileName) !== null;
      const config = await ProfileManager.getConfig();
      outputJson({
        ...p,
        hasKey,
        hasSession,
        isDefault: profileName === config.defaultProfile
      });
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("switch <name>").description("Set default profile").action(async (name, _options, cmd) => {
    try {
      if (!await ProfileManager.profileExists(name)) {
        throw new CLIError("PROFILE_NOT_FOUND", `Profile "${name}" does not exist`, ExitCode.NOT_FOUND);
      }
      const config = await ProfileManager.getConfig();
      await ProfileManager.setConfig({ ...config, defaultProfile: name });
      outputJson({ defaultProfile: name, switched: true });
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("delete <name>").description("Delete a profile").action(async (name, _options, cmd) => {
    try {
      if (isInteractive()) {
        const rl = createInterface2({ input: process.stdin, output: process.stderr });
        const answer = await new Promise((resolve) => {
          rl.question(`Delete profile "${name}"? This cannot be undone. [y/N] `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          outputJson({ profile: name, deleted: false, reason: "Cancelled by user" });
          return;
        }
      }
      await ProfileManager.deleteProfile(name);
      outputJson({ profile: name, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/completion.ts
function registerCompletionCommand(program2) {
  const completion = program2.command("completion").description("Generate shell completions");
  completion.command("bash").description("Output bash completions").action(() => {
    const script = generateBashCompletion();
    process.stdout.write(script);
  });
  completion.command("zsh").description("Output zsh completions").action(() => {
    const script = generateZshCompletion();
    process.stdout.write(script);
  });
  completion.command("fish").description("Output fish completions").action(() => {
    const script = generateFishCompletion();
    process.stdout.write(script);
  });
}
function generateBashCompletion() {
  return `# tc bash completion
_tc_completions() {
  local cur prev commands subcommands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="init auth kv space delegation share node profile completion"

  case "\${COMP_WORDS[1]}" in
    auth) subcommands="login logout status whoami" ;;
    kv) subcommands="get put delete list head" ;;
    space) subcommands="list create info switch" ;;
    delegation) subcommands="create list info revoke" ;;
    share) subcommands="create receive list revoke" ;;
    node) subcommands="health version status" ;;
    profile) subcommands="list create show switch delete" ;;
    completion) subcommands="bash zsh fish" ;;
    *) COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") ); return ;;
  esac

  if [ \${COMP_CWORD} -eq 2 ]; then
    COMPREPLY=( $(compgen -W "\${subcommands}" -- "\${cur}") )
  fi
}
complete -F _tc_completions tc
`;
}
function generateZshCompletion() {
  return `#compdef tc

_tc() {
  local -a commands
  commands=(
    'init:Initialize a new TinyCloud profile'
    'auth:Authentication management'
    'kv:Key-value store operations'
    'space:Space management'
    'delegation:Manage delegations'
    'share:Share data with others'
    'node:Node health and info'
    'profile:Profile management'
    'completion:Generate shell completions'
  )

  _arguments -C \\
    '(-p --profile)'{-p,--profile}'[Profile to use]:profile:' \\
    '(-H --host)'{-H,--host}'[TinyCloud node URL]:url:' \\
    '(-v --verbose)'{-v,--verbose}'[Enable verbose output]' \\
    '--no-cache[Disable caching]' \\
    '(-q --quiet)'{-q,--quiet}'[Suppress non-essential output]' \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        auth) _values 'subcommand' login logout status whoami ;;
        kv) _values 'subcommand' get put delete list head ;;
        space) _values 'subcommand' list create info switch ;;
        delegation) _values 'subcommand' create list info revoke ;;
        share) _values 'subcommand' create receive list revoke ;;
        node) _values 'subcommand' health version status ;;
        profile) _values 'subcommand' list create show switch delete ;;
        completion) _values 'subcommand' bash zsh fish ;;
      esac
      ;;
  esac
}

_tc
`;
}
function generateFishCompletion() {
  return `# tc fish completion
set -l commands init auth kv space delegation share node profile completion

# Disable file completion by default
complete -c tc -f

# Top-level commands
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a init -d "Initialize a new TinyCloud profile"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a auth -d "Authentication management"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a kv -d "Key-value store operations"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a space -d "Space management"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a delegation -d "Manage delegations"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a share -d "Share data with others"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a node -d "Node health and info"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a profile -d "Profile management"
complete -c tc -n "not __fish_seen_subcommand_from $commands" -a completion -d "Generate shell completions"

# Subcommands
complete -c tc -n "__fish_seen_subcommand_from auth" -a "login logout status whoami"
complete -c tc -n "__fish_seen_subcommand_from kv" -a "get put delete list head"
complete -c tc -n "__fish_seen_subcommand_from space" -a "list create info switch"
complete -c tc -n "__fish_seen_subcommand_from delegation" -a "create list info revoke"
complete -c tc -n "__fish_seen_subcommand_from share" -a "create receive list revoke"
complete -c tc -n "__fish_seen_subcommand_from node" -a "health version status"
complete -c tc -n "__fish_seen_subcommand_from profile" -a "list create show switch delete"
complete -c tc -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"

# Global options
complete -c tc -l profile -s p -d "Profile to use"
complete -c tc -l host -s H -d "TinyCloud node URL"
complete -c tc -l verbose -s v -d "Enable verbose output"
complete -c tc -l no-cache -d "Disable caching"
complete -c tc -l quiet -s q -d "Suppress non-essential output"
`;
}

// src/index.ts
var program = new Command();
program.name("tc").description("TinyCloud CLI").version("0.1.0").option("-p, --profile <name>", "Profile to use").option("-H, --host <url>", "TinyCloud node URL").option("-v, --verbose", "Enable verbose output").option("--no-cache", "Disable caching").option("-q, --quiet", "Suppress non-essential output");
registerInitCommand(program);
registerAuthCommand(program);
registerKvCommand(program);
registerSpaceCommand(program);
registerDelegationCommand(program);
registerShareCommand(program);
registerNodeCommand(program);
registerProfileCommand(program);
registerCompletionCommand(program);
try {
  await program.parseAsync(process.argv);
} catch (error) {
  handleError(error);
}
//# sourceMappingURL=index.js.map
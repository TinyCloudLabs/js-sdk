// src/index.ts
import { readFileSync as readFileSync2 } from "fs";
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

// src/output/theme.ts
import chalk from "chalk";
var TC_PALETTE = {
  primary: "#4473b9",
  accent: "#5b9bd5",
  success: "#2fba6a",
  warn: "#e8a838",
  error: "#d94040",
  muted: "#808080",
  dim: "#5a5a5a"
};
var theme = {
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

// src/output/formatter.ts
function outputJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}
function outputError(code, message) {
  if (isInteractive()) {
    process.stderr.write(
      `${theme.error("\u2717")} ${theme.label(code)}: ${message}
`
    );
  } else {
    process.stderr.write(
      JSON.stringify({ error: { code, message } }, null, 2) + "\n"
    );
  }
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
    spinner.succeed(label);
    return result;
  } catch (error) {
    spinner.fail(label);
    throw error;
  }
}
function shouldOutputJson() {
  return !isInteractive() || process.argv.includes("--json");
}
function formatField(label, value) {
  if (value === null || value === void 0) return `  ${theme.label(label + ":")} ${theme.muted("\u2014")}`;
  if (typeof value === "boolean") {
    return `  ${theme.label(label + ":")} ${value ? theme.success("yes") : theme.muted("no")}`;
  }
  return `  ${theme.label(label + ":")} ${theme.value(String(value))}`;
}
function formatTable(headers, rows) {
  const widths = headers.map(
    (h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || "").length))
  );
  const headerLine = headers.map((h, i) => theme.label(h.padEnd(widths[i]))).join("  ");
  const separator = widths.map((w) => theme.dim("\u2500".repeat(w))).join("  ");
  const dataLines = rows.map(
    (row) => row.map((cell, i) => (cell || "").padEnd(widths[i])).join("  ")
  );
  return [headerLine, separator, ...dataLines].join("\n");
}
function formatCheck(ok, label, detail) {
  const icon = ok === "warn" ? theme.warn("\u26A0") : ok ? theme.success("\u2713") : theme.error("\u2717");
  const detailStr = detail ? ` ${theme.muted(`(${detail})`)}` : "";
  return `${icon} ${label}${detailStr}`;
}
function formatSection(title) {
  return `
${theme.heading(title)}`;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatTimeAgo(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1e3);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
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
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { randomBytes } from "crypto";
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
function generateEthereumPrivateKey() {
  const keyBytes = randomBytes(32);
  return "0x" + keyBytes.toString("hex");
}
async function deriveAddress(privateKey) {
  const signer = new PrivateKeySigner(privateKey);
  return signer.getAddress();
}
function addressToDID(address, chainId = 1) {
  return `did:pkh:eip155:${chainId}:${address}`;
}
async function generateLocalIdentity(chainId = 1) {
  const privateKey = generateEthereumPrivateKey();
  const address = await deriveAddress(privateKey);
  const did = addressToDID(address, chainId);
  return { privateKey, address, did };
}
async function localKeySignIn(options) {
  const { TinyCloudNode: TinyCloudNode2 } = await import("@tinycloud/node-sdk");
  const node = new TinyCloudNode2({
    privateKey: options.privateKey,
    host: options.host,
    autoCreateSpace: true
  });
  await node.signIn();
  const address = await new PrivateKeySigner(options.privateKey).getAddress();
  return {
    spaceId: node.spaceId ?? "",
    address,
    chainId: 1
  };
}

// src/auth/browser-auth.ts
import { createServer } from "http";
import { createInterface } from "readline";
var OPENKEY_BASE = "https://openkey.so";
async function startAuthFlow(did, options = {}) {
  if (options.paste) {
    return pasteFlow(did, options);
  }
  try {
    return await callbackFlow(did, options);
  } catch {
    if (isInteractive()) {
      console.error("Could not open browser. Falling back to manual paste mode.");
      return pasteFlow(did, options);
    }
    throw new Error("Cannot open browser in non-interactive mode. Use --paste flag.");
  }
}
function buildAuthUrl(did, options = {}) {
  const params = new URLSearchParams();
  params.set("did", did);
  if (options.callback) {
    params.set("callback", options.callback);
  }
  if (options.jwk) {
    const jwkB64 = Buffer.from(JSON.stringify(options.jwk)).toString("base64url");
    params.set("jwk", jwkB64);
  }
  if (options.host) {
    params.set("host", options.host);
  }
  return `${OPENKEY_BASE}/delegate?${params.toString()}`;
}
async function callbackFlow(did, options = {}) {
  return new Promise((resolve3, reject) => {
    let timeout;
    let settled = false;
    let rl;
    function settle(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      if (rl) {
        rl.close();
      }
      if (result.data) {
        resolve3(result.data);
      } else {
        reject(result.error);
      }
    }
    function parsePasteInput(input) {
      const trimmed = input.trim();
      try {
        return JSON.parse(trimmed);
      } catch {
        const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
        return JSON.parse(decoded);
      }
    }
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
            settle({ data });
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            settle({ error: new Error("Invalid delegation data received") });
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
        settle({ error: new Error("Failed to start callback server") });
        return;
      }
      const port = addr.port;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const authUrl = buildAuthUrl(did, { ...options, callback: callbackUrl });
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
      if (isInteractive()) {
        console.error(`
If the browser can't connect back, paste the delegation code here:`);
        rl = createInterface({
          input: process.stdin,
          output: process.stderr
        });
        rl.on("line", (input) => {
          if (settled) return;
          try {
            const data = parsePasteInput(input);
            settle({ data });
          } catch {
            console.error("Invalid delegation code. Expected JSON or base64-encoded JSON. Try again:");
          }
        });
      }
    });
    timeout = setTimeout(() => {
      settle({ error: new Error("Authentication timed out after 5 minutes") });
    }, 5 * 60 * 1e3);
  });
}
async function pasteFlow(did, options = {}) {
  const authUrl = buildAuthUrl(did, options);
  console.error(`
Open this URL in a browser to authenticate:
`);
  console.error(`  ${authUrl}
`);
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr
  });
  return new Promise((resolve3, reject) => {
    rl.question("Paste delegation code: ", (input) => {
      rl.close();
      try {
        const data = JSON.parse(input.trim());
        resolve3(data);
      } catch {
        try {
          const decoded = Buffer.from(input.trim(), "base64").toString("utf-8");
          const data = JSON.parse(decoded);
          resolve3(data);
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
      const delegationData = await startAuthFlow(did, {
        paste: options.paste,
        jwk,
        host
      });
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
import { createInterface as createInterface2 } from "readline";
async function promptAuthMethod() {
  if (!isInteractive()) {
    return "local";
  }
  const rl = createInterface2({
    input: process.stdin,
    output: process.stderr
  });
  return new Promise((resolve3) => {
    process.stderr.write("\n" + theme.heading("Choose authentication method:") + "\n");
    process.stderr.write(`  ${theme.accent("1)")} OpenKey ${theme.muted("(browser-based, for interactive use)")}
`);
    process.stderr.write(`  ${theme.accent("2)")} Local key ${theme.muted("(Ethereum private key, for agents/CI)")}

`);
    rl.question("Enter choice [1]: ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "2" || trimmed.toLowerCase() === "local") {
        resolve3("local");
      } else {
        resolve3("openkey");
      }
    });
  });
}
function registerAuthCommand(program2) {
  const auth = program2.command("auth").description("Authentication management");
  auth.command("login").description("Authenticate with TinyCloud").option("--paste", "Use manual paste mode instead of browser callback").option("--method <method>", "Authentication method: local or openkey").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      let method;
      if (options.method) {
        if (options.method !== "local" && options.method !== "openkey") {
          throw new CLIError(
            "INVALID_METHOD",
            `Invalid auth method "${options.method}". Use "local" or "openkey".`,
            ExitCode.USAGE_ERROR
          );
        }
        method = options.method;
      } else {
        method = await promptAuthMethod();
      }
      if (method === "local") {
        await handleLocalAuth(ctx.profile, ctx.host);
      } else {
        await handleOpenKeyAuth(ctx.profile, ctx.host, options.paste);
      }
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
      const authenticated = session !== null;
      if (shouldOutputJson()) {
        outputJson({
          authenticated,
          did: profile?.did ?? null,
          primaryDid: profile?.primaryDid ?? null,
          spaceId: profile?.spaceId ?? null,
          host: ctx.host,
          profile: ctx.profile,
          hasKey: hasKey !== null,
          authMethod: profile?.authMethod ?? null,
          address: profile?.address ?? null
        });
      } else {
        process.stdout.write(theme.heading("Authentication Status") + "\n");
        process.stdout.write(formatField("Profile", ctx.profile) + "\n");
        process.stdout.write(formatField("Authenticated", authenticated) + "\n");
        process.stdout.write(formatField("Auth Method", profile?.authMethod ?? null) + "\n");
        process.stdout.write(formatField("Host", ctx.host) + "\n");
        process.stdout.write(formatField("DID", profile?.did ?? null) + "\n");
        process.stdout.write(formatField("Primary DID", profile?.primaryDid ?? null) + "\n");
        process.stdout.write(formatField("Address", profile?.address ?? null) + "\n");
        process.stdout.write(formatField("Space ID", profile?.spaceId ?? null) + "\n");
        process.stdout.write(formatField("Has Key", hasKey !== null) + "\n");
      }
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
      const authenticated = session !== null;
      if (shouldOutputJson()) {
        outputJson({
          profile: ctx.profile,
          did: profile.did,
          primaryDid: profile.primaryDid ?? null,
          spaceId: profile.spaceId ?? null,
          host: profile.host,
          authenticated,
          authMethod: profile.authMethod ?? null,
          address: profile.address ?? null
        });
      } else {
        process.stdout.write(theme.heading("Identity") + "\n");
        process.stdout.write(formatField("Profile", ctx.profile) + "\n");
        process.stdout.write(formatField("DID", profile.did) + "\n");
        process.stdout.write(formatField("Primary DID", profile.primaryDid ?? null) + "\n");
        process.stdout.write(formatField("Auth Method", profile.authMethod ?? null) + "\n");
        process.stdout.write(formatField("Address", profile.address ?? null) + "\n");
        process.stdout.write(formatField("Space ID", profile.spaceId ?? null) + "\n");
        process.stdout.write(formatField("Host", profile.host) + "\n");
        process.stdout.write(formatField("Authenticated", authenticated) + "\n");
      }
    } catch (error) {
      handleError(error);
    }
  });
}
async function handleLocalAuth(profileName, host) {
  const profile = await ProfileManager.getProfile(profileName).catch(() => null);
  let privateKey;
  let address;
  let did;
  if (profile?.authMethod === "local" && profile.privateKey && profile.address) {
    privateKey = profile.privateKey;
    address = profile.address;
    did = profile.did;
    if (isInteractive()) {
      process.stderr.write(theme.muted("Using existing local key") + "\n");
      process.stderr.write(formatField("Address", address) + "\n");
    }
  } else {
    const identity = await withSpinner("Generating Ethereum key...", async () => {
      return generateLocalIdentity(DEFAULT_CHAIN_ID);
    });
    privateKey = identity.privateKey;
    address = identity.address;
    did = identity.did;
    if (isInteractive()) {
      process.stderr.write("\n" + theme.heading("Local Key Generated") + "\n");
      process.stderr.write(formatField("Address", address) + "\n");
      process.stderr.write(formatField("DID", did) + "\n\n");
    }
  }
  const hasKey = await ProfileManager.getKey(profileName);
  if (!hasKey) {
    const { jwk } = await withSpinner("Generating session key...", async () => {
      return generateKey();
    });
    await ProfileManager.setKey(profileName, jwk);
  }
  const sessionResult = await withSpinner("Signing in...", async () => {
    return localKeySignIn({ privateKey, host });
  });
  await ProfileManager.setSession(profileName, {
    authMethod: "local",
    address,
    chainId: DEFAULT_CHAIN_ID,
    spaceId: sessionResult.spaceId
  });
  await ProfileManager.setProfile(profileName, {
    name: profileName,
    host,
    chainId: DEFAULT_CHAIN_ID,
    spaceName: "default",
    did,
    primaryDid: did,
    spaceId: sessionResult.spaceId,
    createdAt: profile?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    authMethod: "local",
    privateKey,
    address
  });
  outputJson({
    authenticated: true,
    profile: profileName,
    did,
    address,
    spaceId: sessionResult.spaceId,
    authMethod: "local"
  });
}
async function handleOpenKeyAuth(profileName, host, paste) {
  const key = await ProfileManager.getKey(profileName);
  if (!key) {
    throw new CLIError(
      "NO_KEY",
      `No key found for profile "${profileName}". Run \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  const profile = await ProfileManager.getProfile(profileName);
  const delegationData = await startAuthFlow(profile.did, {
    paste,
    jwk: key,
    host
  });
  await ProfileManager.setSession(profileName, delegationData);
  const updatedProfile = {
    ...profile,
    authMethod: "openkey"
  };
  if (delegationData.spaceId) {
    updatedProfile.spaceId = delegationData.spaceId;
    updatedProfile.primaryDid = delegationData.primaryDid;
  }
  await ProfileManager.setProfile(profileName, updatedProfile);
  outputJson({
    authenticated: true,
    profile: profileName,
    did: profile.did,
    spaceId: delegationData.spaceId,
    authMethod: "openkey"
  });
}

// src/commands/kv.ts
import { readFile as readFile2 } from "fs/promises";
import { writeFile as writeFile2 } from "fs/promises";

// src/lib/sdk.ts
import { TinyCloudNode } from "@tinycloud/node-sdk";
async function createSDKInstance(ctx, options) {
  const profile = await ProfileManager.getProfile(ctx.profile);
  const session = await ProfileManager.getSession(ctx.profile);
  const key = await ProfileManager.getKey(ctx.profile);
  const effectivePrivateKey = options?.privateKey ?? profile.privateKey;
  if (!key && !effectivePrivateKey) {
    throw new CLIError(
      "AUTH_REQUIRED",
      `No key found for profile "${ctx.profile}". Run \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  if (profile.authMethod === "local" && effectivePrivateKey) {
    const node2 = new TinyCloudNode({
      host: ctx.host,
      privateKey: effectivePrivateKey
    });
    await node2.signIn();
    return node2;
  }
  const node = new TinyCloudNode({
    host: ctx.host,
    privateKey: options?.privateKey
  });
  if (options?.privateKey) {
    await node.signIn();
  } else if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
    await node.restoreSession({
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: session.spaceId,
      jwk: session.jwk ?? key,
      verificationMethod: session.verificationMethod ?? profile.did,
      address: session.address,
      chainId: session.chainId
    });
  }
  return node;
}
async function ensureAuthenticated(ctx, options) {
  const profile = await ProfileManager.getProfile(ctx.profile).catch(() => null);
  if (profile?.authMethod === "local" && profile.privateKey) {
    return createSDKInstance(ctx, { privateKey: profile.privateKey });
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
      if (shouldOutputJson()) {
        outputJson({
          key,
          data,
          metadata
        });
      } else {
        const content = typeof data === "string" ? data : JSON.stringify(data);
        process.stdout.write(content + "\n");
      }
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
      const rawData = result.data.data ?? result.data;
      const keyList = Array.isArray(rawData) ? rawData : rawData?.keys ?? [];
      if (shouldOutputJson()) {
        outputJson({
          keys: keyList,
          count: keyList.length,
          prefix: options.prefix ?? null
        });
      } else {
        if (keyList.length === 0) {
          process.stdout.write(theme.muted("No keys found.") + "\n");
        } else {
          const rows = keyList.map((e) => [
            e.key || e,
            e.contentLength ? formatBytes(e.contentLength) : "\u2014",
            e.updatedAt ? formatTimeAgo(e.updatedAt) : "\u2014"
          ]);
          process.stdout.write(formatTable(["Key", "Size", "Updated"], rows) + "\n");
        }
      }
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
      if (shouldOutputJson()) {
        outputJson({ spaces: result.data, count: result.data.length });
      } else {
        if (result.data.length === 0) {
          process.stdout.write(theme.muted("No spaces found.") + "\n");
        } else {
          const rows = result.data.map((s) => [
            s.id || s.spaceId || "\u2014",
            s.name || "\u2014",
            s.owner || "\u2014"
          ]);
          process.stdout.write(formatTable(["Space ID", "Name", "Owner"], rows) + "\n");
        }
      }
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
      const response = await fetch(`${ctx.host}/info`);
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
        fetch(`${ctx.host}/info`)
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
import { createInterface as createInterface3 } from "readline";
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
      if (shouldOutputJson()) {
        outputJson({
          profiles,
          defaultProfile: config.defaultProfile
        });
      } else {
        for (const p of profiles) {
          const marker = p.active ? theme.success("\u25CF ") : "  ";
          const name = p.active ? theme.brand(p.name) : p.name;
          const host = theme.muted(p.host || "no host");
          process.stdout.write(`${marker}${name}  ${host}
`);
        }
      }
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
      const isDefault = profileName === config.defaultProfile;
      if (shouldOutputJson()) {
        outputJson({
          ...p,
          hasKey,
          hasSession,
          isDefault
        });
      } else {
        process.stdout.write(`${theme.heading(p.name)}${isDefault ? theme.success(" (default)") : ""}
`);
        process.stdout.write(formatField("Host", p.host) + "\n");
        process.stdout.write(formatField("DID", p.did) + "\n");
        process.stdout.write(formatField("Space", p.spaceId || null) + "\n");
        process.stdout.write(formatField("Key", hasKey) + "\n");
        process.stdout.write(formatField("Session", hasSession) + "\n");
        process.stdout.write(formatField("Created", p.createdAt) + "\n");
      }
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
        const rl = createInterface3({ input: process.stdin, output: process.stderr });
        const answer = await new Promise((resolve3) => {
          rl.question(`Delete profile "${name}"? This cannot be undone. [y/N] `, resolve3);
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

// src/commands/vault.ts
import { readFile as readFile3 } from "fs/promises";
import { writeFile as writeFile3 } from "fs/promises";
import { PrivateKeySigner as PrivateKeySigner2 } from "@tinycloud/node-sdk";
async function readStdin2() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
function resolvePrivateKey(options) {
  const key = options.privateKey || process.env.TC_PRIVATE_KEY;
  if (!key) {
    throw new CLIError(
      "AUTH_REQUIRED",
      "Private key required. Use --private-key <hex> or set TC_PRIVATE_KEY env var.",
      ExitCode.AUTH_REQUIRED
    );
  }
  return key;
}
async function unlockVault(node, privateKey) {
  const signer = new PrivateKeySigner2(privateKey);
  const result = await node.vault.unlock(signer);
  if (result && !result.ok) {
    throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
  }
}
function registerVaultCommand(program2) {
  const vault = program2.command("vault").description("Encrypted vault operations");
  vault.command("unlock").description("Verify vault unlock works").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));
      outputJson({ unlocked: true });
    } catch (error) {
      handleError(error);
    }
  });
  vault.command("put <key> [value]").description("Encrypt and store a value").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (key, value, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));
      let putValue;
      const sources = [value !== void 0, !!options.file, !!options.stdin].filter(Boolean);
      if (sources.length === 0) {
        throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (sources.length > 1) {
        throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (options.file) {
        putValue = new Uint8Array(await readFile3(options.file));
      } else if (options.stdin) {
        putValue = new Uint8Array(await readStdin2());
      } else {
        putValue = value;
      }
      const result = await withSpinner(`Writing ${key}...`, () => node.vault.put(key, putValue));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ key, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  vault.command("get <key>").description("Decrypt and retrieve a value").option("--raw", "Output raw value (no JSON wrapping)").option("-o, --output <file>", "Write value to file").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (key, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));
      const result = await withSpinner(`Getting ${key}...`, () => node.vault.get(key));
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") {
          throw new CLIError("NOT_FOUND", `Key "${key}" not found`, ExitCode.NOT_FOUND);
        }
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const data = result.data.data ?? result.data;
      if (options.output) {
        const content = data instanceof Uint8Array ? Buffer.from(data) : typeof data === "string" ? data : JSON.stringify(data);
        await writeFile3(options.output, content);
        outputJson({ key, written: options.output });
        return;
      }
      if (options.raw) {
        const content = data instanceof Uint8Array ? Buffer.from(data) : typeof data === "string" ? data : JSON.stringify(data);
        process.stdout.write(content);
        return;
      }
      outputJson({
        key,
        data: data instanceof Uint8Array ? Buffer.from(data).toString("base64") : data
      });
    } catch (error) {
      handleError(error);
    }
  });
  vault.command("delete <key>").description("Delete an encrypted key").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (key, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));
      const result = await withSpinner(`Deleting ${key}...`, () => node.vault.delete(key));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ key, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
  vault.command("list").description("List vault keys").option("--prefix <prefix>", "Filter by key prefix").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));
      const listOptions = options.prefix ? { prefix: options.prefix } : void 0;
      const result = await withSpinner("Listing vault keys...", () => node.vault.list(listOptions));
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
  vault.command("head <key>").description("Get metadata for a vault key").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (key, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault(node, privateKey));
      const result = await withSpinner(`Checking ${key}...`, () => node.vault.head(key));
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") {
          outputJson({ key, exists: false, metadata: {} });
          return;
        }
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({
        key,
        exists: true,
        metadata: result.data.headers ?? result.data
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/secrets.ts
import { readFile as readFile4 } from "fs/promises";
import { writeFile as writeFile4 } from "fs/promises";
import { PrivateKeySigner as PrivateKeySigner3 } from "@tinycloud/node-sdk";
var SECRETS_PREFIX = "secrets/";
async function readStdin3() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
function resolvePrivateKey2(options) {
  const key = options.privateKey || process.env.TC_PRIVATE_KEY;
  if (!key) {
    throw new CLIError(
      "AUTH_REQUIRED",
      "Private key required. Use --private-key <hex> or set TC_PRIVATE_KEY env var.",
      ExitCode.AUTH_REQUIRED
    );
  }
  return key;
}
async function unlockVault2(node, privateKey) {
  const signer = new PrivateKeySigner3(privateKey);
  const result = await node.vault.unlock(signer);
  if (result && !result.ok) {
    throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
  }
}
function registerSecretsCommand(program2) {
  const secrets = program2.command("secrets").description("Encrypted secrets management");
  secrets.command("list").description("List secrets").option("--space <spaceId>", "Space to list secrets from (for delegated access)").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey2(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault2(node, privateKey));
      if (options.space) {
        throw new CLIError(
          "NOT_IMPLEMENTED",
          `Listing secrets from a delegated space (${options.space}) is not yet supported at the SDK level. The vault service currently operates on the space bound to the active session. SDK support for cross-space vault operations is planned.`,
          ExitCode.ERROR
        );
      }
      const result = await withSpinner("Listing secrets...", () => node.vault.list({ prefix: SECRETS_PREFIX }));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const keys = result.data.data ?? result.data;
      const keyList = Array.isArray(keys) ? keys : [];
      const secretNames = keyList.map(
        (k) => typeof k === "string" && k.startsWith(SECRETS_PREFIX) ? k.slice(SECRETS_PREFIX.length) : k
      );
      outputJson({
        secrets: secretNames,
        count: secretNames.length,
        ...options.space ? { space: options.space } : {}
      });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("get <name>").description("Get a secret value").option("--raw", "Output raw value (no JSON wrapping)").option("-o, --output <file>", "Write value to file").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey2(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault2(node, privateKey));
      const vaultKey = `${SECRETS_PREFIX}${name}`;
      const result = await withSpinner(`Getting secret ${name}...`, () => node.vault.get(vaultKey));
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") {
          throw new CLIError("NOT_FOUND", `Secret "${name}" not found`, ExitCode.NOT_FOUND);
        }
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const data = result.data.data ?? result.data;
      let value;
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          value = parsed.value;
        } catch {
          value = data;
        }
      } else if (data instanceof Uint8Array) {
        try {
          const parsed = JSON.parse(Buffer.from(data).toString("utf-8"));
          value = parsed.value;
        } catch {
          value = Buffer.from(data).toString("utf-8");
        }
      } else {
        value = data.value ?? data;
      }
      if (options.output) {
        await writeFile4(options.output, value);
        outputJson({ name, written: options.output });
        return;
      }
      if (options.raw) {
        process.stdout.write(value);
        return;
      }
      outputJson({ name, value });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("put <name> [value]").description("Store a secret").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, value, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey2(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault2(node, privateKey));
      let secretValue;
      const sources = [value !== void 0, !!options.file, !!options.stdin].filter(Boolean);
      if (sources.length === 0) {
        throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (sources.length > 1) {
        throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (options.file) {
        secretValue = await readFile4(options.file, "utf-8");
      } else if (options.stdin) {
        secretValue = (await readStdin3()).toString("utf-8");
      } else {
        secretValue = value;
      }
      const payload = JSON.stringify({
        value: secretValue,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      const vaultKey = `${SECRETS_PREFIX}${name}`;
      const result = await withSpinner(`Storing secret ${name}...`, () => node.vault.put(vaultKey, payload));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("delete <name>").description("Delete a secret").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey2(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      await withSpinner("Unlocking vault...", () => unlockVault2(node, privateKey));
      const vaultKey = `${SECRETS_PREFIX}${name}`;
      const result = await withSpinner(`Deleting secret ${name}...`, () => node.vault.delete(vaultKey));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("manage").description("Open the TinyCloud Secrets Manager in your browser").action(async () => {
    try {
      const open = (await import("open")).default;
      await open("https://secrets.tinycloud.xyz");
      outputJson({ opened: "https://secrets.tinycloud.xyz" });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/vars.ts
import { readFile as readFile5 } from "fs/promises";
import { writeFile as writeFile5 } from "fs/promises";
var VARIABLES_PREFIX = "variables/";
async function readStdin4() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
function resolvePrivateKey3(options) {
  const key = options.privateKey || process.env.TC_PRIVATE_KEY;
  if (!key) {
    throw new CLIError(
      "AUTH_REQUIRED",
      "Private key required. Use --private-key <hex> or set TC_PRIVATE_KEY env var.",
      ExitCode.AUTH_REQUIRED
    );
  }
  return key;
}
function registerVarsCommand(program2) {
  const vars = program2.command("vars").description("Plaintext variable management");
  vars.command("list").description("List variables").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey3(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
      const result = await withSpinner("Listing variables...", () => prefixedKv.list());
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const rawData = result.data.data ?? result.data;
      const keyList = Array.isArray(rawData) ? rawData : rawData?.keys ?? [];
      outputJson({
        variables: keyList,
        count: keyList.length
      });
    } catch (error) {
      handleError(error);
    }
  });
  vars.command("get <name>").description("Get a variable value").option("--raw", "Output raw value (no JSON wrapping)").option("-o, --output <file>", "Write value to file").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey3(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
      const result = await withSpinner(`Getting variable ${name}...`, () => prefixedKv.get(name));
      if (!result.ok) {
        if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
          throw new CLIError("NOT_FOUND", `Variable "${name}" not found`, ExitCode.NOT_FOUND);
        }
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const data = result.data.data;
      let value;
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          value = parsed.value;
        } catch {
          value = data;
        }
      } else if (data && typeof data === "object" && "value" in data) {
        value = data.value;
      } else {
        value = typeof data === "string" ? data : JSON.stringify(data);
      }
      if (options.output) {
        await writeFile5(options.output, value);
        outputJson({ name, written: options.output });
        return;
      }
      if (options.raw) {
        process.stdout.write(value);
        return;
      }
      outputJson({ name, value });
    } catch (error) {
      handleError(error);
    }
  });
  vars.command("put <name> [value]").description("Set a variable").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, value, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey3(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      let varValue;
      const sources = [value !== void 0, !!options.file, !!options.stdin].filter(Boolean);
      if (sources.length === 0) {
        throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (sources.length > 1) {
        throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (options.file) {
        varValue = await readFile5(options.file, "utf-8");
      } else if (options.stdin) {
        varValue = (await readStdin4()).toString("utf-8");
      } else {
        varValue = value;
      }
      const payload = {
        value: varValue,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
      const result = await withSpinner(`Setting variable ${name}...`, () => prefixedKv.put(name, payload));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  vars.command("delete <name>").description("Delete a variable").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey3(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
      const result = await withSpinner(`Deleting variable ${name}...`, () => prefixedKv.delete(name));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/doctor.ts
function registerDoctorCommand(program2) {
  program2.command("doctor").description("Run diagnostic checks").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const checks = [];
      const nodeVersion = process.version;
      const nodeOk = parseInt(nodeVersion.slice(1)) >= 18;
      checks.push({ name: "Node.js", ok: nodeOk, detail: nodeVersion });
      let profileName = globalOpts.profile;
      let profileOk = false;
      let profileDetail = "";
      try {
        const config = await ProfileManager.getConfig();
        profileName = profileName || config.defaultProfile;
        const profile = await ProfileManager.getProfile(profileName);
        profileOk = true;
        profileDetail = `"${profileName}" at ${profile.host}`;
      } catch {
        profileDetail = profileName ? `"${profileName}" not found` : "no profiles configured";
      }
      checks.push({ name: "Profile", ok: profileOk, detail: profileDetail });
      let keyOk = false;
      let keyDetail = "";
      if (profileOk && profileName) {
        try {
          const key = await ProfileManager.getKey(profileName);
          keyOk = key !== null;
          if (keyOk) {
            const profile = await ProfileManager.getProfile(profileName);
            keyDetail = profile.did ? `${profile.did.slice(0, 20)}...` : "key found";
          } else {
            keyDetail = "no key \u2014 run tc init";
          }
        } catch {
          keyDetail = "error reading key";
        }
      } else {
        keyDetail = "skipped (no profile)";
      }
      checks.push({ name: "Key", ok: keyOk, detail: keyDetail });
      let sessionOk = false;
      let sessionDetail = "";
      if (profileOk && profileName) {
        try {
          const session = await ProfileManager.getSession(profileName);
          sessionOk = session !== null;
          sessionDetail = sessionOk ? "active" : "no session \u2014 run tc auth login";
        } catch {
          sessionDetail = "error reading session";
        }
      } else {
        sessionDetail = "skipped (no profile)";
      }
      checks.push({ name: "Session", ok: sessionOk, detail: sessionDetail });
      let nodeReachable = false;
      let nodeDetail = "";
      try {
        const host = profileOk && profileName ? (await ProfileManager.getProfile(profileName)).host : globalOpts.host || DEFAULT_HOST;
        const start = Date.now();
        const response = await fetch(`${host}/health`);
        const latency = Date.now() - start;
        nodeReachable = response.ok;
        nodeDetail = nodeReachable ? `${host} (${latency}ms)` : `${host} returned ${response.status}`;
      } catch (e) {
        nodeDetail = `unreachable \u2014 ${e instanceof Error ? e.message : "connection failed"}`;
      }
      checks.push({ name: "Node", ok: nodeReachable, detail: nodeDetail });
      let spaceOk = false;
      let spaceDetail = "";
      if (sessionOk && profileName) {
        try {
          const profile = await ProfileManager.getProfile(profileName);
          spaceOk = Boolean(profile.spaceId);
          spaceDetail = spaceOk ? `${profile.spaceId.slice(0, 16)}...` : "no space \u2014 run tc space create";
        } catch {
          spaceDetail = "error checking space";
        }
      } else {
        spaceDetail = "skipped (no session)";
      }
      checks.push({ name: "Space", ok: spaceOk, detail: spaceDetail });
      const result = {
        checks,
        healthy: checks.every((c) => c.ok)
      };
      if (shouldOutputJson()) {
        outputJson(result);
      } else {
        process.stderr.write(formatSection("Diagnostics") + "\n");
        for (const check of checks) {
          process.stdout.write(formatCheck(check.ok, check.name, check.detail) + "\n");
        }
        process.stdout.write("\n");
        if (result.healthy) {
          process.stdout.write(theme.success("All checks passed.") + "\n");
        } else {
          const failed = checks.filter((c) => !c.ok).length;
          process.stdout.write(theme.warn(`${failed} check${failed > 1 ? "s" : ""} need attention.`) + "\n");
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/sql.ts
import { writeFile as writeFile6 } from "fs/promises";
import { resolve } from "path";
function registerSqlCommand(program2) {
  const sql = program2.command("sql").description("SQL database operations");
  sql.command("query <sql>").description("Run a SELECT query").option("--db <name>", "Database name", "default").option("--params <json>", "Bind parameters as JSON array").action(async (sqlStr, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const params = options.params ? JSON.parse(options.params) : void 0;
      const result = await withSpinner(
        "Running query...",
        () => node.sql.db(options.db).query(sqlStr, params)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const { columns, rows, rowCount } = result.data;
      if (shouldOutputJson()) {
        outputJson({ columns, rows, rowCount });
      } else {
        if (rows.length === 0) {
          process.stdout.write(theme.muted("No rows returned.") + "\n");
        } else {
          const stringRows = rows.map(
            (row) => row.map((v) => v === null ? "NULL" : String(v))
          );
          process.stdout.write(formatTable(columns, stringRows) + "\n");
          process.stdout.write(theme.muted(`
${rowCount} row${rowCount === 1 ? "" : "s"} returned`) + "\n");
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
  sql.command("execute <sql>").description("Run INSERT/UPDATE/DELETE/DDL statement").option("--db <name>", "Database name", "default").option("--params <json>", "Bind parameters as JSON array").action(async (sqlStr, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const params = options.params ? JSON.parse(options.params) : void 0;
      const result = await withSpinner(
        "Executing statement...",
        () => node.sql.db(options.db).execute(sqlStr, params)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({
        changes: result.data.changes,
        lastInsertRowId: result.data.lastInsertRowId
      });
    } catch (error) {
      handleError(error);
    }
  });
  sql.command("export").description("Export database as binary file").option("--db <name>", "Database name", "default").option("-o, --output <file>", "Output file path", "export.db").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await withSpinner(
        "Exporting database...",
        () => node.sql.db(options.db).export()
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const blob = result.data;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const outputPath = resolve(options.output);
      await writeFile6(outputPath, buffer);
      outputJson({
        file: outputPath,
        size: blob.size,
        sizeHuman: formatBytes(blob.size)
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/duckdb.ts
import { readFile as readFile6, writeFile as writeFile7 } from "fs/promises";
import { resolve as resolve2 } from "path";
function registerDuckdbCommand(program2) {
  const duckdb = program2.command("duckdb").description("DuckDB database operations");
  duckdb.command("query <sql>").description("Run a SELECT query").option("--db <name>", "Database name", "default").option("--params <json>", "Bind parameters as JSON array").action(async (sqlStr, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const params = options.params ? JSON.parse(options.params) : void 0;
      const result = await withSpinner(
        "Running query...",
        () => node.duckdb.db(options.db).query(sqlStr, params)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const { columns, rows, rowCount } = result.data;
      if (shouldOutputJson()) {
        outputJson({ columns, rows, rowCount });
      } else {
        if (rows.length === 0) {
          process.stdout.write(theme.muted("No rows returned.") + "\n");
        } else {
          const stringRows = rows.map(
            (row) => row.map((v) => v === null ? "NULL" : String(v))
          );
          process.stdout.write(formatTable(columns, stringRows) + "\n");
          process.stdout.write(theme.muted(`
${rowCount} row${rowCount === 1 ? "" : "s"} returned`) + "\n");
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
  duckdb.command("execute <sql>").description("Run INSERT/UPDATE/DELETE/DDL statement").option("--db <name>", "Database name", "default").option("--params <json>", "Bind parameters as JSON array").action(async (sqlStr, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const params = options.params ? JSON.parse(options.params) : void 0;
      const result = await withSpinner(
        "Executing statement...",
        () => node.duckdb.db(options.db).execute(sqlStr, params)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ changes: result.data.changes });
    } catch (error) {
      handleError(error);
    }
  });
  duckdb.command("describe").description("Show database schema (tables, columns, views)").option("--db <name>", "Database name", "default").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await withSpinner(
        "Describing schema...",
        () => node.duckdb.db(options.db).describe()
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const schema = result.data;
      if (shouldOutputJson()) {
        outputJson(schema);
      } else {
        const { tables, views } = schema;
        if (tables.length === 0 && views.length === 0) {
          process.stdout.write(theme.muted("No tables or views found.") + "\n");
          return;
        }
        if (tables.length > 0) {
          process.stdout.write(theme.label("Tables:") + "\n\n");
          for (const table of tables) {
            process.stdout.write(`  ${theme.value(table.name)}
`);
            const colRows = table.columns.map((col) => [
              col.name,
              col.type,
              col.nullable ? "YES" : "NO"
            ]);
            const colTable = formatTable(["Column", "Type", "Nullable"], colRows);
            process.stdout.write(colTable.split("\n").map((l) => "    " + l).join("\n") + "\n\n");
          }
        }
        if (views.length > 0) {
          process.stdout.write(theme.label("Views:") + "\n\n");
          const viewRows = views.map((v) => [v.name, v.sql]);
          process.stdout.write(formatTable(["View", "SQL"], viewRows) + "\n");
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
  duckdb.command("export").description("Export database as binary file").option("--db <name>", "Database name", "default").option("-o, --output <file>", "Output file path", "export.duckdb").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const result = await withSpinner(
        "Exporting database...",
        () => node.duckdb.db(options.db).export()
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const blob = result.data;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const outputPath = resolve2(options.output);
      await writeFile7(outputPath, buffer);
      outputJson({
        file: outputPath,
        size: blob.size,
        sizeHuman: formatBytes(blob.size)
      });
    } catch (error) {
      handleError(error);
    }
  });
  duckdb.command("import <file>").description("Import a DuckDB database file").option("--db <name>", "Database name", "default").action(async (file, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const filePath = resolve2(file);
      const bytes = new Uint8Array(await readFile6(filePath));
      const result = await withSpinner(
        "Importing database...",
        () => node.duckdb.db(options.db).import(bytes)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({
        file: filePath,
        size: bytes.byteLength,
        sizeHuman: formatBytes(bytes.byteLength),
        imported: true
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/upgrade.ts
import { execSync as execSync2 } from "child_process";
import { readFileSync } from "fs";
var PACKAGE_NAME = "@tinycloud/cli";
function getCurrentVersion() {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  );
  return pkg.version;
}
async function getLatestVersion() {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
  if (!res.ok) {
    throw new Error(`Failed to fetch latest version: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.version;
}
function detectPackageManager() {
  try {
    const bunGlobals = execSync2("bun pm ls -g", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (bunGlobals.includes(PACKAGE_NAME)) {
      return "bun";
    }
  } catch {
  }
  try {
    const npmGlobals = execSync2("npm ls -g --depth=0", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (npmGlobals.includes(PACKAGE_NAME)) {
      return "npm";
    }
  } catch {
  }
  return "bun";
}
function registerUpgradeCommand(program2) {
  program2.command("upgrade").description("Upgrade the TinyCloud CLI to the latest version").action(async () => {
    try {
      const current = getCurrentVersion();
      process.stderr.write(theme.muted("Checking for updates...") + "\n");
      const latest = await getLatestVersion();
      if (current === latest) {
        process.stdout.write(theme.success(`Already on latest version (${current})`) + "\n");
        return;
      }
      process.stdout.write(`Current: ${theme.warn(current)} \u2192 Latest: ${theme.success(latest)}
`);
      const pm = detectPackageManager();
      const cmd = pm === "bun" ? `bun install -g ${PACKAGE_NAME}@latest` : `npm install -g ${PACKAGE_NAME}@latest`;
      process.stderr.write(theme.muted(`Upgrading via ${pm}...`) + "\n\n");
      try {
        execSync2(cmd, { stdio: "inherit" });
        process.stdout.write("\n" + theme.success(`Upgraded to ${latest}`) + "\n");
      } catch {
        process.stderr.write("\n" + theme.warn("Automatic upgrade failed.") + "\n");
        process.stderr.write(theme.muted("Try running manually:") + "\n");
        process.stderr.write(`  ${theme.command(`bun install -g ${PACKAGE_NAME}@latest`)}
`);
        process.stderr.write(theme.muted("  or") + "\n");
        process.stderr.write(`  ${theme.command(`npm install -g ${PACKAGE_NAME}@latest`)}
`);
      }
    } catch (error) {
      handleError(error);
    }
  });
}

// src/index.ts
var { version } = JSON.parse(
  readFileSync2(new URL("../package.json", import.meta.url), "utf-8")
);
var program = new Command();
program.name("tc").description("TinyCloud CLI \u2014 self-sovereign storage from the terminal").version(version).option("-p, --profile <name>", "Profile to use").option("-H, --host <url>", "TinyCloud node URL").option("-v, --verbose", "Enable verbose output").option("--no-cache", "Disable caching").option("-q, --quiet", "Suppress non-essential output").option("--json", "Force JSON output");
program.hook("preAction", async (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (!opts.quiet) {
    emitBanner(version);
  }
  const commandName = thisCommand.name();
  const parentName = thisCommand.parent?.name();
  const fullCommand = parentName && parentName !== "tc" ? `${parentName} ${commandName}` : commandName;
  const skipGuard = ["tc", "init", "doctor", "completion", "help", "upgrade"].includes(commandName) || fullCommand === "profile create";
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
registerInitCommand(program);
registerAuthCommand(program);
registerKvCommand(program);
registerSpaceCommand(program);
registerDelegationCommand(program);
registerShareCommand(program);
registerNodeCommand(program);
registerProfileCommand(program);
registerCompletionCommand(program);
registerVaultCommand(program);
registerSecretsCommand(program);
registerVarsCommand(program);
registerDoctorCommand(program);
registerSqlCommand(program);
registerDuckdbCommand(program);
registerUpgradeCommand(program);
program.addHelpText("afterAll", () => {
  if (!process.stdout.isTTY) return "";
  return `
${theme.heading("Examples:")}
  ${theme.command("tc init")}                              ${theme.muted("Set up a profile and generate keys")}
  ${theme.command("tc auth login")}                        ${theme.muted("Authenticate via browser")}
  ${theme.command('tc kv put greeting "Hello"')}           ${theme.muted("Store a value")}
  ${theme.command("tc kv list")}                           ${theme.muted("List all keys")}
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
//# sourceMappingURL=index.js.map
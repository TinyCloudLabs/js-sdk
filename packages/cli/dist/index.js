// src/index.ts
import { readFileSync as readFileSync3 } from "fs";
import { Command } from "commander";

// src/output/errors.ts
import { readFileSync, readdirSync } from "fs";
import { join as join2 } from "path";

// src/config/constants.ts
import { homedir } from "os";
import { join } from "path";
var CONFIG_DIR = join(homedir(), ".tinycloud");
var PROFILES_DIR = join(CONFIG_DIR, "profiles");
var CONFIG_FILE = join(CONFIG_DIR, "config.json");
var DEFAULT_HOST = "https://node.tinycloud.xyz";
var DEFAULT_OPENKEY_HOST = "https://openkey.so";
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
function outputError(code, message, hint) {
  if (isInteractive()) {
    process.stderr.write(
      `${theme.error("\u2717")} ${theme.label(code)}: ${message}
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
      error: { code, message }
    };
    if (hint) payload.error.hint = hint;
    process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
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
var activeProfileName;
function setActiveProfileName(name) {
  activeProfileName = name;
}
var CLIError = class extends Error {
  constructor(code, message, exitCode = ExitCode.ERROR, metadata) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.metadata = metadata;
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
  const hint = buildAuthHint(cliError) ?? (cliError.code === "NETWORK_ERROR" ? buildNetworkHint() : void 0);
  outputError(cliError.code, cliError.message, hint);
  process.exit(cliError.exitCode);
}
function buildAuthHint(error) {
  const resource = error.metadata?.resource;
  const requiredAction = error.metadata?.requiredAction;
  if (typeof resource !== "string" || typeof requiredAction !== "string") {
    return void 0;
  }
  const spec = capSpecFromAuthMeta(resource, requiredAction);
  if (!spec) return void 0;
  return [
    "The active session is missing a TinyCloud capability.",
    `Request it with: tc auth request --cap "${spec}"`,
    "Then retry the original command."
  ].join("\n");
}
function capSpecFromAuthMeta(resource, action) {
  const slash = resource.indexOf("/");
  if (slash <= 0 || slash === resource.length - 1) return void 0;
  const spaceUri = resource.slice(0, slash);
  const rest = resource.slice(slash + 1);
  const nextSlash = rest.indexOf("/");
  if (nextSlash <= 0) return void 0;
  const serviceShort = rest.slice(0, nextSlash);
  const path = rest.slice(nextSlash + 1);
  const actionName = action.includes("/") ? action.slice(action.indexOf("/") + 1) : action;
  const spaceName = spaceUri.startsWith("tinycloud:") ? spaceUri.slice(spaceUri.lastIndexOf(":") + 1) : spaceUri;
  return `tinycloud.${serviceShort}:${spaceName}:${path}:${actionName}`;
}
function buildNetworkHint() {
  const readHost = (name) => {
    try {
      const raw = readFileSync(join2(PROFILES_DIR, name, "profile.json"), "utf8");
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
import { join as join3 } from "path";
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
    const profilePath = join3(PROFILES_DIR, name, "profile.json");
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
    const profileDir = join3(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join3(profileDir, "profile.json"), data);
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
    const profileDir = join3(PROFILES_DIR, name);
    await removeDir(profileDir);
  }
  // ── Key management ──────────────────────────────────────────────────
  /**
   * Returns the parsed JWK for a profile, or null if no key exists.
   */
  static async getKey(name) {
    return readJson(join3(PROFILES_DIR, name, "key.json"));
  }
  /**
   * Saves a JWK key for a profile.
   */
  static async setKey(name, jwk) {
    const profileDir = join3(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join3(profileDir, "key.json"), jwk);
  }
  // ── Session management ──────────────────────────────────────────────
  /**
   * Returns the parsed session for a profile, or null if none exists.
   */
  static async getSession(name) {
    return readJson(join3(PROFILES_DIR, name, "session.json"));
  }
  /**
   * Saves session data for a profile.
   */
  static async setSession(name, session) {
    const profileDir = join3(PROFILES_DIR, name);
    await ensureDir(profileDir);
    await writeJson(join3(profileDir, "session.json"), session);
  }
  /**
   * Removes the session file for a profile.
   */
  static async clearSession(name) {
    const sessionPath = join3(PROFILES_DIR, name, "session.json");
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
    const cacheDir = join3(PROFILES_DIR, name, "cache");
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

// src/auth/local-key.ts
import { TCWSessionManager, importKey, initPanicHook } from "@tinycloud/node-sdk-wasm";
import { PrivateKeySigner, pkhDid } from "@tinycloud/node-sdk";
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
function keyToDID(jwk) {
  ensureWasm();
  const mgr = new TCWSessionManager();
  const keyId = importKey(mgr, JSON.stringify(jwk), "imported");
  return mgr.getDID(keyId);
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
  return pkhDid(address, chainId);
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
  const session = node.session;
  if (!session) {
    throw new Error("Local key sign-in did not produce a TinyCloud session");
  }
  return {
    spaceId: session.spaceId,
    address,
    chainId: 1,
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    jwk: session.jwk,
    verificationMethod: session.verificationMethod,
    siwe: session.siwe,
    signature: session.signature
  };
}

// src/auth/browser-auth.ts
import { createServer } from "http";
import { createInterface } from "readline";
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
  if (options.permissions?.length) {
    params.set(
      "permissions",
      Buffer.from(JSON.stringify({ permissions: options.permissions })).toString("base64url")
    );
  }
  if (options.expiry !== void 0) {
    params.set("expiry", String(options.expiry));
  }
  const base = options.openkeyHost ?? DEFAULT_OPENKEY_HOST;
  return `${base}/delegate?${params.toString()}`;
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
        ownerDid: delegationData.ownerDid
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
import { get as httpGet } from "http";
import { get as httpsGet } from "https";
import { spawn } from "child_process";
import { mkdir as mkdir2, readFile as readFile3, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2 } from "path";
import { createInterface as createInterface2 } from "readline";

// src/config/types.ts
var CLI_PROFILE_POSTURES = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key"
];
var CLI_OPERATOR_TYPES = ["human", "agent"];
function isCLIProfilePosture(value) {
  return typeof value === "string" && CLI_PROFILE_POSTURES.includes(value);
}
function isCLIOperatorType(value) {
  return typeof value === "string" && CLI_OPERATOR_TYPES.includes(value);
}
function resolveProfilePosture(profile) {
  if (isCLIProfilePosture(profile.posture)) return profile.posture;
  if (profile.authMethod === "local") return "local-owner-key";
  return "owner-openkey";
}
function resolveProfileOperatorType(profile) {
  if (isCLIOperatorType(profile.operatorType)) return profile.operatorType;
  return "human";
}

// src/lib/sdk.ts
import { TinyCloudNode } from "@tinycloud/node-sdk";

// src/lib/permissions.ts
import { randomBytes as randomBytes2 } from "crypto";
import { appendFile, readFile as readFile2 } from "fs/promises";
import { join as join4 } from "path";
import {
  expandActionShortNames,
  isCapabilitySubset,
  resolveManifest
} from "@tinycloud/node-sdk";

// src/lib/space.ts
import {
  buildSpaceUri,
  canonicalizeAddress,
  makePkhSpaceId,
  parsePkhDid,
  parseSpaceUri
} from "@tinycloud/node-sdk";
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
async function resolveSpaceUri(input, profileName) {
  if (!input) return void 0;
  if (input.startsWith("tinycloud:")) {
    const parsed = parseSpaceUri(input);
    if (!parsed) {
      throw new CLIError(
        "INVALID_SPACE",
        `Invalid --space "${input}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
        ExitCode.USAGE_ERROR
      );
    }
    return buildSpaceUri(parsed.owner, parsed.name);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new CLIError(
      "INVALID_SPACE",
      `Invalid --space "${input}". Use a short name ([A-Za-z0-9_-]) or a full tinycloud:... URI.`,
      ExitCode.USAGE_ERROR
    );
  }
  const profile = await ProfileManager.getProfile(profileName);
  const session = await ProfileManager.getSession(profileName);
  const address = resolveAddress(profile, session);
  const chainId = resolveChainId(profile, session);
  return makePkhSpaceId(address, chainId, input);
}

// src/lib/permissions.ts
function additionalDelegationsPath(profile) {
  return join4(PROFILES_DIR, profile, "additional-delegations.json");
}
function permissionRequestsPath(profile) {
  return join4(PROFILES_DIR, profile, "auth-requests.json");
}
function grantHistoryPath(profile) {
  return join4(PROFILES_DIR, profile, "auth-grants.jsonl");
}
function createPermissionRequestArtifact(params) {
  return {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: `req_${Date.now().toString(36)}_${randomBytes2(4).toString("hex")}`,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    profile: params.profileName,
    posture: resolveProfilePosture(params.profile),
    operatorType: resolveProfileOperatorType(params.profile),
    host: params.host,
    sessionDid: didWithoutFragment(params.profile.sessionDid ?? params.profile.did),
    ownerDid: params.profile.ownerDid,
    spaceId: params.profile.spaceId,
    requestedExpiry: params.requestedExpiry,
    requested: params.requested,
    command: {
      argv: params.argv ?? process.argv.slice(2),
      cwd: params.cwd ?? process.cwd()
    }
  };
}
function didWithoutFragment(did) {
  const fragment = did.indexOf("#");
  return fragment === -1 ? did : did.slice(0, fragment);
}
async function loadAdditionalDelegations(profile) {
  const raw = await readJson(
    additionalDelegationsPath(profile)
  );
  return Array.isArray(raw) ? raw : [];
}
async function saveAdditionalDelegations(profile, entries) {
  const profileDir = join4(PROFILES_DIR, profile);
  await ensureDir(profileDir);
  await writeJson(additionalDelegationsPath(profile), entries);
}
async function appendAdditionalDelegation(profile, entry) {
  const existing = await loadAdditionalDelegations(profile);
  const next = existing.filter((item) => item.delegation.cid !== entry.delegation.cid);
  next.push(entry);
  await saveAdditionalDelegations(profile, next);
}
async function loadPermissionRequestArtifacts(profile) {
  const raw = await readJson(
    permissionRequestsPath(profile)
  );
  return Array.isArray(raw) ? raw.filter(isPermissionRequestArtifact) : [];
}
async function savePermissionRequestArtifacts(profile, entries) {
  const profileDir = join4(PROFILES_DIR, profile);
  await ensureDir(profileDir);
  await writeJson(permissionRequestsPath(profile), entries);
}
async function appendPermissionRequestArtifact(profile, artifact) {
  const existing = await loadPermissionRequestArtifacts(profile);
  const next = existing.filter((item) => item.requestId !== artifact.requestId);
  next.push(artifact);
  await savePermissionRequestArtifacts(profile, next);
}
async function getPermissionRequestArtifact(profile, requestId) {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.find((item) => item.requestId === requestId) ?? null;
}
async function getLastPermissionRequestArtifact(profile) {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.at(-1) ?? null;
}
function isPermissionRequestArtifact(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  return candidate.kind === "tinycloud.auth.request" && candidate.version === 1 && typeof candidate.requestId === "string" && Array.isArray(candidate.requested);
}
function isDelegationImportArtifact(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  return candidate.kind === "tinycloud.auth.delegation" && candidate.version === 1 && candidate.delegation !== void 0 && typeof candidate.delegation === "object";
}
async function replayAdditionalDelegations(node, profile) {
  const entries = await loadAdditionalDelegations(profile);
  for (const entry of entries) {
    const expiry = entry.delegation.expiry instanceof Date ? entry.delegation.expiry : new Date(entry.delegation.expiry);
    if (expiry.getTime() <= Date.now()) continue;
    try {
      await node.useRuntimeDelegation({ ...entry.delegation, expiry });
    } catch (err) {
      if (process.env.TC_DEBUG_REPLAY === "1") {
        process.stderr.write(`[replay] skipping ${entry.delegation.cid}: ${err.message}
`);
      }
    }
  }
}
function storedAdditionalDelegation(delegation, permissions) {
  return { delegation, permissions };
}
async function appendGrantHistory(profile, entry) {
  const profileDir = join4(PROFILES_DIR, profile);
  await ensureDir(profileDir);
  const line = JSON.stringify({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    profile,
    ...entry
  }) + "\n";
  await appendFile(grantHistoryPath(profile), line, "utf8");
}
async function readGrantHistory(profile) {
  const path = grantHistoryPath(profile);
  if (!await fileExists(path)) return [];
  const raw = await readFile2(path, "utf8");
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
async function parseCapSpec(spec, profile) {
  const firstColon = spec.indexOf(":");
  const lastColon = spec.lastIndexOf(":");
  if (firstColon <= 0 || lastColon <= firstColon) {
    throw new CLIError(
      "INVALID_CAP",
      `Invalid --cap "${spec}". Expected tinycloud.<service>:<space>:<path>:<actions-csv>.`,
      ExitCode.USAGE_ERROR
    );
  }
  const service = normalizeService(spec.slice(0, firstColon));
  const actionsCsv = spec.slice(lastColon + 1);
  const spaceAndPath = spec.slice(firstColon + 1, lastColon);
  const { space, path } = splitSpaceAndPath(spaceAndPath);
  const resolvedSpace = await resolveSpaceUri(space, profile) ?? space;
  const actions = expandActionShortNames(
    service,
    actionsCsv.split(",").map((action) => action.trim()).filter(Boolean)
  );
  if (actions.length === 0) {
    throw new CLIError("INVALID_CAP", `Capability "${spec}" has no actions.`, ExitCode.USAGE_ERROR);
  }
  return { service, space: resolvedSpace, path, actions };
}
async function loadPermissionRequest(source, profile) {
  const raw = JSON.parse(await readFile2(source, "utf8"));
  if (!Array.isArray(raw.permissions)) {
    throw new CLIError(
      "INVALID_PERMISSION_REQUEST",
      `Permission request ${source} must contain { "permissions": [...] }.`,
      ExitCode.USAGE_ERROR
    );
  }
  return resolvePermissionSpaces(raw.permissions, profile);
}
async function loadManifestPermissions(source, profile) {
  const raw = await loadManifestText(source);
  const manifest = JSON.parse(raw);
  if (typeof manifest.id === "string") {
    const resolved = resolveManifest(manifest);
    return resolvePermissionSpaces(resolved.resources, profile);
  }
  if (typeof manifest.app_id === "string") {
    const permissions = (manifest.permissions ?? []).filter((entry) => entry !== null && typeof entry === "object").map((entry) => {
      const service = normalizeService(String(entry.service ?? ""));
      const path = String(entry.path ?? "");
      const skipPrefix = entry.skipPrefix === true;
      const resolvedPath = skipPrefix ? path : prefixAppManifestPath(path, manifest.app_id);
      return {
        service,
        space: String(manifest.space ?? "applications"),
        path: resolvedPath,
        actions: expandActionShortNames(
          service,
          Array.isArray(entry.actions) ? entry.actions.map(String) : []
        )
      };
    });
    return resolvePermissionSpaces(permissions, profile);
  }
  throw new CLIError(
    "INVALID_MANIFEST",
    'Manifest must contain either SDK field "id" or app manifest field "app_id".',
    ExitCode.USAGE_ERROR
  );
}
function permissionsFromDelegation(delegation) {
  if (delegation.resources?.length) {
    return delegation.resources.map((resource) => ({
      service: resource.service.startsWith("tinycloud.") ? resource.service : `tinycloud.${resource.service}`,
      space: resource.space,
      path: resource.path,
      actions: [...resource.actions]
    }));
  }
  return [{
    service: serviceFromActions(delegation.actions),
    space: delegation.spaceId,
    path: delegation.path,
    actions: [...delegation.actions]
  }];
}
function compactPermission(permission) {
  const service = permission.service;
  const space = permission.space.startsWith("tinycloud:") ? permission.space.slice(permission.space.lastIndexOf(":") + 1) : permission.space;
  const actions = permission.actions.map((action) => action.startsWith(`${service}/`) ? action.slice(service.length + 1) : action).join(",");
  return `${service}:${space}:${permission.path}:${actions}`;
}
async function resolvePermissionSpaces(entries, profile) {
  const resolved = [];
  for (const entry of entries) {
    const service = normalizeService(entry.service);
    resolved.push({
      ...entry,
      service,
      space: await resolveSpaceUri(entry.space, profile) ?? entry.space,
      actions: expandActionShortNames(service, entry.actions)
    });
  }
  return resolved;
}
async function loadManifestText(source) {
  if (source.startsWith("base64:")) {
    return Buffer.from(source.slice("base64:".length), "base64").toString("utf8");
  }
  if (await fileExists(source)) {
    return readFile2(source, "utf8");
  }
  try {
    const decoded = Buffer.from(source, "base64").toString("utf8");
    JSON.parse(decoded);
    return decoded;
  } catch {
    return readFile2(source, "utf8");
  }
}
function normalizeService(service) {
  if (!service) {
    throw new CLIError("INVALID_CAP", "Capability service is required.", ExitCode.USAGE_ERROR);
  }
  return service.startsWith("tinycloud.") ? service : `tinycloud.${service}`;
}
function splitSpaceAndPath(input) {
  if (input.startsWith("tinycloud:")) {
    const parts = input.split(":");
    if (parts.length < 7) {
      throw new CLIError(
        "INVALID_CAP",
        `Full tinycloud space specs must include a path after the space URI.`,
        ExitCode.USAGE_ERROR
      );
    }
    return {
      space: parts.slice(0, 6).join(":"),
      path: parts.slice(6).join(":")
    };
  }
  const colon = input.indexOf(":");
  if (colon <= 0) {
    throw new CLIError(
      "INVALID_CAP",
      `Capability must include both space and path.`,
      ExitCode.USAGE_ERROR
    );
  }
  return {
    space: input.slice(0, colon),
    path: input.slice(colon + 1)
  };
}
function prefixAppManifestPath(path, appId) {
  const slash = path.indexOf("/");
  if (slash === -1) return `${appId}/${path}`;
  return `${path.slice(0, slash)}/${appId}/${path.slice(slash + 1)}`;
}
function serviceFromActions(actions) {
  const first = actions[0] ?? "tinycloud.unknown/read";
  return first.includes("/") ? first.slice(0, first.indexOf("/")) : "tinycloud.unknown";
}

// src/lib/sdk.ts
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
    if (session && session.delegationHeader && session.delegationCid && session.spaceId) {
      await node2.restoreSession({
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId: session.spaceId,
        jwk: session.jwk ?? key,
        verificationMethod: session.verificationMethod ?? profile.sessionDid ?? profile.did,
        address: session.address,
        chainId: session.chainId,
        siwe: session.siwe,
        signature: session.signature
      });
    } else {
      await node2.signIn();
    }
    await replayAdditionalDelegations(node2, ctx.profile);
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
      chainId: session.chainId,
      siwe: session.siwe,
      signature: session.signature
    });
  }
  await replayAdditionalDelegations(node, ctx.profile);
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

// src/commands/auth.ts
function resolveOpenKeyHost(profile) {
  return process.env.TC_OPENKEY_HOST ?? profile.openkeyHost ?? DEFAULT_OPENKEY_HOST;
}
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
      const posture = profile ? resolveProfilePosture(profile) : null;
      const operatorType = profile ? resolveProfileOperatorType(profile) : null;
      const authenticated = session !== null;
      if (shouldOutputJson()) {
        outputJson({
          authenticated,
          did: profile?.did ?? null,
          sessionDid: profile?.sessionDid ?? null,
          ownerDid: profile?.ownerDid ?? null,
          spaceId: profile?.spaceId ?? null,
          host: ctx.host,
          profile: ctx.profile,
          hasKey: hasKey !== null,
          authMethod: profile?.authMethod ?? null,
          posture,
          operatorType,
          address: profile?.address ?? null
        });
      } else {
        process.stdout.write(theme.heading("Authentication Status") + "\n");
        process.stdout.write(formatField("Profile", ctx.profile) + "\n");
        process.stdout.write(formatField("Authenticated", authenticated) + "\n");
        process.stdout.write(formatField("Auth Method", profile?.authMethod ?? null) + "\n");
        process.stdout.write(formatField("Posture", posture) + "\n");
        process.stdout.write(formatField("Operator", operatorType) + "\n");
        process.stdout.write(formatField("Host", ctx.host) + "\n");
        process.stdout.write(formatField("DID", profile?.did ?? null) + "\n");
        process.stdout.write(formatField("Session DID", profile?.sessionDid ?? null) + "\n");
        process.stdout.write(formatField("Owner DID", profile?.ownerDid ?? null) + "\n");
        process.stdout.write(formatField("Address", profile?.address ?? null) + "\n");
        process.stdout.write(formatField("Space ID", profile?.spaceId ?? null) + "\n");
        process.stdout.write(formatField("Has Key", hasKey !== null) + "\n");
      }
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("request").description("Create a TinyCloud permission request artifact").option(
    "--cap <spec>",
    "Capability spec: tinycloud.<service>:<space>:<path>:<actions-csv> (repeatable)",
    (value, previous) => [...previous, value],
    []
  ).option("--permission <file>", 'JSON permission request: { "permissions": PermissionEntry[] }').option("--manifest <fileOrBase64>", "Manifest file, base64:<json>, or raw base64 JSON").option(
    "--expiry <duration>",
    `Lifetime of the granted delegation. ms-format string (e.g. "7d", "30m") or raw milliseconds. Defaults to 7d, capped by the active session's expiry.`
  ).option("--emit [file]", "Emit the request artifact to stdout, or write it to file when provided").option("--grant", "Grant the requested permissions immediately with this owner profile").option("--yes", "Skip local-key TTY confirmation", false).action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profile = await ProfileManager.getProfile(ctx.profile);
      const requested = await collectRequestedPermissions(options, ctx.profile);
      const expiryOption = parseExpiryOption(options.expiry);
      if (requested.length === 0) {
        throw new CLIError(
          "NO_CAPS_REQUESTED",
          "Provide at least one --cap, --permission, or --manifest.",
          ExitCode.USAGE_ERROR
        );
      }
      if (!options.grant) {
        const artifact = createPermissionRequestArtifact({
          profileName: ctx.profile,
          profile,
          host: ctx.host,
          requested,
          requestedExpiry: expiryOption
        });
        await appendPermissionRequestArtifact(ctx.profile, artifact);
        await emitPermissionRequestArtifact(artifact, options.emit);
        return;
      }
      const node = await ensureAuthenticated(ctx);
      if (node.hasRuntimePermissions(requested)) {
        outputJson({ changed: false, missing: [], added: [] });
        return;
      }
      if (profile.authMethod === "openkey") {
        const key = await ProfileManager.getKey(ctx.profile);
        if (!key) {
          throw new CLIError("NO_KEY", `No key found for profile "${ctx.profile}". Run \`tc init\` first.`, ExitCode.AUTH_REQUIRED);
        }
        const delegationCids2 = [];
        let expiry2;
        const openkeyHost = resolveOpenKeyHost(profile);
        for (const group of groupPermissionsBySpace(requested)) {
          const delegationData = await startAuthFlow(profile.did, {
            jwk: key,
            host: ctx.host,
            permissions: group,
            openkeyHost,
            expiry: expiryOption
          });
          const delegation = portableFromOpenKeyDelegation(delegationData, group, ctx.host);
          const stored = storedAdditionalDelegation(delegation, group);
          await appendAdditionalDelegation(ctx.profile, stored);
          await node.useRuntimeDelegation(delegation);
          delegationCids2.push(delegation.cid);
          expiry2 = delegation.expiry.toISOString();
          await appendGrantHistory(ctx.profile, {
            addedCaps: group,
            source: options.manifest ? "manifest" : "cli",
            delegationCid: delegation.cid,
            expiry: expiry2
          });
        }
        outputJson({
          changed: delegationCids2.length > 0,
          added: requested,
          delegationCid: delegationCids2[0],
          delegationCids: delegationCids2,
          expiry: expiry2
        });
        return;
      }
      if (isInteractive()) {
        if (!options.yes) {
          await confirmPermissionRequest(requested);
        }
      } else if (!options.yes) {
        throw new CLIError(
          "CONFIRMATION_REQUIRED",
          "Local-key permission requests in non-interactive mode require --yes.",
          ExitCode.USAGE_ERROR
        );
      }
      const delegations = await node.grantRuntimePermissions(
        requested,
        expiryOption !== void 0 ? { expiry: expiryOption } : void 0
      );
      const delegationCids = [];
      let expiry;
      for (const delegation of delegations) {
        const covering = permissionsFromDelegation(delegation);
        const stored = storedAdditionalDelegation(delegation, covering);
        await appendAdditionalDelegation(ctx.profile, stored);
        delegationCids.push(delegation.cid);
        expiry = delegation.expiry.toISOString();
        await appendGrantHistory(ctx.profile, {
          addedCaps: covering,
          source: options.manifest ? "manifest" : "cli",
          delegationCid: delegation.cid,
          expiry
        });
      }
      if (delegationCids.length === 0) {
        outputJson({ changed: false, missing: [], added: [] });
        return;
      }
      outputJson({
        changed: true,
        added: requested,
        delegationCid: delegationCids[0],
        delegationCids,
        expiry
      });
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("import [source]").description("Import a TinyCloud delegation or permission request artifact").option("--stdin", "Read the JSON artifact from stdin").option("--paste", "Read the JSON artifact from stdin").action(async (source, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const raw = await readAuthArtifactSource(source, {
        stdin: options.stdin === true || options.paste === true
      });
      const parsed = JSON.parse(raw);
      if (isPermissionRequestArtifact(parsed)) {
        await appendPermissionRequestArtifact(ctx.profile, parsed);
        outputJson({
          imported: true,
          kind: parsed.kind,
          requestId: parsed.requestId,
          requested: parsed.requested,
          next: `tc auth retry ${parsed.requestId}`
        });
        return;
      }
      const imported = normalizeDelegationImport(parsed);
      const node = await ensureAuthenticated(ctx);
      await appendAdditionalDelegation(ctx.profile, storedAdditionalDelegation(
        imported.delegation,
        imported.permissions
      ));
      await node.useRuntimeDelegation(imported.delegation);
      await appendGrantHistory(ctx.profile, {
        addedCaps: imported.permissions,
        source: "cli",
        delegationCid: imported.delegation.cid,
        expiry: imported.delegation.expiry.toISOString()
      });
      outputJson({
        imported: true,
        kind: "tinycloud.auth.delegation",
        requestId: imported.requestId ?? null,
        delegationCid: imported.delegation.cid,
        permissions: imported.permissions,
        expiry: imported.delegation.expiry.toISOString()
      });
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("grant [request]").description("Grant a TinyCloud permission request artifact to its requester").option("--stdin", "Read the JSON request artifact from stdin").option("--paste", "Read the JSON request artifact from stdin").option("--yes", "Skip local-key TTY confirmation", false).action(async (source, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profile = await ProfileManager.getProfile(ctx.profile);
      const raw = await readAuthArtifactSource(source, {
        stdin: options.stdin === true || options.paste === true
      });
      const parsed = JSON.parse(raw);
      if (!isPermissionRequestArtifact(parsed)) {
        throw new CLIError(
          "INVALID_AUTH_REQUEST",
          "Auth grant requires a tinycloud.auth.request artifact.",
          ExitCode.USAGE_ERROR
        );
      }
      const node = await ensureAuthenticated(ctx);
      await ensureDelegationAuthority({
        ctx,
        profile,
        node,
        requested: parsed.requested,
        expiryOption: parsed.requestedExpiry,
        yes: options.yes === true
      });
      const result = await node.delegateTo(
        parsed.sessionDid,
        parsed.requested,
        parsed.requestedExpiry !== void 0 ? { expiry: parsed.requestedExpiry } : void 0
      );
      outputJson({
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId: parsed.requestId,
        delegationCid: result.delegation.cid,
        delegation: result.delegation,
        permissions: parsed.requested,
        expiry: result.delegation.expiry.toISOString(),
        prompted: result.prompted
      });
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("retry [requestId]").description("Check whether a stored permission request is now satisfied").option("--last", "Use the latest stored permission request for this profile").option("--exec", "Run the captured command when the request is covered").action(async (requestId, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const artifact = options.last ? await getLastPermissionRequestArtifact(ctx.profile) : requestId ? await getPermissionRequestArtifact(ctx.profile, requestId) : null;
      if (!artifact) {
        throw new CLIError(
          "REQUEST_NOT_FOUND",
          options.last ? `No stored permission requests exist for profile "${ctx.profile}".` : "Provide a requestId or use --last.",
          ExitCode.NOT_FOUND
        );
      }
      const node = await ensureAuthenticated(ctx);
      const covered = node.hasRuntimePermissions(artifact.requested);
      if (options.exec) {
        if (!covered) {
          throw new CLIError(
            "PERMISSIONS_MISSING",
            `Request ${artifact.requestId} is not covered yet. Import a delegation, then retry with --exec.`,
            ExitCode.PERMISSION_DENIED
          );
        }
        if (!artifact.command?.argv?.length) {
          throw new CLIError(
            "COMMAND_NOT_CAPTURED",
            `Request ${artifact.requestId} does not include a captured command.`,
            ExitCode.USAGE_ERROR
          );
        }
        await execCapturedCommand(artifact.command);
        return;
      }
      outputJson({
        requestId: artifact.requestId,
        covered,
        missing: covered ? [] : artifact.requested,
        command: artifact.command ?? null
      });
    } catch (error) {
      handleError(error);
    }
  });
  auth.command("caps").description("Show granted capabilities for the active session").option("--diff <spec>", "Show missing capabilities for a spec").option("--history", "Show recent permission grants").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      if (options.history) {
        const history = (await readGrantHistory(ctx.profile)).slice(-20);
        if (shouldOutputJson()) {
          outputJson({ grants: history });
        } else if (history.length === 0) {
          process.stdout.write(theme.muted("No grant history.") + "\n");
        } else {
          process.stdout.write(formatTable(
            ["time", "source", "delegation", "caps"],
            history.map((entry) => [
              entry.ts,
              entry.source,
              entry.delegationCid ?? "",
              entry.addedCaps.map(compactPermission).join("; ")
            ])
          ) + "\n");
        }
        return;
      }
      const node = await ensureAuthenticated(ctx);
      const runtimeDelegations = node.getRuntimePermissionDelegations();
      const granted = runtimeDelegations.flatMap(permissionsFromDelegation);
      if (options.diff) {
        const requested = [await parseCapSpec(options.diff, ctx.profile)];
        const covered = node.hasRuntimePermissions(requested);
        outputJson({
          requested,
          changed: !covered,
          covered,
          // `missing` retained for backwards-compatible callers.
          missing: covered ? [] : requested
        });
        return;
      }
      const appended = await loadAdditionalDelegations(ctx.profile);
      if (shouldOutputJson()) {
        outputJson({ granted, appendedDelegations: appended.length });
      } else if (granted.length === 0) {
        process.stdout.write(theme.muted("No appended runtime delegations on this profile.") + "\n");
      } else {
        process.stdout.write(formatTable(
          ["service", "space", "path", "actions"],
          granted.map((entry) => [
            entry.service,
            entry.space,
            entry.path,
            entry.actions.join(", ")
          ])
        ) + "\n");
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
      const posture = resolveProfilePosture(profile);
      const operatorType = resolveProfileOperatorType(profile);
      if (shouldOutputJson()) {
        outputJson({
          profile: ctx.profile,
          did: profile.did,
          sessionDid: profile.sessionDid ?? null,
          ownerDid: profile.ownerDid ?? null,
          spaceId: profile.spaceId ?? null,
          host: profile.host,
          authenticated,
          authMethod: profile.authMethod ?? null,
          posture,
          operatorType,
          address: profile.address ?? null
        });
      } else {
        process.stdout.write(theme.heading("Identity") + "\n");
        process.stdout.write(formatField("Profile", ctx.profile) + "\n");
        process.stdout.write(formatField("DID", profile.did) + "\n");
        process.stdout.write(formatField("Session DID", profile.sessionDid ?? null) + "\n");
        process.stdout.write(formatField("Owner DID", profile.ownerDid ?? null) + "\n");
        process.stdout.write(formatField("Auth Method", profile.authMethod ?? null) + "\n");
        process.stdout.write(formatField("Posture", posture) + "\n");
        process.stdout.write(formatField("Operator", operatorType) + "\n");
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
async function emitPermissionRequestArtifact(artifact, emitOption) {
  if (typeof emitOption === "string" && emitOption.length > 0) {
    await mkdir2(dirname2(emitOption), { recursive: true });
    await writeFile2(emitOption, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    outputJson({
      emitted: true,
      path: emitOption,
      requestId: artifact.requestId,
      requested: artifact.requested
    });
    return;
  }
  outputJson(artifact);
}
async function readAuthArtifactSource(source, options) {
  if (options.stdin || source === "-" || !source && !isInteractive()) {
    return readStdin();
  }
  if (!source) {
    throw new CLIError(
      "IMPORT_SOURCE_REQUIRED",
      "Provide an artifact file, URL, or use --stdin.",
      ExitCode.USAGE_ERROR
    );
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return readUrl(source);
  }
  return readFile3(source, "utf8");
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function readUrl(source) {
  return new Promise((resolve3, reject) => {
    const getter = source.startsWith("https://") ? httpsGet : httpGet;
    const request = getter(source, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        readUrl(new URL(response.headers.location, source).toString()).then(resolve3, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new CLIError(
          "IMPORT_FETCH_FAILED",
          `Failed to fetch ${source}: HTTP ${status}.`,
          ExitCode.ERROR
        ));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => resolve3(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}
function normalizeDelegationImport(value) {
  if (isDelegationImportArtifact(value)) {
    const delegation = normalizePortableDelegation(value.delegation);
    return {
      requestId: value.requestId,
      delegation,
      permissions: Array.isArray(value.permissions) && value.permissions.length > 0 ? value.permissions : permissionsFromDelegation(delegation)
    };
  }
  if (isStoredDelegationLike(value)) {
    const delegation = normalizePortableDelegation(value.delegation);
    return {
      delegation,
      permissions: Array.isArray(value.permissions) && value.permissions.length > 0 ? value.permissions : permissionsFromDelegation(delegation)
    };
  }
  if (isPortableDelegationLike(value)) {
    const delegation = normalizePortableDelegation(value);
    return {
      delegation,
      permissions: permissionsFromDelegation(delegation)
    };
  }
  throw new CLIError(
    "INVALID_AUTH_IMPORT",
    "Auth import must be a tinycloud.auth.delegation artifact, a portable delegation, or a tinycloud.auth.request artifact.",
    ExitCode.USAGE_ERROR
  );
}
function isStoredDelegationLike(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  return isPortableDelegationLike(candidate.delegation);
}
function isPortableDelegationLike(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  return typeof candidate.cid === "string" && typeof candidate.spaceId === "string" && typeof candidate.path === "string" && Array.isArray(candidate.actions) && candidate.delegationHeader !== void 0 && typeof candidate.delegationHeader === "object";
}
function normalizePortableDelegation(delegation) {
  const rawExpiry = delegation.expiry;
  const expiry = rawExpiry instanceof Date ? rawExpiry : new Date(String(rawExpiry));
  if (Number.isNaN(expiry.getTime())) {
    throw new CLIError(
      "INVALID_AUTH_IMPORT",
      "Imported delegation must include a valid expiry.",
      ExitCode.USAGE_ERROR
    );
  }
  return { ...delegation, expiry };
}
async function ensureDelegationAuthority(params) {
  if (params.node.hasRuntimePermissions(params.requested)) return;
  if (params.profile.authMethod === "openkey") {
    const key = await ProfileManager.getKey(params.ctx.profile);
    if (!key) {
      throw new CLIError(
        "NO_KEY",
        `No key found for profile "${params.ctx.profile}". Run \`tc init\` first.`,
        ExitCode.AUTH_REQUIRED
      );
    }
    const openkeyHost = resolveOpenKeyHost(params.profile);
    for (const group of groupPermissionsBySpace(params.requested)) {
      const delegationData = await startAuthFlow(params.profile.did, {
        jwk: key,
        host: params.ctx.host,
        permissions: group,
        openkeyHost,
        expiry: params.expiryOption
      });
      const delegation = portableFromOpenKeyDelegation(delegationData, group, params.ctx.host);
      await appendAdditionalDelegation(
        params.ctx.profile,
        storedAdditionalDelegation(delegation, group)
      );
      await params.node.useRuntimeDelegation(delegation);
      await appendGrantHistory(params.ctx.profile, {
        addedCaps: group,
        source: "cli",
        delegationCid: delegation.cid,
        expiry: delegation.expiry.toISOString()
      });
    }
    return;
  }
  if (isInteractive()) {
    if (!params.yes) {
      await confirmPermissionRequest(params.requested);
    }
  } else if (!params.yes) {
    throw new CLIError(
      "CONFIRMATION_REQUIRED",
      "Local-key auth grants in non-interactive mode require --yes.",
      ExitCode.USAGE_ERROR
    );
  }
  const delegations = await params.node.grantRuntimePermissions(
    params.requested,
    params.expiryOption !== void 0 ? { expiry: params.expiryOption } : void 0
  );
  for (const delegation of delegations) {
    const covering = permissionsFromDelegation(delegation);
    await appendAdditionalDelegation(
      params.ctx.profile,
      storedAdditionalDelegation(delegation, covering)
    );
    await appendGrantHistory(params.ctx.profile, {
      addedCaps: covering,
      source: "cli",
      delegationCid: delegation.cid,
      expiry: delegation.expiry.toISOString()
    });
  }
}
function execCapturedCommand(command) {
  return new Promise((resolve3, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...command.argv], {
      cwd: command.cwd,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new CLIError(
          "COMMAND_SIGNAL",
          `Captured command exited from signal ${signal}.`,
          ExitCode.ERROR
        ));
        return;
      }
      if (code && code !== 0) {
        process.exitCode = code;
      }
      resolve3();
    });
  });
}
async function collectRequestedPermissions(options, profile) {
  const permissions = [];
  for (const spec of options.cap ?? []) {
    permissions.push(await parseCapSpec(spec, profile));
  }
  if (options.permission) {
    permissions.push(...await loadPermissionRequest(options.permission, profile));
  }
  if (options.manifest) {
    permissions.push(...await loadManifestPermissions(options.manifest, profile));
  }
  return permissions;
}
async function confirmPermissionRequest(permissions) {
  process.stderr.write("\n" + theme.heading("Additional Permissions") + "\n");
  for (const permission of permissions) {
    const dangerous = isDangerousPermission(permission);
    const line = `  ${compactPermission(permission)}`;
    process.stderr.write((dangerous ? theme.warn(line) : theme.value(line)) + "\n");
  }
  process.stderr.write("\n");
  const rl = createInterface2({
    input: process.stdin,
    output: process.stderr
  });
  const answer = await new Promise((resolve3) => {
    rl.question("Approve local-key delegation? [y/N] ", resolve3);
  });
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CLIError("REQUEST_CANCELLED", "Permission request cancelled.", ExitCode.ERROR);
  }
}
function isDangerousPermission(permission) {
  if (permission.path === "" || permission.path === "/") return true;
  return permission.actions.some(
    (action) => action.includes("*") || action.endsWith("/write") || action.endsWith("/admin") || action.endsWith("/ddl") || action.endsWith("/del")
  );
}
function parseExpiryOption(raw) {
  if (raw === void 0 || raw === null) return void 0;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CLIError(
      "INVALID_EXPIRY",
      `--expiry must be a string (e.g. "7d", "30m") or a millisecond integer.`,
      ExitCode.USAGE_ERROR
    );
  }
  if (/^\d+$/.test(raw.trim())) {
    const ms = Number(raw.trim());
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new CLIError("INVALID_EXPIRY", `--expiry must be a positive integer when numeric.`, ExitCode.USAGE_ERROR);
    }
    return ms;
  }
  return raw;
}
function groupPermissionsBySpace(permissions) {
  const groups = /* @__PURE__ */ new Map();
  for (const permission of permissions) {
    const group = groups.get(permission.space) ?? [];
    group.push(permission);
    groups.set(permission.space, group);
  }
  return Array.from(groups.values());
}
function portableFromOpenKeyDelegation(data, permissions, host) {
  const primary = permissions[0];
  const returnedSpace = String(data.spaceId ?? primary.space);
  const expectedSpaces = new Set(permissions.map((permission) => permission.space));
  if (expectedSpaces.size !== 1 || !expectedSpaces.has(returnedSpace)) {
    throw new CLIError(
      "OPENKEY_SCOPE_MISMATCH",
      `OpenKey returned delegation for ${returnedSpace}, expected ${Array.from(expectedSpaces).join(", ")}.`,
      ExitCode.PERMISSION_DENIED
    );
  }
  const expiry = inferDelegationExpiry(data);
  return {
    cid: String(data.delegationCid),
    delegationHeader: data.delegationHeader,
    spaceId: returnedSpace,
    path: primary.path,
    actions: primary.actions,
    resources: permissions.map((permission) => ({
      service: permission.service.startsWith("tinycloud.") ? permission.service.slice("tinycloud.".length) : permission.service,
      space: permission.space,
      path: permission.path,
      actions: [...permission.actions]
    })),
    expiry,
    delegateDID: String(data.verificationMethod),
    ownerAddress: String(data.address ?? ""),
    chainId: typeof data.chainId === "number" ? data.chainId : DEFAULT_CHAIN_ID,
    host
  };
}
function inferDelegationExpiry(data) {
  const direct = data.expiry ?? data.expiresAt;
  if (typeof direct === "string") {
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + 60 * 60 * 1e3);
}
async function handleLocalAuth(profileName, host) {
  const profile = await ProfileManager.getProfile(profileName).catch(() => null);
  let privateKey;
  let address;
  let did;
  let sessionDid = profile?.sessionDid;
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
    const { jwk, did: generatedSessionDid } = await withSpinner("Generating session key...", async () => {
      return generateKey();
    });
    await ProfileManager.setKey(profileName, jwk);
    sessionDid = generatedSessionDid;
  } else if (!sessionDid) {
    sessionDid = keyToDID(hasKey);
  }
  const sessionResult = await withSpinner("Signing in...", async () => {
    return localKeySignIn({ privateKey, host });
  });
  await ProfileManager.setSession(profileName, {
    authMethod: "local",
    address,
    chainId: DEFAULT_CHAIN_ID,
    spaceId: sessionResult.spaceId,
    delegationHeader: sessionResult.delegationHeader,
    delegationCid: sessionResult.delegationCid,
    jwk: sessionResult.jwk,
    verificationMethod: sessionResult.verificationMethod,
    siwe: sessionResult.siwe,
    signature: sessionResult.signature
  });
  sessionDid = sessionResult.verificationMethod;
  await ProfileManager.setProfile(profileName, {
    ...profile,
    name: profileName,
    host,
    chainId: DEFAULT_CHAIN_ID,
    spaceName: "default",
    did,
    sessionDid,
    ownerDid: did,
    spaceId: sessionResult.spaceId,
    createdAt: profile?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    posture: profile?.posture ?? "local-owner-key",
    operatorType: profile?.operatorType ?? "human",
    authMethod: "local",
    privateKey,
    address
  });
  outputJson({
    authenticated: true,
    profile: profileName,
    did,
    sessionDid,
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
    host,
    openkeyHost: resolveOpenKeyHost(profile)
  });
  await ProfileManager.setSession(profileName, delegationData);
  const updatedProfile = {
    ...profile,
    sessionDid: profile.sessionDid ?? profile.did,
    posture: profile.posture ?? "owner-openkey",
    operatorType: profile.operatorType ?? "human",
    authMethod: "openkey"
  };
  if (delegationData.spaceId) {
    updatedProfile.spaceId = delegationData.spaceId;
    updatedProfile.ownerDid = delegationData.ownerDid;
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
import { readFile as readFile4 } from "fs/promises";
import { writeFile as writeFile3 } from "fs/promises";
async function readStdin2() {
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
        await writeFile3(options.output, content);
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
        putValue = await readFile4(options.file);
      } else if (options.stdin) {
        putValue = await readStdin2();
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
import { principalDidEquals } from "@tinycloud/node-sdk";
function didMatches(actual, expected) {
  if (!actual) return false;
  try {
    return principalDidEquals(actual, expected);
  } catch {
    return actual === expected;
  }
}
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
        delegations = delegations.filter((d) => didMatches(d.delegatorDID, myDid));
      } else if (options.received) {
        const myDid = node.did;
        delegations = delegations.filter((d) => didMatches(d.delegateDID, myDid));
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
              posture: resolveProfilePosture(p),
              operatorType: resolveProfileOperatorType(p),
              active: name === config.defaultProfile
            };
          } catch {
            return {
              name,
              host: null,
              did: null,
              posture: null,
              operatorType: null,
              active: name === config.defaultProfile
            };
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
          const posture = p.posture ? theme.muted(String(p.posture)) : theme.muted("no posture");
          process.stdout.write(`${marker}${name}  ${host}  ${posture}
`);
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("create <name>").description("Create a new profile").option("--host <url>", "TinyCloud node URL").option(
    "--posture <posture>",
    `Profile posture: ${CLI_PROFILE_POSTURES.join(", ")}. Defaults to owner-openkey.`
  ).option(
    "--operator <type>",
    `Operator type: ${CLI_OPERATOR_TYPES.join(", ")}. Defaults to human.`
  ).action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const host = options.host ?? globalOpts.host ?? "https://node.tinycloud.xyz";
      const posture = parseProfilePosture(options.posture);
      const operatorType = parseOperatorType(options.operator);
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
        sessionDid: did,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        posture,
        operatorType
      });
      outputJson({ profile: name, did, host, posture, operatorType, created: true });
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
      const posture = resolveProfilePosture(p);
      const operatorType = resolveProfileOperatorType(p);
      if (shouldOutputJson()) {
        outputJson({
          ...p,
          posture,
          operatorType,
          hasKey,
          hasSession,
          isDefault
        });
      } else {
        process.stdout.write(`${theme.heading(p.name)}${isDefault ? theme.success(" (default)") : ""}
`);
        process.stdout.write(formatField("Host", p.host) + "\n");
        process.stdout.write(formatField("DID", p.did) + "\n");
        process.stdout.write(formatField("Session DID", p.sessionDid ?? null) + "\n");
        process.stdout.write(formatField("Posture", posture) + "\n");
        process.stdout.write(formatField("Operator", operatorType) + "\n");
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
function parseProfilePosture(raw) {
  if (raw === void 0 || raw === null || raw === "") return "owner-openkey";
  if (isCLIProfilePosture(raw)) return raw;
  throw new CLIError(
    "INVALID_POSTURE",
    `Invalid posture "${String(raw)}". Use one of: ${CLI_PROFILE_POSTURES.join(", ")}.`,
    ExitCode.USAGE_ERROR
  );
}
function parseOperatorType(raw) {
  if (raw === void 0 || raw === null || raw === "") return "human";
  if (isCLIOperatorType(raw)) return raw;
  throw new CLIError(
    "INVALID_OPERATOR",
    `Invalid operator "${String(raw)}". Use one of: ${CLI_OPERATOR_TYPES.join(", ")}.`,
    ExitCode.USAGE_ERROR
  );
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
import { readFile as readFile5 } from "fs/promises";
import { writeFile as writeFile4 } from "fs/promises";
import { PrivateKeySigner as PrivateKeySigner2 } from "@tinycloud/node-sdk";
async function readStdin3() {
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
        putValue = new Uint8Array(await readFile5(options.file));
      } else if (options.stdin) {
        putValue = new Uint8Array(await readStdin3());
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
        await writeFile4(options.output, content);
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
import { readFile as readFile6 } from "fs/promises";
import { writeFile as writeFile5 } from "fs/promises";
async function readStdin4() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
function authOptions(options) {
  const privateKey = options.privateKey || process.env.TC_PRIVATE_KEY;
  return privateKey ? { privateKey } : void 0;
}
function resolveSecretScope(options) {
  const scope = options.scope ?? options.space;
  return scope ? { scope } : void 0;
}
function registerSecretsCommand(program2) {
  const secrets = program2.command("secrets").description("Encrypted secrets management");
  const network = secrets.command("network").description("Manage the default secrets encryption network");
  network.command("show [nameOrNetworkId]").description("Show a secrets encryption network").option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)").action(async (nameOrNetworkId, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const requested = nameOrNetworkId ?? "default";
      const networkId = requested.startsWith("urn:tinycloud:encryption:") ? requested : node.getDefaultEncryptionNetworkId(requested);
      const descriptor = await withSpinner(
        "Fetching encryption network...",
        () => node.getEncryptionNetwork(requested)
      );
      outputJson({
        networkId,
        exists: descriptor !== null,
        ...descriptor ? { descriptor } : {}
      });
    } catch (error) {
      handleError(error);
    }
  });
  network.command("init [name]").description("Create a secrets encryption network if needed").option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const descriptor = await withSpinner(
        "Ensuring encryption network...",
        () => node.ensureEncryptionNetwork(name ?? "default")
      );
      outputJson({
        networkId: descriptor.networkId,
        state: descriptor.state,
        descriptor
      });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("list").description("List secrets").option("--scope <scope>", "Logical secret scope").option("--space <scope>", "Deprecated alias for --scope").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const scopeOptions = resolveSecretScope(options);
      const result = await withSpinner(
        "Listing secrets...",
        () => node.secrets.list(scopeOptions)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const secretNames = Array.isArray(result.data) ? result.data : [];
      const scope = options.scope ?? options.space;
      outputJson({
        secrets: secretNames,
        count: secretNames.length,
        ...scope ? { scope } : {}
      });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("get <name>").description("Get a secret value").option("--scope <scope>", "Logical secret scope").option("--space <scope>", "Deprecated alias for --scope").option("--raw", "Output raw value (no JSON wrapping)").option("-o, --output <file>", "Write value to file").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const scopeOptions = resolveSecretScope(options);
      const result = await withSpinner(
        `Getting secret ${name}...`,
        () => node.secrets.get(name, scopeOptions)
      );
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND" || result.error.code === "KEY_NOT_FOUND") {
          throw new CLIError("NOT_FOUND", `Secret "${name}" not found`, ExitCode.NOT_FOUND);
        }
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const value = String(result.data);
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
  secrets.command("put <name> [value]").description("Store a secret").option("--scope <scope>", "Logical secret scope").option("--space <scope>", "Deprecated alias for --scope").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, value, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      let secretValue;
      const sources = [value !== void 0, !!options.file, !!options.stdin].filter(Boolean);
      if (sources.length === 0) {
        throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (sources.length > 1) {
        throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (options.file) {
        secretValue = await readFile6(options.file, "utf-8");
      } else if (options.stdin) {
        secretValue = (await readStdin4()).toString("utf-8");
      } else {
        secretValue = value;
      }
      const scopeOptions = resolveSecretScope(options);
      const result = await withSpinner(
        `Storing secret ${name}...`,
        () => node.secrets.put(name, secretValue, scopeOptions)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("delete <name>").description("Delete a secret").option("--scope <scope>", "Logical secret scope").option("--space <scope>", "Deprecated alias for --scope").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const scopeOptions = resolveSecretScope(options);
      const result = await withSpinner(
        `Deleting secret ${name}...`,
        () => node.secrets.delete(name, scopeOptions)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
  network.command("grant <recipientDid> [name]").description("Grant decrypt permission for a secrets encryption network").option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)").action(async (recipientDid, name, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const networkName = name ?? "default";
      const descriptor = await withSpinner(
        "Ensuring encryption network...",
        () => node.ensureEncryptionNetwork(networkName)
      );
      const permission = {
        service: "tinycloud.encryption",
        path: descriptor.networkId,
        actions: ["decrypt"]
      };
      const result = await withSpinner(
        `Granting decrypt permission to ${recipientDid}...`,
        () => node.delegateTo(recipientDid, [permission])
      );
      outputJson({
        networkId: descriptor.networkId,
        recipientDid,
        cid: result.delegation.cid,
        prompted: result.prompted,
        path: result.delegation.path,
        actions: result.delegation.actions
      });
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
import { readFile as readFile7 } from "fs/promises";
import { writeFile as writeFile6 } from "fs/promises";
var VARIABLES_PREFIX = "variables/";
async function readStdin5() {
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
function registerVarsCommand(program2) {
  const vars = program2.command("vars").description("Plaintext variable management");
  vars.command("list").description("List variables").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey2(options);
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
      const privateKey = resolvePrivateKey2(options);
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
        await writeFile6(options.output, value);
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
      const privateKey = resolvePrivateKey2(options);
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
        varValue = await readFile7(options.file, "utf-8");
      } else if (options.stdin) {
        varValue = (await readStdin5()).toString("utf-8");
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
      const privateKey = resolvePrivateKey2(options);
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
import { writeFile as writeFile7 } from "fs/promises";
import { resolve } from "path";
async function dbHandle(node, dbName, spaceInput, profileName) {
  const spaceUri = await resolveSpaceUri(spaceInput, profileName);
  const sql = spaceUri ? node.sqlForSpace(spaceUri) : node.sql;
  return sql.db(dbName);
}
function registerSqlCommand(program2) {
  const sql = program2.command("sql").description("SQLite database operations for your TinyCloud space").addHelpText("after", `

TinyCloud SQL gives each space isolated SQLite databases. Use the default
database for simple apps, or pass --db to target a named database. Pass
--space to target a non-primary space (e.g. the manifest "applications" space).

Common workflows:
  $ tc sql execute "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)"
  $ tc sql execute "INSERT INTO notes (body) VALUES (?)" --params '["ship docs"]'
  $ tc sql query "SELECT id, body FROM notes ORDER BY id"
  $ tc sql query "SELECT * FROM events WHERE type = ?" --db analytics --params '["signup"]'
  $ tc sql query "SELECT count(*) FROM conversation" --space applications --db xyz.tinycloud.listen/conversations
  $ tc sql export --db analytics --output analytics.db

Commands:
  query     Read rows with SELECT statements
  execute   Run writes and schema changes such as INSERT, UPDATE, DELETE, CREATE, DROP
  export    Download the raw SQLite database file
  copy      Copy rows between databases (optionally across spaces)

Tips:
  - SQL strings should usually be quoted so your shell passes them as one argument.
  - --params accepts a JSON array and binds values to ? placeholders.
  - --space accepts a short name ("applications") or full URI ("tinycloud:pkh:eip155:1:0x...:applications").
  - Add --json for scripting-friendly output.
`);
  sql.command("query <sql>").description("Run a read-only SELECT query").option("--db <name>", "SQLite database name within the current space", "default").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").option("--params <json>", "Bind parameters as a JSON array for ? placeholders").addHelpText("after", `

Examples:
  $ tc sql query "SELECT * FROM notes ORDER BY id"
  $ tc sql query "SELECT * FROM notes WHERE id = ?" --params '[42]'
  $ tc sql query "SELECT count(*) AS total FROM events" --db analytics --json
  $ tc sql query "SELECT count(*) FROM conversation" --space applications --db xyz.tinycloud.listen/conversations

Output:
  Human output is formatted as a table. Piped output or --json returns
  { "columns": string[], "rows": unknown[][], "rowCount": number }.
`).action(async (sqlStr, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const params = options.params ? JSON.parse(options.params) : void 0;
      const handle = await dbHandle(node, options.db, options.space, ctx.profile);
      const result = await withSpinner(
        "Running query...",
        () => handle.query(sqlStr, params)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR, result.error.meta);
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
  sql.command("execute <sql>").description("Run a write or schema statement").option("--db <name>", "SQLite database name within the current space", "default").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").option("--params <json>", "Bind parameters as a JSON array for ? placeholders").addHelpText("after", `

Examples:
  $ tc sql execute "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)"
  $ tc sql execute "INSERT INTO notes (body) VALUES (?)" --params '["first note"]'
  $ tc sql execute "UPDATE notes SET body = ? WHERE id = ?" --params '["edited", 1]'
  $ tc sql execute "DROP TABLE old_notes" --db archive
  $ tc sql execute "DELETE FROM conversation WHERE id = ?" --space applications --db xyz.tinycloud.listen/conversations --params '["abc"]'

Output:
  Returns JSON with the changed row count and last inserted row id when available.
`).action(async (sqlStr, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const params = options.params ? JSON.parse(options.params) : void 0;
      const handle = await dbHandle(node, options.db, options.space, ctx.profile);
      const result = await withSpinner(
        "Executing statement...",
        () => handle.execute(sqlStr, params)
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR, result.error.meta);
      }
      outputJson({
        changes: result.data.changes,
        lastInsertRowId: result.data.lastInsertRowId
      });
    } catch (error) {
      handleError(error);
    }
  });
  sql.command("export").description("Export a SQLite database as a binary .db file").option("--db <name>", "SQLite database name within the current space", "default").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").option("-o, --output <file>", "Output file path", "export.db").addHelpText("after", `

Examples:
  $ tc sql export
  $ tc sql export --db analytics --output analytics.db
  $ tc sql export --space applications --db xyz.tinycloud.listen/conversations --output listen.db

Output:
  Writes the database file locally and returns JSON with the path and size.
`).action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const handle = await dbHandle(node, options.db, options.space, ctx.profile);
      const result = await withSpinner(
        "Exporting database...",
        () => handle.export()
      );
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR, result.error.meta);
      }
      const blob = result.data;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const outputPath = resolve(options.output);
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
  sql.command("copy").description("Copy rows between SQL databases (optionally across spaces)").requiredOption("--from-db <name>", "Source database name").requiredOption("--to-db <name>", "Destination database name").option("--from-space <name|uri>", "Source space (defaults to primary)").option("--to-space <name|uri>", "Destination space (defaults to primary)").option("--table <name...>", "Restrict copy to specific tables (repeat or comma-separated)").option("--dry-run", "Print the plan without writing", false).addHelpText("after", `

Examples:
  $ tc sql copy --from-db com.tinycloud.conversation-sync/conversations \\
                --to-db xyz.tinycloud.listen/conversations \\
                --space applications --dry-run
  $ tc sql copy --from-space applications --from-db com.foo/data \\
                --to-space applications --to-db com.bar/data \\
                --table conversation --table participant

Notes:
  - Refuses to run when (resolved space, db) is identical for source and destination.
  - Does NOT create destination tables. Run the target app once (or use \`tc sql execute\`)
    to materialize the schema before copying.
  - One row at a time; suitable for small/medium datasets. Large copies should
    use \`tc sql export\` + bulk import.
  - Authorization: the active session/delegation must cover sql/read on source
    AND sql/write on destination. Otherwise the relevant operation will fail.
`).action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const fromSpaceInput = options.fromSpace ?? options.space;
      const toSpaceInput = options.toSpace ?? options.space;
      const fromSpaceUri = await resolveSpaceUri(fromSpaceInput, ctx.profile) ?? "<primary>";
      const toSpaceUri = await resolveSpaceUri(toSpaceInput, ctx.profile) ?? "<primary>";
      if (fromSpaceUri === toSpaceUri && options.fromDb === options.toDb) {
        throw new CLIError(
          "SELF_COPY",
          `Refusing to copy: source and destination resolve to the same (space, db) \u2014 ${fromSpaceUri} / ${options.fromDb}.`,
          ExitCode.USAGE_ERROR
        );
      }
      const fromHandle = await dbHandle(node, options.fromDb, fromSpaceInput, ctx.profile);
      const toHandle = await dbHandle(node, options.toDb, toSpaceInput, ctx.profile);
      let tables;
      if (options.table && options.table.length > 0) {
        tables = options.table.flatMap((t) => t.split(",").map((s) => s.trim()).filter(Boolean));
      } else {
        const listing = await fromHandle.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        if (!listing.ok) {
          throw new CLIError(listing.error.code, `Cannot list source tables: ${listing.error.message}`, ExitCode.ERROR, listing.error.meta);
        }
        tables = listing.data.rows.map((r) => String(r[0]));
      }
      if (tables.length === 0) {
        throw new CLIError(
          "EMPTY_PLAN",
          `No tables to copy. Use --table to specify tables, or check that the source database has user tables.`,
          ExitCode.USAGE_ERROR
        );
      }
      const plan = [];
      for (const table of tables) {
        const safe = quoteIdent(table);
        const countResult = await fromHandle.query(`SELECT count(*) AS n FROM ${safe}`);
        if (!countResult.ok) {
          throw new CLIError(
            countResult.error.code,
            `Cannot count rows in source table "${table}": ${countResult.error.message}`,
            ExitCode.ERROR,
            countResult.error.meta
          );
        }
        const rows = Number(countResult.data.rows[0]?.[0] ?? 0);
        plan.push({ table, rows, copied: 0, skipped: 0 });
      }
      if (options.dryRun) {
        outputJson({
          dryRun: true,
          from: { space: fromSpaceUri, db: options.fromDb },
          to: { space: toSpaceUri, db: options.toDb },
          tables: plan.map((p) => ({ table: p.table, rows: p.rows }))
        });
        return;
      }
      for (const entry of plan) {
        const safe = quoteIdent(entry.table);
        const fetched = await fromHandle.query(`SELECT * FROM ${safe}`);
        if (!fetched.ok) {
          throw new CLIError(fetched.error.code, `Failed to read "${entry.table}": ${fetched.error.message}`, ExitCode.ERROR, fetched.error.meta);
        }
        const columns = fetched.data.columns;
        const rows = fetched.data.rows;
        if (rows.length === 0) continue;
        const colList = columns.map(quoteIdent).join(", ");
        const placeholders = columns.map(() => "?").join(", ");
        const insertSql = `INSERT INTO ${safe} (${colList}) VALUES (${placeholders})`;
        for (const row of rows) {
          const writeResult = await toHandle.execute(insertSql, row);
          if (!writeResult.ok) {
            throw new CLIError(
              writeResult.error.code,
              `Insert into "${entry.table}" failed after ${entry.copied} row(s): ${writeResult.error.message}`,
              ExitCode.ERROR,
              writeResult.error.meta
            );
          }
          entry.copied += writeResult.data.changes ?? 1;
        }
      }
      outputJson({
        from: { space: fromSpaceUri, db: options.fromDb },
        to: { space: toSpaceUri, db: options.toDb },
        tables: plan.map((p) => ({ table: p.table, rowsRead: p.rows, rowsWritten: p.copied }))
      });
    } catch (error) {
      handleError(error);
    }
  });
}
function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

// src/commands/duckdb.ts
import { readFile as readFile8, writeFile as writeFile8 } from "fs/promises";
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
      await writeFile8(outputPath, buffer);
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
      const bytes = new Uint8Array(await readFile8(filePath));
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

// src/commands/manifest.ts
import { readFile as readFile9 } from "fs/promises";
var DEFAULT_APP_SPACE = "applications";
function registerManifestCommand(program2) {
  const manifest = program2.command("manifest").description("Inspect TinyCloud app manifests");
  manifest.command("resolve <source>").description("Resolve a manifest file or URL to its effective space, paths, and DB basenames").addHelpText("after", `

Examples:
  $ tc manifest resolve ./manifest.json
  $ tc manifest resolve https://app.example.com/manifest.json --json

What it shows:
  - app_id, name, manifest_version
  - effective space name (default: "applications") and full space URI for the active profile
  - per-permission: service, fully-qualified path, actions
  - inferred SQL database basenames for sql/<db>/... paths

This command is read-only and does NOT contact the node \u2014 it just resolves
the manifest against the active profile's address/chain so you know which
\`--space\` and \`--db\` values to pass to other tc commands.
`).action(async (source, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const raw = await loadManifestSource(source);
      const parsed = JSON.parse(raw);
      if (!parsed.app_id) {
        throw new CLIError(
          "INVALID_MANIFEST",
          `Manifest is missing required field "app_id".`,
          ExitCode.ERROR
        );
      }
      await ensureAuthenticated(ctx);
      const spaceName = parsed.space ?? DEFAULT_APP_SPACE;
      const spaceUri = await resolveSpaceUri(spaceName, ctx.profile);
      const permissions = (parsed.permissions ?? []).map((p) => {
        const resolvedPath = p.skipPrefix ? p.path : prefixWithAppId(p.path, parsed.app_id);
        return {
          service: p.service,
          path: resolvedPath,
          actions: p.actions,
          sqlDb: extractSqlDbName(resolvedPath)
        };
      });
      const sqlDbs = unique(
        permissions.map((p) => p.sqlDb).filter((db) => Boolean(db))
      );
      const summary = {
        source,
        app_id: parsed.app_id,
        name: parsed.name,
        manifest_version: parsed.manifest_version,
        space: {
          name: spaceName,
          uri: spaceUri
        },
        permissions,
        sqlDatabases: sqlDbs
      };
      if (shouldOutputJson()) {
        outputJson(summary);
        return;
      }
      process.stdout.write(`${theme.heading("Manifest")}: ${theme.value(parsed.app_id)}`);
      if (parsed.name) process.stdout.write(theme.muted(` (${parsed.name})`));
      process.stdout.write("\n");
      process.stdout.write(`${theme.label("Space")}: ${theme.value(spaceName)}
`);
      if (spaceUri) {
        process.stdout.write(`${theme.label("Space URI")}: ${theme.value(spaceUri)}
`);
      }
      if (sqlDbs.length > 0) {
        process.stdout.write(`
${theme.heading("SQL databases")}
`);
        for (const db of sqlDbs) {
          process.stdout.write(`  ${theme.value(db)}
`);
        }
        process.stdout.write(theme.muted(`
Use with: tc sql query --space ${spaceName} --db <db> "..."
`));
      }
      if (permissions.length > 0) {
        process.stdout.write(`
${theme.heading("Permissions")}
`);
        const rows = permissions.map((p) => [p.service, p.path, p.actions.join(", ")]);
        process.stdout.write(formatTable(["service", "path", "actions"], rows) + "\n");
      }
    } catch (error) {
      handleError(error);
    }
  });
}
async function loadManifestSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new CLIError(
        "MANIFEST_FETCH_FAILED",
        `Failed to fetch manifest from ${source}: ${response.status} ${response.statusText}`,
        ExitCode.NETWORK_ERROR
      );
    }
    return response.text();
  }
  return readFile9(source, "utf8");
}
function prefixWithAppId(path, appId) {
  const slash = path.indexOf("/");
  if (slash === -1) return `${appId}/${path}`;
  const head = path.slice(0, slash);
  const tail = path.slice(slash + 1);
  return `${head}/${appId}/${tail}`;
}
function extractSqlDbName(path) {
  if (!path.startsWith("sql/")) return void 0;
  const rest = path.slice(4);
  const segments = rest.split("/");
  if (segments.length < 2) return rest;
  return segments.slice(0, -1).join("/");
}
function unique(arr) {
  return Array.from(new Set(arr));
}

// src/commands/upgrade.ts
import { execSync as execSync2 } from "child_process";
import { readFileSync as readFileSync2 } from "fs";
var PACKAGE_NAME = "@tinycloud/cli";
function getCurrentVersion() {
  const pkg = JSON.parse(
    readFileSync2(new URL("../package.json", import.meta.url), "utf-8")
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

// src/commands/status.ts
import {
  NodeWasmBindings
} from "@tinycloud/node-sdk";
var wasmBindings = null;
function registerStatusCommand(program2) {
  program2.command("status").description("Show local TinyCloud profile, session, delegation, and permission state").action(async (_options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const config = await ProfileManager.getConfig();
      const names = (await ProfileManager.listProfiles()).sort(
        (a, b) => a.localeCompare(b)
      );
      const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
      const profiles = await Promise.all(
        names.map(
          (name) => inspectProfile({
            name,
            activeProfile: ctx.profile,
            defaultProfile: config.defaultProfile
          })
        )
      );
      const summary = {
        generatedAt,
        activeProfile: ctx.profile,
        defaultProfile: config.defaultProfile,
        profileCount: profiles.length,
        authenticatedProfileCount: profiles.filter((p) => p.authenticated).length,
        activeDelegationCount: profiles.reduce(
          (sum, profile) => sum + profile.activeDelegationCount,
          0
        ),
        profiles
      };
      if (shouldOutputJson()) {
        outputJson(summary);
        return;
      }
      process.stdout.write(formatStatus(summary));
    } catch (error) {
      handleError(error);
    }
  });
}
async function inspectProfile(params) {
  const issues = [];
  const profile = await readProfile(params.name, issues);
  const session = await readSession(params.name, issues);
  const hasKey = await readHasKey(params.name, issues);
  const storedDelegations = await readDelegations(params.name, issues);
  const sessionPermissions = session ? sessionPermissionsFromRecap(session) : [];
  const sessionExpiry = session ? extractSessionExpiry(session) : null;
  const sessionExpired = sessionExpiry === null ? null : sessionExpiry.getTime() <= Date.now();
  const statusSession = {
    present: session !== null,
    expired: session === null ? null : sessionExpired,
    expiresAt: sessionExpiry?.toISOString() ?? null,
    permissions: sessionPermissions,
    permissionsCompact: compactPermissions(sessionPermissions)
  };
  const delegations = storedDelegations.map(inspectDelegation);
  const activeDelegationPermissions = delegations.filter((delegation) => delegation.active).flatMap((delegation) => delegation.permissions);
  const permissions = uniquePermissions([
    ...sessionPermissions,
    ...activeDelegationPermissions
  ]);
  const hasPrivateKey = typeof profile?.privateKey === "string" && profile.privateKey.length > 0;
  const localKeyAuthenticated = profile?.authMethod === "local" && hasPrivateKey;
  const sessionAuthenticated = session !== null && sessionExpired !== true;
  const authenticated = localKeyAuthenticated || sessionAuthenticated;
  const status = resolveStatus({
    exists: profile !== null,
    authenticated,
    localKeyAuthenticated,
    sessionExpired
  });
  return {
    name: params.name,
    active: params.name === params.activeProfile,
    default: params.name === params.defaultProfile,
    exists: profile !== null,
    status,
    host: profile?.host ?? null,
    did: profile?.did ?? null,
    sessionDid: profile?.sessionDid ?? null,
    ownerDid: profile?.ownerDid ?? null,
    address: profile?.address ?? null,
    spaceId: profile?.spaceId ?? null,
    authMethod: profile?.authMethod ?? null,
    posture: profile ? resolveProfilePosture(profile) : null,
    operatorType: profile ? resolveProfileOperatorType(profile) : null,
    hasKey,
    hasPrivateKey,
    authenticated,
    session: statusSession,
    delegations,
    permissions,
    permissionsCompact: compactPermissions(permissions),
    permissionCount: permissions.length,
    activeDelegationCount: delegations.filter((delegation) => delegation.active).length,
    delegationCount: delegations.length,
    issues
  };
}
async function readProfile(name, issues) {
  try {
    return await ProfileManager.getProfile(name);
  } catch (error) {
    issues.push(`profile: ${messageFromError(error)}`);
    return null;
  }
}
async function readSession(name, issues) {
  try {
    return asRecord(await ProfileManager.getSession(name));
  } catch (error) {
    issues.push(`session: ${messageFromError(error)}`);
    return null;
  }
}
async function readHasKey(name, issues) {
  try {
    return await ProfileManager.getKey(name) !== null;
  } catch (error) {
    issues.push(`key: ${messageFromError(error)}`);
    return false;
  }
}
async function readDelegations(name, issues) {
  try {
    return await loadAdditionalDelegations(name);
  } catch (error) {
    issues.push(`delegations: ${messageFromError(error)}`);
    return [];
  }
}
function inspectDelegation(entry) {
  const expiry = parseDate(entry.delegation.expiry);
  const expired = expiry === null ? null : expiry.getTime() <= Date.now();
  const permissions = normalizePermissions(
    Array.isArray(entry.permissions) && entry.permissions.length > 0 ? entry.permissions : permissionsFromDelegation(entry.delegation)
  );
  return {
    cid: entry.delegation.cid,
    active: expired !== true,
    expired,
    expiresAt: expiry?.toISOString() ?? null,
    permissions,
    permissionsCompact: compactPermissions(permissions)
  };
}
function resolveStatus(params) {
  if (!params.exists) return "missing";
  if (params.localKeyAuthenticated) return "local-key";
  if (params.authenticated) return "logged-in";
  if (params.sessionExpired === true) return "expired";
  return "signed-out";
}
function sessionPermissionsFromRecap(session) {
  if (typeof session.siwe !== "string" || session.siwe.length === 0) return [];
  try {
    const rawEntries = getWasmBindings().parseRecapFromSiwe(session.siwe);
    if (!Array.isArray(rawEntries)) return [];
    return normalizePermissions(rawEntries.map(permissionFromRawRecap));
  } catch {
    return [];
  }
}
function permissionFromRawRecap(value) {
  const record = asRecord(value);
  if (!record) return null;
  const service = stringValue(record.service);
  const space = stringValue(record.space);
  const path = stringValue(record.path);
  const actions = Array.isArray(record.actions) ? record.actions.map(String).filter(Boolean) : [];
  if (!service || !space || path === null || actions.length === 0) return null;
  return {
    service: normalizeService2(service),
    space,
    path,
    actions
  };
}
function normalizePermissions(entries) {
  const permissions = [];
  for (const entry of entries) {
    const permission = permissionFromUnknown(entry);
    if (permission) permissions.push(permission);
  }
  return uniquePermissions(permissions);
}
function permissionFromUnknown(value) {
  const record = asRecord(value);
  if (!record) return null;
  const service = stringValue(record.service);
  const space = stringValue(record.space);
  const path = stringValue(record.path);
  const actions = Array.isArray(record.actions) ? record.actions.map(String).filter(Boolean) : [];
  if (!service || !space || path === null || actions.length === 0) return null;
  return {
    service: normalizeService2(service),
    space,
    path,
    actions
  };
}
function uniquePermissions(entries) {
  const seen = /* @__PURE__ */ new Set();
  const unique2 = [];
  for (const entry of entries) {
    const key = compactPermission(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique2.push(entry);
  }
  return unique2;
}
function compactPermissions(entries) {
  return entries.map(compactPermission);
}
function extractSessionExpiry(session) {
  for (const key of ["expiresAt", "expiry", "expirationTime"]) {
    const parsed = parseDate(session[key]);
    if (parsed) return parsed;
  }
  if (typeof session.siwe !== "string") return null;
  const match = session.siwe.match(/^Expiration Time:\s*(.+)$/im);
  return match ? parseDate(match[1].trim()) : null;
}
function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 0 && value < 1e12 ? value * 1e3 : value;
    const date2 = new Date(millis);
    return Number.isNaN(date2.getTime()) ? null : date2;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function getWasmBindings() {
  wasmBindings ??= new NodeWasmBindings();
  return wasmBindings;
}
function normalizeService2(service) {
  return service.startsWith("tinycloud.") ? service : `tinycloud.${service}`;
}
function asRecord(value) {
  return value !== null && typeof value === "object" ? value : null;
}
function stringValue(value) {
  return typeof value === "string" ? value : null;
}
function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}
function formatStatus(summary) {
  const lines = [];
  lines.push(theme.heading("TinyCloud Status"));
  lines.push(`Active profile: ${theme.value(summary.activeProfile)}`);
  lines.push(`Default profile: ${theme.value(summary.defaultProfile)}`);
  lines.push("");
  if (summary.profiles.length === 0) {
    lines.push(theme.muted("No profiles configured. Run: tc init"));
    return `${lines.join("\n")}
`;
  }
  lines.push(theme.label("Profiles"));
  for (const profile of summary.profiles) {
    lines.push(formatProfile(profile));
  }
  return `${lines.join("\n")}
`;
}
function formatProfile(profile) {
  const marker = profile.active ? theme.success("*") : " ";
  const name = profile.default ? `${profile.name} (default)` : profile.name;
  const host = profile.host ? theme.muted(profile.host) : theme.muted("no host");
  const summary = [
    `${marker} ${profile.active ? theme.brand(name) : name}`,
    formatProfileStatus(profile.status),
    profile.posture ?? "no posture",
    plural(profile.permissionCount, "permission"),
    `${profile.activeDelegationCount}/${profile.delegationCount} delegations`,
    host
  ].join("  ");
  const lines = [summary];
  lines.push(`  session: ${formatSession(profile.session)}`);
  if (profile.permissionsCompact.length > 0) {
    lines.push("  permissions:");
    for (const permission of profile.permissionsCompact) {
      lines.push(`    ${permission}`);
    }
  }
  if (profile.delegations.length > 0) {
    lines.push("  delegations:");
    for (const delegation of profile.delegations) {
      lines.push(`    ${formatDelegation(delegation)}`);
    }
  }
  if (profile.issues.length > 0) {
    lines.push("  issues:");
    for (const issue of profile.issues) {
      lines.push(`    ${theme.warn(issue)}`);
    }
  }
  return lines.join("\n");
}
function formatProfileStatus(status) {
  switch (status) {
    case "logged-in":
      return theme.success("logged in");
    case "local-key":
      return theme.success("local key");
    case "expired":
      return theme.warn("expired");
    case "missing":
      return theme.warn("missing");
    case "signed-out":
      return theme.muted("signed out");
  }
}
function formatSession(session) {
  if (!session.present) return theme.muted("none");
  if (session.expired === true) {
    return `${theme.warn("expired")}${formatExpiresAt(session.expiresAt)}`;
  }
  if (session.expired === false) {
    return `${theme.success("active")}${formatExpiresAt(session.expiresAt)}`;
  }
  return `${theme.success("present")}${formatExpiresAt(session.expiresAt)}`;
}
function formatDelegation(delegation) {
  const state = delegation.expired === true ? theme.warn("expired") : theme.success("active");
  return [
    delegation.cid,
    state,
    formatExpiresAt(delegation.expiresAt).trim(),
    plural(delegation.permissions.length, "permission")
  ].filter(Boolean).join("  ");
}
function formatExpiresAt(expiresAt) {
  return expiresAt ? ` until ${expiresAt}` : "";
}
function plural(count, label) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

// src/index.ts
var { version } = JSON.parse(
  readFileSync3(new URL("../package.json", import.meta.url), "utf-8")
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
registerManifestCommand(program);
registerUpgradeCommand(program);
registerStatusCommand(program);
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
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from3, except, desc) => {
  if (from3 && typeof from3 === "object" || typeof from3 === "function") {
    for (let key of __getOwnPropNames(from3))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from3[key], enumerable: !(desc = __getOwnPropDesc(from3, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/ms/index.js
var require_ms = __commonJS({
  "../../node_modules/ms/index.js"(exports, module) {
    "use strict";
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms3) {
      var msAbs = Math.abs(ms3);
      if (msAbs >= d) {
        return Math.round(ms3 / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms3 / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms3 / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms3 / s) + "s";
      }
      return ms3 + "ms";
    }
    function fmtLong(ms3) {
      var msAbs = Math.abs(ms3);
      if (msAbs >= d) {
        return plural2(ms3, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural2(ms3, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural2(ms3, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural2(ms3, msAbs, s, "second");
      }
      return ms3 + " ms";
    }
    function plural2(ms3, msAbs, n, name2) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms3 / n) + " " + name2 + (isPlural ? "s" : "");
    }
  }
});

// ../sdk-services/dist/internal/decrypt-transport-response-error.cjs
var require_decrypt_transport_response_error = __commonJS({
  "../sdk-services/dist/internal/decrypt-transport-response-error.cjs"(exports, module) {
    "use strict";
    var __defProp3 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export3 = (target, all) => {
      for (var name2 in all)
        __defProp3(target, name2, { get: all[name2], enumerable: true });
    };
    var __copyProps2 = (to, from3, except, desc) => {
      if (from3 && typeof from3 === "object" || typeof from3 === "function") {
        for (let key of __getOwnPropNames2(from3))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp3(to, key, { get: () => from3[key], enumerable: !(desc = __getOwnPropDesc2(from3, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps2(__defProp3({}, "__esModule", { value: true }), mod);
    var DecryptTransportResponseError_exports = {};
    __export3(DecryptTransportResponseError_exports, {
      DecryptTransportResponseError: () => DecryptTransportResponseError4
    });
    module.exports = __toCommonJS(DecryptTransportResponseError_exports);
    var DecryptTransportResponseError4 = class extends Error {
      constructor(status, permissionHint) {
        super("Node decrypt request failed");
        this.status = status;
        this.permissionHint = permissionHint;
        this.name = "DecryptTransportResponseError";
      }
    };
  }
});

// src/index.ts
import { readFileSync as readFileSync3 } from "fs";
import { Command } from "commander";

// src/output/errors.ts
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// src/config/constants.ts
import {
  profilesPath,
  tinycloudConfigPath,
  tinycloudHomePath
} from "@tinycloud/operations/state";
var CONFIG_DIR = tinycloudHomePath();
var PROFILES_DIR = profilesPath();
var CONFIG_FILE = tinycloudConfigPath();
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
function outputError(code2, message, hint) {
  if (isInteractive()) {
    process.stderr.write(
      `${theme.error("\u2717")} ${theme.label(code2)}: ${message}
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
      error: { code: code2, message }
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
function formatCheck(ok2, label, detail) {
  const icon = ok2 === "warn" ? theme.warn("\u26A0") : ok2 ? theme.success("\u2713") : theme.error("\u2717");
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
function setActiveProfileName(name2) {
  activeProfileName = name2;
}
var CLIError = class extends Error {
  constructor(code2, message, exitCode = ExitCode.ERROR, metadata) {
    super(message);
    this.code = code2;
    this.exitCode = exitCode;
    this.metadata = metadata;
    this.name = "CLIError";
  }
};
function wrapError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Missing private key parameter in JWK")) {
    const profileName = activeProfileName ?? process.env.TC_PROFILE ?? DEFAULT_PROFILE;
    return new CLIError(
      "AUTH_REQUIRED",
      `Profile "${profileName}" cannot restore its session because its private key material is missing.`,
      ExitCode.AUTH_REQUIRED,
      {
        hint: `Sign in again with: tc --profile ${profileName} auth login --method openkey`
      }
    );
  }
  if (error instanceof CLIError) return error;
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
  const prebuilt = typeof cliError.metadata?.hint === "string" ? cliError.metadata.hint : void 0;
  const hint = prebuilt ?? buildAuthHint(cliError) ?? (cliError.code === "NETWORK_ERROR" ? buildNetworkHint() : void 0);
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
  const readHost = (name2) => {
    try {
      const raw = readFileSync(join(PROFILES_DIR, name2, "profile.json"), "utf8");
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
    for (const { name: name2, host } of others) {
      lines.push(`  tc profile switch ${name2.padEnd(longest)}   # ${host}`);
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
import { join as join2 } from "path";
import {
  readSession,
  removeSession,
  writeSession
} from "@tinycloud/operations/state";

// src/config/storage.ts
import { readFile, writeFile, stat, mkdir, rm, readdir } from "fs/promises";
import { dirname } from "path";
async function readJson(filePath) {
  try {
    const data = await readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (err2) {
    if (err2.code === "ENOENT") {
      return null;
    }
    throw err2;
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
  } catch (err2) {
    if (err2.code === "ENOENT") {
      return false;
    }
    throw err2;
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
  } catch (err2) {
    if (err2.code === "ENOENT") {
      return [];
    }
    throw err2;
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
  static async getProfile(name2) {
    const profilePath = join2(PROFILES_DIR, name2, "profile.json");
    const profile = await readJson(profilePath);
    if (!profile) {
      throw new CLIError(
        "PROFILE_NOT_FOUND",
        `Profile "${name2}" does not exist. Run \`tc init\` or \`tc profile create ${name2}\` first.`
      );
    }
    return profile;
  }
  /**
   * Saves a profile config, creating the profile directory if needed.
   */
  static async setProfile(name2, data) {
    const profileDir = join2(PROFILES_DIR, name2);
    await ensureDir(profileDir);
    await writeJson(join2(profileDir, "profile.json"), data);
  }
  /**
   * Returns true if a profile directory exists.
   */
  static async profileExists(name2) {
    return fileExists(join2(PROFILES_DIR, name2, "profile.json"));
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
  static async deleteProfile(name2) {
    const config = await _ProfileManager.getConfig();
    if (config.defaultProfile === name2) {
      throw new CLIError(
        "PROFILE_DELETE_DEFAULT",
        `Cannot delete the default profile "${name2}". Change the default first with \`tc profile default <other>\`.`
      );
    }
    const profileDir = join2(PROFILES_DIR, name2);
    await removeDir(profileDir);
  }
  // ── Key management ──────────────────────────────────────────────────
  /**
   * Returns the parsed JWK for a profile, or null if no key exists.
   */
  static async getKey(name2) {
    return readJson(join2(PROFILES_DIR, name2, "key.json"));
  }
  /**
   * Saves a JWK key for a profile.
   */
  static async setKey(name2, jwk) {
    const profileDir = join2(PROFILES_DIR, name2);
    await ensureDir(profileDir);
    await writeJson(join2(profileDir, "key.json"), jwk);
  }
  // ── Session management ──────────────────────────────────────────────
  /**
   * Returns the parsed session for a profile, or null if none exists.
   */
  static async getSession(name2) {
    return readSession(name2);
  }
  /**
   * Saves session data for a profile.
   */
  static async setSession(name2, session) {
    await writeSession(name2, session);
  }
  /**
   * Removes the session file for a profile.
   */
  static async clearSession(name2) {
    await removeSession(name2);
  }
  // ── Cache management ────────────────────────────────────────────────
  /**
   * Returns the path to the profile's cache directory, creating it if needed.
   */
  static async getCacheDir(name2) {
    const cacheDir = join2(PROFILES_DIR, name2, "cache");
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

// src/commands/account.ts
import open from "open";
import { readFile as readFile3 } from "fs/promises";

// src/lib/sdk.ts
import { TinyCloudNode } from "@tinycloud/node-sdk";

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

// src/lib/permissions.ts
import { appendFile, readFile as readFile2 } from "fs/promises";
import { join as join3 } from "path";
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
  upsertProfileRecord,
  withProfileLock,
  writeJsonAtomic
} from "@tinycloud/operations/state";

// ../sdk-core/src/manifest.ts
var import_ms = __toESM(require_ms(), 1);

// ../../node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
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

// ../../node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
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

// ../../node_modules/zod/v3/ZodError.js
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

// ../../node_modules/zod/v3/locales/en.js
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

// ../../node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../node_modules/zod/v3/helpers/parseUtil.js
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

// ../../node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../node_modules/zod/v3/types.js
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
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
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
      } catch (err2) {
        if (err2?.message?.toLowerCase()?.includes("encountered")) {
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
    const base642 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base642));
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
        const base3 = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base3))
          return INVALID;
        const result = effect.transform(base3.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base3) => {
          if (!isValid(base3))
            return INVALID;
          return Promise.resolve(effect.transform(base3.value, checkCtx)).then((result) => ({
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
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
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

// ../bootstrap/dist/index.js
var CAPABILITIES = [
  { urn: "tinycloud.kv/get", service: "tinycloud.kv", status: "active" },
  { urn: "tinycloud.kv/list", service: "tinycloud.kv", status: "active" },
  { urn: "tinycloud.kv/metadata", service: "tinycloud.kv", status: "active" },
  { urn: "tinycloud.kv/put", service: "tinycloud.kv", status: "active" },
  { urn: "tinycloud.kv/del", service: "tinycloud.kv", status: "active" },
  { urn: "tinycloud.kv/delete", service: "tinycloud.kv", status: "deprecated-alias", aliasOf: "tinycloud.kv/del" },
  { urn: "tinycloud.sql/read", service: "tinycloud.sql", status: "active" },
  { urn: "tinycloud.sql/select", service: "tinycloud.sql", status: "deprecated-alias", aliasOf: "tinycloud.sql/read" },
  { urn: "tinycloud.sql/write", service: "tinycloud.sql", status: "active" },
  { urn: "tinycloud.sql/schema", service: "tinycloud.sql", status: "active" },
  { urn: "tinycloud.sql/admin", service: "tinycloud.sql", status: "active", implies: ["tinycloud.sql/schema"] },
  { urn: "tinycloud.sql/*", service: "tinycloud.sql", status: "active", implies: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema", "tinycloud.sql/admin"] },
  { urn: "tinycloud.duckdb/read", service: "tinycloud.duckdb", status: "active" },
  { urn: "tinycloud.duckdb/write", service: "tinycloud.duckdb", status: "active" },
  { urn: "tinycloud.duckdb/admin", service: "tinycloud.duckdb", status: "active" },
  { urn: "tinycloud.duckdb/import", service: "tinycloud.duckdb", status: "active" },
  { urn: "tinycloud.duckdb/export", service: "tinycloud.duckdb", status: "active" },
  { urn: "tinycloud.duckdb/select", service: "tinycloud.duckdb", status: "deprecated-alias", aliasOf: "tinycloud.duckdb/read" },
  { urn: "tinycloud.duckdb/*", service: "tinycloud.duckdb", status: "active", implies: ["tinycloud.duckdb/read", "tinycloud.duckdb/write", "tinycloud.duckdb/admin", "tinycloud.duckdb/import", "tinycloud.duckdb/export"] },
  { urn: "tinycloud.capabilities/read", service: "tinycloud.capabilities", status: "active" },
  { urn: "tinycloud.hooks/subscribe", service: "tinycloud.hooks", status: "active" },
  { urn: "tinycloud.hooks/register", service: "tinycloud.hooks", status: "active" },
  { urn: "tinycloud.hooks/list", service: "tinycloud.hooks", status: "active" },
  { urn: "tinycloud.hooks/unregister", service: "tinycloud.hooks", status: "active" },
  { urn: "tinycloud.encryption/decrypt", service: "tinycloud.encryption", status: "active" },
  { urn: "tinycloud.encryption/network.create", service: "tinycloud.encryption", status: "active" },
  { urn: "tinycloud.encryption/network.revoke", service: "tinycloud.encryption", status: "active" },
  { urn: "tinycloud.space/host", service: "tinycloud.space", status: "active" },
  { urn: "tinycloud.space/create", service: "tinycloud.space", status: "active" },
  { urn: "tinycloud.space/list", service: "tinycloud.space", status: "active" },
  { urn: "tinycloud.space/info", service: "tinycloud.space", status: "active" },
  { urn: "tinycloud.vfs/get", service: "tinycloud.vfs", status: "reserved" },
  { urn: "tinycloud.vfs/list", service: "tinycloud.vfs", status: "reserved" },
  { urn: "tinycloud.vfs/metadata", service: "tinycloud.vfs", status: "reserved" },
  { urn: "tinycloud.vfs/put", service: "tinycloud.vfs", status: "reserved" },
  { urn: "tinycloud.vfs/delete", service: "tinycloud.vfs", status: "reserved" }
];
function actionKey(action) {
  if (action === "*") return "ALL";
  return action.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
function serviceOf(urn) {
  return urn.slice("tinycloud.".length, urn.indexOf("/"));
}
function actionOf(urn) {
  return urn.slice(urn.indexOf("/") + 1);
}
function deriveServiceConstants(service) {
  const out = {};
  for (const entry of CAPABILITIES) {
    if (serviceOf(entry.urn) !== service) continue;
    out[actionKey(actionOf(entry.urn))] = entry.urn;
  }
  return out;
}
var KV = deriveServiceConstants("kv");
var SQL = {
  ...deriveServiceConstants("sql"),
  EXECUTE: "tinycloud.sql/execute",
  EXPORT: "tinycloud.sql/export"
};
var DUCKDB = {
  ...deriveServiceConstants("duckdb"),
  DESCRIBE: "tinycloud.duckdb/describe",
  EXECUTE: "tinycloud.duckdb/execute"
};
var CAPABILITIES2 = deriveServiceConstants("capabilities");
var HOOKS = deriveServiceConstants("hooks");
var ENCRYPTION = deriveServiceConstants("encryption");
var SPACE = deriveServiceConstants("space");
var CAPABILITY_REGISTRY = CAPABILITIES;
var DEFAULT_MANIFEST_SPACE = "applications";
var ACCOUNT_REGISTRY_SPACE = "account";
var ACCOUNT_REGISTRY_PATH = "applications/";
var SECRETS_SPACE = "secrets";
var BOOTSTRAP_DEFAULT_SPACE = "default";
var BOOTSTRAP_PUBLIC_SPACE = "public";
var BOOTSTRAP_ENCRYPTION_NETWORK_NAME = "default";
var BOOTSTRAP_ENCRYPTION_NETWORK_RESOURCE_TEMPLATE = `urn:tinycloud:encryption:{ownerDid}:${BOOTSTRAP_ENCRYPTION_NETWORK_NAME}`;
var DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1e3;
var VAULT_PERMISSION_SERVICE = "tinycloud.vault";
var ENCRYPTION_PERMISSION_SERVICE = "tinycloud.encryption";
var ENCRYPTION_MANIFEST_SPACE = "encryption";
var NETWORK_CREATE_ACTION = ENCRYPTION.NETWORK_CREATE;
var BOOTSTRAP_SPACE_NAMES = [
  BOOTSTRAP_DEFAULT_SPACE,
  DEFAULT_MANIFEST_SPACE,
  ACCOUNT_REGISTRY_SPACE,
  SECRETS_SPACE,
  BOOTSTRAP_PUBLIC_SPACE
];
var TINYCLOUD_DEFAULT_SPACE_MANIFEST = {
  app_id: "xyz.tinycloud.default",
  name: "TinyCloud Default Space",
  space: BOOTSTRAP_DEFAULT_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: BOOTSTRAP_DEFAULT_SPACE,
      // Empty path = whole service on this space. Do NOT use "/": the recap
      // encoder joins it as `<space>/<service>//`, which the node's byte-prefix
      // resource matching can never extend (real paths start `<service>/x…`).
      path: "",
      actions: ["get", "put", "del", "list", "metadata"]
    },
    {
      service: "tinycloud.sql",
      space: BOOTSTRAP_DEFAULT_SPACE,
      path: "",
      actions: ["read", "write"]
    }
  ]
};
var TINYCLOUD_APPLICATIONS_SPACE_MANIFEST = {
  app_id: "xyz.tinycloud.applications",
  name: "TinyCloud Applications Space",
  space: DEFAULT_MANIFEST_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: DEFAULT_MANIFEST_SPACE,
      // Empty path = whole service on this space. Do NOT use "/": the recap
      // encoder joins it as `<space>/<service>//`, which the node's byte-prefix
      // resource matching can never extend (real paths start `<service>/x…`).
      path: "",
      actions: ["get", "put", "del", "list", "metadata"]
    },
    {
      service: "tinycloud.sql",
      space: DEFAULT_MANIFEST_SPACE,
      path: "",
      actions: ["read", "write"]
    }
  ]
};
var TINYCLOUD_ACCOUNT_SPACE_MANIFEST = {
  app_id: "xyz.tinycloud.account",
  name: "TinyCloud Account Registry",
  space: ACCOUNT_REGISTRY_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "applications/",
      actions: ["get", "put", "list"]
    },
    {
      service: "tinycloud.kv",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "spaces/",
      actions: ["get", "put", "list"]
    },
    {
      service: "tinycloud.sql",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "account",
      actions: ["read", "write", "schema"]
    }
  ]
};
var TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST = {
  app_id: "xyz.tinycloud.secrets",
  name: "TinyCloud Secrets",
  space: SECRETS_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.vault",
      space: SECRETS_SPACE,
      path: "secrets/",
      actions: ["read"],
      skipPrefix: true
    },
    {
      service: "tinycloud.kv",
      space: SECRETS_SPACE,
      path: "variables",
      actions: ["list", "metadata"],
      skipPrefix: true
    },
    {
      service: "tinycloud.kv",
      space: SECRETS_SPACE,
      path: "variables/",
      actions: ["get", "put", "del", "list", "metadata"],
      skipPrefix: true
    },
    {
      service: "tinycloud.sql",
      space: SECRETS_SPACE,
      path: "default",
      actions: ["read", "write", "schema"],
      skipPrefix: true
    },
    {
      service: "tinycloud.capabilities",
      space: SECRETS_SPACE,
      path: "",
      actions: ["read"],
      skipPrefix: true
    }
  ]
};
var TINYCLOUD_PUBLIC_SPACE_MANIFEST = {
  app_id: "xyz.tinycloud.public",
  name: "TinyCloud Public Space",
  space: BOOTSTRAP_PUBLIC_SPACE,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: BOOTSTRAP_PUBLIC_SPACE,
      path: "",
      actions: ["get", "list", "metadata"]
    }
  ]
};
var BOOTSTRAP_SPACE_MANIFESTS = {
  [BOOTSTRAP_DEFAULT_SPACE]: TINYCLOUD_DEFAULT_SPACE_MANIFEST,
  [DEFAULT_MANIFEST_SPACE]: TINYCLOUD_APPLICATIONS_SPACE_MANIFEST,
  [ACCOUNT_REGISTRY_SPACE]: TINYCLOUD_ACCOUNT_SPACE_MANIFEST,
  [SECRETS_SPACE]: TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST,
  [BOOTSTRAP_PUBLIC_SPACE]: TINYCLOUD_PUBLIC_SPACE_MANIFEST
};
var BOOTSTRAP_PERSISTED_APPLICATION_MANIFESTS = [
  TINYCLOUD_SECRETS_BOOTSTRAP_MANIFEST
];
var ACCOUNT_INDEX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applications (
    app_id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    updated_at TEXT,
    manifest_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS application_state (
    app_id TEXT PRIMARY KEY,
    manifest_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS spaces (
    space_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_did TEXT NOT NULL,
    type TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    status TEXT NOT NULL,
    registered_at TEXT,
    updated_at TEXT NOT NULL,
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS delegations (
    cid TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    space_id TEXT NOT NULL,
    space_name TEXT,
    counterparty_did TEXT NOT NULL,
    delegate_did TEXT NOT NULL,
    delegator_did TEXT,
    path TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    expiry TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    source TEXT PRIMARY KEY,
    synced_at TEXT NOT NULL,
    count INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_delegations_direction ON delegations(direction)",
  "CREATE INDEX IF NOT EXISTS idx_delegations_space ON delegations(space_id)",
  "CREATE INDEX IF NOT EXISTS idx_delegations_counterparty ON delegations(counterparty_did)",
  "CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_did)",
  "CREATE INDEX IF NOT EXISTS idx_spaces_type ON spaces(type)"
];
var SECRET_RECORDS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS secret_records (
    scope TEXT NOT NULL,
    name TEXT NOT NULL,
    provider_id TEXT,
    custom_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_tested TEXT,
    test_status TEXT,
    test_message TEXT,
    PRIMARY KEY(scope, name)
  )`
];
var BOOTSTRAP_MANIFEST = {
  spaces: BOOTSTRAP_SPACE_NAMES.map((name2) => ({
    name: name2,
    manifest: BOOTSTRAP_SPACE_MANIFESTS[name2],
    persistedAsApplication: name2 === SECRETS_SPACE
  })),
  applications: BOOTSTRAP_PERSISTED_APPLICATION_MANIFESTS,
  accountIndexSchema: ACCOUNT_INDEX_SCHEMA,
  secretRecordsSchema: SECRET_RECORDS_SCHEMA,
  encryptionNetwork: {
    name: BOOTSTRAP_ENCRYPTION_NETWORK_NAME
  }
};
function cloneManifest(manifest) {
  return {
    ...manifest,
    permissions: manifest.permissions?.map((permission) => ({
      ...permission,
      actions: [...permission.actions]
    }))
  };
}
function actionUrn(service, action) {
  return action.includes("/") ? action : `${service}/${action}`;
}
function applyPrefix(prefix, path, skipPrefix) {
  if (skipPrefix === true || prefix === "" || path === "") {
    return path;
  }
  if (path === "/") {
    return `${prefix}/`;
  }
  const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const trimmedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${trimmedPrefix}/${trimmedPath}`;
}
function expandVaultPermission(entry) {
  return entry.actions.map((action) => {
    const normalized = action.startsWith("tinycloud.vault/") ? action.slice("tinycloud.vault/".length) : action.startsWith("tinycloud.kv/") ? action.slice("tinycloud.kv/".length) : action;
    const mapped = normalized === "read" || normalized === "get" ? KV.GET : normalized === "write" || normalized === "put" ? KV.PUT : normalized === "delete" || normalized === "del" ? KV.DEL : normalized === "list" ? KV.LIST : normalized === "metadata" ? KV.METADATA : void 0;
    if (mapped === void 0) {
      throw new Error(`unknown vault action ${JSON.stringify(action)}`);
    }
    const normalizedPath = entry.path.startsWith("/") ? entry.path.slice(1) : entry.path;
    return {
      ...entry,
      service: "tinycloud.kv",
      path: `vault/${normalizedPath}`,
      actions: [mapped],
      skipPrefix: true
    };
  });
}
function expandPermissionEntry(entry, prefix, inheritedSpace) {
  if (entry.service === VAULT_PERMISSION_SERVICE) {
    return expandVaultPermission(entry).flatMap(
      (expanded) => expandPermissionEntry(expanded, prefix, inheritedSpace)
    );
  }
  const skipPrefix = entry.skipPrefix === true || entry.service === ENCRYPTION_PERMISSION_SERVICE;
  return [
    {
      service: entry.service,
      space: entry.service === ENCRYPTION_PERMISSION_SERVICE ? ENCRYPTION_MANIFEST_SPACE : entry.space ?? inheritedSpace,
      path: applyPrefix(prefix, entry.path, skipPrefix),
      actions: entry.actions.map((action) => actionUrn(entry.service, action)),
      ...entry.description !== void 0 ? { description: entry.description } : {}
    }
  ];
}
function dedupeResources(resources) {
  const byKey = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    const key = `${resource.service}\0${resource.space}\0${resource.path}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...resource, actions: [...resource.actions] });
      continue;
    }
    for (const action of resource.actions) {
      if (!existing.actions.includes(action)) {
        existing.actions.push(action);
      }
    }
  }
  return [...byKey.values()];
}
function withCapabilitiesReadForSpaces(resources) {
  const spaces = new Set(
    resources.filter((resource) => resource.service !== ENCRYPTION_PERMISSION_SERVICE).map((resource) => resource.space)
  );
  return dedupeResources([
    ...resources,
    ...[...spaces].map((space) => ({
      service: "tinycloud.capabilities",
      space,
      path: "",
      actions: [CAPABILITIES2.READ]
    }))
  ]);
}
function accountRegistryPermissions() {
  return [
    {
      service: "tinycloud.kv",
      space: ACCOUNT_REGISTRY_SPACE,
      path: ACCOUNT_REGISTRY_PATH,
      actions: [KV.GET, KV.PUT, KV.LIST]
    },
    {
      service: "tinycloud.kv",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "spaces/",
      actions: [KV.GET, KV.PUT, KV.LIST]
    },
    {
      service: "tinycloud.sql",
      space: ACCOUNT_REGISTRY_SPACE,
      path: "account",
      actions: [SQL.READ, SQL.WRITE, SQL.SCHEMA]
    }
  ];
}
function composeManifestRequest(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("composeManifestRequest requires at least one manifest");
  }
  const includeAccountRegistryPermissions = options.includeAccountRegistryPermissions ?? true;
  const manifests = inputs.map(cloneManifest);
  const resources = manifests.flatMap((manifest) => {
    const prefix = manifest.prefix ?? manifest.app_id;
    const space = manifest.space ?? DEFAULT_MANIFEST_SPACE;
    const explicit = manifest.permissions ?? [];
    return explicit.flatMap((entry) => expandPermissionEntry(entry, prefix, space));
  });
  if (includeAccountRegistryPermissions) {
    resources.push(...accountRegistryPermissions());
  }
  const manifestsByAppId = /* @__PURE__ */ new Map();
  for (const manifest of manifests) {
    const current = manifestsByAppId.get(manifest.app_id) ?? [];
    current.push(cloneManifest(manifest));
    manifestsByAppId.set(manifest.app_id, current);
  }
  return {
    manifests,
    resources: withCapabilitiesReadForSpaces(resources),
    delegationTargets: [],
    registryRecords: includeAccountRegistryPermissions ? [...manifestsByAppId.entries()].map(([app_id, appManifests]) => ({
      key: `${ACCOUNT_REGISTRY_PATH}${app_id}`,
      app_id,
      manifests: appManifests
    })) : [],
    expiryMs: DEFAULT_EXPIRY_MS,
    includePublicSpace: manifests.some(
      (manifest) => manifest.includePublicSpace ?? true
    )
  };
}
function composeBootstrapSpaceManifest(space) {
  return composeManifestRequest([BOOTSTRAP_SPACE_MANIFESTS[space]], {
    includeAccountRegistryPermissions: false
  });
}
var BOOTSTRAP_SESSION_REQUESTS = Object.freeze(
  Object.fromEntries(
    BOOTSTRAP_SPACE_NAMES.map((space) => [
      space,
      composeBootstrapSpaceManifest(space)
    ])
  )
);
var ACCOUNT_SESSION_RAW_ALLOWLIST = Object.freeze([
  {
    service: "tinycloud.encryption",
    resource: BOOTSTRAP_ENCRYPTION_NETWORK_RESOURCE_TEMPLATE,
    actions: [NETWORK_CREATE_ACTION]
  }
]);
var BOOTSTRAP_ALLOWLIST = Object.freeze(
  BOOTSTRAP_SPACE_NAMES.flatMap((space) => [
    {
      kind: "session",
      service: "tinycloud.session",
      space,
      actions: ["siwe"],
      resources: BOOTSTRAP_SESSION_REQUESTS[space].resources,
      ...space === ACCOUNT_REGISTRY_SPACE ? { rawAbilities: ACCOUNT_SESSION_RAW_ALLOWLIST } : {}
    },
    {
      kind: "space/host",
      service: "tinycloud.space",
      space,
      actions: [SPACE.HOST]
    }
  ])
);

// ../sdk-services/dist/index.js
var import_decrypt_transport_response_error = __toESM(require_decrypt_transport_response_error(), 1);
var import_decrypt_transport_response_error2 = __toESM(require_decrypt_transport_response_error(), 1);
var import_decrypt_transport_response_error3 = __toESM(require_decrypt_transport_response_error(), 1);
var ErrorCodes = {
  // Common errors
  NOT_FOUND: "NOT_FOUND",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  ABORTED: "ABORTED",
  INVALID_INPUT: "INVALID_INPUT",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  // KV-specific errors
  KV_NOT_FOUND: "KV_NOT_FOUND",
  KV_WRITE_FAILED: "KV_WRITE_FAILED",
  // SQL-specific errors
  SQL_ERROR: "SQL_ERROR",
  SQL_PERMISSION_DENIED: "SQL_PERMISSION_DENIED",
  SQL_DATABASE_NOT_FOUND: "SQL_DATABASE_NOT_FOUND",
  SQL_RESPONSE_TOO_LARGE: "SQL_RESPONSE_TOO_LARGE",
  SQL_QUOTA_EXCEEDED: "SQL_QUOTA_EXCEEDED",
  SQL_INVALID_STATEMENT: "SQL_INVALID_STATEMENT",
  SQL_SCHEMA_ERROR: "SQL_SCHEMA_ERROR",
  SQL_READONLY_VIOLATION: "SQL_READONLY_VIOLATION",
  // Storage quota errors
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  STORAGE_LIMIT_REACHED: "STORAGE_LIMIT_REACHED",
  // DuckDB-specific errors
  DUCKDB_ERROR: "DUCKDB_ERROR",
  DUCKDB_PERMISSION_DENIED: "DUCKDB_PERMISSION_DENIED",
  DUCKDB_DATABASE_NOT_FOUND: "DUCKDB_DATABASE_NOT_FOUND",
  DUCKDB_RESPONSE_TOO_LARGE: "DUCKDB_RESPONSE_TOO_LARGE",
  DUCKDB_QUOTA_EXCEEDED: "DUCKDB_QUOTA_EXCEEDED",
  DUCKDB_INVALID_STATEMENT: "DUCKDB_INVALID_STATEMENT",
  DUCKDB_SCHEMA_ERROR: "DUCKDB_SCHEMA_ERROR",
  DUCKDB_READONLY_VIOLATION: "DUCKDB_READONLY_VIOLATION"
};
var defaultRetryPolicy = {
  maxAttempts: 3,
  backoff: "exponential",
  baseDelayMs: 1e3,
  maxDelayMs: 1e4,
  retryableErrors: [ErrorCodes.NETWORK_ERROR, ErrorCodes.TIMEOUT]
};
var TelemetryEvents = {
  SPAN: "telemetry.span",
  SERVICE_REQUEST: "service.request",
  SERVICE_RESPONSE: "service.response",
  SERVICE_ERROR: "service.error",
  SERVICE_RETRY: "service.retry",
  SESSION_CHANGED: "session.changed",
  SESSION_EXPIRED: "session.expired"
};
function ok(data) {
  return { ok: true, data };
}
function err(error) {
  return { ok: false, error };
}
function serviceError(code2, message, service, options) {
  return {
    code: code2,
    message,
    service,
    cause: options?.cause,
    meta: options?.meta
  };
}
var REDACTED = "[REDACTED]";
var SAFE_NUMBER_FIELDS = /* @__PURE__ */ new Set([
  "duration",
  "durationMs",
  "endedAt",
  "startedAt",
  "status",
  "timestamp"
]);
var SAFE_BOOLEAN_FIELDS = /* @__PURE__ */ new Set(["authenticated", "ok", "persisted"]);
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function isBinaryData(value) {
  try {
    return Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
  } catch {
    return true;
  }
}
function read(value, key) {
  try {
    return value[key];
  } catch {
    return REDACTED;
  }
}
function projectDiagnosticError(error) {
  if (typeof error !== "object" || error === null) return {};
  const status = finiteNumber(read(error, "status"));
  return status !== void 0 && status >= 100 && status <= 599 ? { status } : {};
}
function projectDiagnosticData(value) {
  if (value === null || value === void 0) return value;
  if (typeof value !== "object") return REDACTED;
  try {
    if (isBinaryData(value)) return REDACTED;
    const projected = {};
    for (const key of SAFE_NUMBER_FIELDS) {
      const number = finiteNumber(read(value, key));
      if (number !== void 0) projected[key] = number;
    }
    for (const key of SAFE_BOOLEAN_FIELDS) {
      const boolean = read(value, key);
      if (typeof boolean === "boolean") projected[key] = boolean;
    }
    const url = read(value, "url");
    if (url !== void 0) projected.url = REDACTED;
    const error = read(value, "error");
    if (error !== void 0) projected.error = projectDiagnosticError(error);
    return projected;
  } catch {
    return REDACTED;
  }
}
var DEBUG_FLAG = "TinyCloud_debug";
var MAX_EVENTS = 1e3;
function getGlobal() {
  return globalThis;
}
function nowMs() {
  const performanceNow = globalThis.performance?.now?.bind(globalThis.performance);
  return typeof performanceNow === "function" ? performanceNow() : Date.now();
}
function isTrue(value) {
  return value === true || value === "true" || value === "1";
}
function getProcessDebugFlag() {
  const processLike = globalThis.process;
  return processLike?.env?.[DEBUG_FLAG];
}
function isBrowserWindow() {
  const global = getGlobal();
  return global.window === globalThis;
}
function getLocalStorage() {
  if (!isBrowserWindow()) {
    return void 0;
  }
  try {
    return globalThis.localStorage;
  } catch {
    return void 0;
  }
}
function getStoredDebugFlag() {
  const storage = getLocalStorage();
  if (!storage) {
    return void 0;
  }
  try {
    return storage.getItem(DEBUG_FLAG);
  } catch {
    return void 0;
  }
}
function setStoredDebugFlag(enabled) {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    if (enabled) {
      storage.setItem(DEBUG_FLAG, "true");
    } else {
      storage.removeItem(DEBUG_FLAG);
    }
  } catch {
  }
}
function shouldStartEnabled() {
  const global = getGlobal();
  return isTrue(global[DEBUG_FLAG]) || isTrue(getStoredDebugFlag()) || isTrue(getProcessDebugFlag());
}
var TinyCloudDebugLogger = class {
  constructor() {
    this.enabled = shouldStartEnabled();
    this.sequence = 0;
    this.events = [];
    this.maxEvents = MAX_EVENTS;
  }
  isEnabled() {
    return this.enabled || isTrue(getGlobal()[DEBUG_FLAG]) || isTrue(getProcessDebugFlag());
  }
  enable(options = {}) {
    this.enabled = true;
    getGlobal()[DEBUG_FLAG] = true;
    if (options.persist !== false) {
      setStoredDebugFlag(true);
    }
    this.log("debug.enabled", { persisted: options.persist !== false });
  }
  disable(options = {}) {
    this.log("debug.disabled", { persisted: options.persist !== false });
    this.enabled = false;
    getGlobal()[DEBUG_FLAG] = false;
    if (options.persist !== false) {
      setStoredDebugFlag(false);
    }
  }
  clear() {
    this.events = [];
  }
  getLogs() {
    return [...this.events];
  }
  log(event, data, message) {
    if (!this.isEnabled()) {
      return void 0;
    }
    return this.record({
      event,
      data,
      message,
      level: "debug",
      timestamp: Date.now(),
      timestampIso: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  startTimer(event, data) {
    if (!this.isEnabled()) {
      return { stop: () => void 0 };
    }
    const startedAt = nowMs();
    this.log(`${event}.start`, data);
    return {
      stop: (finishData) => {
        const endedAt = nowMs();
        return this.record({
          event: `${event}.end`,
          data: finishData,
          durationMs: endedAt - startedAt,
          startedAt,
          endedAt,
          level: "debug",
          timestamp: Date.now(),
          timestampIso: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    };
  }
  async timeAsync(event, operation, data) {
    if (!this.isEnabled()) {
      return operation();
    }
    const timer = this.startTimer(event, data);
    try {
      const result = await operation();
      timer.stop({ ok: true });
      return result;
    } catch (error) {
      timer.stop({ ok: false, error });
      throw error;
    }
  }
  time(event, operation, data) {
    if (!this.isEnabled()) {
      return operation();
    }
    const timer = this.startTimer(event, data);
    try {
      const result = operation();
      timer.stop({ ok: true });
      return result;
    } catch (error) {
      timer.stop({ ok: false, error });
      throw error;
    }
  }
  record(event) {
    const debugEvent = {
      ...event,
      ...event.data === void 0 ? {} : { data: projectDiagnosticData(event.data) },
      ...event.message === void 0 ? {} : { message: "[REDACTED]" },
      sequence: ++this.sequence
    };
    this.events.push(debugEvent);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    try {
      globalThis.console?.debug?.("[TinyCloud]", debugEvent.event, debugEvent);
    } catch {
    }
    return debugEvent;
  }
};
var tinyCloudDebugLogger = new TinyCloudDebugLogger();
function enableTinyCloudDebug(options) {
  tinyCloudDebugLogger.enable(options);
  return tinyCloudDebugLogger;
}
function disableTinyCloudDebug(options) {
  tinyCloudDebugLogger.disable(options);
  return tinyCloudDebugLogger;
}
function getTinyCloudDebugLogs() {
  return tinyCloudDebugLogger.getLogs();
}
function clearTinyCloudDebugLogs() {
  tinyCloudDebugLogger.clear();
}
function installTinyCloudDebugGlobals() {
  const global = getGlobal();
  global.TinyCloudDebug = tinyCloudDebugLogger;
  global.enableTinyCloudDebug = enableTinyCloudDebug;
  global.disableTinyCloudDebug = disableTinyCloudDebug;
  global.getTinyCloudDebugLogs = getTinyCloudDebugLogs;
  global.clearTinyCloudDebugLogs = clearTinyCloudDebugLogs;
}
installTinyCloudDebugGlobals();
var ServiceErrorSchema = external_exports.object({
  /** Error code for programmatic handling (e.g., 'KV_NOT_FOUND', 'AUTH_EXPIRED') */
  code: external_exports.string(),
  /** Human-readable error message */
  message: external_exports.string(),
  /** Service that produced the error (e.g., 'kv', 'sql') */
  service: external_exports.string(),
  /** Original error if this wraps another error - not validated since Error is a class */
  cause: external_exports.unknown().optional(),
  /** Additional metadata about the error - passthrough allows any object properties */
  meta: external_exports.object({}).passthrough().optional()
});
function createResultSchema(dataSchema, errorSchema = ServiceErrorSchema) {
  return external_exports.discriminatedUnion("ok", [
    external_exports.object({
      ok: external_exports.literal(true),
      data: dataSchema
    }),
    external_exports.object({
      ok: external_exports.literal(false),
      error: errorSchema
    })
  ]);
}
var GenericResultSchema = createResultSchema(external_exports.unknown(), ServiceErrorSchema);
var KVResponseHeadersSchema = external_exports.object({
  /** ETag for conditional requests */
  etag: external_exports.string().optional(),
  /** Content type of the stored value */
  contentType: external_exports.string().optional(),
  /** Last modification timestamp */
  lastModified: external_exports.string().optional(),
  /** Content length in bytes */
  contentLength: external_exports.number().optional()
});
function createKVResponseSchema(dataSchema) {
  return external_exports.object({
    /** The data payload */
    data: dataSchema,
    /** Response headers with metadata */
    headers: KVResponseHeadersSchema
  });
}
var GenericKVResponseSchema = createKVResponseSchema(external_exports.unknown());
var KVListResponseSchema = external_exports.object({
  /** Array of keys matching the list criteria */
  keys: external_exports.array(external_exports.string())
});
var KVListResultSchema = createResultSchema(KVListResponseSchema);
var ServiceRequestEventSchema = external_exports.object({
  service: external_exports.string(),
  action: external_exports.string(),
  span: external_exports.string().optional(),
  key: external_exports.string().optional(),
  timestamp: external_exports.number()
});
var ServiceResponseEventSchema = external_exports.object({
  service: external_exports.string(),
  action: external_exports.string(),
  span: external_exports.string().optional(),
  ok: external_exports.boolean(),
  duration: external_exports.number(),
  durationMs: external_exports.number().optional(),
  status: external_exports.number().optional()
});
var ServiceErrorEventSchema = external_exports.object({
  service: external_exports.string(),
  span: external_exports.string().optional(),
  error: ServiceErrorSchema
});
var ServiceRetryEventSchema = external_exports.object({
  service: external_exports.string(),
  attempt: external_exports.number().int().positive(),
  maxAttempts: external_exports.number().int().positive(),
  error: ServiceErrorSchema
});
var TelemetrySpanEventSchema = external_exports.object({
  span: external_exports.string(),
  ok: external_exports.boolean(),
  durationMs: external_exports.number(),
  service: external_exports.string().optional(),
  action: external_exports.string().optional(),
  status: external_exports.number().optional(),
  error: ServiceErrorSchema.optional()
});
var RetryPolicySchema = external_exports.object({
  /** Maximum number of attempts (including initial) */
  maxAttempts: external_exports.number().int().positive(),
  /** Backoff strategy between retries */
  backoff: external_exports.enum(["none", "linear", "exponential"]),
  /** Base delay in milliseconds for backoff calculation */
  baseDelayMs: external_exports.number().nonnegative(),
  /** Maximum delay in milliseconds between retries */
  maxDelayMs: external_exports.number().nonnegative(),
  /** Error codes that should trigger a retry */
  retryableErrors: external_exports.array(external_exports.string())
});
var ServiceSessionSchema = external_exports.object({
  /** The delegation header containing the UCAN */
  delegationHeader: external_exports.object({
    Authorization: external_exports.string()
  }),
  /** The delegation CID */
  delegationCid: external_exports.string(),
  /** The space ID for this session */
  spaceId: external_exports.string(),
  /** The verification method DID */
  verificationMethod: external_exports.string(),
  /** The session key JWK (required for invoke) */
  jwk: external_exports.object({}).passthrough()
});
function parsePermissionHint(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const candidate = value;
  const keys = Object.keys(candidate).sort();
  if (keys.some((key) => !["actions", "path", "service", "space"].includes(key))) return void 0;
  if (candidate.service !== "tinycloud.kv" && candidate.service !== "tinycloud.encryption") return void 0;
  if (typeof candidate.path !== "string" || candidate.path.length === 0 || candidate.path.includes("*")) return void 0;
  if (candidate.service === "tinycloud.kv" && (typeof candidate.space !== "string" || candidate.space.length === 0 || !candidate.path.startsWith("vault/") || candidate.path.endsWith("/"))) {
    return void 0;
  }
  if (candidate.service === "tinycloud.encryption" && (candidate.space !== void 0 || !candidate.path.startsWith("urn:tinycloud:encryption:") || candidate.path.endsWith(":"))) {
    return void 0;
  }
  if (!Array.isArray(candidate.actions) || candidate.actions.length !== 1 || typeof candidate.actions[0] !== "string" || candidate.actions[0].includes("*")) return void 0;
  const expectedAction = candidate.service === "tinycloud.kv" ? "tinycloud.kv/get" : "tinycloud.encryption/decrypt";
  if (candidate.actions[0] !== expectedAction) return void 0;
  const space = typeof candidate.space === "string" ? candidate.space : void 0;
  return {
    service: candidate.service,
    ...space === void 0 ? {} : { space },
    path: candidate.path,
    actions: [candidate.actions[0]]
  };
}
function parsePermissionHintFromErrorText(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return void 0;
    const root = parsed;
    const nested = root.error;
    const nestedRecord = typeof nested === "object" && nested !== null ? nested : void 0;
    return parsePermissionHint(root.permissionHint) ?? parsePermissionHint(nestedRecord?.permissionHint);
  } catch {
    return void 0;
  }
}
function authRequiredError(service) {
  return {
    code: ErrorCodes.AUTH_REQUIRED,
    message: "Authentication required. Please sign in first.",
    service
  };
}
function timeoutError(service) {
  return {
    code: ErrorCodes.TIMEOUT,
    message: "Request timed out.",
    service
  };
}
function abortedError(service) {
  return {
    code: ErrorCodes.ABORTED,
    message: "Request was aborted.",
    service
  };
}
function parseAuthError(responseText) {
  const match = responseText.match(/^Unauthorized Action:\s*(.+?)\s*\/\s*(tinycloud\.\S+)$/m);
  if (match) {
    return { resource: match[1].trim(), action: match[2].trim() };
  }
  return {};
}
function authUnauthorizedError(service, message, meta) {
  return serviceError(ErrorCodes.AUTH_UNAUTHORIZED, message, service, { meta });
}
function storageQuotaExceededError(service, message, meta) {
  return {
    code: ErrorCodes.STORAGE_QUOTA_EXCEEDED,
    message,
    service,
    meta
  };
}
function storageLimitReachedError(service, message, meta) {
  return {
    code: ErrorCodes.STORAGE_LIMIT_REACHED,
    message,
    service,
    meta
  };
}
function wrapError2(service, error, defaultCode = ErrorCodes.NETWORK_ERROR) {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return abortedError(service);
    }
    if (error.name === "TimeoutError" || error.message.toLowerCase().includes("timeout")) {
      return timeoutError(service);
    }
    return {
      code: defaultCode,
      message: error.message,
      service,
      cause: error
    };
  }
  return {
    code: defaultCode,
    message: String(error),
    service
  };
}
var BaseService = class {
  constructor() {
    this.abortController = new AbortController();
    this._config = {};
  }
  /**
   * Get the service configuration.
   */
  get config() {
    return this._config;
  }
  /**
   * Initialize the service with context.
   * Called by the SDK after instantiation.
   *
   * @param context - The service context
   */
  initialize(context) {
    this.context = context;
  }
  /**
   * Called when session changes (sign-in, sign-out, refresh).
   * Override in subclasses to handle session changes.
   *
   * @param session - The new session, or null if signed out
   */
  onSessionChange(session) {
  }
  /**
   * Called when SDK signs out.
   * Aborts all pending operations.
   */
  onSignOut() {
    this.abortController.abort();
    this.abortController = new AbortController();
  }
  /**
   * Get the abort signal for this service.
   * Combines the service-level abort with context-level abort.
   */
  get abortSignal() {
    return this.combineSignals();
  }
  /**
   * Check if the service is authenticated.
   */
  get isAuthenticated() {
    return this.context?.isAuthenticated ?? false;
  }
  /**
   * Get the current session.
   * Throws if not authenticated.
   */
  get session() {
    if (!this.context?.session) {
      throw new Error("Not authenticated");
    }
    return this.context.session;
  }
  /**
   * Check authentication and return error result if not authenticated.
   * Use this at the start of methods that require authentication.
   *
   * @returns true if authenticated, false otherwise
   */
  requireAuth() {
    return this.isAuthenticated;
  }
  /**
   * Emit a telemetry event.
   *
   * @param event - Event name
   * @param data - Event data
   */
  emit(event, data) {
    this.context?.emit(event, data);
  }
  /**
   * Emit a service request event.
   *
   * @param action - The action being performed
   * @param key - Optional key/path being accessed
   */
  emitRequest(action, key) {
    const service = this.getServiceName();
    this.emit(TelemetryEvents.SERVICE_REQUEST, {
      service,
      action,
      span: this.spanName(action),
      key,
      timestamp: Date.now()
    });
  }
  /**
   * Emit a service response event.
   *
   * @param action - The action that was performed
   * @param ok - Whether the request was successful
   * @param startTime - Start time for duration calculation
   * @param status - Optional HTTP status code
   */
  emitResponse(action, ok2, startTime, status) {
    const service = this.getServiceName();
    const durationMs = Date.now() - startTime;
    const span = this.spanName(action);
    this.emit(TelemetryEvents.SERVICE_RESPONSE, {
      service,
      action,
      span,
      ok: ok2,
      duration: durationMs,
      durationMs,
      status
    });
    this.emit(TelemetryEvents.SPAN, {
      span,
      service,
      action,
      ok: ok2,
      durationMs,
      status
    });
  }
  /**
   * Emit a service error event.
   *
   * @param error - The service error
   */
  emitError(error, action) {
    const span = action ? this.spanName(action) : void 0;
    this.emit(TelemetryEvents.SERVICE_ERROR, {
      service: this.getServiceName(),
      ...span ? { span } : {},
      error
    });
  }
  /**
   * Get the service name from the static property.
   * Subclasses must define static serviceName.
   */
  getServiceName() {
    return this.constructor.serviceName;
  }
  /**
   * Stable span name used by SDK telemetry sinks.
   */
  spanName(action) {
    return `sdk.${this.getServiceName()}.${action}`;
  }
  /**
   * Create a combined abort signal from multiple sources.
   *
   * @param signals - Additional abort signals to combine
   * @returns A combined abort signal
   */
  combineSignals(...signals) {
    const controller = new AbortController();
    const allSignals = [
      this.abortController.signal,
      this.context?.abortSignal,
      ...signals.filter(Boolean)
    ].filter(Boolean);
    for (const signal of allSignals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true
      });
    }
    return controller.signal;
  }
  /**
   * Wrap an operation with error handling and telemetry.
   *
   * @param action - The action name for telemetry
   * @param key - Optional key for telemetry
   * @param operation - The operation to execute
   * @returns Result of the operation
   */
  async withTelemetry(action, key, operation) {
    const startTime = Date.now();
    this.emitRequest(action, key);
    try {
      const result = await operation();
      if (result.ok) {
        this.emitResponse(action, true, startTime);
      } else {
        this.emitResponse(action, false, startTime);
        this.emitError(result.error, action);
      }
      return result;
    } catch (error) {
      const serviceError3 = wrapError2(this.getServiceName(), error);
      this.emitResponse(action, false, startTime);
      this.emitError(serviceError3, action);
      return err(serviceError3);
    }
  }
};
var PrefixedKVService = class _PrefixedKVService {
  /**
   * Create a new PrefixedKVService.
   *
   * @param kv - The underlying KV service to delegate to
   * @param prefix - The prefix to apply to all operations
   */
  constructor(kv, prefix) {
    this._kv = kv;
    this._prefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  }
  /**
   * The current prefix for this scoped view.
   */
  get prefix() {
    return this._prefix;
  }
  /**
   * Compute the full key path by combining prefix and key.
   *
   * @param key - The key to prefix
   * @returns The full path including prefix
   */
  getFullKey(key) {
    const normalizedKey = key.startsWith("/") ? key : `/${key}`;
    return `${this._prefix}${normalizedKey}`;
  }
  /**
   * Get a value by key.
   */
  async get(key, options) {
    const fullKey = this.getFullKey(key);
    return this._kv.get(fullKey, { ...options, prefix: "" });
  }
  /**
   * Store a value at a key.
   */
  async put(key, value, options) {
    const fullKey = this.getFullKey(key);
    return this._kv.put(fullKey, value, { ...options, prefix: "" });
  }
  /**
   * Store multiple values within this prefix in one TinyCloud KV invocation.
   */
  async batchPut(items, options) {
    return this._kv.batchPut(
      items.map((item) => ({
        ...item,
        key: this.getFullKey(item.key)
      })),
      { ...options, prefix: "" }
    );
  }
  /**
   * List keys within this prefix.
   */
  async list(options) {
    const removePrefix = options?.removePrefix ?? true;
    return this._kv.list({
      ...options,
      prefix: this._prefix,
      removePrefix
    });
  }
  /**
   * Delete a key.
   */
  async delete(key, options) {
    const fullKey = this.getFullKey(key);
    return this._kv.delete(fullKey, { ...options, prefix: "" });
  }
  /**
   * Get metadata for a key without retrieving the value.
   */
  async head(key, options) {
    const fullKey = this.getFullKey(key);
    return this._kv.head(fullKey, { ...options, prefix: "" });
  }
  /**
   * Create a short-lived signed URL for reading a KV object.
   */
  async createSignedReadUrl(key, options) {
    const fullKey = this.getFullKey(key);
    return this._kv.createSignedReadUrl(fullKey, { ...options, prefix: "" });
  }
  /**
   * Create a nested prefix-scoped view.
   */
  withPrefix(subPrefix) {
    const normalizedSubPrefix = subPrefix.startsWith("/") ? subPrefix : `/${subPrefix}`;
    const combinedPrefix = `${this._prefix}${normalizedSubPrefix}`;
    return new _PrefixedKVService(this._kv, combinedPrefix);
  }
};
var DEFAULT_SIGNED_READ_URL_EXPIRY_MS = 5 * 60 * 1e3;
var KVAction = {
  GET: "tinycloud.kv/get",
  PUT: "tinycloud.kv/put",
  LIST: "tinycloud.kv/list",
  DELETE: "tinycloud.kv/del",
  HEAD: "tinycloud.kv/metadata"
};
function encodeKvBatchPartName(path) {
  return encodeURIComponent(path).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
var KVService = class extends BaseService {
  /**
   * Create a new KVService instance.
   *
   * @param config - Service configuration
   */
  constructor(config = {}) {
    super();
    this._config = config;
  }
  /**
   * Get the service configuration.
   */
  get config() {
    return this._config;
  }
  // Parses "Used: X bytes, Limit: Y bytes" from tinycloud-node error responses
  parseQuotaInfo(errorText) {
    const match = errorText.match(
      /Used:\s*(\d+)\s*bytes,\s*Limit:\s*(\d+)\s*bytes/i
    );
    if (match) {
      return {
        usedBytes: parseInt(match[1], 10),
        limitBytes: parseInt(match[2], 10)
      };
    }
    return void 0;
  }
  handleQuotaErrorResponse(response, errorText, key) {
    if (response.status === 402) {
      const quotaInfo = this.parseQuotaInfo(errorText);
      return err(
        storageQuotaExceededError(
          "kv",
          `Storage quota exceeded for key "${key}": ${errorText}`,
          {
            status: response.status,
            ...quotaInfo ? { usedBytes: quotaInfo.usedBytes, limitBytes: quotaInfo.limitBytes } : {}
          }
        )
      );
    }
    if (response.status === 413) {
      const quotaInfo = this.parseQuotaInfo(errorText);
      return err(
        storageLimitReachedError(
          "kv",
          `Storage limit reached for key "${key}": ${errorText}`,
          {
            status: response.status,
            ...quotaInfo ? { usedBytes: quotaInfo.usedBytes, limitBytes: quotaInfo.limitBytes } : {}
          }
        )
      );
    }
    return void 0;
  }
  /**
   * Classify a KV 404 by reading the response body once.
   *
   * The server returns 404 both for a genuinely missing key AND for an
   * un-hosted space (body "Space not found"). Previously get/head/delete
   * collapsed every 404 to KV_NOT_FOUND before reading the body, so an
   * un-hosted-space read was indistinguishable from a missing key. We now
   * preserve status + the "Space not found" body for the un-hosted case (so the
   * CLI/SDK can normalize it to SPACE_NOT_HOSTED, matching put/list/sql), and
   * fall through to KV_NOT_FOUND for a real missing key.
   */
  async classifyNotFound(response, key) {
    const errorText = await response.text();
    if (/space not found/i.test(errorText)) {
      return err(
        serviceError(
          ErrorCodes.KV_NOT_FOUND,
          `KV ${response.status} - ${errorText}`,
          "kv",
          { meta: { status: response.status, statusText: response.statusText } }
        )
      );
    }
    return err(serviceError(ErrorCodes.KV_NOT_FOUND, `Key not found: ${key}`, "kv"));
  }
  /**
   * Get the full path with optional prefix.
   *
   * @param key - The key
   * @param prefixOverride - Optional prefix override
   * @returns The full path
   */
  getFullPath(key, prefixOverride) {
    const prefix = prefixOverride ?? this._config.prefix ?? "";
    return prefix ? `${prefix}/${key}` : key;
  }
  /**
   * Get the host URL.
   */
  get host() {
    return this.context.hosts[0];
  }
  withJsonContentType(headers) {
    if (Array.isArray(headers)) {
      return [...headers, ["content-type", "application/json"]];
    }
    return {
      ...headers,
      "content-type": "application/json"
    };
  }
  /**
   * Execute an invoke operation.
   *
   * @param path - Resource path
   * @param action - KV action
   * @param body - Optional request body
   * @param signal - Optional abort signal
   * @returns Fetch response
   */
  async invokeOperation(path, action, body, signal) {
    const session = this.context.session;
    const headers = this.context.invoke(
      session,
      "kv",
      path,
      action
    );
    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers,
      body,
      signal: this.combineSignals(signal)
    });
  }
  /**
   * Serialize a single put value into a fetch body.
   *
   * Binary values (Blob/ArrayBuffer/typed-array, incl. Node Buffer) are sent as
   * raw bytes (as a Blob) so they round-trip byte-identically — without this a
   * Buffer would be JSON.stringify'd into `{"type":"Buffer","data":[...]}`.
   * Strings are returned unchanged (preserving prior behavior); other values are
   * JSON-encoded. `contentType` overrides the inferred type for binary values.
   */
  serializePutValue(value, contentType) {
    if (value instanceof Blob) {
      if (!contentType || value.type === contentType) {
        return value;
      }
      return new Blob([value], { type: contentType });
    }
    if (value instanceof ArrayBuffer) {
      return new Blob([value], {
        type: contentType ?? "application/octet-stream"
      });
    }
    if (ArrayBuffer.isView(value)) {
      const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return new Blob([view], {
        type: contentType ?? "application/octet-stream"
      });
    }
    if (typeof value === "string") {
      return contentType ? new Blob([value], { type: contentType }) : value;
    }
    return JSON.stringify(value);
  }
  serializeBatchPutValue(item) {
    const contentType = item.contentType;
    if (item.value instanceof Blob) {
      if (!contentType || item.value.type === contentType) {
        return item.value;
      }
      return new Blob([item.value], { type: contentType });
    }
    if (item.value instanceof ArrayBuffer) {
      return new Blob([item.value], {
        type: contentType ?? "application/octet-stream"
      });
    }
    if (ArrayBuffer.isView(item.value)) {
      const value = item.value;
      const bytes = new Uint8Array(value.byteLength);
      bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return new Blob([bytes], {
        type: contentType ?? "application/octet-stream"
      });
    }
    if (typeof item.value === "string") {
      return new Blob([item.value], {
        type: contentType ?? "text/plain;charset=UTF-8"
      });
    }
    const json = JSON.stringify(item.value);
    if (json === void 0) {
      throw new Error(`Cannot JSON serialize KV batch value for key "${item.key}"`);
    }
    return new Blob([json], {
      type: contentType ?? "application/json"
    });
  }
  normalizeBatchPutResponse(data) {
    if (!data || typeof data !== "object") {
      return void 0;
    }
    const response = data;
    if (!Array.isArray(response.written) || !response.written.every((key) => typeof key === "string") || typeof response.count !== "number") {
      return void 0;
    }
    return {
      written: response.written,
      count: response.count
    };
  }
  /**
   * Create KVResponseHeaders from fetch response headers.
   *
   * @param headers - Fetch response headers
   * @returns KVResponseHeaders object
   */
  createResponseHeaders(headers) {
    return {
      etag: headers.get("etag") ?? void 0,
      contentType: headers.get("content-type") ?? void 0,
      lastModified: headers.get("last-modified") ?? void 0,
      contentLength: headers.get("content-length") ? parseInt(headers.get("content-length"), 10) : void 0,
      get: (name2) => headers.get(name2)
    };
  }
  /**
   * Parse response body based on content type.
   *
   * @param response - Fetch response
   * @param raw - Whether to return raw text
   * @returns Parsed data
   */
  async parseResponse(response, raw = false, binary = false) {
    if (!response.ok) {
      return void 0;
    }
    if (binary) {
      return new Uint8Array(await response.arrayBuffer());
    }
    if (raw) {
      return await response.text();
    }
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return await response.json();
    } else if (contentType?.startsWith("text/")) {
      return await response.text();
    }
    const text = await response.text();
    if (!text) {
      return void 0;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  async createSignedReadUrlError(response, key) {
    let errorText = response.statusText;
    try {
      const text = await response.text();
      if (text) {
        errorText = text;
      }
    } catch {
    }
    if (response.status === 401 || response.status === 403) {
      const { resource, action } = parseAuthError(errorText);
      return err(authUnauthorizedError("kv", errorText, {
        status: response.status,
        ...action && { requiredAction: action },
        ...resource && { resource }
      }));
    }
    const code2 = response.status === 400 ? ErrorCodes.INVALID_INPUT : ErrorCodes.NETWORK_ERROR;
    return err(
      serviceError(
        code2,
        `Failed to create signed read URL for key "${key}": ${response.status} - ${errorText}`,
        "kv",
        { meta: { status: response.status, statusText: response.statusText } }
      )
    );
  }
  normalizeSignedReadUrlResponse(data) {
    if (!data || typeof data !== "object") {
      return void 0;
    }
    const response = data;
    if (typeof response.url !== "string" || typeof response.ticketId !== "string" || typeof response.expiresAt !== "string") {
      return void 0;
    }
    return {
      url: new URL(response.url, this.host).toString(),
      relativeUrl: response.url,
      ticketId: response.ticketId,
      expiresAt: response.expiresAt
    };
  }
  /**
   * Get a value by key.
   */
  async get(key, options) {
    return this.withTelemetry("get", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }
      const path = this.getFullPath(key, options?.prefix);
      try {
        const response = await this.invokeOperation(
          path,
          KVAction.GET,
          void 0,
          options?.signal
        );
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            const errorText2 = await response.text();
            const { resource, action } = parseAuthError(errorText2);
            const permissionHint = parsePermissionHintFromErrorText(errorText2);
            return err(authUnauthorizedError("kv", errorText2, {
              status: response.status,
              ...action && { requiredAction: action },
              ...resource && { resource },
              ...permissionHint === void 0 ? {} : { permissionHint }
            }));
          }
          if (response.status === 404) {
            return this.classifyNotFound(response, key);
          }
          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to get key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }
        const data = await this.parseResponse(
          response,
          options?.raw,
          options?.binary
        );
        return ok({
          data,
          headers: this.createResponseHeaders(response.headers)
        });
      } catch (error) {
        return err(wrapError2("kv", error));
      }
    });
  }
  /**
   * Store a value at a key.
   */
  async put(key, value, options) {
    return this.withTelemetry("put", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }
      const path = this.getFullPath(key, options?.prefix);
      const body = this.serializePutValue(value, options?.contentType);
      try {
        const response = await this.invokeOperation(
          path,
          KVAction.PUT,
          body,
          options?.signal
        );
        if (!response.ok) {
          if (response.status === 401) {
            const errorText2 = await response.text();
            const { resource, action } = parseAuthError(errorText2);
            return err(authUnauthorizedError("kv", errorText2, {
              status: response.status,
              ...action && { requiredAction: action },
              ...resource && { resource }
            }));
          }
          const errorText = await response.text();
          const quotaError = this.handleQuotaErrorResponse(
            response,
            errorText,
            key
          );
          if (quotaError) {
            return quotaError;
          }
          return err(
            serviceError(
              ErrorCodes.KV_WRITE_FAILED,
              `Failed to put key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }
        return ok({
          data: void 0,
          headers: this.createResponseHeaders(response.headers)
        });
      } catch (error) {
        return err(wrapError2("kv", error));
      }
    });
  }
  /**
   * Store multiple values in one TinyCloud KV invocation.
   */
  async batchPut(items, options) {
    return this.withTelemetry("batchPut", String(items.length), async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }
      if (items.length === 0) {
        return ok({ written: [], count: 0 });
      }
      if (!this.context.invokeAny) {
        return err(
          serviceError(
            ErrorCodes.INVALID_INPUT,
            "KV batchPut requires SDK runtime support for multi-resource invocations",
            "kv"
          )
        );
      }
      const session = this.context.session;
      const paths = items.map((item) => this.getFullPath(item.key, options?.prefix));
      const seen = /* @__PURE__ */ new Set();
      for (const path of paths) {
        if (seen.has(path)) {
          return err(
            serviceError(
              ErrorCodes.INVALID_INPUT,
              `KV batchPut received duplicate key after prefix resolution: ${path}`,
              "kv"
            )
          );
        }
        seen.add(path);
      }
      try {
        const body = new FormData();
        for (let index = 0; index < items.length; index++) {
          body.append(
            encodeKvBatchPartName(paths[index]),
            this.serializeBatchPutValue(items[index])
          );
        }
        const headers = this.context.invokeAny(
          session,
          paths.map((path) => ({
            spaceId: session.spaceId,
            service: "kv",
            path,
            action: KVAction.PUT
          }))
        );
        const response = await this.context.fetch(`${this.host}/invoke`, {
          method: "POST",
          headers,
          body,
          signal: this.combineSignals(options?.signal)
        });
        if (!response.ok) {
          const errorText = await response.text();
          if (response.status === 401 || response.status === 403) {
            const { resource, action } = parseAuthError(errorText);
            return err(authUnauthorizedError("kv", errorText, {
              status: response.status,
              ...action && { requiredAction: action },
              ...resource && { resource }
            }));
          }
          const quotaError = this.handleQuotaErrorResponse(
            response,
            errorText,
            "batch"
          );
          if (quotaError) {
            return quotaError;
          }
          return err(
            serviceError(
              ErrorCodes.KV_WRITE_FAILED,
              `Failed to batch put ${items.length} key(s): ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }
        const batchResponse = this.normalizeBatchPutResponse(await response.json());
        if (!batchResponse || batchResponse.count !== batchResponse.written.length) {
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              "KV batchPut response did not include matching written keys and count",
              "kv"
            )
          );
        }
        return ok(batchResponse);
      } catch (error) {
        return err(wrapError2("kv", error));
      }
    });
  }
  /**
   * List keys with optional prefix filtering.
   */
  async list(options) {
    return this.withTelemetry("list", options?.prefix, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }
      let listPath = options?.prefix ?? this._config.prefix ?? "";
      if (options?.path) {
        listPath = listPath ? `${listPath}/${options.path}` : options.path;
      }
      try {
        const response = await this.invokeOperation(
          listPath,
          KVAction.LIST,
          void 0,
          options?.signal
        );
        if (!response.ok) {
          if (response.status === 401) {
            const errorText2 = await response.text();
            const { resource, action } = parseAuthError(errorText2);
            return err(authUnauthorizedError("kv", errorText2, {
              status: response.status,
              ...action && { requiredAction: action },
              ...resource && { resource }
            }));
          }
          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to list keys: ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }
        let keys = await this.parseResponse(response, options?.raw);
        keys = keys ?? [];
        if (options?.removePrefix && listPath) {
          const prefixWithSlash = listPath.endsWith("/") ? listPath : `${listPath}/`;
          keys = keys.map(
            (key) => key.startsWith(prefixWithSlash) ? key.slice(prefixWithSlash.length) : key
          );
        }
        return ok({ keys });
      } catch (error) {
        return err(wrapError2("kv", error));
      }
    });
  }
  /**
   * Delete a key.
   */
  async delete(key, options) {
    return this.withTelemetry("delete", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }
      const path = this.getFullPath(key, options?.prefix);
      try {
        const response = await this.invokeOperation(
          path,
          KVAction.DELETE,
          void 0,
          options?.signal
        );
        if (!response.ok) {
          if (response.status === 401) {
            const errorText2 = await response.text();
            const { resource, action } = parseAuthError(errorText2);
            return err(authUnauthorizedError("kv", errorText2, {
              status: response.status,
              ...action && { requiredAction: action },
              ...resource && { resource }
            }));
          }
          if (response.status === 404) {
            return this.classifyNotFound(response, key);
          }
          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to delete key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }
        return ok(void 0);
      } catch (error) {
        return err(wrapError2("kv", error));
      }
    });
  }
  /**
   * Get metadata for a key without retrieving the value.
   */
  async head(key, options) {
    return this.withTelemetry("head", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }
      const path = this.getFullPath(key, options?.prefix);
      try {
        const response = await this.invokeOperation(
          path,
          KVAction.HEAD,
          void 0,
          options?.signal
        );
        if (!response.ok) {
          if (response.status === 401) {
            const errorText2 = await response.text();
            const { resource, action } = parseAuthError(errorText2);
            return err(authUnauthorizedError("kv", errorText2, {
              status: response.status,
              ...action && { requiredAction: action },
              ...resource && { resource }
            }));
          }
          if (response.status === 404) {
            return this.classifyNotFound(response, key);
          }
          const errorText = await response.text();
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              `Failed to get metadata for key "${key}": ${response.status} - ${errorText}`,
              "kv",
              { meta: { status: response.status, statusText: response.statusText } }
            )
          );
        }
        return ok({
          data: void 0,
          headers: this.createResponseHeaders(response.headers)
        });
      } catch (error) {
        return err(wrapError2("kv", error));
      }
    });
  }
  /**
   * Create a short-lived signed URL for reading a KV object.
   */
  async createSignedReadUrl(key, options) {
    return this.withTelemetry("createSignedReadUrl", key, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("kv"));
      }
      const path = this.getFullPath(key, options?.prefix);
      const session = this.context.session;
      const headers = this.context.invoke(
        session,
        "kv",
        path,
        KVAction.GET
      );
      const body = {
        space: session.spaceId,
        path,
        ttl_seconds: options?.expiresInSeconds ?? Math.ceil(DEFAULT_SIGNED_READ_URL_EXPIRY_MS / 1e3)
      };
      if (options?.contentHash !== void 0) {
        body.content_hash = options.contentHash;
      }
      if (options?.etag !== void 0) {
        body.etag = options.etag;
      }
      try {
        const response = await this.context.fetch(`${this.host}/signed/kv`, {
          method: "POST",
          headers: this.withJsonContentType(headers),
          body: JSON.stringify(body),
          signal: this.combineSignals(options?.signal)
        });
        if (!response.ok) {
          return this.createSignedReadUrlError(response, key);
        }
        const signedUrl = this.normalizeSignedReadUrlResponse(
          await response.json()
        );
        if (!signedUrl) {
          return err(
            serviceError(
              ErrorCodes.NETWORK_ERROR,
              "Signed read URL response did not include url, ticketId, and expiresAt",
              "kv"
            )
          );
        }
        return ok(signedUrl);
      } catch (error) {
        return err(wrapError2("kv", error));
      }
    });
  }
  /**
   * Create a prefix-scoped view of this KV service.
   *
   * Returns a PrefixedKVService that automatically prefixes all
   * key operations with the specified prefix. This enables apps
   * to isolate their data within a shared space.
   *
   * @param prefix - The prefix to apply to all operations
   * @returns A PrefixedKVService scoped to the prefix
   *
   * ## Prefix Conventions
   *
   * | Pattern | Use Case | Example |
   * | -- | -- | -- |
   * | `/app.{domain}/` | App-private data | `/app.photos.xyz/settings.json` |
   * | `/{type}/` | Shared data type | `/photos/vacation.jpg` |
   * | `/.{name}/` | Hidden/system data | `/.cache/thumbnails/` |
   * | `/public/` | Explicitly shareable | `/public/profile.json` |
   *
   * @example
   * ```typescript
   * const space = sdk.space('default');
   *
   * // Create prefix-scoped views
   * const myApp = space.kv.withPrefix('/app.myapp.com');
   * const sharedPhotos = space.kv.withPrefix('/photos');
   *
   * // Operations are automatically prefixed
   * await myApp.put('settings.json', { theme: 'dark' });
   * // -> Actually writes to: /app.myapp.com/settings.json
   *
   * await myApp.get('settings.json');
   * // -> Actually reads from: /app.myapp.com/settings.json
   *
   * await sharedPhotos.list();
   * // -> Lists: /photos/*
   *
   * // Nested prefixes
   * const settings = myApp.withPrefix('/settings');
   * await settings.get('theme.json');  // -> /app.myapp.com/settings/theme.json
   * ```
   */
  withPrefix(prefix) {
    return new PrefixedKVService(this, prefix);
  }
};
KVService.serviceName = "kv";
function parseServiceErrorBody(errorText) {
  try {
    return JSON.parse(errorText);
  } catch {
    return {};
  }
}
function formatServiceResponseError(serviceLabel, operation, status, errorText, parsed) {
  if (parsed.message) {
    return compactMessage(parsed.message);
  }
  if (looksLikeHtml(errorText)) {
    if (status === 524 || /524\s*[:-]/i.test(errorText) || /a timeout occurred/i.test(errorText)) {
      return `${serviceLabel} ${operation} failed: upstream request timed out. Please retry.`;
    }
    return `${serviceLabel} ${operation} failed: upstream service returned an HTML error page (${status}).`;
  }
  return `${serviceLabel} ${operation} failed: ${status} - ${compactMessage(errorText)}`;
}
function responseErrorMeta(status, statusText, errorText) {
  const meta = { status, statusText };
  const snippet = compactMessage(errorText);
  if (snippet) {
    meta.responseSnippet = snippet.slice(0, 300);
  }
  return meta;
}
function looksLikeHtml(text) {
  return /<!doctype html/i.test(text) || /<html[\s>]/i.test(text);
}
function compactMessage(message) {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}
var SQLMigrations = class {
  constructor(service, dbName) {
    this.service = service;
    this.dbName = dbName;
  }
  apply(options) {
    return this.service.applyMigrationsOnDb(this.dbName, options);
  }
};
var DatabaseHandle = class {
  constructor(service, name2) {
    this.service = service;
    this.name = name2;
    this.migrations = new SQLMigrations(service, name2);
  }
  async query(sql, params, options) {
    return this.service.queryOnDb(this.name, sql, params, options);
  }
  async execute(sql, params, options) {
    return this.service.executeOnDb(this.name, sql, params, options);
  }
  async batch(statements, options) {
    return this.service.batchOnDb(this.name, statements, options);
  }
  async executeStatement(name2, params, options) {
    return this.service.executeStatementOnDb(this.name, name2, params, options);
  }
  async export(options) {
    return this.service.exportDb(this.name, options);
  }
};
var SQLAction = {
  READ: SQL.READ,
  WRITE: SQL.WRITE,
  SCHEMA: SQL.SCHEMA,
  ADMIN: SQL.ADMIN,
  SELECT: SQL.SELECT,
  EXECUTE: SQL.EXECUTE,
  EXPORT: SQL.EXPORT,
  ALL: SQL.ALL
};
var DDL_TOKENS = /* @__PURE__ */ new Set(["alter", "create", "drop"]);
var MIGRATIONS_TABLE = "__tinycloud_sql_migrations";
var MIGRATIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  key TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  statement_count INTEGER NOT NULL
)`;
var MIGRATIONS_META_NAMESPACE = "tinycloud.sql.migrations";
var MIGRATIONS_META_ID = "000_metadata";
var SQLService = class extends BaseService {
  constructor(config = {}) {
    super();
    this.migrationLocks = /* @__PURE__ */ new Map();
    this._config = config;
  }
  get config() {
    return this._config;
  }
  get defaultDbName() {
    return this._config.defaultDatabase ?? "default";
  }
  get host() {
    return this.context.hosts[0];
  }
  /**
   * Get a handle to a named database.
   */
  db(name2) {
    return new DatabaseHandle(this, name2 ?? this.defaultDbName);
  }
  /**
   * Shortcut: query the default database.
   */
  async query(sql, params, options) {
    return this.queryOnDb(this.defaultDbName, sql, params, options);
  }
  /**
   * Shortcut: execute on the default database.
   */
  async execute(sql, params, options) {
    return this.executeOnDb(this.defaultDbName, sql, params, options);
  }
  /**
   * Shortcut: batch on the default database.
   */
  async batch(statements, options) {
    return this.batchOnDb(this.defaultDbName, statements, options);
  }
  async applyMigrationsOnDb(dbName, options) {
    const validationError = validateMigrationOptions(options);
    if (validationError) {
      return err(serviceError(ErrorCodes.INVALID_INPUT, validationError, "sql"));
    }
    const lockKey = `${dbName}\0${options.namespace}`;
    const existing = this.migrationLocks.get(lockKey);
    if (existing) {
      return existing;
    }
    const promise = this.applyMigrationsOnDbUnlocked(dbName, options);
    this.migrationLocks.set(lockKey, promise);
    try {
      return await promise;
    } finally {
      this.migrationLocks.delete(lockKey);
    }
  }
  // === Internal methods called by DatabaseHandle ===
  async queryOnDb(dbName, sql, params, options) {
    return this.withTelemetry("query", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }
      try {
        const response = await this.invokeSQL(
          dbName,
          this.actionForSql(sql, SQLAction.READ),
          { action: "query", sql, params: params ?? [] },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "query");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("sql", error));
      }
    });
  }
  async executeOnDb(dbName, sql, params, options) {
    return this.withTelemetry("execute", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }
      try {
        const body = {
          action: "execute",
          sql,
          params: params ?? []
        };
        if (options?.schema) {
          body.schema = options.schema;
        }
        const actions = [
          this.actionForSql(sql, SQLAction.WRITE),
          ...(options?.schema ?? []).map(
            (statement) => this.actionForSql(statement, SQLAction.SCHEMA)
          )
        ];
        const response = await this.invokeSQL(
          dbName,
          this.dedupeActions(actions),
          body,
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "execute");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("sql", error));
      }
    });
  }
  async batchOnDb(dbName, statements, options) {
    return this.withTelemetry("batch", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }
      try {
        const response = await this.invokeSQL(
          dbName,
          this.actionsForSqlBatch(statements),
          { action: "batch", statements },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "batch");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("sql", error));
      }
    });
  }
  async executeStatementOnDb(dbName, name2, params, options) {
    return this.withTelemetry("executeStatement", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }
      try {
        const response = await this.invokeSQL(
          dbName,
          SQLAction.WRITE,
          { action: "execute_statement", name: name2, params: params ?? [] },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "executeStatement");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("sql", error));
      }
    });
  }
  async exportDb(dbName, options) {
    return this.withTelemetry("export", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("sql"));
      }
      try {
        const response = await this.invokeSQL(
          dbName,
          SQLAction.READ,
          { action: "export" },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "export");
        }
        const resp = response;
        if (typeof resp.blob === "function") {
          const blob = await resp.blob();
          return ok(blob);
        }
        const text = await response.text();
        return ok(text);
      } catch (error) {
        return err(wrapError2("sql", error));
      }
    });
  }
  async applyMigrationsOnDbUnlocked(dbName, options) {
    return this.withTelemetry("migrations.apply", dbName, async () => {
      const created = await this.ensureMigrationsTable(dbName, options.signal);
      if (!created.ok) return created;
      const listed = await this.queryOnDb(
        dbName,
        `SELECT id FROM ${MIGRATIONS_TABLE} WHERE namespace = ? ORDER BY applied_at, id`,
        [options.namespace],
        { signal: options.signal }
      );
      if (!listed.ok) return listed;
      const appliedIds = new Set(
        listed.data.rows.map((row) => rowValue(row, 0)).filter((id) => typeof id === "string")
      );
      const skipped = options.migrations.filter((migration) => appliedIds.has(migration.id)).map((migration) => migration.id);
      const pending = options.migrations.filter((migration) => !appliedIds.has(migration.id));
      const applied = [];
      for (const migration of pending) {
        const result = await this.applyOneMigration(dbName, options.namespace, migration, options.signal);
        if (!result.ok) return result;
        applied.push(migration.id);
      }
      return ok({
        database: dbName,
        namespace: options.namespace,
        status: applied.length > 0 ? "applied" : "already_current",
        applied,
        skipped
      });
    });
  }
  async applyOneMigration(dbName, namespace, migration, signal) {
    const statements = [
      ...migration.sql.map(
        (statement) => typeof statement === "string" ? { sql: statement } : statement
      ),
      {
        sql: `INSERT OR REPLACE INTO ${MIGRATIONS_TABLE} (key, namespace, id, applied_at, statement_count) VALUES (?, ?, ?, ?, ?)`,
        params: [
          migrationKey(namespace, migration.id),
          namespace,
          migration.id,
          (/* @__PURE__ */ new Date()).toISOString(),
          migration.sql.length
        ]
      }
    ];
    const result = await this.batchOnDb(dbName, statements, { signal });
    if (!result.ok) return result;
    return ok(void 0);
  }
  async ensureMigrationsTable(dbName, signal) {
    const result = await this.batchOnDb(
      dbName,
      [
        { sql: MIGRATIONS_SCHEMA },
        {
          sql: `INSERT OR REPLACE INTO ${MIGRATIONS_TABLE} (key, namespace, id, applied_at, statement_count) VALUES (?, ?, ?, ?, ?)`,
          params: [
            migrationKey(MIGRATIONS_META_NAMESPACE, MIGRATIONS_META_ID),
            MIGRATIONS_META_NAMESPACE,
            MIGRATIONS_META_ID,
            (/* @__PURE__ */ new Date()).toISOString(),
            1
          ]
        }
      ],
      { signal }
    );
    if (!result.ok) return result;
    return ok(void 0);
  }
  // === Private helpers ===
  async invokeSQL(dbName, actions, body, signal) {
    const session = this.context.session;
    const actionList = Array.isArray(actions) ? actions : [actions];
    const headers = actionList.length === 1 ? this.context.invoke(session, "sql", dbName, actionList[0]) : this.invokeSQLAny(session, dbName, actionList);
    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: this.combineSignals(signal)
    });
  }
  actionForSql(sql, fallback) {
    const token = firstSqlToken(sql);
    if (token === "pragma") return SQLAction.ADMIN;
    if (token !== void 0 && DDL_TOKENS.has(token)) return SQLAction.SCHEMA;
    return fallback;
  }
  actionsForSqlBatch(statements) {
    return this.dedupeActions(
      statements.map((statement) => this.actionForSql(statement.sql, SQLAction.WRITE))
    );
  }
  dedupeActions(actions) {
    return [...new Set(actions)];
  }
  invokeSQLAny(session, dbName, actions) {
    if (!this.context.invokeAny) {
      throw new Error(
        `SQL operation requires multiple permissions (${actions.join(", ")}) but this SDK runtime does not support multi-resource invocations`
      );
    }
    return this.context.invokeAny(
      session,
      actions.map((action) => ({
        spaceId: session.spaceId,
        service: "sql",
        path: dbName,
        action
      }))
    );
  }
  async handleErrorResponse(response, operation) {
    const errorText = await response.text();
    const errorBody = parseServiceErrorBody(errorText);
    const errorCode = this.mapHttpStatusToErrorCode(
      response.status,
      errorBody.error
    );
    const message = formatServiceResponseError(
      "SQL",
      operation,
      response.status,
      errorText,
      errorBody
    );
    const meta = responseErrorMeta(response.status, response.statusText, errorText);
    if (response.status === 401) {
      const { resource, action } = parseAuthError(errorText);
      if (action) meta.requiredAction = action;
      if (resource) meta.resource = resource;
    }
    return err(
      serviceError(errorCode, message, "sql", { meta })
    );
  }
  mapHttpStatusToErrorCode(status, serverError) {
    switch (status) {
      case 400:
        return ErrorCodes.SQL_ERROR;
      case 401:
        return ErrorCodes.AUTH_UNAUTHORIZED;
      case 403:
        if (serverError === "sql_readonly_violation") {
          return ErrorCodes.SQL_READONLY_VIOLATION;
        }
        return ErrorCodes.SQL_PERMISSION_DENIED;
      case 404:
        return ErrorCodes.SQL_DATABASE_NOT_FOUND;
      case 413:
        return ErrorCodes.SQL_RESPONSE_TOO_LARGE;
      case 429:
        return ErrorCodes.SQL_QUOTA_EXCEEDED;
      default:
        return ErrorCodes.NETWORK_ERROR;
    }
  }
};
SQLService.serviceName = "sql";
function firstSqlToken(sql) {
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /\s/.test(sql[index])) {
      index++;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      if (newline === -1) {
        return void 0;
      }
      index = newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        return void 0;
      }
      index = end + 2;
      continue;
    }
    break;
  }
  const match = /^[A-Za-z_]+/.exec(sql.slice(index));
  return match?.[0].toLowerCase();
}
function validateMigrationOptions(options) {
  if (!options || typeof options !== "object") {
    return "SQL migrations require options";
  }
  if (!options.namespace || typeof options.namespace !== "string") {
    return "SQL migrations require a non-empty namespace";
  }
  if (!Array.isArray(options.migrations)) {
    return "SQL migrations require an ordered migrations array";
  }
  const ids = /* @__PURE__ */ new Set();
  for (const migration of options.migrations) {
    if (!migration.id || typeof migration.id !== "string") {
      return "SQL migrations require every migration to have a non-empty id";
    }
    if (ids.has(migration.id)) {
      return `Duplicate SQL migration id: ${migration.id}`;
    }
    ids.add(migration.id);
    if (!Array.isArray(migration.sql)) {
      return `SQL migration ${migration.id} requires a sql array`;
    }
    for (const statement of migration.sql) {
      if (typeof statement === "string") {
        if (statement.trim() === "") {
          return `SQL migration ${migration.id} contains an empty statement`;
        }
        continue;
      }
      if (!statement || typeof statement.sql !== "string" || statement.sql.trim() === "") {
        return `SQL migration ${migration.id} contains an invalid statement`;
      }
    }
  }
  return null;
}
function migrationKey(namespace, id) {
  return `${encodeURIComponent(namespace)}:${encodeURIComponent(id)}`;
}
function rowValue(row, index) {
  if (Array.isArray(row)) return row[index];
  if (row && typeof row === "object") {
    const values = Object.values(row);
    return values[index];
  }
  return void 0;
}
var DuckDbDatabaseHandle = class {
  constructor(service, name2) {
    this.service = service;
    this.name = name2;
  }
  async query(sql, params, options) {
    return this.service.queryOnDb(this.name, sql, params, options);
  }
  async queryArrow(sql, params, options) {
    return this.service.queryArrowOnDb(this.name, sql, params, options);
  }
  async execute(sql, params, options) {
    return this.service.executeOnDb(this.name, sql, params, options);
  }
  async batch(statements, options) {
    return this.service.batchOnDb(this.name, statements, options);
  }
  async executeStatement(name2, params, options) {
    return this.service.executeStatementOnDb(this.name, name2, params, options);
  }
  async describe(options) {
    return this.service.describeDb(this.name, options);
  }
  async export(options) {
    return this.service.exportOnDb(this.name, options);
  }
  async import(data, options) {
    return this.service.importOnDb(this.name, data, options);
  }
};
var DuckDbAction = {
  READ: DUCKDB.READ,
  WRITE: DUCKDB.WRITE,
  ADMIN: DUCKDB.ADMIN,
  DESCRIBE: DUCKDB.DESCRIBE,
  EXPORT: DUCKDB.EXPORT,
  IMPORT: DUCKDB.IMPORT,
  EXECUTE: DUCKDB.EXECUTE,
  ALL: DUCKDB.ALL
};
var DuckDbService = class extends BaseService {
  constructor(config = {}) {
    super();
    this._config = config;
  }
  get config() {
    return this._config;
  }
  get defaultDbName() {
    return this._config.defaultDatabase ?? "default";
  }
  get host() {
    return this.context.hosts[0];
  }
  /**
   * Get a handle to a named database.
   */
  db(name2) {
    return new DuckDbDatabaseHandle(this, name2 ?? this.defaultDbName);
  }
  /**
   * Shortcut: query the default database (JSON format).
   */
  async query(sql, params, options) {
    return this.queryOnDb(this.defaultDbName, sql, params, options);
  }
  /**
   * Shortcut: query the default database (Arrow IPC format).
   */
  async queryArrow(sql, params, options) {
    return this.queryArrowOnDb(this.defaultDbName, sql, params, options);
  }
  /**
   * Shortcut: execute on the default database.
   */
  async execute(sql, params, options) {
    return this.executeOnDb(this.defaultDbName, sql, params, options);
  }
  /**
   * Shortcut: batch on the default database.
   */
  async batch(statements, options) {
    return this.batchOnDb(this.defaultDbName, statements, options);
  }
  // === Internal methods called by DuckDbDatabaseHandle ===
  async queryOnDb(dbName, sql, params, options) {
    return this.withTelemetry("query", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.READ,
          { action: "query", sql, params: params ?? [] },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "query");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  async queryArrowOnDb(dbName, sql, params, options) {
    return this.withTelemetry("queryArrow", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.READ,
          { action: "query", sql, params: params ?? [] },
          options?.signal,
          { Accept: "application/vnd.apache.arrow.stream" }
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "queryArrow");
        }
        const buffer = await response.arrayBuffer();
        return ok(buffer);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  async executeOnDb(dbName, sql, params, options) {
    return this.withTelemetry("execute", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const body = {
          action: "execute",
          sql,
          params: params ?? []
        };
        if (options?.schema) {
          body.schema = options.schema;
        }
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.WRITE,
          body,
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "execute");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  async batchOnDb(dbName, statements, options) {
    return this.withTelemetry("batch", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const body = {
          action: "batch",
          statements
        };
        if (options?.transactional !== void 0) {
          body.transactional = options.transactional;
        }
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.WRITE,
          body,
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "batch");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  async executeStatementOnDb(dbName, name2, params, options) {
    return this.withTelemetry("executeStatement", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.WRITE,
          { action: "executeStatement", name: name2, params: params ?? [] },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "executeStatement");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  async describeDb(dbName, options) {
    return this.withTelemetry("describe", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.READ,
          { action: "describe" },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "describe");
        }
        const data = await response.json();
        return ok(data);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  async exportOnDb(dbName, options) {
    return this.withTelemetry("export", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const response = await this.invokeDuckDb(
          dbName,
          DuckDbAction.EXPORT,
          { action: "export" },
          options?.signal
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "export");
        }
        const blob = await response.blob();
        return ok(blob);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  async importOnDb(dbName, data, options) {
    return this.withTelemetry("import", dbName, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("duckdb"));
      }
      try {
        const session = this.context.session;
        const headers = this.context.invoke(
          session,
          "duckdb",
          dbName,
          DuckDbAction.IMPORT
        );
        const response = await this.context.fetch(`${this.host}/invoke`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/x-duckdb"
          },
          body: new Blob([data]),
          signal: this.combineSignals(options?.signal)
        });
        if (!response.ok) {
          return this.handleErrorResponse(response, "import");
        }
        return ok(void 0);
      } catch (error) {
        return err(wrapError2("duckdb", error));
      }
    });
  }
  // === Private helpers ===
  async invokeDuckDb(dbName, action, body, signal, extraHeaders) {
    const session = this.context.session;
    const headers = this.context.invoke(session, "duckdb", dbName, action);
    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal: this.combineSignals(signal)
    });
  }
  async handleErrorResponse(response, operation) {
    const errorText = await response.text();
    const errorBody = parseServiceErrorBody(errorText);
    const errorCode = this.mapHttpStatusToErrorCode(
      response.status,
      errorBody.error
    );
    const message = formatServiceResponseError(
      "DuckDB",
      operation,
      response.status,
      errorText,
      errorBody
    );
    const meta = responseErrorMeta(response.status, response.statusText, errorText);
    if (response.status === 401) {
      const { resource, action } = parseAuthError(errorText);
      if (action) meta.requiredAction = action;
      if (resource) meta.resource = resource;
    }
    return err(
      serviceError(errorCode, message, "duckdb", { meta })
    );
  }
  mapHttpStatusToErrorCode(status, serverError) {
    switch (status) {
      case 400:
        return ErrorCodes.DUCKDB_ERROR;
      case 401:
        return ErrorCodes.AUTH_UNAUTHORIZED;
      case 403:
        if (serverError === "duckdb_readonly_violation") {
          return ErrorCodes.DUCKDB_READONLY_VIOLATION;
        }
        return ErrorCodes.DUCKDB_PERMISSION_DENIED;
      case 404:
        return ErrorCodes.DUCKDB_DATABASE_NOT_FOUND;
      case 413:
        return ErrorCodes.DUCKDB_RESPONSE_TOO_LARGE;
      case 429:
        return ErrorCodes.DUCKDB_QUOTA_EXCEEDED;
      default:
        return ErrorCodes.NETWORK_ERROR;
    }
  }
};
DuckDbService.serviceName = "duckdb";
var AsyncQueue = class {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  push(value) {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: void 0, done: true });
    }
  }
  next() {
    if (this.values.length > 0) {
      const value = this.values.shift();
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: void 0, done: true });
    }
    return new Promise((resolve3) => {
      this.waiters.push(resolve3);
    });
  }
};
var HooksService = class extends BaseService {
  constructor(config = {}) {
    super();
    this._subscribers = /* @__PURE__ */ new Set();
    this._refreshChain = Promise.resolve();
    this._activeSignature = "";
    this._config = config;
  }
  get config() {
    return this._config;
  }
  get host() {
    return this._config.host ?? this.context.hosts[0];
  }
  async *subscribe(subscriptions, options = {}) {
    if (!this.requireAuth()) {
      throw new Error("Authentication required for hooks subscription");
    }
    if (subscriptions.length === 0) {
      throw new Error("At least one hook subscription is required");
    }
    const normalized = subscriptions.map(normalizeSubscription);
    const subscriber = {
      requested: normalized,
      ttlSeconds: options.ttlSeconds,
      queue: new AsyncQueue()
    };
    this._subscribers.add(subscriber);
    const abortHandler = () => {
      this._subscribers.delete(subscriber);
      subscriber.queue.close();
      void this.scheduleSharedStreamRefresh();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
    void this.scheduleSharedStreamRefresh();
    try {
      for await (const event of subscriber.queue) {
        yield event;
      }
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      abortHandler();
    }
  }
  async register(webhook) {
    if (!this.requireAuth()) {
      return err(authRequiredError("hooks"));
    }
    if (typeof webhook.secret !== "string" || webhook.secret.trim().length === 0) {
      return err(
        serviceError(
          ErrorCodes.INVALID_INPUT,
          "Webhook secret is required",
          "hooks",
          { meta: { field: "secret" } }
        )
      );
    }
    try {
      const response = await this.context.fetch(`${this.host}/hooks/webhooks`, {
        method: "POST",
        headers: {
          ...serviceHeadersToRecord(
            this.createHookHeaders(
              "tinycloud.hooks/register",
              buildScopePath(webhook.service, webhook.pathPrefix)
            )
          ),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          space: webhook.space,
          service: webhook.service,
          pathPrefix: normalizePathPrefix(webhook.pathPrefix),
          abilities: webhook.abilities ?? [],
          callbackUrl: webhook.callbackUrl,
          secret: webhook.secret
        })
      });
      if (!response.ok) {
        return err(
          await responseError("hooks", "failed to register webhook", response)
        );
      }
      const data = normalizeWebhookRecord(await response.json());
      if (!data) {
        return err(
          wrapError2(
            "hooks",
            new Error("Webhook registration response did not include a record")
          )
        );
      }
      return ok(data);
    } catch (error) {
      return err(wrapError2("hooks", error));
    }
  }
  async list(options = {}) {
    if (!this.requireAuth()) {
      return err(authRequiredError("hooks"));
    }
    try {
      const query = new URLSearchParams();
      if (options.space) {
        query.set("space", options.space);
      }
      if (options.service) {
        query.set("service", options.service);
      }
      if (options.pathPrefix) {
        const normalizedPrefix = normalizePathPrefix(options.pathPrefix);
        if (normalizedPrefix) {
          query.set("prefix", normalizedPrefix);
        }
      }
      const response = await this.context.fetch(
        `${this.host}/hooks/webhooks${query.size > 0 ? `?${query.toString()}` : ""}`,
        {
          method: "GET",
          headers: serviceHeadersToRecord(
            this.createHookHeaders(
              "tinycloud.hooks/list",
              options.service ? buildScopePath(options.service, options.pathPrefix) : "webhooks"
            )
          )
        }
      );
      if (!response.ok) {
        return err(
          await responseError("hooks", "failed to list webhooks", response)
        );
      }
      const payload = await response.json();
      const records = normalizeWebhookRecordList(payload);
      if (!records) {
        return err(
          wrapError2(
            "hooks",
            new Error("Webhook list response did not include records")
          )
        );
      }
      return ok(records);
    } catch (error) {
      return err(wrapError2("hooks", error));
    }
  }
  async unregister(id, options = {}) {
    if (!this.requireAuth()) {
      return err(authRequiredError("hooks"));
    }
    try {
      const response = await this.context.fetch(
        `${this.host}/hooks/webhooks/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: serviceHeadersToRecord(
            this.createHookHeaders(
              "tinycloud.hooks/unregister",
              options.target ? buildScopePath(
                options.target.service,
                options.target.pathPrefix
              ) : `webhooks/${id}`
            )
          )
        }
      );
      if (!response.ok) {
        return err(
          await responseError(
            "hooks",
            "failed to unregister webhook",
            response
          )
        );
      }
      return ok(void 0);
    } catch (error) {
      return err(wrapError2("hooks", error));
    }
  }
  async scheduleSharedStreamRefresh() {
    this._refreshChain = this._refreshChain.then(() => this.refreshSharedStream()).catch(() => void 0);
    await this._refreshChain;
  }
  async refreshSharedStream() {
    if (!this.requireAuth() || this._subscribers.size === 0) {
      this.abortSharedStream();
      this._activeSignature = "";
      return;
    }
    const state = this.collectSharedStreamState();
    if (state.signature !== this._activeSignature) {
      this._activeSignature = state.signature;
      this.abortSharedStream();
    }
    if (!this._sharedStreamTask) {
      this._sharedStreamTask = this.runSharedStream(state).catch((error) => {
        if (!isAbortError(error)) {
          throw error;
        }
      }).finally(() => {
        this._sharedStreamTask = void 0;
        this._sharedStreamAbort = void 0;
        if (this._subscribers.size > 0) {
          void this.scheduleSharedStreamRefresh();
        }
      });
    }
  }
  collectSharedStreamState() {
    const merged = /* @__PURE__ */ new Map();
    const ttlCandidates = [];
    for (const subscriber of this._subscribers) {
      if (typeof subscriber.ttlSeconds === "number") {
        ttlCandidates.push(subscriber.ttlSeconds);
      }
      for (const subscription of subscriber.requested) {
        merged.set(subscriptionSignature(subscription), subscription);
      }
    }
    const subscriptions = [...merged.values()].sort(
      (left, right) => subscriptionSignature(left).localeCompare(subscriptionSignature(right))
    );
    const ttlSeconds = ttlCandidates.length > 0 ? Math.min(...ttlCandidates) : void 0;
    const signature = JSON.stringify({
      subscriptions: subscriptions.map(subscriptionSignature),
      ttlSeconds
    });
    return {
      subscriptions,
      ttlSeconds,
      signature
    };
  }
  async runSharedStream(state) {
    const abortController = new AbortController();
    this._sharedStreamAbort = abortController;
    try {
      const host = this._config.host ?? this.context.hosts[0];
      const ticketResponse = await this.mintHookTicket(
        state.subscriptions,
        state.ttlSeconds,
        abortController.signal
      );
      const streamResponse = await this.openHookStream(
        host,
        ticketResponse.ticket,
        abortController.signal
      );
      for await (const message of parseSseStream(
        streamResponse.body,
        abortController.signal
      )) {
        if (!message.data) {
          continue;
        }
        const event = parseHookEvent(message);
        for (const subscriber of this._subscribers) {
          if (matchesAnySubscription(event, subscriber.requested)) {
            subscriber.queue.push(event);
          }
        }
      }
    } finally {
      if (this._sharedStreamAbort === abortController) {
        this._sharedStreamAbort = void 0;
      }
    }
  }
  abortSharedStream() {
    this._sharedStreamAbort?.abort();
  }
  createHookHeaders(action, path) {
    return this.context.invoke(this.session, "hooks", path, action);
  }
  async mintHookTicket(subscriptions, ttlSeconds, signal) {
    const host = this._config.host ?? this.context.hosts[0];
    const headers = this.createInvokeHeaders(subscriptions);
    const ticketResponse = await this.context.fetch(`${host}/hooks/tickets`, {
      method: "POST",
      headers: {
        ...serviceHeadersToRecord(headers),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        subscriptions,
        ttlSeconds
      }),
      signal
    });
    if (!ticketResponse.ok) {
      throw await responseError(
        "hooks",
        "failed to mint hook ticket",
        ticketResponse
      );
    }
    const ticketJson = await ticketResponse.json();
    if (!ticketJson?.ticket) {
      throw new Error("Hook ticket response did not include a ticket");
    }
    return ticketJson;
  }
  async openHookStream(host, ticket, signal) {
    const streamResponse = await this.context.fetch(
      `${host}/hooks/events?ticket=${encodeURIComponent(ticket)}`,
      {
        method: "GET",
        headers: { accept: "text/event-stream" },
        signal
      }
    );
    if (!streamResponse.ok) {
      throw await responseError(
        "hooks",
        "failed to open hook stream",
        streamResponse
      );
    }
    return streamResponse;
  }
  createInvokeHeaders(subscriptions) {
    const entries = subscriptions.map((subscription) => ({
      spaceId: subscription.space,
      service: "hooks",
      path: subscription.pathPrefix ? `${subscription.service}/${subscription.pathPrefix}` : subscription.service,
      action: "tinycloud.hooks/subscribe"
    }));
    if (this.context.invokeAny) {
      return this.context.invokeAny(this.session, entries);
    }
    if (entries.length === 1) {
      const entry = entries[0];
      return this.context.invoke(
        this.session,
        entry.service,
        entry.path,
        entry.action
      );
    }
    throw new Error(
      "This SDK runtime does not support multi-scope hook invocations"
    );
  }
};
HooksService.serviceName = "hooks";
function buildScopePath(service, pathPrefix) {
  const normalized = normalizePathPrefix(pathPrefix);
  return normalized ? `${service}/${normalized}` : service;
}
function normalizeSubscription(subscription) {
  return {
    ...subscription,
    pathPrefix: normalizePathPrefix(subscription.pathPrefix),
    abilities: subscription.abilities ?? []
  };
}
function subscriptionSignature(subscription) {
  return JSON.stringify({
    space: subscription.space,
    service: subscription.service,
    pathPrefix: subscription.pathPrefix ?? "",
    abilities: [...subscription.abilities ?? []].sort()
  });
}
function matchesAnySubscription(event, subscriptions) {
  return subscriptions.some(
    (subscription) => matchesSubscription(event, subscription)
  );
}
function matchesSubscription(event, subscription) {
  if (event.space !== subscription.space) {
    return false;
  }
  if (event.service !== subscription.service) {
    return false;
  }
  if (subscription.pathPrefix) {
    const prefix = subscription.pathPrefix.endsWith("/") ? subscription.pathPrefix : `${subscription.pathPrefix}/`;
    if (event.path && event.path !== subscription.pathPrefix && !event.path.startsWith(prefix)) {
      return false;
    }
  }
  const abilities = subscription.abilities ?? [];
  if (abilities.length > 0 && !abilities.includes(event.ability)) {
    return false;
  }
  return true;
}
function normalizePathPrefix(pathPrefix) {
  if (!pathPrefix) {
    return void 0;
  }
  const trimmed = pathPrefix.replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? trimmed : void 0;
}
function serviceHeadersToRecord(headers) {
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}
async function responseError(service, message, response) {
  let detail = response.statusText;
  try {
    const text = await response.text();
    if (text) {
      detail = text;
    }
  } catch {
  }
  return wrapError2(
    service,
    new Error(`${message}: ${response.status} ${detail}`)
  );
}
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}
async function* parseSseStream(body, signal) {
  if (!body) {
    throw new Error("Hook stream response does not expose a readable body");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of readBodyChunks(body, signal)) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed) {
        yield parsed;
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  const trailing = parseSseEvent(buffer.trim());
  if (trailing) {
    yield trailing;
  }
}
async function* readBodyChunks(body, signal) {
  const asyncIterable = body;
  if (typeof asyncIterable?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of asyncIterable) {
      if (signal?.aborted) {
        break;
      }
      yield chunk;
    }
    return;
  }
  const stream = body;
  if (typeof stream.getReader !== "function") {
    throw new Error("Unsupported hook stream body type");
  }
  const reader = stream.getReader();
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    try {
      await reader.cancel?.();
    } catch {
    }
    reader.releaseLock?.();
  }
}
function parseSseEvent(rawEvent) {
  if (!rawEvent) {
    return null;
  }
  let event = "message";
  let id;
  const dataLines = [];
  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").replace(/^ /, "");
    switch (field) {
      case "event":
        event = value;
        break;
      case "id":
        id = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      default:
        break;
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return {
    event,
    id,
    data: dataLines.join("\n")
  };
}
function parseHookEvent(message) {
  const parsed = JSON.parse(message.data);
  return {
    type: "write",
    id: parsed.id ?? message.id ?? "",
    space: parsed.space ?? "",
    service: parsed.service ?? "",
    ability: parsed.ability ?? "",
    path: parsed.path,
    actor: parsed.actor ?? "",
    epoch: parsed.epoch ?? "",
    eventIndex: parsed.eventIndex ?? 0,
    timestamp: parsed.timestamp ?? ""
  };
}
function normalizeWebhookRecord(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = isRecordContainer(data);
  const candidate = pickWebhookRecord(record) ?? normalizeWebhookRecord(record.webhook) ?? normalizeWebhookRecord(record.hook) ?? normalizeWebhookRecord(record.subscription) ?? normalizeWebhookRecord(record.data);
  return candidate ?? null;
}
function normalizeWebhookRecordList(data) {
  if (Array.isArray(data)) {
    const records = data.map((entry) => normalizeWebhookRecord(entry)).filter((entry) => entry !== null);
    return records;
  }
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = isRecordContainer(data);
  const nested = maybeRecordArray(record.webhooks) ?? maybeRecordArray(record.subscriptions) ?? maybeRecordArray(record.hooks) ?? maybeRecordArray(record.data);
  if (nested) {
    return nested;
  }
  const single = pickWebhookRecord(record);
  return single ? [single] : null;
}
function maybeRecordArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const records = value.map((entry) => normalizeWebhookRecord(entry)).filter((entry) => entry !== null);
  return records;
}
function pickWebhookRecord(value) {
  const id = stringField(value, "id");
  const space = stringField(value, "space") ?? stringField(value, "spaceId");
  const service = stringField(value, "service");
  const callbackUrl = stringField(value, "callbackUrl") ?? stringField(value, "callback_url");
  if (!id || !space || !service || !callbackUrl) {
    return null;
  }
  return {
    id,
    space,
    service,
    pathPrefix: optionalStringField(value, "pathPrefix") ?? optionalStringField(value, "path_prefix"),
    abilities: stringArrayField(value, "abilities") ?? parsedStringArrayField(value, "abilitiesJson") ?? parsedStringArrayField(value, "abilities_json"),
    callbackUrl,
    active: booleanField(value, "active") ?? true,
    createdAt: stringField(value, "createdAt") ?? stringField(value, "created_at") ?? (/* @__PURE__ */ new Date()).toISOString(),
    subscriberDid: optionalStringField(value, "subscriberDid") ?? optionalStringField(value, "subscriber_did")
  };
}
function isRecordContainer(value) {
  return value;
}
function stringField(value, key) {
  const field = value[key];
  return typeof field === "string" ? field : void 0;
}
function optionalStringField(value, key) {
  return stringField(value, key);
}
function booleanField(value, key) {
  const field = value[key];
  return typeof field === "boolean" ? field : void 0;
}
function stringArrayField(value, key) {
  const field = value[key];
  if (!Array.isArray(field)) {
    return void 0;
  }
  const strings = field.filter(
    (item) => typeof item === "string"
  );
  return strings.length === field.length ? strings : void 0;
}
function parsedStringArrayField(value, key) {
  const field = value[key];
  if (typeof field !== "string") {
    return void 0;
  }
  try {
    const parsed = JSON.parse(field);
    if (!Array.isArray(parsed)) {
      return void 0;
    }
    const strings = parsed.filter(
      (item) => typeof item === "string"
    );
    return strings.length === parsed.length ? strings : void 0;
  } catch {
    return void 0;
  }
}
var VaultVersionConfig = {
  "1": {
    masterMessage: (spaceId) => `tinycloud-vault-master-v1:${spaceId}`,
    identityMessage: "tinycloud-encryption-identity-v1"
  }
};
var CURRENT_VAULT_VERSION = "1";
var VaultHeaders = {
  VERSION: "x-vault-version",
  CIPHER: "x-vault-cipher",
  KEY_ID: "x-vault-key-id",
  CONTENT_TYPE: "x-vault-content-type",
  KDF: "x-vault-kdf",
  KEY_ROTATION: "x-vault-key-rotation",
  GRANT_VERSION: "x-vault-grant-version",
  GRANTOR: "x-vault-grantor"
};
var DB_NAME = "tinycloud-vault-cache";
var DB_VERSION = 1;
var STORE_NAME = "signatures";
var WRAP_KEY_ID = "__wrap_key__";
function isBrowser() {
  try {
    return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
  } catch {
    return false;
  }
}
function openDB() {
  return new Promise((resolve3, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve3(request.result);
    request.onerror = () => reject(request.error);
  });
}
function idbGet(db, key) {
  return new Promise((resolve3, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve3(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(db, key, value) {
  return new Promise((resolve3, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve3();
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(db, key) {
  return new Promise((resolve3, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(key);
    req.onsuccess = () => resolve3();
    req.onerror = () => reject(req.error);
  });
}
function idbKeys(db) {
  return new Promise((resolve3, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    req.onsuccess = () => resolve3(req.result.filter((k) => typeof k === "string"));
    req.onerror = () => reject(req.error);
  });
}
async function getWrapKey(db) {
  const existing = await idbGet(db, WRAP_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    // non-extractable
    ["encrypt", "decrypt"]
  );
  await idbPut(db, WRAP_KEY_ID, key);
  return key;
}
async function encryptSig(wrapKey, sigBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, sigBytes)
  );
  return { iv, ciphertext };
}
async function decryptSig(wrapKey, entry) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: entry.iv },
    wrapKey,
    entry.ciphertext
  );
  return new Uint8Array(plaintext);
}
function cacheKey(spaceId) {
  return `sig:${spaceId}`;
}
async function loadCachedSignature(spaceId) {
  if (!isBrowser()) return null;
  try {
    const db = await openDB();
    const entry = await idbGet(db, cacheKey(spaceId));
    if (!entry) return null;
    const wrapKey = await getWrapKey(db);
    return await decryptSig(wrapKey, entry);
  } catch {
    return null;
  }
}
async function cacheSignature(spaceId, sigBytes) {
  if (!isBrowser()) return;
  try {
    const db = await openDB();
    const wrapKey = await getWrapKey(db);
    const encrypted = await encryptSig(wrapKey, sigBytes);
    await idbPut(db, cacheKey(spaceId), encrypted);
  } catch {
  }
}
async function clearSignatureCache(spaceId) {
  if (!isBrowser()) return;
  try {
    const db = await openDB();
    if (spaceId) {
      await idbDelete(db, cacheKey(spaceId));
    } else {
      const keys = await idbKeys(db);
      for (const k of keys) {
        if (k.startsWith("sig:")) {
          await idbDelete(db, k);
        }
      }
    }
  } catch {
  }
}
function toError(error) {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    return new Error(JSON.stringify(error));
  }
  return new Error(String(error));
}
function toBytes(str) {
  return new TextEncoder().encode(str);
}
function fromBytes(bytes) {
  return new TextDecoder().decode(bytes);
}
function hexEncode(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function concatBytes(...arrays) {
  const total = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
function base64Encode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
function base64Decode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
function unwrapKVData(value) {
  if (value !== null && typeof value === "object" && "data" in value) {
    return value.data;
  }
  return value;
}
function hasHttpResponse(error) {
  return typeof error.meta?.status === "number";
}
function isUnlockSigner(signer) {
  return typeof signer === "object" && signer !== null && typeof signer.signMessage === "function";
}
function defaultVaultMessage(input) {
  switch (input.code) {
    case "DECRYPTION_FAILED":
      return input.message ?? "Decryption failed";
    case "KEY_NOT_FOUND":
      return input.message ?? `Key not found: ${input.key}`;
    case "INTEGRITY_ERROR":
      return input.message ?? "Integrity check failed";
    case "GRANT_NOT_FOUND":
      return input.message ?? `Grant not found: ${input.grantor} / ${input.key}`;
    case "VAULT_LOCKED":
      return input.message ?? "Vault is locked";
    case "PUBLIC_KEY_NOT_FOUND":
      return input.message ?? `Public key not found for ${input.did}`;
    case "STORAGE_ERROR":
      return input.message ?? input.cause.message;
  }
}
function vaultError(input) {
  const error = {
    ...input,
    service: "vault",
    message: defaultVaultMessage(input)
  };
  return { ok: false, error };
}
var DataVaultService = class extends BaseService {
  /**
   * Create a new DataVaultService instance.
   *
   * @param config - Service configuration including crypto and tc references
   */
  constructor(config) {
    super();
    this.masterKey = null;
    this.encryptionIdentity = null;
    this._isUnlocked = false;
    this.unlockInFlight = null;
    this.vaultConfig = config;
    this._config = config;
  }
  /**
   * Get the service configuration.
   */
  get config() {
    return this._config;
  }
  /**
   * Whether the vault is currently unlocked.
   */
  get isUnlocked() {
    return this.usesNetworkEncryption || this._isUnlocked;
  }
  /**
   * The vault's public encryption key (X25519).
   * Throws if vault is locked.
   */
  get publicKey() {
    if (this.usesNetworkEncryption) {
      throw new Error("Network-encrypted vaults do not expose a local public key");
    }
    if (!this.encryptionIdentity) {
      throw new Error("Vault is locked");
    }
    return this.encryptionIdentity.publicKey;
  }
  /**
   * Convenience accessor for crypto operations.
   */
  get crypto() {
    return this.vaultConfig.crypto;
  }
  /**
   * Convenience accessor for TinyCloud instance.
   */
  get tc() {
    return this.vaultConfig.tc;
  }
  get networkEncryption() {
    return this.vaultConfig.encryption;
  }
  get usesNetworkEncryption() {
    return this.networkEncryption !== void 0;
  }
  /**
   * Get the host URL.
   */
  get host() {
    return this.tc.hosts[0];
  }
  async decryptCapabilityProof() {
    const proof = this.networkEncryption?.decryptCapabilityProof;
    if (typeof proof === "function") {
      return await proof();
    }
    return proof ?? { proofs: [] };
  }
  serializeValue(value, options) {
    let plaintext;
    if (value instanceof Uint8Array) {
      plaintext = value;
    } else if (options?.serialize) {
      plaintext = options.serialize(value);
    } else if (typeof value === "string") {
      plaintext = toBytes(value);
    } else {
      plaintext = toBytes(JSON.stringify(value));
    }
    const contentType = options?.contentType ?? (value instanceof Uint8Array ? "application/octet-stream" : "application/json");
    return { plaintext, contentType };
  }
  deserializeValue(plaintext, contentType, options) {
    if (options?.raw) {
      return plaintext;
    }
    if (options?.deserialize) {
      return options.deserialize(plaintext);
    }
    if (contentType === "application/json") {
      return JSON.parse(fromBytes(plaintext));
    }
    return plaintext;
  }
  // =========================================================================
  // Phase 1: Core Operations
  // =========================================================================
  /**
   * Unlock the vault. Derives keys from two wallet signatures:
   * 1. Master signature (per-space) — used to derive the master encryption key
   * 2. Identity signature (per-address) — used to derive X25519 encryption identity
   *
   * If the identity public key already exists in the public space, the identity
   * signature is skipped entirely (no wallet popup). The identity private key is
   * only needed for sharing operations.
   *
   * @param signer - Object with signMessage method. Optional when cached
   *                 signatures exist (browser only).
   */
  async unlock(signer) {
    if (this.usesNetworkEncryption) {
      this._isUnlocked = true;
      return { ok: true, data: void 0 };
    }
    const unlockSigner = isUnlockSigner(signer) ? signer : void 0;
    if (this._isUnlocked && this.masterKey && (this.encryptionIdentity || !unlockSigner)) {
      return { ok: true, data: void 0 };
    }
    if (this.unlockInFlight) {
      return this.unlockInFlight;
    }
    this.unlockInFlight = this.withTelemetry("unlock", void 0, async () => {
      const spaceId = this.vaultConfig.spaceId;
      const versionConfig = VaultVersionConfig[CURRENT_VAULT_VERSION];
      const masterCacheKey = `vault-master:${spaceId}`;
      const identityCacheKey = `vault-identity:${this.tc.address}`;
      try {
        if (!this.masterKey) {
          let masterSigBytes = await loadCachedSignature(masterCacheKey);
          if (!masterSigBytes) {
            if (!unlockSigner) {
              return vaultError({
                code: "VAULT_LOCKED",
                message: "Signer is required when no cached master signature exists"
              });
            }
            const sig = await unlockSigner.signMessage(
              versionConfig.masterMessage(spaceId)
            );
            masterSigBytes = toBytes(sig);
            await cacheSignature(masterCacheKey, masterSigBytes);
          }
          this.masterKey = this.crypto.deriveKey(
            masterSigBytes,
            this.crypto.sha256(toBytes(spaceId)),
            toBytes("vault-master")
          );
        }
        const publicSpaceId = this.tc.makePublicSpaceId(this.tc.address, this.tc.chainId);
        let existingPubKey = null;
        try {
          const existing = await this.tc.readPublicSpace(
            this.host,
            publicSpaceId,
            ".well-known/vault-pubkey"
          );
          if (existing.ok && existing.data) {
            existingPubKey = existing.data;
          }
        } catch {
        }
        if (existingPubKey) {
          this.encryptionIdentity = {
            publicKey: base64Decode(existingPubKey),
            privateKey: new Uint8Array(0)
            // private key not available without signing
          };
        } else {
          let identitySigBytes = await loadCachedSignature(identityCacheKey);
          if (!identitySigBytes) {
            if (!unlockSigner) {
              this.encryptionIdentity = null;
              this._isUnlocked = true;
              return ok(void 0);
            }
            const sig = await unlockSigner.signMessage(
              versionConfig.identityMessage
            );
            identitySigBytes = toBytes(sig);
            await cacheSignature(identityCacheKey, identitySigBytes);
          }
          const seed = this.crypto.deriveKey(
            identitySigBytes,
            toBytes("tinycloud-x25519"),
            toBytes("encryption-identity")
          );
          this.encryptionIdentity = this.crypto.x25519FromSeed(seed);
          try {
            const pubKeyB64 = base64Encode(this.encryptionIdentity.publicKey);
            await this.tc.ensurePublicSpace();
            await this.tc.publicKV.put(".well-known/vault-pubkey", pubKeyB64);
            await this.tc.publicKV.put(".well-known/vault-version", CURRENT_VAULT_VERSION);
            await this.tc.publicKV.put(".well-known/vault-space", this.vaultConfig.spaceId);
          } catch {
          }
        }
        this._isUnlocked = true;
        return ok(void 0);
      } catch (error) {
        this.masterKey = null;
        this.encryptionIdentity = null;
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
    try {
      return await this.unlockInFlight;
    } finally {
      this.unlockInFlight = null;
    }
  }
  /**
   * Clear the cached vault signatures.
   *
   * @param spaceId - Clear only this space's master cache. If omitted, clears all.
   */
  async clearCache(spaceId) {
    if (spaceId) {
      await clearSignatureCache(`vault-master:${spaceId}`);
    } else {
      await clearSignatureCache();
    }
  }
  /**
   * Lock the vault, clearing all key material from memory.
   */
  lock() {
    this.masterKey = null;
    this.encryptionIdentity = null;
    this._isUnlocked = false;
  }
  /**
   * Called when SDK signs out. Locks the vault and aborts operations.
   */
  onSignOut() {
    this.lock();
    super.onSignOut();
  }
  async putNetworkEncrypted(key, value, options) {
    const config = this.networkEncryption;
    if (!config) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Network encryption is not configured"
      });
    }
    if (!this.requireAuth()) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Authentication required"
      });
    }
    try {
      const { plaintext, contentType } = this.serializeValue(value, options);
      const metadata = {
        [VaultHeaders.VERSION]: "2",
        [VaultHeaders.CIPHER]: "tinycloud-network-envelope",
        [VaultHeaders.CONTENT_TYPE]: contentType,
        ...options?.metadata ?? {}
      };
      const aad = toBytes(`tinycloud.vault:${this.vaultConfig.spaceId}:${key}`);
      const envelopeResult = await config.service.encryptToNetwork(
        config.networkId,
        plaintext,
        { aad, metadata }
      );
      if (!envelopeResult.ok) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(envelopeResult.error.message)
        });
      }
      const valuePutResult = await this.tc.kv.put(
        `vault/${key}`,
        JSON.stringify(envelopeResult.data)
      );
      if (!valuePutResult.ok) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(
            `Failed to store encrypted value: ${valuePutResult.error.message}`
          )
        });
      }
      return { ok: true, data: void 0 };
    } catch (error) {
      return vaultError({
        code: "STORAGE_ERROR",
        cause: toError(error)
      });
    }
  }
  async getNetworkEncrypted(key, options) {
    const config = this.networkEncryption;
    if (!config) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Network encryption is not configured"
      });
    }
    if (!this.requireAuth()) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Authentication required"
      });
    }
    try {
      const valueResult = await this.tc.kv.get(`vault/${key}`, {
        raw: true
      });
      if (!valueResult.ok) {
        return vaultError({ code: "KEY_NOT_FOUND", key });
      }
      const rawEnvelope = unwrapKVData(valueResult.data);
      const envelope = typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope;
      const proof = await this.decryptCapabilityProof();
      const plaintextResult = await config.service.decryptEnvelope(envelope, proof);
      if (!plaintextResult.ok) {
        return vaultError({
          code: "DECRYPTION_FAILED",
          message: plaintextResult.error.message
        });
      }
      const metadata = envelope.metadata ?? {};
      const contentType = metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
      const keyId = metadata[VaultHeaders.KEY_ID] ?? envelope.encryptedSymmetricKeyHash.slice(0, 16);
      const value = this.deserializeValue(
        plaintextResult.data,
        contentType,
        options
      );
      return { ok: true, data: { value, metadata, keyId } };
    } catch (error) {
      return vaultError({
        code: "STORAGE_ERROR",
        cause: toError(error)
      });
    }
  }
  /**
   * Read a network-encrypted entry while preserving safe failure phases.
   *
   * Unlike {@link getNetworkEncrypted}, this is intentionally message-free so
   * an operation layer can distinguish an authorized absence from a failed
   * read without receiving node, envelope, plaintext, or key material.
   */
  async readNetworkEncrypted(key, options) {
    const config = this.networkEncryption;
    if (!config || !this.requireAuth()) {
      return { status: "read_failed" };
    }
    let valueResult;
    try {
      valueResult = await this.tc.kv.get(`vault/${key}`, { raw: true });
    } catch {
      return { status: "node_unreachable" };
    }
    if (!valueResult.ok) {
      const permissionHint = parsePermissionHint(valueResult.error.meta?.permissionHint);
      if (valueResult.error.code === "AUTH_UNAUTHORIZED" && permissionHint !== void 0) {
        return { status: "permission_required", hint: permissionHint };
      }
      if ((valueResult.error.code === "NOT_FOUND" || valueResult.error.code === "KV_NOT_FOUND") && !hasHttpResponse(valueResult.error)) {
        return { status: "not_found" };
      }
      if (valueResult.error.code === "NETWORK_ERROR" || valueResult.error.code === "TIMEOUT" || valueResult.error.code === "ABORTED") {
        return hasHttpResponse(valueResult.error) ? { status: "read_failed" } : { status: "node_unreachable" };
      }
      return { status: "read_failed" };
    }
    let envelope;
    try {
      const rawEnvelope = unwrapKVData(valueResult.data);
      envelope = typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope;
    } catch {
      return { status: "corrupt_envelope" };
    }
    let plaintextResult;
    try {
      const proof = await this.decryptCapabilityProof();
      plaintextResult = await config.service.decryptEnvelope(envelope, proof);
    } catch {
      return { status: "decrypt_failed" };
    }
    if (!plaintextResult.ok) {
      const permissionHint = parsePermissionHint(
        plaintextResult.error.permissionHint
      );
      if (plaintextResult.error.code === "DECRYPT_DENIED" && permissionHint !== void 0) {
        return { status: "permission_required", hint: permissionHint };
      }
      if (plaintextResult.error.code === "INVALID_ENVELOPE") {
        return { status: "corrupt_envelope" };
      }
      if (plaintextResult.error.code === "TRANSPORT_ERROR") {
        return { status: "node_unreachable" };
      }
      return { status: "decrypt_failed" };
    }
    try {
      const metadata = envelope.metadata ?? {};
      const contentType = metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
      const keyId = metadata[VaultHeaders.KEY_ID] ?? envelope.encryptedSymmetricKeyHash.slice(0, 16);
      const value = this.deserializeValue(
        plaintextResult.data,
        contentType,
        options
      );
      return { status: "ok", entry: { value, metadata, keyId } };
    } catch {
      return { status: "invalid_payload" };
    }
  }
  async headNetworkEncrypted(key) {
    if (!this.requireAuth()) {
      return vaultError({
        code: "VAULT_LOCKED",
        message: "Authentication required"
      });
    }
    try {
      const valueResult = await this.tc.kv.get(`vault/${key}`, {
        raw: true
      });
      if (!valueResult.ok) {
        return vaultError({ code: "KEY_NOT_FOUND", key });
      }
      const rawEnvelope = unwrapKVData(valueResult.data);
      const envelope = typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope;
      return { ok: true, data: envelope.metadata ?? {} };
    } catch (error) {
      return vaultError({
        code: "STORAGE_ERROR",
        cause: toError(error)
      });
    }
  }
  /**
   * Encrypt and store a value at the given key.
   *
   * @param key - The key to store under
   * @param value - The value to encrypt and store
   * @param options - Optional put configuration
   */
  async put(key, value, options) {
    return this.withTelemetry("put", key, async () => {
      if (this.usesNetworkEncryption) {
        return this.putNetworkEncrypted(key, value, options);
      }
      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before storing data"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        let plaintext;
        if (value instanceof Uint8Array) {
          plaintext = value;
        } else if (options?.serialize) {
          plaintext = options.serialize(value);
        } else if (typeof value === "string") {
          plaintext = toBytes(value);
        } else {
          plaintext = toBytes(JSON.stringify(value));
        }
        const contentType = options?.contentType ?? (value instanceof Uint8Array ? "application/octet-stream" : "application/json");
        const entryKey = this.crypto.randomBytes(32);
        const keyId = hexEncode(this.crypto.sha256(entryKey)).slice(0, 16);
        const encrypted = this.crypto.encrypt(entryKey, plaintext);
        const keyBlob = this.crypto.encrypt(this.masterKey, entryKey);
        const metadata = {
          [VaultHeaders.VERSION]: "1",
          [VaultHeaders.CIPHER]: "aes-256-gcm",
          [VaultHeaders.KEY_ID]: keyId,
          [VaultHeaders.CONTENT_TYPE]: contentType,
          [VaultHeaders.KDF]: "hkdf-sha256",
          [VaultHeaders.KEY_ROTATION]: this.vaultConfig.keyRotation ?? "per-write",
          ...options?.metadata ?? {}
        };
        const keyMetadata = JSON.stringify({
          keyId,
          contentType,
          ...metadata
        });
        const keyPayload = JSON.stringify({
          key: base64Encode(keyBlob),
          metadata: keyMetadata
        });
        const keyPutResult = await this.tc.kv.put(
          `keys/${key}`,
          keyPayload
        );
        if (!keyPutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store key blob: ${keyPutResult.error.message}`
            )
          });
        }
        const valuePayload = JSON.stringify({
          data: base64Encode(encrypted),
          metadata
        });
        const valuePutResult = await this.tc.kv.put(
          `vault/${key}`,
          valuePayload
        );
        if (!valuePutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store encrypted value: ${valuePutResult.error.message}`
            )
          });
        }
        return ok(void 0);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  /**
   * Retrieve and decrypt a value by key.
   *
   * @param key - The key to retrieve
   * @param options - Optional get configuration
   * @returns Result with the decrypted entry
   */
  async get(key, options) {
    return this.withTelemetry("get", key, async () => {
      if (this.usesNetworkEncryption) {
        return this.getNetworkEncrypted(key, options);
      }
      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before reading data"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        const keyResult = await this.tc.kv.get(`keys/${key}`, {
          raw: true
        });
        if (!keyResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }
        const keyEnvelope = JSON.parse(keyResult.data.data);
        const keyBlobBytes = base64Decode(keyEnvelope.key);
        const entryKey = this.crypto.decrypt(this.masterKey, keyBlobBytes);
        const valueResult = await this.tc.kv.get(`vault/${key}`, {
          raw: true
        });
        if (!valueResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }
        const valueEnvelope = JSON.parse(valueResult.data.data);
        const encryptedBytes = base64Decode(valueEnvelope.data);
        const plaintext = this.crypto.decrypt(entryKey, encryptedBytes);
        const metadata = valueEnvelope.metadata ?? {};
        const contentType = metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
        const keyId = metadata[VaultHeaders.KEY_ID] ?? "";
        let value;
        if (options?.raw) {
          value = plaintext;
        } else if (options?.deserialize) {
          value = options.deserialize(plaintext);
        } else if (contentType === "application/json") {
          value = JSON.parse(fromBytes(plaintext));
        } else {
          value = plaintext;
        }
        return ok({ value, metadata, keyId });
      } catch (error) {
        if (error instanceof Error && error.message.includes("decryption")) {
          return vaultError({
            code: "DECRYPTION_FAILED",
            message: error.message
          });
        }
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  /**
   * Delete an encrypted key.
   * Removes both the encrypted value and the key blob.
   *
   * @param key - The key to delete
   */
  async delete(key) {
    return this.withTelemetry("delete", key, async () => {
      if (!this.isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before deleting data"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        if (this.usesNetworkEncryption) {
          const valueDelResult2 = await this.tc.kv.delete(`vault/${key}`);
          if (!valueDelResult2.ok) {
            return vaultError({ code: "KEY_NOT_FOUND", key });
          }
          return ok(void 0);
        }
        const [keyDelResult, valueDelResult] = await Promise.all([
          this.tc.kv.delete(`keys/${key}`),
          this.tc.kv.delete(`vault/${key}`)
        ]);
        if (!keyDelResult.ok && !valueDelResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }
        return ok(void 0);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  /**
   * List vault keys with optional prefix filtering.
   *
   * @param options - Optional list configuration
   * @returns Result with array of key names (vault/ prefix stripped)
   */
  async list(options) {
    return this.withTelemetry("list", options?.prefix, async () => {
      if (!this.isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before listing data"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        const listPrefix = options?.prefix ? `vault/${options.prefix}` : "vault/";
        const listResult = await this.tc.kv.list({
          prefix: listPrefix,
          removePrefix: true
        });
        if (!listResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to list vault keys: ${listResult.error.message}`
            )
          });
        }
        let keys = listResult.data.keys;
        if (options?.removePrefix && options.prefix) {
          const userPrefix = options.prefix.endsWith("/") ? options.prefix : `${options.prefix}/`;
          keys = keys.map(
            (k) => k.startsWith(userPrefix) ? k.slice(userPrefix.length) : k
          );
        }
        return ok(keys);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  /**
   * Get envelope metadata for a key without decrypting the value.
   *
   * @param key - The key to inspect
   * @returns Result with metadata headers
   */
  async head(key) {
    return this.withTelemetry("head", key, async () => {
      if (this.usesNetworkEncryption) {
        return this.headNetworkEncrypted(key);
      }
      if (!this._isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before reading metadata"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        const valueResult = await this.tc.kv.get(`vault/${key}`, {
          raw: true
        });
        if (!valueResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }
        const valueEnvelope = JSON.parse(valueResult.data.data);
        const metadata = valueEnvelope.metadata ?? {};
        return ok(metadata);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  // =========================================================================
  // Batch Operations
  // =========================================================================
  /**
   * Encrypt and store multiple entries.
   *
   * @param entries - Array of key/value pairs with optional per-entry options
   * @returns Array of results, one per entry
   */
  async putMany(entries) {
    return Promise.all(
      entries.map((entry) => this.put(entry.key, entry.value, entry.options))
    );
  }
  /**
   * Retrieve and decrypt multiple keys.
   *
   * @param keys - Array of keys to retrieve
   * @param options - Optional get configuration applied to all entries
   * @returns Array of results, one per key
   */
  async getMany(keys, options) {
    return Promise.all(keys.map((key) => this.get(key, options)));
  }
  // =========================================================================
  // Phase 2: Sharing
  // =========================================================================
  /**
   * Re-encrypt a vault key for another user (renamed from grant).
   * Re-encrypts the data key to the recipient's public key via X25519 DH.
   *
   * @param key - The key to share
   * @param recipientDID - The recipient's primary DID (did:pkh:...)
   * @param options - Optional grant configuration
   */
  async reencrypt(key, recipientDID, options) {
    return this.withTelemetry("reencrypt", key, async () => {
      if (this.usesNetworkEncryption) {
        void recipientDID;
        void options;
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(
            "Vault key grants are deprecated for network-encrypted vaults; grant tinycloud.encryption/decrypt on the network plus KV access to vault data."
          )
        });
      }
      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before granting access"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        const pubKeyResult = await this.resolvePublicKey(recipientDID);
        if (!pubKeyResult.ok) {
          return pubKeyResult;
        }
        const bobPubKey = pubKeyResult.data;
        const keyResult = await this.tc.kv.get(`keys/${key}`, {
          raw: true
        });
        if (!keyResult.ok) {
          return vaultError({ code: "KEY_NOT_FOUND", key });
        }
        const keyEnvelope = JSON.parse(keyResult.data.data);
        const keyBlobBytes = base64Decode(keyEnvelope.key);
        const entryKey = this.crypto.decrypt(this.masterKey, keyBlobBytes);
        const ephemeralSeed = this.crypto.randomBytes(32);
        const ephemeralKeyPair = this.crypto.x25519FromSeed(ephemeralSeed);
        const sharedSecret = this.crypto.x25519Dh(
          ephemeralKeyPair.privateKey,
          bobPubKey
        );
        const encryptionKey = this.crypto.deriveKey(
          sharedSecret,
          toBytes("tinycloud-x25519"),
          toBytes("vault-grant")
        );
        const encryptedGrant = this.crypto.encrypt(encryptionKey, entryKey);
        const grantBlob = concatBytes(
          ephemeralKeyPair.publicKey,
          encryptedGrant
        );
        const grantPayload = JSON.stringify({
          grant: base64Encode(grantBlob),
          spaceId: this.vaultConfig.spaceId,
          metadata: {
            [VaultHeaders.GRANT_VERSION]: "1",
            [VaultHeaders.GRANTOR]: this.tc.did,
            ...options?.metadata ?? {}
          }
        });
        const grantPutResult = await this.tc.kv.put(
          `grants/${recipientDID}/${key}`,
          grantPayload
        );
        if (!grantPutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store grant: ${grantPutResult.error.message}`
            )
          });
        }
        return ok(void 0);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  /**
   * @deprecated Use reencrypt() instead.
   */
  async grant(key, recipientDID, options) {
    return this.reencrypt(key, recipientDID, options);
  }
  /**
   * Retrieve and decrypt a value shared by another user.
   *
   * @param grantorDID - The DID of the user who shared the data
   * @param key - The key that was shared
   * @param options - Optional get configuration
   * @returns Result with the decrypted entry
   */
  async getShared(grantorDID, key, options) {
    return this.withTelemetry("getShared", key, async () => {
      if (this.usesNetworkEncryption) {
        const grantorKV = options?.kv;
        if (!grantorKV) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              "getShared requires a delegated KV service via options.kv."
            )
          });
        }
        const config = this.networkEncryption;
        if (!config) {
          return vaultError({
            code: "VAULT_LOCKED",
            message: "Network encryption is not configured"
          });
        }
        if (!this.requireAuth()) {
          return vaultError({
            code: "VAULT_LOCKED",
            message: "Authentication required"
          });
        }
        try {
          const valueResult = await grantorKV.get(`vault/${key}`, {
            raw: true
          });
          if (!valueResult.ok) {
            return vaultError({ code: "KEY_NOT_FOUND", key });
          }
          const rawEnvelope = unwrapKVData(valueResult.data);
          const envelope = typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope;
          const proof = await this.decryptCapabilityProof();
          const plaintextResult = await config.service.decryptEnvelope(
            envelope,
            proof
          );
          if (!plaintextResult.ok) {
            return vaultError({
              code: "DECRYPTION_FAILED",
              message: plaintextResult.error.message
            });
          }
          const metadata = envelope.metadata ?? {};
          const contentType = metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
          const keyId = metadata[VaultHeaders.KEY_ID] ?? envelope.encryptedSymmetricKeyHash.slice(0, 16);
          const value = this.deserializeValue(
            plaintextResult.data,
            contentType,
            options
          );
          void grantorDID;
          return { ok: true, data: { value, metadata, keyId } };
        } catch (error) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: toError(error)
          });
        }
      }
      if (!this._isUnlocked || !this.masterKey || !this.encryptionIdentity) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before reading shared data"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        const myDID = this.tc.did;
        const grantorKV = options?.kv;
        if (!grantorKV) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              "getShared requires a delegated KV service via options.kv. Use useDelegation() to get delegated access, then pass { kv: access.kv }."
            )
          });
        }
        const grantResult = await grantorKV.get(`grants/${myDID}/${key}`, {
          raw: true
        });
        if (!grantResult.ok) {
          return vaultError({
            code: "GRANT_NOT_FOUND",
            grantor: grantorDID,
            key
          });
        }
        const grantEnvelope = typeof grantResult.data?.data === "string" ? JSON.parse(grantResult.data.data) : grantResult.data?.data;
        const grantBlobBytes = base64Decode(grantEnvelope.grant);
        const ephemeralPubKey = grantBlobBytes.slice(0, 32);
        const encryptedGrant = grantBlobBytes.slice(32);
        const sharedSecret = this.crypto.x25519Dh(
          this.encryptionIdentity.privateKey,
          ephemeralPubKey
        );
        const encryptionKey = this.crypto.deriveKey(
          sharedSecret,
          toBytes("tinycloud-x25519"),
          toBytes("vault-grant")
        );
        const entryKey = this.crypto.decrypt(encryptionKey, encryptedGrant);
        const valueResult = await grantorKV.get(`vault/${key}`, {
          raw: true
        });
        if (!valueResult.ok) {
          return vaultError({
            code: "KEY_NOT_FOUND",
            key
          });
        }
        const valueEnvelope = typeof valueResult.data?.data === "string" ? JSON.parse(valueResult.data.data) : valueResult.data?.data;
        const encryptedBytes = base64Decode(valueEnvelope.data);
        const plaintext = this.crypto.decrypt(entryKey, encryptedBytes);
        const metadata = valueEnvelope.metadata ?? {};
        const contentType = metadata[VaultHeaders.CONTENT_TYPE] ?? "application/json";
        const keyId = metadata[VaultHeaders.KEY_ID] ?? "";
        let value;
        if (options?.raw) {
          value = plaintext;
        } else if (options?.deserialize) {
          value = options.deserialize(plaintext);
        } else if (contentType === "application/json") {
          value = JSON.parse(fromBytes(plaintext));
        } else {
          value = plaintext;
        }
        return ok({ value, metadata, keyId });
      } catch (error) {
        if (error instanceof Error && error.message.includes("decryption")) {
          return vaultError({
            code: "DECRYPTION_FAILED",
            message: error.message
          });
        }
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  /**
   * Resolve another user's public encryption key from their DID.
   *
   * @param did - The DID to resolve (did:pkh:eip155:{chainId}:{address})
   * @returns Result with the public key bytes
   */
  async resolvePublicKey(did) {
    try {
      const parts = this.parseDID(did);
      if (!parts) {
        return vaultError({ code: "PUBLIC_KEY_NOT_FOUND", did });
      }
      const spaceId = this.tc.makePublicSpaceId(
        parts.address,
        parts.chainId
      );
      const result = await this.tc.readPublicSpace(
        this.host,
        spaceId,
        ".well-known/vault-pubkey"
      );
      if (!result.ok) {
        return vaultError({ code: "PUBLIC_KEY_NOT_FOUND", did });
      }
      const pubKeyBytes = base64Decode(result.data);
      return { ok: true, data: pubKeyBytes };
    } catch (error) {
      return vaultError({ code: "PUBLIC_KEY_NOT_FOUND", did });
    }
  }
  /**
   * List DIDs that have been granted access to a key.
   *
   * @param key - The key to list grants for
   * @returns Result with array of recipient DIDs
   */
  async listGrants(key) {
    return this.withTelemetry("listGrants", key, async () => {
      if (this.usesNetworkEncryption) {
        void key;
        return { ok: true, data: [] };
      }
      if (!this._isUnlocked) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before listing grants"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        const listResult = await this.tc.kv.list({
          prefix: "grants/",
          removePrefix: true
        });
        if (!listResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to list grants: ${listResult.error.message}`
            )
          });
        }
        const dids = [];
        for (const grantPath of listResult.data.keys) {
          if (grantPath.endsWith(`/${key}`)) {
            const did = grantPath.slice(
              0,
              grantPath.length - key.length - 1
            );
            if (did) {
              dids.push(did);
            }
          }
        }
        return ok(dids);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  // =========================================================================
  // Phase 3: Key Rotation / Revocation
  // =========================================================================
  /**
   * Revoke a previously issued grant.
   *
   * This performs a full key rotation:
   * 1. Lists current grantees
   * 2. Removes the revoked recipient
   * 3. Re-encrypts the value with a new entry key
   * 4. Re-issues grants to remaining recipients
   *
   * @param key - The key to revoke access to
   * @param recipientDID - The recipient whose access to revoke
   */
  async revoke(key, recipientDID) {
    return this.withTelemetry("revoke", key, async () => {
      if (this.usesNetworkEncryption) {
        void recipientDID;
        return vaultError({
          code: "STORAGE_ERROR",
          cause: new Error(
            "Vault key grants are deprecated for network-encrypted vaults; revoke KV and tinycloud.encryption/decrypt grants instead."
          )
        });
      }
      if (!this._isUnlocked || !this.masterKey) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Vault must be unlocked before revoking access"
        });
      }
      if (!this.requireAuth()) {
        return vaultError({
          code: "VAULT_LOCKED",
          message: "Authentication required"
        });
      }
      try {
        const granteesResult = await this.listGrants(key);
        if (!granteesResult.ok) {
          return granteesResult;
        }
        const remainingGrantees = granteesResult.data.filter(
          (did) => did !== recipientDID
        );
        const deleteGrantResult = await this.tc.kv.delete(
          `grants/${recipientDID}/${key}`
        );
        const getResult = await this.get(key);
        if (!getResult.ok) {
          return getResult;
        }
        const currentEntry = getResult.data;
        const newEntryKey = this.crypto.randomBytes(32);
        const newKeyId = hexEncode(this.crypto.sha256(newEntryKey)).slice(
          0,
          16
        );
        let plaintext;
        if (currentEntry.value instanceof Uint8Array) {
          plaintext = currentEntry.value;
        } else {
          plaintext = toBytes(JSON.stringify(currentEntry.value));
        }
        const encrypted = this.crypto.encrypt(newEntryKey, plaintext);
        const newKeyBlob = this.crypto.encrypt(this.masterKey, newEntryKey);
        const metadata = {
          ...currentEntry.metadata,
          [VaultHeaders.KEY_ID]: newKeyId
        };
        const keyPayload = JSON.stringify({
          key: base64Encode(newKeyBlob),
          metadata: JSON.stringify({
            keyId: newKeyId,
            ...metadata
          })
        });
        const keyPutResult = await this.tc.kv.put(
          `keys/${key}`,
          keyPayload
        );
        if (!keyPutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store rotated key blob: ${keyPutResult.error.message}`
            )
          });
        }
        const valuePayload = JSON.stringify({
          data: base64Encode(encrypted),
          metadata
        });
        const valuePutResult = await this.tc.kv.put(
          `vault/${key}`,
          valuePayload
        );
        if (!valuePutResult.ok) {
          return vaultError({
            code: "STORAGE_ERROR",
            cause: new Error(
              `Failed to store re-encrypted value: ${valuePutResult.error.message}`
            )
          });
        }
        for (const did of remainingGrantees) {
          const grantResult = await this.reencrypt(key, did);
          if (!grantResult.ok) {
          }
        }
        return ok(void 0);
      } catch (error) {
        return vaultError({
          code: "STORAGE_ERROR",
          cause: toError(error)
        });
      }
    });
  }
  // =========================================================================
  // Internal Helpers
  // =========================================================================
  /**
   * Parse a DID string to extract address and chainId.
   * Expected format: did:pkh:eip155:{chainId}:{address}
   *
   * @param did - The DID to parse
   * @returns Parsed address and chainId, or null if invalid
   */
  parseDID(did) {
    const parts = did.split(":");
    if (parts.length !== 5 || parts[0] !== "did" || parts[1] !== "pkh" || parts[2] !== "eip155") {
      return null;
    }
    const chainId = parseInt(parts[3], 10);
    const address = parts[4];
    if (isNaN(chainId) || !address) {
      return null;
    }
    return { address, chainId };
  }
};
DataVaultService.serviceName = "vault";
var SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
var SECRET_PREFIX = "secrets/";
var SCOPED_SECRET_PREFIX = "secrets/scoped/";
var RESERVED_SECRET_SCOPES = /* @__PURE__ */ new Set(["default", "global"]);
function canonicalizeSecretScope(scope) {
  if (scope === void 0) {
    return void 0;
  }
  const trimmed = scope.trim();
  if (trimmed === "") {
    throw new Error("Secret scope must be non-empty; omit scope for global secrets.");
  }
  const canonical = trimmed.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (canonical === "") {
    throw new Error("Secret scope must contain at least one letter or number.");
  }
  if (RESERVED_SECRET_SCOPES.has(canonical)) {
    throw new Error(
      `Secret scope ${JSON.stringify(scope)} is reserved; omit scope for global secrets.`
    );
  }
  return canonical;
}
function resolveSecretPath(name2, options = {}) {
  const normalizedName = name2.trim();
  if (!SECRET_NAME_RE.test(normalizedName)) {
    throw new Error(
      `Invalid secret name ${JSON.stringify(name2)}. Secret names must match ${SECRET_NAME_RE.source}.`
    );
  }
  const scope = canonicalizeSecretScope(options.scope);
  const vaultKey = scope === void 0 ? `${SECRET_PREFIX}${normalizedName}` : `${SCOPED_SECRET_PREFIX}${scope}/${normalizedName}`;
  return {
    name: normalizedName,
    ...scope !== void 0 ? { scope } : {},
    vaultKey,
    permissionPaths: {
      vault: `vault/${vaultKey}`
    }
  };
}
function canonicalize(value) {
  if (value === void 0) {
    return "";
  }
  return stringify(value);
}
function stringify(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(stringify).join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const k of keys) {
        const v = value[k];
        if (v === void 0) continue;
        parts.push(`${JSON.stringify(k)}:${stringify(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(
        `canonicalize: unsupported value type ${typeof value}`
      );
  }
}
var HEX = "0123456789abcdef";
function hexEncode2(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[b >> 4 & 15] + HEX[b & 15];
  }
  return out;
}
function base64Encode2(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2 & 63];
    out += chars[(b0 << 4 | b1 >> 4) & 63];
    out += i + 1 < bytes.length ? chars[(b1 << 2 | b2 >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? chars[b2 & 63] : "=";
  }
  return out;
}
function base64Decode2(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  if (len % 4 !== 0) {
    throw new Error("invalid base64 input");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const outLen = len / 4 * 3 - padding;
  const out = new Uint8Array(outLen);
  const lookup = {};
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) lookup[chars[i]] = i;
  let outIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const v0 = lookup[clean[i]] ?? 0;
    const v1 = lookup[clean[i + 1]] ?? 0;
    const v2 = clean[i + 2] === "=" ? 0 : lookup[clean[i + 2]] ?? 0;
    const v3 = clean[i + 3] === "=" ? 0 : lookup[clean[i + 3]] ?? 0;
    const b0 = v0 << 2 | v1 >> 4;
    const b1 = (v1 & 15) << 4 | v2 >> 2;
    const b2 = (v2 & 3) << 6 | v3;
    if (outIdx < outLen) out[outIdx++] = b0;
    if (outIdx < outLen) out[outIdx++] = b1;
    if (outIdx < outLen) out[outIdx++] = b2;
  }
  return out;
}
function utf8Encode(s) {
  return new TextEncoder().encode(s);
}
function canonicalHashHex(sha256, value) {
  const canonical = canonicalize(value);
  return hexEncode2(sha256(utf8Encode(canonical)));
}
var URN_PREFIX = "urn:tinycloud:encryption:";
var NETWORK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
var PKH_EIP155_DID_RE = /^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/;
var NetworkIdError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkIdError";
  }
};
function parseNetworkId(networkId) {
  if (typeof networkId !== "string" || networkId.length === 0) {
    throw new NetworkIdError("networkId must be a non-empty string");
  }
  if (!networkId.startsWith(URN_PREFIX)) {
    throw new NetworkIdError(
      `networkId must start with ${URN_PREFIX} (got ${JSON.stringify(networkId)})`
    );
  }
  const body = networkId.slice(URN_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === body.length - 1) {
    throw new NetworkIdError(
      `networkId missing ownerDid or name segment (got ${JSON.stringify(networkId)})`
    );
  }
  const ownerDid = body.slice(0, lastColon);
  const name2 = body.slice(lastColon + 1);
  if (!ownerDid.startsWith("did:")) {
    throw new NetworkIdError(
      `networkId ownerDid must be a DID (got ${JSON.stringify(ownerDid)})`
    );
  }
  const didParts = ownerDid.split(":");
  if (didParts.length < 3 || didParts.some((p) => p.length === 0)) {
    throw new NetworkIdError(
      `networkId ownerDid is not a well-formed DID (got ${JSON.stringify(ownerDid)})`
    );
  }
  if (!NETWORK_NAME_RE.test(name2)) {
    throw new NetworkIdError(
      `networkId name ${JSON.stringify(name2)} must match ${NETWORK_NAME_RE.source}`
    );
  }
  return { networkId, ownerDid, name: name2 };
}
function parsePkhOwnerDid(ownerDid) {
  const match = ownerDid.match(PKH_EIP155_DID_RE);
  if (!match) return null;
  return {
    chainId: match[1],
    address: match[2].toLowerCase()
  };
}
function ownerDidMatches(a, b) {
  const aPkh = parsePkhOwnerDid(a);
  const bPkh = parsePkhOwnerDid(b);
  if (aPkh && bPkh) {
    return aPkh.chainId === bPkh.chainId && aPkh.address === bPkh.address;
  }
  return a === b;
}
function networkDiscoveryKey(name2) {
  if (!NETWORK_NAME_RE.test(name2)) {
    throw new NetworkIdError(
      `network name ${JSON.stringify(name2)} must match ${NETWORK_NAME_RE.source}`
    );
  }
  return `.well-known/encryption/network/${name2}`;
}
var DEFAULT_ENCRYPTION_ALG = "x25519-aes256gcm/v1";
var ENVELOPE_VERSION = 1;
var DEFAULT_KEY_VERSION = 1;
var DECRYPT_FACT_TYPE = "tinycloud.encryption.decrypt/v1";
var DECRYPT_RESULT_TYPE = "tinycloud.encryption.decrypt-result/v1";
function defaultEncryptionMessage(input) {
  switch (input.code) {
    case "NETWORK_NOT_FOUND":
      return input.message ?? `Network not found: ${input.networkId ?? input.name ?? "<unknown>"}`;
    case "NETWORK_NOT_ACTIVE":
      return input.message ?? `Network not active (state=${input.state})`;
    case "INVALID_NETWORK_ID":
      return input.message;
    case "INVALID_ENVELOPE":
      return input.message;
    case "DECRYPT_DENIED":
      return input.message;
    case "INVALID_RESPONSE":
      return input.message;
    case "RESPONSE_SIGNATURE_INVALID":
      return input.message ?? "Node response signature failed to verify";
    case "RESPONSE_BINDING_MISMATCH":
      return input.message ?? `Node response binding mismatch on field ${JSON.stringify(input.field)}`;
    case "TRANSPORT_ERROR":
      return input.message ?? input.cause.message;
    case "INVALID_INPUT":
      return input.message;
  }
}
function encryptionError(input) {
  return {
    ...input,
    service: "encryption",
    message: defaultEncryptionMessage(input)
  };
}
function toError2(error) {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    return new Error(JSON.stringify(error));
  }
  return new Error(String(error));
}
async function discoverNetwork(input) {
  let networkId;
  let ownerDid;
  let name2;
  try {
    if (input.identifier.startsWith("urn:tinycloud:encryption:")) {
      const parsed = parseNetworkId(input.identifier);
      networkId = parsed.networkId;
      ownerDid = parsed.ownerDid;
      name2 = parsed.name;
    } else {
      if (input.ownerDid === void 0) {
        return {
          ok: false,
          error: encryptionError({
            code: "INVALID_INPUT",
            message: "discoverNetwork requires `ownerDid` when identifier is a bare network name"
          })
        };
      }
      networkId = `urn:tinycloud:encryption:${input.ownerDid}:${input.identifier}`;
      const parsed = parseNetworkId(networkId);
      ownerDid = parsed.ownerDid;
      name2 = parsed.name;
    }
  } catch (err3) {
    if (err3 instanceof NetworkIdError) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_NETWORK_ID",
          message: err3.message
        })
      };
    }
    throw err3;
  }
  if (input.node !== void 0) {
    try {
      const descriptor = await input.node.fetchByNetworkId(networkId);
      if (descriptor !== null) {
        const validated = validateDescriptor(descriptor, networkId, ownerDid, name2);
        if (!validated.ok) return validated;
        return { ok: true, data: { descriptor: validated.data, source: "node" } };
      }
    } catch (err3) {
    }
  }
  if (input.wellKnown !== void 0) {
    try {
      const descriptor = await input.wellKnown.fetchWellKnown(
        ownerDid,
        networkDiscoveryKey(name2)
      );
      if (descriptor !== null) {
        const validated = validateDescriptor(descriptor, networkId, ownerDid, name2);
        if (!validated.ok) return validated;
        return {
          ok: true,
          data: { descriptor: validated.data, source: "well-known" }
        };
      }
    } catch (err3) {
    }
  }
  return {
    ok: false,
    error: encryptionError({
      code: "NETWORK_NOT_FOUND",
      networkId,
      name: name2
    })
  };
}
function validateDescriptor(descriptor, networkId, ownerDid, name2) {
  let descriptorNetwork;
  try {
    descriptorNetwork = parseNetworkId(descriptor.networkId);
  } catch (err3) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: `descriptor networkId is malformed: ${err3 instanceof Error ? err3.message : String(err3)}`
      })
    };
  }
  if (descriptorNetwork.name !== name2 || !ownerDidMatches(descriptorNetwork.ownerDid, ownerDid)) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: `descriptor networkId ${JSON.stringify(descriptor.networkId)} does not match expected ${JSON.stringify(networkId)}`
      })
    };
  }
  const descriptorOwnerDid = descriptorOwner(descriptor);
  if (descriptorOwnerDid === void 0 || !ownerDidMatches(descriptorOwnerDid, ownerDid) || !ownerDidMatches(descriptorOwnerDid, descriptorNetwork.ownerDid)) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: "descriptor ownerDid does not match networkId ownerDid"
      })
    };
  }
  if (descriptor.name !== name2) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: "descriptor name does not match networkId name"
      })
    };
  }
  if (typeof descriptor.publicEncryptionKey !== "string" || descriptor.publicEncryptionKey.length === 0) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: "descriptor publicEncryptionKey must be a non-empty string"
      })
    };
  }
  return {
    ok: true,
    data: {
      ...descriptor,
      ownerDid: descriptorOwnerDid
    }
  };
}
function descriptorOwner(descriptor) {
  if (typeof descriptor.ownerDid === "string" && descriptor.ownerDid.length > 0) {
    return descriptor.ownerDid;
  }
  const legacyDescriptor = descriptor;
  return typeof legacyDescriptor.principal === "string" && legacyDescriptor.principal.length > 0 ? legacyDescriptor.principal : void 0;
}
function ensureNetworkUsableForDecrypt(descriptor) {
  if (descriptor.state === "active" || descriptor.state === "rotating") {
    return { ok: true, data: descriptor };
  }
  return {
    ok: false,
    error: encryptionError({
      code: "NETWORK_NOT_ACTIVE",
      state: descriptor.state
    })
  };
}
function encryptToNetwork(crypto22, input) {
  parseNetworkId(input.networkId);
  const alg = input.alg ?? DEFAULT_ENCRYPTION_ALG;
  const keyVersion = input.keyVersion ?? DEFAULT_KEY_VERSION;
  const symmetricKey = crypto22.randomBytes(32);
  const ciphertext = crypto22.authEncrypt(symmetricKey, input.plaintext, input.aad);
  const wrapped = crypto22.sealToNetworkKey(input.networkPublicKey, symmetricKey);
  const encryptedSymmetricKey = base64Encode2(wrapped);
  const encryptedSymmetricKeyHash = canonicalHashHex(
    crypto22.sha256,
    encryptedSymmetricKey
  );
  const envelope = {
    v: ENVELOPE_VERSION,
    networkId: input.networkId,
    alg,
    keyVersion,
    encryptedSymmetricKey,
    encryptedSymmetricKeyHash,
    ciphertext: base64Encode2(ciphertext),
    ...input.aad !== void 0 ? { aad: base64Encode2(input.aad) } : {},
    ...input.metadata !== void 0 ? { metadata: input.metadata } : {}
  };
  return { envelope, symmetricKey };
}
function validateEnvelope(crypto22, envelope) {
  if (envelope === null || typeof envelope !== "object") {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: "envelope must be an object"
      })
    };
  }
  const e = envelope;
  if (e.v !== ENVELOPE_VERSION) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: `envelope.v must be ${ENVELOPE_VERSION} (got ${e.v})`
      })
    };
  }
  try {
    parseNetworkId(e.networkId);
  } catch (err3) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: `envelope.networkId is malformed: ${err3 instanceof Error ? err3.message : String(err3)}`
      })
    };
  }
  for (const field of [
    "alg",
    "encryptedSymmetricKey",
    "encryptedSymmetricKeyHash",
    "ciphertext"
  ]) {
    if (typeof e[field] !== "string" || e[field].length === 0) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_ENVELOPE",
          message: `envelope.${field} must be a non-empty string`
        })
      };
    }
  }
  if (typeof e.keyVersion !== "number" || !Number.isInteger(e.keyVersion)) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: "envelope.keyVersion must be an integer"
      })
    };
  }
  const expectedHash = canonicalHashHex(crypto22.sha256, e.encryptedSymmetricKey);
  if (expectedHash !== e.encryptedSymmetricKeyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_ENVELOPE",
        message: "envelope.encryptedSymmetricKeyHash does not match canonical hash of encryptedSymmetricKey"
      })
    };
  }
  return { ok: true, data: e };
}
function decryptEnvelopeWithKey(crypto22, envelope, symmetricKey) {
  const ciphertext = base64Decode2(envelope.ciphertext);
  const aad = envelope.aad !== void 0 ? base64Decode2(envelope.aad) : void 0;
  return crypto22.authDecrypt(symmetricKey, ciphertext, aad);
}
function buildCanonicalDecryptRequest(input) {
  const canonicalBody = canonicalize(input.body);
  const bodyHash = canonicalHashHex(
    input.crypto.sha256,
    input.body
  );
  const receiverPublicKeyHash = canonicalHashHex(
    input.crypto.sha256,
    input.body.receiverPublicKey
  );
  return { canonicalBody, bodyHash, receiverPublicKeyHash };
}
function buildDecryptFacts(input) {
  const bodyHash = input.canonicalBody !== void 0 ? hexEncode2(input.crypto.sha256(utf8Encode(input.canonicalBody))) : canonicalHashHex(
    input.crypto.sha256,
    input.body
  );
  const receiverPublicKeyHash = canonicalHashHex(
    input.crypto.sha256,
    input.body.receiverPublicKey
  );
  return {
    type: DECRYPT_FACT_TYPE,
    targetNode: input.body.targetNode,
    networkId: input.body.networkId,
    bodyHash,
    encryptedSymmetricKeyHash: input.encryptedSymmetricKeyHash,
    receiverPublicKeyHash,
    alg: input.body.alg,
    keyVersion: input.body.keyVersion
  };
}
function checkDecryptInvocationInput(crypto22, input) {
  if (input.body.type !== DECRYPT_FACT_TYPE) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: `body.type must be ${DECRYPT_FACT_TYPE}`
      })
    };
  }
  if (input.facts.type !== DECRYPT_FACT_TYPE) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: `facts.type must be ${DECRYPT_FACT_TYPE}`
      })
    };
  }
  if (input.facts.targetNode !== input.targetNode) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.targetNode must equal targetNode \u2014 the UCAN audience binds the request to a single node"
      })
    };
  }
  if (input.body.targetNode !== input.targetNode) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "body.targetNode must equal targetNode"
      })
    };
  }
  if (input.facts.networkId !== input.networkId) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.networkId must equal networkId"
      })
    };
  }
  if (input.body.networkId !== input.networkId) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "body.networkId must equal networkId"
      })
    };
  }
  if (input.facts.alg !== input.body.alg) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.alg must equal body.alg"
      })
    };
  }
  if (input.facts.keyVersion !== input.body.keyVersion) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.keyVersion must equal body.keyVersion"
      })
    };
  }
  if (input.facts.encryptedSymmetricKeyHash !== input.body.encryptedSymmetricKeyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.encryptedSymmetricKeyHash must equal body.encryptedSymmetricKeyHash"
      })
    };
  }
  if (input.facts.receiverPublicKeyHash !== input.body.receiverPublicKeyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.receiverPublicKeyHash must equal body.receiverPublicKeyHash"
      })
    };
  }
  try {
    parseNetworkId(input.networkId);
  } catch (err3) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_NETWORK_ID",
        message: err3 instanceof Error ? err3.message : String(err3)
      })
    };
  }
  const canonicalBody = canonicalize(
    input.body
  );
  const expectedBodyHash = canonicalHashHex(crypto22.sha256, input.body);
  if (expectedBodyHash !== input.facts.bodyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_INPUT",
        message: "facts.bodyHash does not match the canonical body hash"
      })
    };
  }
  return { ok: true, data: input, canonicalBody };
}
async function buildDecryptInvocation(crypto22, signer, input) {
  const checked = checkDecryptInvocationInput(crypto22, input);
  if (!checked.ok) {
    return checked;
  }
  try {
    const built = await signer.signDecryptInvocation(checked.data);
    if (!built.authorization || !built.invocationCid) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_INPUT",
          message: "decrypt-invocation signer returned an empty authorization or invocationCid"
        })
      };
    }
    if (built.canonicalBody !== checked.canonicalBody) {
      return {
        ok: false,
        error: encryptionError({
          code: "INVALID_INPUT",
          message: "decrypt-invocation signer returned a canonicalBody that does not match the SDK's canonicalization \u2014 signer must use the SDK-provided body"
        })
      };
    }
    return { ok: true, data: built };
  } catch (err3) {
    return {
      ok: false,
      error: encryptionError({
        code: "TRANSPORT_ERROR",
        cause: err3 instanceof Error ? err3 : new Error(String(err3)),
        message: `failed to sign decrypt invocation: ${err3 instanceof Error ? err3.message : String(err3)}`
      })
    };
  }
}
function generateRandomReceiverKey(input) {
  const seed = input.crypto.randomBytes(32);
  return input.crypto.x25519FromSeed(seed);
}
function canonicalSignedResponse(response) {
  const { nodeSignature: _drop, ...rest } = response;
  return canonicalize(rest);
}
function verifyDecryptResponse(input) {
  const { crypto: crypto22, request, facts, invocationCid, requestBodyHash, response } = input;
  if (response.type !== DECRYPT_RESULT_TYPE) {
    return {
      ok: false,
      error: encryptionError({
        code: "INVALID_RESPONSE",
        message: `response.type must be ${DECRYPT_RESULT_TYPE}`
      })
    };
  }
  if (response.targetNode !== request.targetNode) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "targetNode"
      })
    };
  }
  if (response.networkId !== request.networkId) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "networkId"
      })
    };
  }
  if (response.nodeId !== request.targetNode) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "nodeId"
      })
    };
  }
  if (response.alg !== request.alg) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "alg"
      })
    };
  }
  if (response.keyVersion !== request.keyVersion) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "keyVersion"
      })
    };
  }
  if (response.encryptedSymmetricKeyHash !== request.encryptedSymmetricKeyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "encryptedSymmetricKeyHash"
      })
    };
  }
  if (response.receiverPublicKeyHash !== request.receiverPublicKeyHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "receiverPublicKeyHash"
      })
    };
  }
  if (response.invocationCid !== invocationCid) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "invocationCid"
      })
    };
  }
  const expectedRequestHash = hexEncode2(
    crypto22.sha256(utf8Encode(`${invocationCid}${requestBodyHash}`))
  );
  if (response.requestHash !== expectedRequestHash) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "requestHash"
      })
    };
  }
  if (facts.encryptedSymmetricKeyHash !== response.encryptedSymmetricKeyHash || facts.receiverPublicKeyHash !== response.receiverPublicKeyHash || facts.networkId !== response.networkId || facts.targetNode !== response.targetNode || facts.alg !== response.alg || facts.keyVersion !== response.keyVersion) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_BINDING_MISMATCH",
        field: "facts"
      })
    };
  }
  const signedBytes = new TextEncoder().encode(
    canonicalSignedResponse(response)
  );
  const signatureBytes = base64Decode2(response.nodeSignature);
  if (!crypto22.verifyNodeSignature(response.nodeId, signedBytes, signatureBytes)) {
    return {
      ok: false,
      error: encryptionError({
        code: "RESPONSE_SIGNATURE_INVALID"
      })
    };
  }
  return { ok: true, data: response };
}
function openWrappedKey(crypto22, receiverPrivateKey, response) {
  const wrapped = base64Decode2(response.wrappedKey);
  return crypto22.openWithReceiverKey(receiverPrivateKey, wrapped);
}
function encOk(data) {
  return { ok: true, data };
}
function encErr(error) {
  return { ok: false, error };
}
var EncryptionService = class extends BaseService {
  constructor(config) {
    super();
    this._config = config;
  }
  get config() {
    return this._config;
  }
  get crypto() {
    return this._config.crypto;
  }
  async discoverNetwork(identifier, ownerDid) {
    this.assertActive();
    const result = await discoverNetwork({
      identifier,
      ...ownerDid !== void 0 ? { ownerDid } : {},
      ...this._config.node !== void 0 ? { node: this._config.node } : {},
      ...this._config.wellKnown !== void 0 ? { wellKnown: this._config.wellKnown } : {}
    });
    this.assertActive();
    if (!result.ok) return result;
    return encOk(result.data.descriptor);
  }
  async encryptToNetwork(networkId, plaintext, options) {
    try {
      this.assertActive();
      const discovered = await this.discoverNetwork(networkId);
      if (!discovered.ok) return discovered;
      const usable = ensureNetworkUsableForDecrypt(discovered.data);
      if (!usable.ok) return usable;
      const descriptor = usable.data;
      const networkPublicKey = base64Decode2(descriptor.publicEncryptionKey);
      const result = encryptToNetwork(this.crypto, {
        networkId,
        networkPublicKey,
        plaintext,
        ...options?.aad !== void 0 ? { aad: options.aad } : {},
        alg: options?.alg ?? descriptor.alg,
        keyVersion: options?.keyVersion ?? descriptor.keyVersion,
        ...options?.metadata !== void 0 ? { metadata: options.metadata } : {}
      });
      return encOk(result.envelope);
    } catch (error) {
      return encErr(
        encryptionError({
          code: "TRANSPORT_ERROR",
          cause: toError2(error)
        })
      );
    }
  }
  async decryptEnvelope(envelope, capabilityProof, options) {
    try {
      this.assertActive();
      const validated = validateEnvelope(this.crypto, envelope);
      if (!validated.ok) return validated;
      if (options?.aad !== void 0 && validated.data.aad !== base64Encode2(options.aad)) {
        return encErr(
          encryptionError({
            code: "INVALID_INPUT",
            message: "decryptEnvelope aad does not match the envelope"
          })
        );
      }
      let descriptor;
      if (options?.descriptor !== void 0) {
        descriptor = options.descriptor;
      } else {
        const discovered = await this.discoverNetwork(envelope.networkId);
        if (!discovered.ok) return discovered;
        descriptor = discovered.data;
      }
      const usable = ensureNetworkUsableForDecrypt(descriptor);
      if (!usable.ok) return usable;
      const targetNode = options?.targetNode ?? descriptor.members[0]?.nodeId;
      if (targetNode === void 0) {
        return encErr(
          encryptionError({
            code: "INVALID_INPUT",
            message: "no target node available from descriptor"
          })
        );
      }
      const receiverKey = generateRandomReceiverKey({ crypto: this.crypto });
      const receiverPublicKey = base64Encode2(receiverKey.publicKey);
      const receiverPublicKeyHash = canonicalHashHex(
        this.crypto.sha256,
        receiverPublicKey
      );
      const body = {
        type: DECRYPT_FACT_TYPE,
        targetNode,
        networkId: envelope.networkId,
        alg: envelope.alg,
        keyVersion: envelope.keyVersion,
        encryptedSymmetricKey: envelope.encryptedSymmetricKey,
        encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
        receiverPublicKey,
        receiverPublicKeyHash
      };
      const canonicalRequest = buildCanonicalDecryptRequest({
        crypto: this.crypto,
        body,
        receiverPublicKey: receiverKey.publicKey
      });
      const facts = buildDecryptFacts({
        crypto: this.crypto,
        body,
        encryptedSymmetricKeyHash: envelope.encryptedSymmetricKeyHash,
        receiverPublicKey: receiverKey.publicKey,
        canonicalBody: canonicalRequest.canonicalBody
      });
      const built = await buildDecryptInvocation(this.crypto, this._config.signer, {
        targetNode,
        networkId: envelope.networkId,
        body,
        facts,
        proof: capabilityProof
      });
      this.assertActive();
      if (!built.ok) {
        if (built.error.code !== "TRANSPORT_ERROR") return built;
        return encErr(
          encryptionError({
            code: "INVALID_INPUT",
            message: "Unable to build decrypt request"
          })
        );
      }
      let response;
      try {
        response = await this._config.transport.postDecrypt({
          targetNode,
          networkId: envelope.networkId,
          authorization: built.data.authorization,
          canonicalBody: built.data.canonicalBody,
          signal: this.abortSignal
        });
        this.assertActive();
      } catch (error) {
        if (error instanceof import_decrypt_transport_response_error.DecryptTransportResponseError) {
          return encErr(
            encryptionError(
              error.status === 401 || error.status === 403 ? {
                code: "DECRYPT_DENIED",
                message: "Node denied decrypt request",
                ...error.permissionHint === void 0 ? {} : { permissionHint: error.permissionHint }
              } : { code: "INVALID_RESPONSE", message: "Node decrypt request failed" }
            )
          );
        }
        return encErr(
          encryptionError({
            code: "TRANSPORT_ERROR",
            cause: toError2(error)
          })
        );
      }
      const verified = verifyDecryptResponse({
        crypto: this.crypto,
        request: body,
        facts,
        invocationCid: built.data.invocationCid,
        requestBodyHash: facts.bodyHash,
        response
      });
      if (!verified.ok) return verified;
      const symmetricKey = openWrappedKey(
        this.crypto,
        receiverKey.privateKey,
        verified.data
      );
      const plaintext = decryptEnvelopeWithKey(
        this.crypto,
        envelope,
        symmetricKey
      );
      return encOk(plaintext);
    } catch (error) {
      return encErr(
        encryptionError({
          code: "INVALID_RESPONSE",
          message: "Local decryption failed"
        })
      );
    }
  }
  assertActive() {
    this._config.assertActive?.();
  }
};
EncryptionService.serviceName = "encryption";

// ../sdk-core/src/manifest.ts
var DEFAULT_KNOWLEDGE_ROOT = "knowledge/index.md";
var ManifestValidationError = class extends Error {
  constructor(message) {
    super(`Manifest validation failed: ${message}`);
    this.name = "ManifestValidationError";
  }
};
var DEFAULT_EXPIRY = "30d";
var DEFAULT_DEFAULTS = true;
var DEFAULT_MANIFEST_VERSION = 1;
var DEFAULT_MANIFEST_SPACE2 = "applications";
var SECRETS_SPACE2 = "secrets";
var VAULT_PERMISSION_SERVICE2 = "tinycloud.vault";
var SERVICE_SHORT_TO_LONG = Object.freeze({
  kv: "tinycloud.kv",
  sql: "tinycloud.sql",
  duckdb: "tinycloud.duckdb",
  capabilities: "tinycloud.capabilities",
  hooks: "tinycloud.hooks",
  encryption: "tinycloud.encryption",
  delegation: "tinycloud.delegation"
});
var ENCRYPTION_PERMISSION_SERVICE2 = "tinycloud.encryption";
var ENCRYPTION_MANIFEST_SPACE2 = "encryption";
var SERVICE_LONG_TO_SHORT = Object.freeze(
  Object.fromEntries(
    Object.entries(SERVICE_SHORT_TO_LONG).map(([s, l]) => [l, s])
  )
);
var DEFAULT_STANDARD_ENTRIES = [
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE2,
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"]
  },
  {
    service: "tinycloud.sql",
    space: DEFAULT_MANIFEST_SPACE2,
    path: "/",
    actions: ["read", "write"]
  }
];
var DEFAULT_ADMIN_ENTRIES = [
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE2,
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"]
  },
  {
    service: "tinycloud.sql",
    space: DEFAULT_MANIFEST_SPACE2,
    path: "/",
    actions: ["read", "write", "schema"]
  }
];
var DEFAULT_ALL_ENTRIES = [
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE2,
    path: "/",
    actions: ["get", "put", "del", "list", "metadata"]
  },
  {
    service: "tinycloud.sql",
    space: DEFAULT_MANIFEST_SPACE2,
    path: "/",
    actions: ["read", "write", "schema"]
  },
  {
    service: "tinycloud.duckdb",
    space: DEFAULT_MANIFEST_SPACE2,
    path: "/",
    actions: ["read", "write"]
  }
];
function parseExpiry(duration) {
  if (typeof duration !== "string" || duration.length === 0) {
    throw new ManifestValidationError(
      `expiry must be a non-empty duration string (got ${JSON.stringify(duration)})`
    );
  }
  const parsed = (0, import_ms.default)(duration);
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new ManifestValidationError(
      `invalid expiry duration: ${JSON.stringify(duration)}`
    );
  }
  return parsed;
}
function expandActionShortNames(service, actions) {
  return actions.map((a) => {
    if (a.includes("/")) {
      return a;
    }
    return `${service}/${a}`;
  });
}
function expandPermissionEntry2(entry) {
  if (entry.service === ENCRYPTION_PERMISSION_SERVICE2) {
    return expandEncryptionPermissionEntry(entry);
  }
  if (entry.service !== VAULT_PERMISSION_SERVICE2) {
    return [
      {
        ...entry,
        actions: expandActionShortNames(entry.service, entry.actions)
      }
    ];
  }
  return expandVaultPermissionEntry(entry);
}
function expandEncryptionPermissionEntry(entry) {
  if (typeof entry.path !== "string" || !entry.path.startsWith("urn:tinycloud:encryption:")) {
    throw new ManifestValidationError(
      `tinycloud.encryption entries require path to be a networkId URN (got ${JSON.stringify(entry.path)})`
    );
  }
  const normalizedActions = [];
  for (const action of entry.actions) {
    if (action === "decrypt" || action === "tinycloud.encryption/decrypt") {
      normalizedActions.push("tinycloud.encryption/decrypt");
      continue;
    }
    if (action === "network.create" || action === "tinycloud.encryption/network.create") {
      normalizedActions.push("tinycloud.encryption/network.create");
      continue;
    }
    if (action === "network.revoke" || action === "tinycloud.encryption/network.revoke") {
      normalizedActions.push("tinycloud.encryption/network.revoke");
      continue;
    }
    if (action.includes("/")) {
      throw new ManifestValidationError(
        `unknown encryption action ${JSON.stringify(action)}; expected decrypt, network.create, or network.revoke`
      );
    }
    throw new ManifestValidationError(
      `unknown encryption action ${JSON.stringify(action)}; expected decrypt, network.create, or network.revoke`
    );
  }
  const dedupedActions = [];
  const seen = /* @__PURE__ */ new Set();
  for (const a of normalizedActions) {
    if (!seen.has(a)) {
      dedupedActions.push(a);
      seen.add(a);
    }
  }
  return [
    {
      service: ENCRYPTION_PERMISSION_SERVICE2,
      space: ENCRYPTION_MANIFEST_SPACE2,
      path: entry.path,
      actions: dedupedActions,
      skipPrefix: true,
      ...entry.expiry !== void 0 ? { expiry: entry.expiry } : {},
      ...entry.description !== void 0 ? { description: entry.description } : {}
    }
  ];
}
function applyPrefix2(prefix, path, skipPrefix) {
  if (skipPrefix) {
    return path;
  }
  if (prefix === "") {
    return path;
  }
  if (path.startsWith("/")) {
    return `${prefix}${path}`;
  }
  return `${prefix}/${path}`;
}
function validateManifest(input) {
  if (input === null || typeof input !== "object") {
    throw new ManifestValidationError("manifest must be an object");
  }
  const m = input;
  if (m.manifest_version !== void 0 && m.manifest_version !== DEFAULT_MANIFEST_VERSION) {
    throw new ManifestValidationError(
      `manifest.manifest_version must be ${DEFAULT_MANIFEST_VERSION}`
    );
  }
  if (typeof m.app_id !== "string" || m.app_id.length === 0) {
    throw new ManifestValidationError(
      "manifest.app_id is required and must be a non-empty string"
    );
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new ManifestValidationError(
      "manifest.name is required and must be a non-empty string"
    );
  }
  if (m.did !== void 0 && (typeof m.did !== "string" || m.did.length === 0)) {
    throw new ManifestValidationError(
      "manifest.did must be a non-empty DID string"
    );
  }
  if (m.space !== void 0 && (typeof m.space !== "string" || m.space.length === 0)) {
    throw new ManifestValidationError(
      "manifest.space must be a non-empty string"
    );
  }
  if (m.expiry !== void 0) {
    parseExpiry(m.expiry);
  }
  if (m.knowledge !== void 0) {
    resolveManifestKnowledgeRoot(m.knowledge);
  }
  if (m.permissions !== void 0) {
    if (!Array.isArray(m.permissions)) {
      throw new ManifestValidationError(
        "manifest.permissions must be an array"
      );
    }
    m.permissions.forEach(
      (p, i) => validatePermissionEntry(p, `permissions[${i}]`)
    );
  }
  if (m.secrets !== void 0) {
    validateManifestSecrets(m.secrets);
  }
  return m;
}
function resolveManifestKnowledgeRoot(knowledge) {
  if (knowledge === void 0) {
    return void 0;
  }
  if (knowledge === true) {
    return DEFAULT_KNOWLEDGE_ROOT;
  }
  if (typeof knowledge !== "string" || knowledge.length === 0) {
    throw new ManifestValidationError(
      "manifest.knowledge must be true or a knowledge/*.md root path"
    );
  }
  if (!/^knowledge\/.+\.md$/.test(knowledge)) {
    throw new ManifestValidationError(
      "manifest.knowledge must be true or a knowledge/*.md root path"
    );
  }
  return knowledge;
}
function validateManifestSecrets(secrets) {
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new ManifestValidationError("manifest.secrets must be an object");
  }
  for (const [name2, spec] of Object.entries(secrets)) {
    if (!SECRET_NAME_RE.test(name2)) {
      throw new ManifestValidationError(
        `manifest.secrets.${name2} must match ${SECRET_NAME_RE.source}`
      );
    }
    try {
      resolveSecretPath(
        secretNameFromSpec(name2, spec),
        { scope: secretScopeFromSpec(spec) }
      );
    } catch (error) {
      throw new ManifestValidationError(
        `manifest.secrets.${name2}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const actions = secretActionsFromSpec(name2, spec);
    if (actions.length === 0) {
      throw new ManifestValidationError(
        `manifest.secrets.${name2} actions must be non-empty`
      );
    }
    for (const action of actions) {
      if (typeof action !== "string" || action.length === 0) {
        throw new ManifestValidationError(
          `manifest.secrets.${name2} actions must be non-empty strings`
        );
      }
    }
    if (spec !== null && typeof spec === "object" && !Array.isArray(spec) && spec.expiry !== void 0) {
      parseExpiry(spec.expiry);
    }
  }
}
function validatePermissionEntry(p, path) {
  if (p === null || typeof p !== "object") {
    throw new ManifestValidationError(`${path} must be an object`);
  }
  const entry = p;
  if (typeof entry.service !== "string" || entry.service.length === 0) {
    throw new ManifestValidationError(`${path}.service is required`);
  }
  if (entry.space !== void 0 && (typeof entry.space !== "string" || entry.space.length === 0)) {
    throw new ManifestValidationError(
      `${path}.space must be a non-empty string`
    );
  }
  if (typeof entry.path !== "string") {
    throw new ManifestValidationError(
      `${path}.path is required (use "" or "/" for root)`
    );
  }
  if (!Array.isArray(entry.actions) || entry.actions.length === 0) {
    throw new ManifestValidationError(
      `${path}.actions must be a non-empty array`
    );
  }
  for (const action of entry.actions) {
    if (typeof action !== "string" || action.length === 0) {
      throw new ManifestValidationError(
        `${path}.actions must contain non-empty strings`
      );
    }
    if (entry.service === VAULT_PERMISSION_SERVICE2) {
      vaultActionExpansion(action);
    }
  }
  if (entry.caveats !== void 0 && (!Array.isArray(entry.caveats) || entry.caveats.some(
    (caveat) => caveat === null || typeof caveat !== "object" || Array.isArray(caveat)
  ))) {
    throw new ManifestValidationError(`${path}.caveats must be an array of objects`);
  }
  if (entry.expiry !== void 0) {
    parseExpiry(entry.expiry);
  }
}
function normalizeDefaults(value) {
  if (value === void 0) {
    return DEFAULT_DEFAULTS;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "admin" || normalized === "all") {
    return normalized;
  }
  return true;
}
function defaultEntriesForTier(tier) {
  if (tier === false) {
    return [];
  }
  const source = tier === "admin" ? DEFAULT_ADMIN_ENTRIES : tier === "all" ? DEFAULT_ALL_ENTRIES : DEFAULT_STANDARD_ENTRIES;
  return source.map((e) => ({
    service: e.service,
    space: e.space,
    path: e.path,
    actions: [...e.actions],
    ...e.skipPrefix !== void 0 ? { skipPrefix: e.skipPrefix } : {}
  }));
}
function resolveManifest(input) {
  const manifest = validateManifest(input);
  const prefix = manifest.prefix !== void 0 ? manifest.prefix : manifest.app_id;
  const space = manifest.space ?? DEFAULT_MANIFEST_SPACE2;
  const expiryMs = parseExpiry(manifest.expiry ?? DEFAULT_EXPIRY);
  const includePublicSpace = manifest.includePublicSpace ?? true;
  const tier = normalizeDefaults(manifest.defaults);
  const defaultEntries = defaultEntriesForTier(tier);
  const explicitEntries = manifest.permissions ?? [];
  const secretEntries = secretEntriesForManifest(manifest.secrets);
  const allEntries = [
    ...defaultEntries,
    ...explicitEntries,
    ...secretEntries
  ];
  const resources = withCapabilitiesReadForSpaces2(
    allEntries.flatMap((entry) => resolveEntry(entry, prefix, expiryMs, space))
  );
  const additionalDelegates = manifest.did === void 0 ? [] : [
    {
      did: manifest.did,
      name: manifest.name,
      expiryMs,
      permissions: resources.map(cloneResourceCapability)
    }
  ];
  return {
    app_id: manifest.app_id,
    ...manifest.did !== void 0 ? { did: manifest.did } : {},
    space,
    resources,
    expiryMs,
    includePublicSpace,
    additionalDelegates
  };
}
function normalizeSecretActions(actions) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (action) => {
    if (!seen.has(action)) {
      out.push(action);
      seen.add(action);
    }
  };
  for (const action of actions) {
    if (action === "read") {
      add("get");
      continue;
    }
    if (action === "write") {
      add("put");
      continue;
    }
    if (action === "delete") {
      add("del");
      continue;
    }
    if (action === "get" || action === "put" || action === "del" || action === "list" || action === "metadata") {
      add(action);
      continue;
    }
    if (action === "tinycloud.kv/get" || action === "tinycloud.kv/put" || action === "tinycloud.kv/del" || action === "tinycloud.kv/list" || action === "tinycloud.kv/metadata") {
      add(action);
      continue;
    }
    throw new ManifestValidationError(
      `unknown secret action ${JSON.stringify(action)}; expected read, write, delete, list, or metadata`
    );
  }
  return out;
}
function secretNameFromSpec(fallbackName, spec) {
  if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
    return spec.name ?? fallbackName;
  }
  return fallbackName;
}
function secretScopeFromSpec(spec) {
  if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
    return spec.scope;
  }
  return void 0;
}
function secretActionsFromSpec(name2, spec) {
  if (spec === true) {
    return ["read"];
  }
  if (typeof spec === "string") {
    return [spec];
  }
  if (Array.isArray(spec)) {
    return spec;
  }
  if (spec === null || typeof spec !== "object") {
    throw new ManifestValidationError(
      `manifest.secrets.${name2} must be true, a string action, an actions array, or an object`
    );
  }
  if (spec.actions === void 0) {
    return ["read"];
  }
  if (typeof spec.actions === "string") {
    return [spec.actions];
  }
  if (Array.isArray(spec.actions)) {
    return spec.actions;
  }
  throw new ManifestValidationError(
    `manifest.secrets.${name2}.actions must be a string or array`
  );
}
function secretEntriesForManifest(secrets) {
  if (secrets === void 0) {
    return [];
  }
  const entries = [];
  for (const [name2, spec] of Object.entries(secrets)) {
    const actions = secretActionsFromSpec(name2, spec);
    const secretPath = resolveSecretPath(
      secretNameFromSpec(name2, spec),
      { scope: secretScopeFromSpec(spec) }
    );
    const extra = spec !== true && typeof spec === "object" && !Array.isArray(spec) ? spec : {};
    entries.push({
      service: VAULT_PERMISSION_SERVICE2,
      space: SECRETS_SPACE2,
      path: secretPath.vaultKey,
      actions: normalizeSecretActions(actions),
      skipPrefix: true,
      ...extra.expiry !== void 0 ? { expiry: extra.expiry } : {},
      ...extra.description !== void 0 ? { description: extra.description } : {}
    });
  }
  return entries;
}
function resolveEntry(entry, prefix, _inheritedExpiryMs, inheritedSpace) {
  const skipPrefixForEntry = entry.skipPrefix === true || entry.service === ENCRYPTION_PERMISSION_SERVICE2;
  const resolvedPath = applyPrefix2(prefix, entry.path, skipPrefixForEntry);
  const entryExpiryMs = entry.expiry !== void 0 ? parseExpiry(entry.expiry) : void 0;
  return expandPermissionEntry2({
    ...entry,
    space: entry.space ?? inheritedSpace,
    path: resolvedPath,
    skipPrefix: true
  }).map((expanded) => ({
    service: expanded.service,
    space: expanded.space ?? inheritedSpace,
    path: expanded.path,
    actions: expanded.actions,
    // Only populate `expiryMs` when the entry had its own expiry override.
    // When absent, callers use the parent (delegation or manifest) expiry
    // which is carried on ResolvedDelegate.expiryMs / ResolvedCapabilities.expiryMs.
    ...entryExpiryMs !== void 0 ? { expiryMs: entryExpiryMs } : {},
    ...entry.description !== void 0 ? { description: entry.description } : {}
  }));
}
function expandVaultPermissionEntry(entry) {
  const byBase = /* @__PURE__ */ new Map();
  for (const action of entry.actions) {
    const expansion = vaultActionExpansion(action);
    for (const base3 of expansion.bases) {
      const actions = byBase.get(base3) ?? [];
      if (!actions.includes(expansion.action)) {
        actions.push(expansion.action);
      }
      byBase.set(base3, actions);
    }
  }
  return [...byBase.entries()].map(([base3, actions]) => ({
    ...entry,
    service: "tinycloud.kv",
    path: vaultKVPath(base3, entry.path),
    actions,
    skipPrefix: true
  }));
}
function vaultActionExpansion(action) {
  const normalized = normalizeVaultAction(action);
  if (normalized === "read" || normalized === "get") {
    return { bases: ["vault"], action: "tinycloud.kv/get" };
  }
  if (normalized === "write" || normalized === "put") {
    return { bases: ["vault"], action: "tinycloud.kv/put" };
  }
  if (normalized === "delete" || normalized === "del") {
    return { bases: ["vault"], action: "tinycloud.kv/del" };
  }
  if (normalized === "list") {
    return { bases: ["vault"], action: "tinycloud.kv/list" };
  }
  if (normalized === "head") {
    return { bases: ["vault"], action: "tinycloud.kv/get" };
  }
  if (normalized === "metadata") {
    return { bases: ["vault"], action: "tinycloud.kv/metadata" };
  }
  throw new ManifestValidationError(
    `unknown vault action ${JSON.stringify(action)}; expected read, write, delete, get, put, del, list, head, or metadata`
  );
}
function normalizeVaultAction(action) {
  if (action.startsWith(`${VAULT_PERMISSION_SERVICE2}/`)) {
    return action.slice(`${VAULT_PERMISSION_SERVICE2}/`.length);
  }
  if (action.startsWith("tinycloud.kv/")) {
    return action.slice("tinycloud.kv/".length);
  }
  if (action.includes("/")) {
    throw new ManifestValidationError(
      `unknown vault action ${JSON.stringify(action)}; expected a tinycloud.vault or tinycloud.kv action`
    );
  }
  return action;
}
function vaultKVPath(base3, path) {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return `${base3}/${normalized}`;
}
function cloneResourceCapability(entry) {
  return {
    service: entry.service,
    space: entry.space,
    path: entry.path,
    actions: [...entry.actions],
    ...entry.expiryMs !== void 0 ? { expiryMs: entry.expiryMs } : {},
    ...entry.description !== void 0 ? { description: entry.description } : {}
  };
}
function dedupeResources2(resources) {
  const byKey = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    const key = `${resource.service}\0${resource.space}\0${resource.path}\0${resource.expiryMs ?? ""}`;
    const existing = byKey.get(key);
    if (existing === void 0) {
      byKey.set(key, cloneResourceCapability(resource));
      continue;
    }
    const seen = new Set(existing.actions);
    for (const action of resource.actions) {
      if (!seen.has(action)) {
        existing.actions.push(action);
        seen.add(action);
      }
    }
    if (existing.description === void 0 && resource.description !== void 0) {
      existing.description = resource.description;
    }
  }
  return [...byKey.values()];
}
function capabilitiesReadPermission(space) {
  return {
    service: "tinycloud.capabilities",
    space,
    path: "",
    actions: ["tinycloud.capabilities/read"]
  };
}
function withCapabilitiesReadForSpaces2(resources) {
  if (resources.length === 0) {
    return [];
  }
  const spaces = new Set(
    resources.filter((resource) => resource.service !== ENCRYPTION_PERMISSION_SERVICE2).map((resource) => resource.space)
  );
  return dedupeResources2([
    ...resources,
    ...[...spaces].map(capabilitiesReadPermission)
  ]);
}

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
function makePkhSpaceId(address, chainId, name2) {
  return `tinycloud:pkh:eip155:${chainId}:${canonicalizeAddress(address)}:${name2}`;
}
function parseSpaceUri(input) {
  if (!input.startsWith("tinycloud:")) return null;
  const parts = input.split(":");
  if (parts.length < 3) return null;
  const name2 = parts.at(-1);
  if (!name2) return null;
  return {
    owner: parts.slice(1, -1).join(":"),
    name: name2
  };
}
function buildSpaceUri(owner, name2) {
  return `tinycloud:${owner}:${name2}`;
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

// src/lib/permissions.ts
function isCompatiblePermissionRequestArtifact(value) {
  return isPermissionRequestArtifact(value) || isNodeSdkAuthRequestArtifact(value);
}
function isNodeSdkAuthRequestArtifact(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  return candidate.kind === "tinycloud.auth.request" && candidate.version === 1 && typeof candidate.requestId === "string" && Array.isArray(candidate.requested);
}
function additionalDelegationsPath(profile) {
  return sharedAdditionalDelegationsPath(profile);
}
function permissionRequestsPath(profile) {
  return sharedAuthRequestsPath(profile);
}
function grantHistoryPath(profile) {
  return join3(PROFILES_DIR, profile, "auth-grants.jsonl");
}
function createPermissionRequestArtifact(params) {
  return buildPermissionRequestArtifact({
    profile: params.profileName,
    posture: resolveProfilePosture(params.profile),
    operatorType: resolveProfileOperatorType(params.profile),
    host: params.host,
    sessionDid: didWithoutFragment(params.profile.sessionDid ?? params.profile.did),
    ownerDid: params.profile.ownerDid,
    spaceId: params.profile.spaceId,
    requestedExpiry: params.requestedExpiry,
    missing: params.requested,
    command: {
      argv: params.argv ?? process.argv.slice(2),
      cwd: params.cwd ?? process.cwd()
    }
  });
}
function didWithoutFragment(did) {
  const fragment = did.indexOf("#");
  return fragment === -1 ? did : did.slice(0, fragment);
}
async function loadAdditionalDelegations(profile) {
  return readAdditionalDelegations(profile);
}
async function appendAdditionalDelegation(profile, entry) {
  await upsertProfileRecord(
    profile,
    "additional-delegations",
    entry.delegation.cid,
    entry,
    (candidate) => candidate.delegation.cid
  );
}
async function loadPermissionRequestArtifacts(profile) {
  const raw = await readAuthRequests(profile);
  return raw.filter(isCompatiblePermissionRequestArtifact);
}
async function appendPermissionRequestArtifact(profile, artifact) {
  await withProfileLock(profile, async () => {
    const existing = (await readAuthRequests(profile)).filter(isCompatiblePermissionRequestArtifact);
    const next = existing.filter((item) => item.requestId !== artifact.requestId);
    next.push(artifact);
    await writeSharedRecords(profile, "auth-requests", next);
  });
}
async function writeSharedRecords(profile, store, entries) {
  const path = store === "additional-delegations" ? additionalDelegationsPath(profile) : permissionRequestsPath(profile);
  await writeJsonAtomic(path, entries);
  await writeJsonAtomic(profileStoreMetadataPath(profile, store), { formatVersion: 1 });
}
async function getPermissionRequestArtifact(profile, requestId) {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.find((item) => item.requestId === requestId) ?? null;
}
async function getLastPermissionRequestArtifact(profile) {
  const existing = await loadPermissionRequestArtifacts(profile);
  return existing.at(-1) ?? null;
}
async function replayAdditionalDelegations(node, profile) {
  const entries = await loadAdditionalDelegations(profile);
  for (const entry of entries) {
    const expiry = entry.delegation.expiry instanceof Date ? entry.delegation.expiry : new Date(entry.delegation.expiry);
    if (expiry.getTime() <= Date.now()) continue;
    try {
      await node.useRuntimeDelegation({ ...entry.delegation, expiry });
    } catch (err2) {
      if (process.env.TC_DEBUG_REPLAY === "1") {
        process.stderr.write(`[replay] skipping ${entry.delegation.cid}: ${err2.message}
`);
      }
    }
  }
}
function storedAdditionalDelegation(delegation, permissions) {
  return { delegation, permissions };
}
async function appendGrantHistory(profile, entry) {
  const profileDir = join3(PROFILES_DIR, profile);
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
  const actions = expandActionShortNames(
    service,
    actionsCsv.split(",").map((action) => action.trim()).filter(Boolean)
  );
  if (actions.length === 0) {
    throw new CLIError("INVALID_CAP", `Capability "${spec}" has no actions.`, ExitCode.USAGE_ERROR);
  }
  return (await resolvePermissionSpaces([
    { service, space, path, actions }
  ], profile))[0];
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
    permissions.push(...await secretPermissionsFromAppManifest(manifest, profile));
    return resolvePermissionSpaces(permissions, profile);
  }
  throw new CLIError(
    "INVALID_MANIFEST",
    'Manifest must contain either SDK field "id" or app manifest field "app_id".',
    ExitCode.USAGE_ERROR
  );
}
async function secretPermissionsFromAppManifest(manifest, profile) {
  if (manifest.secrets === void 0) {
    return [];
  }
  const resolved = resolveManifest({
    app_id: String(manifest.app_id),
    name: typeof manifest.name === "string" ? manifest.name : String(manifest.app_id),
    defaults: false,
    prefix: "",
    secrets: manifest.secrets
  });
  const permissions = resolved.resources.filter(
    (resource) => resource.service === "tinycloud.kv" && resource.space === "secrets" && resource.path.startsWith("vault/secrets/")
  );
  const needsDecrypt = permissions.some(
    (permission) => permission.actions.includes("tinycloud.kv/get")
  );
  if (needsDecrypt) {
    permissions.push({
      service: ENCRYPTION_PERMISSION_SERVICE2,
      space: ENCRYPTION_MANIFEST_SPACE2,
      path: await defaultSecretsNetworkId(profile),
      actions: ["tinycloud.encryption/decrypt"],
      skipPrefix: true
    });
  }
  return permissions;
}
async function defaultSecretsNetworkId(profileName) {
  const profile = await ProfileManager.getProfile(profileName);
  const ownerDid = (profile.ownerDid ?? profile.did)?.split("#")[0];
  if (!ownerDid) {
    throw new CLIError(
      "OWNER_DID_UNKNOWN",
      `Cannot determine owner DID for profile "${profileName}". Run \`tc auth login\` first.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  return `urn:tinycloud:encryption:${ownerDid}:default`;
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
  const profileConfig = await ProfileManager.getProfile(profile);
  const allowLogicalSpaces = resolveProfilePosture(profileConfig) === "delegate-session";
  const resolved = [];
  for (const entry of entries) {
    const service = normalizeService(entry.service);
    let space;
    try {
      space = await resolveSpaceUri(entry.space, profile) ?? entry.space;
    } catch (error) {
      if (!allowLogicalSpaces || entry.space.startsWith("tinycloud:") || !(error instanceof CLIError) || error.code !== "ADDRESS_UNKNOWN") {
        throw error;
      }
      space = entry.space;
    }
    resolved.push({
      ...entry,
      service,
      space,
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
  if (!key && !effectivePrivateKey) {
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
      jwk: signerJwkForProfile(ctx.profile, session.jwk, key),
      verificationMethod: session.verificationMethod ?? profile?.did,
      address: session.address,
      chainId: session.chainId,
      siwe: session.siwe,
      signature: session.signature
    });
  }
  await replayAdditionalDelegations(node, ctx.profile);
  return node;
}
async function bootstrapDelegatedSession(ctx, delegation) {
  const profile = await ProfileManager.getProfile(ctx.profile);
  if (resolveProfilePosture(profile) !== "delegate-session") {
    throw new CLIError(
      "AUTH_REQUIRED",
      `Profile "${ctx.profile}" is not a delegate-session profile.`,
      ExitCode.AUTH_REQUIRED
    );
  }
  const sessionDid = profile.sessionDid ?? profile.did;
  if (delegation.delegateDID.split("#", 1)[0] !== sessionDid.split("#", 1)[0]) {
    throw new CLIError(
      "DELEGATION_AUDIENCE_MISMATCH",
      `Delegation targets ${delegation.delegateDID}, but profile "${ctx.profile}" uses ${sessionDid}.`,
      ExitCode.PERMISSION_DENIED
    );
  }
  const key = await ProfileManager.getKey(ctx.profile);
  const jwk = signerJwkForProfile(ctx.profile, void 0, key);
  await ProfileManager.setSession(ctx.profile, {
    delegationHeader: delegation.delegationHeader,
    delegationCid: delegation.cid,
    spaceId: delegation.spaceId,
    jwk,
    verificationMethod: sessionDid,
    address: delegation.ownerAddress,
    chainId: delegation.chainId,
    siwe: "",
    signature: ""
  });
  await ProfileManager.setProfile(ctx.profile, {
    ...profile,
    sessionDid,
    spaceId: delegation.spaceId
  });
  return createSDKInstance(ctx);
}
async function ensureAuthenticated(ctx, options) {
  if (options?.privateKey) {
    return createSDKInstance(ctx, options);
  }
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

// src/commands/account.ts
var ACCOUNT_BILLING_URL = "https://account.tinycloud.xyz/billing";
function registerAccountCommand(program2) {
  const account = program2.command("account").description("Account applications, spaces, delegations, and billing");
  account.command("status").description("Show account status").action(async (_options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const status = await node.account.status();
      assertOk(status);
      outputJson(status.data);
    } catch (error) {
      handleError(error);
    }
  });
  const apps = account.command("apps").description("Manage account application registry");
  apps.command("list").description("List applications registered under account/applications").option("--live", "Read canonical account KV records instead of the SQLite index").action(async (_options, cmd) => {
    try {
      const options = _options;
      const node = await authenticatedNode(cmd);
      const result = options.live ? await node.account.applications.list() : await node.account.applications.list({ preferIndex: true });
      assertOk(result);
      const payload = { applications: result.data, count: result.data.length };
      if (shouldOutputJson()) {
        outputJson(payload);
        return;
      }
      if (result.data.length === 0) {
        process.stdout.write(theme.muted("No account applications registered.") + "\n");
        return;
      }
      process.stdout.write(
        formatTable(
          ["App ID", "Name", "Manifests", "Updated"],
          result.data.map((app) => [
            app.appId,
            app.name ?? "\u2014",
            String(app.manifests.length),
            app.updatedAt ?? "\u2014"
          ])
        ) + "\n"
      );
    } catch (error) {
      handleError(error);
    }
  });
  const spaces = account.command("spaces").description("Manage account space registry");
  spaces.command("list").description("List spaces registered under account/spaces").option("--live", "Read canonical account KV records instead of the SQLite index").action(async (options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = options.live ? await node.account.spaces.list() : await node.account.spaces.list({ preferIndex: true });
      assertOk(result);
      const payload = { spaces: result.data.map(formatSpace), count: result.data.length };
      if (shouldOutputJson()) {
        outputJson(payload);
        return;
      }
      if (result.data.length === 0) {
        process.stdout.write(theme.muted("No account spaces registered.") + "\n");
        return;
      }
      process.stdout.write(
        formatTable(
          ["Space", "Type", "Owner", "Status", "Updated"],
          result.data.map((space) => [
            space.name,
            space.type,
            space.ownerDid,
            space.status,
            space.updatedAt ?? "\u2014"
          ])
        ) + "\n"
      );
    } catch (error) {
      handleError(error);
    }
  });
  spaces.command("info <space-id>").description("Show a registered account space").action(async (spaceId, _options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.spaces.get(spaceId);
      assertOk(result);
      outputJson(formatSpace(result.data));
    } catch (error) {
      handleError(error);
    }
  });
  spaces.command("register <space-id>").description("Register a space in account/spaces").requiredOption("--name <name>", "Display name for the space").requiredOption("--owner <did>", "Owner DID for the space").option("--type <type>", "Space type: owned, delegated, or discovered", "discovered").option("--permission <permission...>", "Permission strings for the space").action(async (spaceId, options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.spaces.register({
        spaceId,
        name: options.name,
        ownerDid: options.owner,
        type: options.type,
        permissions: options.permission ?? [],
        status: "active"
      });
      assertOk(result);
      outputJson({ space: formatSpace(result.data), registered: true });
    } catch (error) {
      handleError(error);
    }
  });
  spaces.command("sync").description("Register currently accessible spaces into account/spaces").action(async (_options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.spaces.syncAccessible();
      assertOk(result);
      outputJson({ spaces: result.data.map(formatSpace), count: result.data.length, synced: true });
    } catch (error) {
      handleError(error);
    }
  });
  spaces.command("remove <space-id>").alias("delete").description("Remove a space registry entry").action(async (spaceId, _options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.spaces.remove(spaceId);
      assertOk(result);
      outputJson({ spaceId, removed: true });
    } catch (error) {
      handleError(error);
    }
  });
  apps.command("info <app-id>").description("Show a registered account application").action(async (appId, _options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.applications.get(appId);
      assertOk(result);
      outputJson(result.data);
    } catch (error) {
      handleError(error);
    }
  });
  apps.command("register <manifest>").description("Register an app manifest in account/applications").action(async (manifestSource, _options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const manifest = await loadManifestSource(manifestSource);
      const result = await node.account.applications.register(manifest);
      assertOk(result);
      outputJson({ application: result.data, registered: true });
    } catch (error) {
      handleError(error);
    }
  });
  apps.command("remove <app-id>").alias("delete").description("Remove an application registry entry").action(async (appId, _options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.applications.remove(appId);
      assertOk(result);
      outputJson({ appId, removed: true });
    } catch (error) {
      handleError(error);
    }
  });
  const delegations = account.command("delegations").description("View and revoke account delegations");
  delegations.command("list").description("List delegations granted by or to this account").option("--granted", "Show only delegations granted by this account").option("--received", "Show only delegations granted to this account").option("--space <space>", "Filter by space name or ID").option("--live", "Read live delegation services instead of the SQLite index").action(async (options, cmd) => {
    try {
      if (options.granted && options.received) {
        throw new CLIError("USAGE_ERROR", "Use only one of --granted or --received.", ExitCode.USAGE_ERROR);
      }
      const node = await authenticatedNode(cmd);
      const direction = options.granted ? "granted" : options.received ? "received" : "all";
      const result = options.live ? await node.account.delegations.list({ direction, space: options.space }) : await node.account.delegations.list({ direction, space: options.space, preferIndex: true });
      assertOk(result);
      const payload = { delegations: result.data.map(formatDelegation), count: result.data.length };
      if (shouldOutputJson()) {
        outputJson(payload);
        return;
      }
      if (result.data.length === 0) {
        process.stdout.write(theme.muted("No delegations found.") + "\n");
        return;
      }
      process.stdout.write(
        formatTable(
          ["CID", "Direction", "Space", "Counterparty", "Status", "Expiry"],
          result.data.map((delegation) => [
            delegation.cid,
            delegation.direction,
            delegation.spaceName ?? delegation.spaceId,
            delegation.counterpartyDid,
            delegation.status,
            delegation.expiry.toISOString()
          ])
        ) + "\n"
      );
    } catch (error) {
      handleError(error);
    }
  });
  delegations.command("revoke <cid>").description("Revoke an active delegation granted by this account").requiredOption("--space <space>", "Space name or ID containing the delegation").action(async (cid, options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.delegations.revoke({ cid, space: options.space });
      assertOk(result);
      outputJson({ cid, space: options.space, revoked: true });
    } catch (error) {
      handleError(error);
    }
  });
  const index = account.command("index").description("Manage the materialized account SQLite index");
  index.command("ensure").description("Create account SQLite index tables if they are missing").action(async (_options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.index.ensure();
      assertOk(result);
      outputJson({ ...result.data, ensured: true });
    } catch (error) {
      handleError(error);
    }
  });
  index.command("status").description("Show account SQLite index sync status").action(async (_options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.index.status();
      assertOk(result);
      outputJson(result.data);
    } catch (error) {
      handleError(error);
    }
  });
  index.command("rebuild").description("Rebuild account SQLite index from canonical account data").action(async (_options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const result = await node.account.index.rebuild();
      assertOk(result);
      outputJson(result.data);
    } catch (error) {
      handleError(error);
    }
  });
  index.command("query <sql>").description("Query the materialized account SQLite index").option("--params <json>", "Bind parameters as a JSON array for ? placeholders").action(async (sql, options, cmd) => {
    try {
      const node = await authenticatedNode(cmd);
      const params = parseParams(options.params);
      const result = await node.account.index.query(sql, params);
      assertOk(result);
      outputJson(result.data);
    } catch (error) {
      handleError(error);
    }
  });
  const billing = account.command("billing").description("Open account billing");
  for (const name2 of ["status", "checkout", "portal"]) {
    billing.command(name2).description(`${name2 === "status" ? "Show" : "Open"} account billing page`).option("--open", "Open account.tinycloud.xyz in your browser").action(async (options) => {
      try {
        if (options.open) {
          await open(ACCOUNT_BILLING_URL);
        }
        outputJson({ url: ACCOUNT_BILLING_URL, opened: Boolean(options.open) });
      } catch (error) {
        handleError(error);
      }
    });
  }
}
async function authenticatedNode(cmd) {
  const globalOpts = cmd.optsWithGlobals();
  const ctx = await ProfileManager.resolveContext(globalOpts);
  return ensureAuthenticated(ctx);
}
function assertOk(result) {
  if (!result.ok) {
    throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
  }
}
async function loadManifestSource(source) {
  const raw = /^https?:\/\//i.test(source) ? await fetchManifest(source) : await readFile3(source, "utf8");
  return JSON.parse(raw);
}
async function fetchManifest(source) {
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
function parseParams(input) {
  if (!input) return void 0;
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed)) {
    throw new CLIError("INVALID_PARAMS", "--params must be a JSON array.", ExitCode.USAGE_ERROR);
  }
  return parsed;
}
function formatDelegation(delegation) {
  return {
    cid: delegation.cid,
    direction: delegation.direction,
    spaceId: delegation.spaceId,
    spaceName: delegation.spaceName,
    counterpartyDid: delegation.counterpartyDid,
    delegateDid: delegation.delegateDid,
    delegatorDid: delegation.delegatorDid,
    path: delegation.path,
    actions: delegation.actions,
    expiry: delegation.expiry.toISOString(),
    status: delegation.status,
    createdAt: delegation.createdAt?.toISOString()
  };
}
function formatSpace(space) {
  return {
    ...space,
    expiresAt: space.expiresAt?.toISOString()
  };
}

// src/commands/auth.ts
import { get as httpGet } from "http";
import { get as httpsGet } from "https";
import { spawn } from "child_process";
import { mkdir as mkdir2, readFile as readFile4, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2 } from "path";
import { createInterface as createInterface2 } from "readline";
import { grantAuthRequest, principalDidEquals } from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";

// src/auth/browser-auth.ts
import { createServer } from "http";
import { createInterface } from "readline";
var PRIVATE_JWK_FIELDS = /* @__PURE__ */ new Set([
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "k"
]);
function publicJwkForDelegation(jwk) {
  const publicJwk = {};
  for (const [key, value] of Object.entries(jwk)) {
    if (!PRIVATE_JWK_FIELDS.has(key)) {
      publicJwk[key] = value;
    }
  }
  return publicJwk;
}
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
    const jwkB64 = Buffer.from(
      JSON.stringify(publicJwkForDelegation(options.jwk))
    ).toString("base64url");
    params.set("jwk", jwkB64);
  }
  if (options.host) {
    params.set("host", options.host);
  }
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (options.permissions?.length) {
    params.set(
      "permissions",
      Buffer.from(JSON.stringify({
        permissions: options.permissions,
        ...reason ? { reason } : {}
      })).toString("base64url")
    );
  }
  if (reason) {
    params.set("reason", reason);
  }
  if (options.expiry !== void 0) {
    params.set("expiry", String(options.expiry));
  }
  const base3 = options.openkeyHost ?? DEFAULT_OPENKEY_HOST;
  return `${base3}/delegate?${params.toString()}`;
}
function shouldOpenBrowser(options) {
  if (options.noPopup) return false;
  const env = process.env.TC_AUTH_NO_POPUP ?? process.env.TC_NO_POPUP;
  return env !== "1" && env !== "true";
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
          } catch (err2) {
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
      const openBrowser = shouldOpenBrowser(options);
      if (openBrowser && isInteractive()) {
        console.error(`Opening browser for authentication...`);
        console.error(`If the browser doesn't open, visit: ${authUrl}`);
      } else if (!openBrowser || isInteractive()) {
        console.error(`Open this URL in a browser to authenticate: ${authUrl}`);
      }
      if (openBrowser) {
        try {
          const open2 = (await import("open")).default;
          await open2(authUrl);
        } catch {
          server.close();
          throw new Error("Failed to open browser");
        }
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

// src/auth/local-key.ts
import { TCWSessionManager, importKey, initPanicHook } from "@tinycloud/node-sdk-wasm";
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
  auth.command("login").description("Authenticate with TinyCloud").option("--paste", "Use manual paste mode instead of browser callback").option("--no-popup", "Print the OpenKey URL without opening a browser").option("--method <method>", "Authentication method: local or openkey").action(async (options, cmd) => {
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
        await handleOpenKeyAuth(ctx.profile, ctx.host, {
          paste: options.paste,
          noPopup: options.popup === false
        });
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
  auth.command("rotate").description("Rotate the active profile session key").option("--paste", "Use manual paste mode instead of browser callback").option("--no-popup", "Print the OpenKey URL without opening a browser").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      await rotateAuthKey(ctx.profile, ctx.host, {
        paste: options.paste,
        noPopup: options.popup === false
      });
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
  ).option("--emit [file]", "Emit the request artifact to stdout, or write it to file when provided").option("--grant", "Grant the requested permissions immediately with this owner profile").option("--yes", "Skip local-key TTY confirmation", false).option("--no-popup", "Print the OpenKey URL without opening a browser when granting with OpenKey").action(async (options, cmd) => {
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
            reason: permissionGrantReason(
              "Grant requested TinyCloud permissions from `tc auth request --grant`.",
              group
            ),
            openkeyHost,
            expiry: expiryOption,
            noPopup: options.popup === false
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
      await persistCurrentLocalSession(ctx.profile, profile, node.restorableSession);
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
      if (isCompatiblePermissionRequestArtifact(parsed)) {
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
      const requestId = await requestBoundDelegationRequestId(ctx, parsed);
      if (requestId !== void 0) {
        await importRequestBoundDelegation(ctx, parsed, requestId);
        return;
      }
      const imported = normalizeDelegationImport(parsed);
      let node;
      try {
        node = await ensureAuthenticated(ctx);
      } catch (error) {
        const profile = await ProfileManager.getProfile(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile);
        if (session || resolveProfilePosture(profile) !== "delegate-session") throw error;
        node = await bootstrapDelegatedSession(ctx, imported.delegation);
      }
      await appendAdditionalDelegation(ctx.profile, storedAdditionalDelegation(
        imported.delegation,
        imported.permissions
      ));
      const targetsSessionKey = typeof imported.delegation.delegateDID === "string" && principalDidEquals(imported.delegation.delegateDID, node.sessionDid);
      let activated = false;
      if (targetsSessionKey) {
        await node.useRuntimeDelegation(imported.delegation);
        activated = true;
      }
      await appendGrantHistory(ctx.profile, {
        addedCaps: imported.permissions,
        source: "cli",
        delegationCid: imported.delegation.cid,
        expiry: imported.delegation.expiry.toISOString()
      });
      outputJson({
        imported: true,
        activated,
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
      if (!isCompatiblePermissionRequestArtifact(parsed)) {
        throw new CLIError(
          "INVALID_AUTH_REQUEST",
          "Auth grant requires a tinycloud.auth.request artifact.",
          ExitCode.USAGE_ERROR
        );
      }
      const requested = await resolvePermissionSpaces(parsed.requested, ctx.profile);
      const resolvedRequest = { ...parsed, requested };
      const node = await ensureAuthenticated(ctx);
      await ensureDelegationAuthority({
        ctx,
        profile,
        node,
        requested,
        expiryOption: parsed.requestedExpiry,
        reason: "Grant permissions requested by a TinyCloud auth request artifact.",
        yes: options.yes === true
      });
      const grant = await grantAuthRequest(node, resolvedRequest);
      outputJson(grant);
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
        const command = isPermissionRequestArtifact(artifact) ? artifact.command : void 0;
        if (!command?.argv?.length) {
          throw new CLIError(
            "COMMAND_NOT_CAPTURED",
            `Request ${artifact.requestId} does not include a captured command.`,
            ExitCode.USAGE_ERROR
          );
        }
        await execCapturedCommand(command);
        return;
      }
      outputJson({
        requestId: artifact.requestId,
        covered,
        missing: covered ? [] : artifact.requested,
        command: isPermissionRequestArtifact(artifact) ? artifact.command ?? null : null
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
  return readFile4(source, "utf8");
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
  if (isLegacyDelegationImportArtifact(value)) {
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
function isLegacyDelegationImportArtifact(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  return candidate.kind === "tinycloud.auth.delegation" && candidate.version === 1 && candidate.delegation !== null && typeof candidate.delegation === "object";
}
async function requestBoundDelegationRequestId(ctx, value) {
  const requestId = delegationEnvelopeRequestId(value);
  if (requestId === void 0) return void 0;
  return await getPermissionRequestArtifact(ctx.profile, requestId) === null ? void 0 : requestId;
}
function delegationEnvelopeRequestId(value) {
  if (value === null || typeof value !== "object") return void 0;
  const candidate = value;
  return candidate.kind === "tinycloud.auth.delegation" && candidate.version === 1 && typeof candidate.requestId === "string" ? candidate.requestId : void 0;
}
async function importRequestBoundDelegation(ctx, artifact, requestId) {
  const result = await invokeOperation(
    "tinycloud.auth.import",
    1,
    // `tc auth import` is a direct human CLI invocation. This explicit opt-in
    // preserves owner-profile imports under the operations owner posture gate;
    // it has no effect on delegate-session execution.
    { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true },
    artifact
  );
  switch (result.status) {
    case "ok": {
      const output = result.output;
      outputJson({
        imported: true,
        activated: output.activated,
        kind: "tinycloud.auth.delegation",
        requestId,
        delegationCid: output.cid,
        permissions: output.effectivePermissions,
        expiry: output.expiry
      });
      return;
    }
    case "authority_required":
      throw new CLIError(
        "AUTHORITY_REQUIRED",
        "The active session requires additional authority before importing this delegation.",
        ExitCode.PERMISSION_DENIED
      );
    case "setup_required":
      throw new CLIError(
        "SETUP_REQUIRED",
        "The active profile requires setup before importing this delegation.",
        ExitCode.ERROR
      );
    case "error":
      throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
  }
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
  if (!params.force && params.node.hasRuntimePermissions(params.requested)) return;
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
    const acquireOpenKey = params.openKeyAcquisition ?? startAuthFlow;
    for (const group of groupPermissionsBySpace(params.requested)) {
      const delegationData = await acquireOpenKey(params.profile.did, {
        jwk: key,
        host: params.ctx.host,
        permissions: group,
        reason: permissionGrantReason(params.reason, group),
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
function permissionGrantReason(context, permissions) {
  const first = permissions[0];
  const summary = first ? compactPermission(first) : "no permissions";
  const more = permissions.length > 1 ? ` and ${permissions.length - 1} more permission${permissions.length === 2 ? "" : "s"}` : "";
  return `${context} Requested: ${summary}${more}.`;
}
function execCapturedCommand(command) {
  return new Promise((resolve3, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...command.argv], {
      cwd: command.cwd,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code2, signal) => {
      if (signal) {
        reject(new CLIError(
          "COMMAND_SIGNAL",
          `Captured command exited from signal ${signal}.`,
          ExitCode.ERROR
        ));
        return;
      }
      if (code2 && code2 !== 0) {
        process.exitCode = code2;
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
    (action) => action.includes("*") || action.endsWith("/write") || action.endsWith("/admin") || action.endsWith("/schema") || action.endsWith("/del")
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
    const ms3 = Number(raw.trim());
    if (!Number.isFinite(ms3) || ms3 <= 0) {
      throw new CLIError("INVALID_EXPIRY", `--expiry must be a positive integer when numeric.`, ExitCode.USAGE_ERROR);
    }
    return ms3;
  }
  return raw;
}
function groupPermissionsBySpace(permissions) {
  const groups = /* @__PURE__ */ new Map();
  const rawEntries = [];
  for (const permission of permissions) {
    if (isRawPermission(permission)) {
      rawEntries.push(permission);
      continue;
    }
    const key = normalizeSpaceForCompare(permission.space);
    const group = groups.get(key) ?? [];
    group.push(permission);
    groups.set(key, group);
  }
  const grouped = Array.from(groups.values());
  if (grouped.length === 0) {
    return rawEntries.length > 0 ? [rawEntries] : [];
  }
  grouped[0].push(...rawEntries);
  return grouped;
}
function isRawPermission(permission) {
  return permission.service === "tinycloud.encryption" && permission.path.startsWith("urn:tinycloud:encryption:");
}
function normalizeSpaceForCompare(space) {
  return space.replace(
    /(eip155:\d+:)(0x[0-9a-fA-F]{40})/,
    (_match, prefix, addr) => prefix + addr.toLowerCase()
  );
}
function returnedSpaceMatchesExpected(returnedSpace, expectedSpace) {
  if (normalizeSpaceForCompare(returnedSpace) === normalizeSpaceForCompare(expectedSpace)) {
    return true;
  }
  if (!returnedSpace.startsWith("tinycloud:")) return false;
  const returnedName = returnedSpace.slice(returnedSpace.lastIndexOf(":") + 1);
  return returnedName === expectedSpace;
}
function portableFromOpenKeyDelegation(data, permissions, host) {
  const primary = permissions.find((permission) => !isRawPermission(permission)) ?? permissions[0];
  const returnedSpace = String(data.spaceId ?? primary.space ?? "encryption");
  const expectedSpaces = new Set(
    permissions.filter((permission) => !isRawPermission(permission)).map((permission) => normalizeSpaceForCompare(permission.space))
  );
  const matchesExpectedSpace = expectedSpaces.size === 1 && returnedSpaceMatchesExpected(returnedSpace, Array.from(expectedSpaces)[0]);
  if (expectedSpaces.size > 0 && !matchesExpectedSpace) {
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
      space: isRawPermission(permission) ? permission.space : returnedSpace,
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
  for (const key of ["expiry", "expiresAt", "expirationTime"]) {
    const parsed = parseDelegationExpiryField(data[key]);
    if (parsed) return parsed;
  }
  if (typeof data.siwe === "string") {
    const match = data.siwe.match(/^Expiration Time:\s*(.+)$/im);
    const parsed = match ? parseDelegationExpiryField(match[1]?.trim()) : null;
    if (parsed) return parsed;
  }
  throw new CLIError(
    "OPENKEY_EXPIRY_MISSING",
    "OpenKey delegation response did not include expiry, expiresAt, expirationTime, or a SIWE Expiration Time.",
    ExitCode.ERROR
  );
}
function parseDelegationExpiryField(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const parsed = new Date(value < 1e10 ? value * 1e3 : value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}
async function rotateAuthKey(profileName, host, options = {}) {
  const profile = await ProfileManager.getProfile(profileName);
  const posture = resolveProfilePosture(profile);
  const oldDid = profile.sessionDid ?? profile.did;
  if (posture === "delegate-session") {
    throw new CLIError(
      "ROTATE_DELEGATE_SESSION_UNSUPPORTED",
      `Profile "${profileName}" is a delegated session. Request or import a new owner delegation instead of rotating it locally.`,
      ExitCode.PERMISSION_DENIED
    );
  }
  if (profile.authMethod === "local" || posture === "local-owner-key") {
    if (!profile.privateKey) {
      throw new CLIError(
        "LOCAL_OWNER_KEY_REQUIRED",
        `Profile "${profileName}" does not have a local owner private key. Run \`tc auth login --method local\` first.`,
        ExitCode.AUTH_REQUIRED
      );
    }
    await ProfileManager.clearSession(profileName);
    const result2 = await handleLocalAuth(profileName, host, {
      emitOutput: false,
      forceSessionKey: true
    });
    outputRotationResult(result2.profile, profileName, oldDid, "local");
    return;
  }
  const { jwk, did } = await withSpinner("Generating session key...", async () => {
    return generateKey();
  });
  await ProfileManager.setKey(profileName, jwk);
  await ProfileManager.clearSession(profileName);
  await ProfileManager.setProfile(profileName, {
    ...profile,
    host,
    did,
    sessionDid: did,
    posture: profile.posture ?? "owner-openkey",
    operatorType: profile.operatorType ?? "human",
    authMethod: "openkey"
  });
  const result = await refreshOpenKeySession(profileName, host, {
    paste: options.paste,
    noPopup: options.noPopup
  });
  outputRotationResult(result.profile, profileName, oldDid, "openkey");
}
function outputRotationResult(profile, profileName, oldDid, authMethod) {
  outputJson({
    rotated: true,
    profile: profileName,
    oldDid,
    did: profile.did,
    sessionDid: profile.sessionDid ?? null,
    authMethod,
    spaceId: profile.spaceId ?? null
  });
}
async function persistCurrentLocalSession(profileName, profile, session) {
  if (!session) return;
  await ProfileManager.setSession(profileName, {
    authMethod: "local",
    address: session.address,
    chainId: session.chainId,
    spaceId: session.spaceId,
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    jwk: session.jwk,
    verificationMethod: session.verificationMethod,
    siwe: session.siwe,
    signature: session.signature
  });
  if (profile.sessionDid !== session.verificationMethod || profile.spaceId !== session.spaceId) {
    await ProfileManager.setProfile(profileName, {
      ...profile,
      sessionDid: session.verificationMethod,
      spaceId: session.spaceId
    });
  }
}
async function handleLocalAuth(profileName, host, options = {}) {
  const profile = await ProfileManager.getProfile(profileName).catch(() => null);
  const posture = profile ? resolveProfilePosture(profile) : null;
  let privateKey;
  let address;
  let did;
  let sessionDid = profile?.sessionDid;
  if ((profile?.authMethod === "local" || posture === "local-owner-key") && profile.privateKey) {
    privateKey = profile.privateKey;
    address = profile.address ?? await deriveAddress(privateKey);
    did = profile.did.startsWith("did:pkh:") ? profile.did : addressToDID(address, profile.chainId ?? DEFAULT_CHAIN_ID);
    if (isInteractive()) {
      process.stderr.write(theme.muted("Using existing local key") + "\n");
      process.stderr.write(formatField("Address", address) + "\n");
    }
  } else {
    const identity3 = await withSpinner("Generating Ethereum key...", async () => {
      return generateLocalIdentity(DEFAULT_CHAIN_ID);
    });
    privateKey = identity3.privateKey;
    address = identity3.address;
    did = identity3.did;
    if (isInteractive()) {
      process.stderr.write("\n" + theme.heading("Local Key Generated") + "\n");
      process.stderr.write(formatField("Address", address) + "\n");
      process.stderr.write(formatField("DID", did) + "\n\n");
    }
  }
  const hasKey = await ProfileManager.getKey(profileName);
  if (options.forceSessionKey || !hasKey) {
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
  const updatedProfile = {
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
  };
  await ProfileManager.setProfile(profileName, updatedProfile);
  if (options.emitOutput ?? true) {
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
  return { profile: updatedProfile, sessionResult };
}
async function handleOpenKeyAuth(profileName, host, options = {}) {
  const { profile, delegationData } = await refreshOpenKeySession(profileName, host, options);
  outputJson({
    authenticated: true,
    profile: profileName,
    did: profile.did,
    spaceId: delegationData.spaceId,
    authMethod: "openkey"
  });
}
function mergePrivateJwkIntoSession(session, key) {
  const sessionJwk = session.jwk;
  if (!sessionJwk || typeof sessionJwk !== "object") {
    return session;
  }
  const sessionJwkRecord = sessionJwk;
  const sessionD = sessionJwkRecord.d;
  if (typeof sessionD === "string" && sessionD.length > 0) {
    return session;
  }
  const keyD = key.d;
  if (typeof keyD !== "string" || keyD.length === 0) {
    return session;
  }
  return {
    ...session,
    jwk: { ...sessionJwkRecord, d: keyD }
  };
}
async function refreshOpenKeySession(profileName, host, options = {}) {
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
    paste: options.paste,
    noPopup: options.noPopup,
    jwk: key,
    host,
    openkeyHost: resolveOpenKeyHost(profile)
  });
  const sanitizedSession = mergePrivateJwkIntoSession(delegationData, key);
  await ProfileManager.setSession(profileName, sanitizedSession);
  const updatedProfile = {
    ...profile,
    sessionDid: profile.sessionDid ?? profile.did,
    posture: profile.posture ?? "owner-openkey",
    operatorType: profile.operatorType ?? "human",
    authMethod: "openkey"
  };
  if (sanitizedSession.spaceId) {
    updatedProfile.spaceId = sanitizedSession.spaceId;
    updatedProfile.ownerDid = sanitizedSession.ownerDid;
  }
  await ProfileManager.setProfile(profileName, updatedProfile);
  return { profile: updatedProfile, delegationData: sanitizedSession };
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
    auth) subcommands="login logout rotate status whoami" ;;
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
        auth) _values 'subcommand' login logout rotate status whoami ;;
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
complete -c tc -n "__fish_seen_subcommand_from auth" -a "login logout rotate status whoami"
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
    const ms3 = date.getTime() - Date.now();
    if (ms3 <= 0) {
      throw new Error(`Expiry date "${input}" is in the past`);
    }
    return ms3;
  }
  throw new Error(`Invalid duration: "${input}". Use format like "1h", "7d", or an ISO date.`);
}
function parseExpiry2(input) {
  return new Date(Date.now() + parseDuration(input));
}

// src/commands/delegation.ts
function normalizeDid(input) {
  const normalized = input.trim();
  const fragmentIndex = normalized.indexOf("#");
  return (fragmentIndex === -1 ? normalized : normalized.slice(0, fragmentIndex)).toLowerCase();
}
function didMatches(actual, expected) {
  if (!actual) return false;
  try {
    return normalizeDid(actual) === normalizeDid(expected);
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
      const expiry = parseExpiry2(options.expiry);
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

// src/commands/duckdb.ts
import { readFile as readFile5, writeFile as writeFile3 } from "fs/promises";
import { resolve } from "path";
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
      const outputPath = resolve(options.output);
      await writeFile3(outputPath, buffer);
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
      const filePath = resolve(file);
      const bytes = new Uint8Array(await readFile5(filePath));
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

// src/commands/init.ts
function registerInitCommand(program2) {
  program2.command("init").description("Initialize a new TinyCloud profile").option("--name <profile>", "Profile name", "default").option("--key-only", "Only generate key, skip authentication").option("--host <url>", "TinyCloud node URL").option("--paste", "Use manual paste mode for authentication").option("--no-popup", "Print the OpenKey URL without opening a browser").option("--default-space <name>", "Default space used when --space is omitted (e.g. applications)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const profileName = options.name;
      const host = options.host ?? globalOpts.host ?? DEFAULT_HOST;
      const defaultSpace = options.defaultSpace;
      if (defaultSpace !== void 0 && !/^[A-Za-z0-9_-]+$/.test(defaultSpace)) {
        throw new CLIError(
          "INVALID_SPACE",
          `Invalid --default-space "${defaultSpace}". Use a short name ([A-Za-z0-9_-]).`,
          ExitCode.USAGE_ERROR
        );
      }
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
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        ...defaultSpace ? { defaultSpace } : {}
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
        noPopup: options.popup === false,
        jwk,
        host
      });
      const sanitizedSession = mergePrivateJwkIntoSession(delegationData, jwk);
      await ProfileManager.setSession(profileName, sanitizedSession);
      await ProfileManager.setProfile(profileName, {
        ...profileConfig,
        spaceId: sanitizedSession.spaceId,
        ownerDid: sanitizedSession.ownerDid
      });
      outputJson({
        profile: profileName,
        did,
        host,
        spaceId: sanitizedSession.spaceId,
        authenticated: true
      });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/commands/kv.ts
import { readFile as readFile6 } from "fs/promises";
import { writeFile as writeFile4 } from "fs/promises";

// src/lib/host.ts
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
async function resolveHostSpace(name2, profileName) {
  const resolved = await resolveSpaceUri(name2, profileName);
  if (!resolved) {
    throw new Error(`Could not resolve a space for "${name2}".`);
  }
  return resolved;
}

// src/commands/kv.ts
async function throwKvError(error, spaceUri, profileName) {
  const hosted = await unhostedSpaceError(error, spaceUri, profileName);
  if (hosted) throw hosted;
  throw new CLIError(error.code, error.message, ExitCode.ERROR);
}
async function readStdin2() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
async function kvHandle(node, spaceInput, profileName) {
  const spaceUri = await resolveSpaceUri(spaceInput, profileName);
  const kv = spaceUri ? node.kvForSpace(spaceUri) : node.kv;
  return { kv, spaceUri };
}
function registerKvCommand(program2) {
  const kv = program2.command("kv").description("Key-value store operations");
  kv.command("get <key>").description("Get a value by key").option("--raw", "Output raw value (no JSON wrapping)").option("-o, --output <file>", "Write value to file").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").action(async (key, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const { kv: kv2, spaceUri } = await kvHandle(node, options.space, ctx.profile);
      const wantBytes = !!options.output || !!options.raw;
      const result = await withSpinner(
        `Getting ${key}...`,
        () => kv2.get(key, wantBytes ? { binary: true } : void 0)
      );
      if (!result.ok) {
        const hosted = await unhostedSpaceError(result.error, spaceUri, ctx.profile);
        if (hosted) throw hosted;
        if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
          throw new CLIError("NOT_FOUND", `Key "${key}" not found`, ExitCode.NOT_FOUND);
        }
        await throwKvError(result.error, spaceUri, ctx.profile);
      }
      const data = result.data.data;
      const metadata = result.data.headers ?? {};
      if (options.output) {
        await writeFile4(options.output, data);
        outputJson({ key, written: options.output });
        return;
      }
      if (options.raw) {
        process.stdout.write(data);
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
  kv.command("put <key> [value]").description("Set a value").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").action(async (key, value, options, cmd) => {
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
        putValue = await readFile6(options.file);
      } else if (options.stdin) {
        putValue = await readStdin2();
      } else {
        try {
          putValue = JSON.parse(value);
        } catch {
          putValue = value;
        }
      }
      const { kv: kv2, spaceUri } = await kvHandle(node, options.space, ctx.profile);
      const result = await withSpinner(`Writing ${key}...`, () => kv2.put(key, putValue));
      if (!result.ok) {
        await throwKvError(result.error, spaceUri, ctx.profile);
      }
      outputJson({ key, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  kv.command("delete <key>").description("Delete a key").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").action(async (key, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const { kv: kv2, spaceUri } = await kvHandle(node, options.space, ctx.profile);
      const result = await withSpinner(`Deleting ${key}...`, () => kv2.delete(key));
      if (!result.ok) {
        await throwKvError(result.error, spaceUri, ctx.profile);
      }
      outputJson({ key, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
  kv.command("list").description("List keys").option("--prefix <prefix>", "Filter by key prefix").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const { kv: kv2, spaceUri } = await kvHandle(node, options.space, ctx.profile);
      const listOptions = options.prefix ? { prefix: options.prefix } : void 0;
      const result = await withSpinner("Listing keys...", () => kv2.list(listOptions));
      if (!result.ok) {
        await throwKvError(result.error, spaceUri, ctx.profile);
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
  kv.command("head <key>").description("Get metadata for a key (no body)").option("--space <name|uri>", "Target a non-primary space (short name or full URI)").action(async (key, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const { kv: kv2, spaceUri } = await kvHandle(node, options.space, ctx.profile);
      const result = await withSpinner(`Checking ${key}...`, () => kv2.head(key));
      if (!result.ok) {
        const hosted = await unhostedSpaceError(result.error, spaceUri, ctx.profile);
        if (hosted) throw hosted;
        if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
          outputJson({ key, exists: false, metadata: {} });
          return;
        }
        await throwKvError(result.error, spaceUri, ctx.profile);
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

// ../sdk-core/dist/index.js
import { SiweMessage } from "siwe";
import crypto2 from "crypto";
var import_ms2 = __toESM(require_ms(), 1);
import { Buffer as Buffer2 } from "buffer";
import { Buffer as Buffer3 } from "buffer";
import { Buffer as Buffer4 } from "buffer";
import { Buffer as Buffer5 } from "buffer";
import { isIPv4, isIPv6, isIP as ipVersion } from "net";
var __defProp2 = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp2(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export2 = (target, all) => {
  for (var name2 in all)
    __defProp2(target, name2, { get: all[name2], enumerable: true });
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var EnsDataSchema = external_exports.object({
  domain: external_exports.string().nullable().optional(),
  avatarUrl: external_exports.string().nullable().optional()
});
var SiweConfigSchema = external_exports.object({
  domain: external_exports.string().optional(),
  uri: external_exports.string().optional(),
  chainId: external_exports.number().optional(),
  statement: external_exports.string().optional(),
  nonce: external_exports.string().optional(),
  expirationTime: external_exports.string().optional(),
  notBefore: external_exports.string().optional(),
  requestId: external_exports.string().optional(),
  resources: external_exports.array(external_exports.string()).optional()
}).passthrough();
var ClientSessionSchema = external_exports.object({
  address: external_exports.string(),
  walletAddress: external_exports.string(),
  chainId: external_exports.number(),
  sessionKey: external_exports.string(),
  siwe: external_exports.string(),
  signature: external_exports.string(),
  ens: EnsDataSchema.optional()
});
var base32_exports = {};
__export2(base32_exports, {
  base32: () => base32,
  base32hex: () => base32hex,
  base32hexpad: () => base32hexpad,
  base32hexpadupper: () => base32hexpadupper,
  base32hexupper: () => base32hexupper,
  base32pad: () => base32pad,
  base32padupper: () => base32padupper,
  base32upper: () => base32upper,
  base32z: () => base32z
});
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
function fromString(str) {
  return new TextEncoder().encode(str);
}
function toString(b) {
  return new TextDecoder().decode(b);
}
function base(ALPHABET, name2) {
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
  function encode5(source) {
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
    var length2 = 0;
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
      for (var it1 = size - 1; (carry !== 0 || i2 < length2) && it1 !== -1; it1--, i2++) {
        carry += 256 * b58[it1] >>> 0;
        b58[it1] = carry % BASE >>> 0;
        carry = carry / BASE >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length2 = i2;
      pbegin++;
    }
    var it2 = size - length2;
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
    var length2 = 0;
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
      for (var it3 = size - 1; (carry !== 0 || i2 < length2) && it3 !== -1; it3--, i2++) {
        carry += BASE * b256[it3] >>> 0;
        b256[it3] = carry % 256 >>> 0;
        carry = carry / 256 >>> 0;
      }
      if (carry !== 0) {
        throw new Error("Non-zero carry");
      }
      length2 = i2;
      psz++;
    }
    if (source[psz] === " ") {
      return;
    }
    var it4 = size - length2;
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
  function decode7(string2) {
    var buffer = decodeUnsafe(string2);
    if (buffer) {
      return buffer;
    }
    throw new Error(`Non-${name2} character`);
  }
  return {
    encode: encode5,
    decodeUnsafe,
    decode: decode7
  };
}
var src = base;
var _brrp__multiformats_scope_baseX = src;
var base_x_default = _brrp__multiformats_scope_baseX;
var Encoder = class {
  constructor(name2, prefix, baseEncode) {
    __publicField(this, "name");
    __publicField(this, "prefix");
    __publicField(this, "baseEncode");
    this.name = name2;
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
var Decoder = class {
  constructor(name2, prefix, baseDecode) {
    __publicField(this, "name");
    __publicField(this, "prefix");
    __publicField(this, "baseDecode");
    __publicField(this, "prefixCodePoint");
    this.name = name2;
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
  constructor(decoders2) {
    __publicField(this, "decoders");
    this.decoders = decoders2;
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
  constructor(name2, prefix, baseEncode, baseDecode) {
    __publicField(this, "name");
    __publicField(this, "prefix");
    __publicField(this, "baseEncode");
    __publicField(this, "baseDecode");
    __publicField(this, "encoder");
    __publicField(this, "decoder");
    this.name = name2;
    this.prefix = prefix;
    this.baseEncode = baseEncode;
    this.baseDecode = baseDecode;
    this.encoder = new Encoder(name2, prefix, baseEncode);
    this.decoder = new Decoder(name2, prefix, baseDecode);
  }
  encode(input) {
    return this.encoder.encode(input);
  }
  decode(input) {
    return this.decoder.decode(input);
  }
};
function from({ name: name2, prefix, encode: encode5, decode: decode7 }) {
  return new Codec(name2, prefix, encode5, decode7);
}
function baseX({ name: name2, prefix, alphabet: alphabet2 }) {
  const { encode: encode5, decode: decode7 } = base_x_default(alphabet2, name2);
  return from({
    prefix,
    name: name2,
    encode: encode5,
    decode: (text) => coerce2(decode7(text))
  });
}
function decode(string2, alphabetIdx, bitsPerChar, name2) {
  let end = string2.length;
  while (string2[end - 1] === "=") {
    --end;
  }
  const out = new Uint8Array(end * bitsPerChar / 8 | 0);
  let bits = 0;
  let buffer = 0;
  let written = 0;
  for (let i = 0; i < end; ++i) {
    const value = alphabetIdx[string2[i]];
    if (value === void 0) {
      throw new SyntaxError(`Non-${name2} character`);
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
function encode(data, alphabet2, bitsPerChar) {
  const pad = alphabet2[alphabet2.length - 1] === "=";
  const mask = (1 << bitsPerChar) - 1;
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < data.length; ++i) {
    buffer = buffer << 8 | data[i];
    bits += 8;
    while (bits > bitsPerChar) {
      bits -= bitsPerChar;
      out += alphabet2[mask & buffer >> bits];
    }
  }
  if (bits !== 0) {
    out += alphabet2[mask & buffer << bitsPerChar - bits];
  }
  if (pad) {
    while ((out.length * bitsPerChar & 7) !== 0) {
      out += "=";
    }
  }
  return out;
}
function createAlphabetIdx(alphabet2) {
  const alphabetIdx = {};
  for (let i = 0; i < alphabet2.length; ++i) {
    alphabetIdx[alphabet2[i]] = i;
  }
  return alphabetIdx;
}
function rfc4648({ name: name2, prefix, bitsPerChar, alphabet: alphabet2 }) {
  const alphabetIdx = createAlphabetIdx(alphabet2);
  return from({
    prefix,
    name: name2,
    encode(input) {
      return encode(input, alphabet2, bitsPerChar);
    },
    decode(input) {
      return decode(input, alphabetIdx, bitsPerChar, name2);
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
var base36_exports = {};
__export2(base36_exports, {
  base36: () => base36,
  base36upper: () => base36upper
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
var base58_exports = {};
__export2(base58_exports, {
  base58btc: () => base58btc,
  base58flickr: () => base58flickr
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
var decode2 = read2;
var MSB$1 = 128;
var REST$1 = 127;
function read2(buf, offset) {
  var res = 0, offset = offset || 0, shift = 0, counter = offset, b, l = buf.length;
  do {
    if (counter >= l) {
      read2.bytes = 0;
      throw new RangeError("Could not decode varint");
    }
    b = buf[counter++];
    res += shift < 28 ? (b & REST$1) << shift : (b & REST$1) * Math.pow(2, shift);
    shift += 7;
  } while (b >= MSB$1);
  read2.bytes = counter - offset;
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
  const code2 = varint_default.decode(data, offset);
  return [code2, varint_default.decode.bytes];
}
function encodeTo(int, target, offset = 0) {
  varint_default.encode(int, target, offset);
  return target;
}
function encodingLength(int) {
  return varint_default.encodingLength(int);
}
function create(code2, digest2) {
  const size = digest2.byteLength;
  const sizeOffset = encodingLength(code2);
  const digestOffset = sizeOffset + encodingLength(size);
  const bytes = new Uint8Array(digestOffset + size);
  encodeTo(code2, bytes, 0);
  encodeTo(size, bytes, sizeOffset);
  bytes.set(digest2, digestOffset);
  return new Digest(code2, size, digest2, bytes);
}
function decode4(multihash) {
  const bytes = coerce2(multihash);
  const [code2, sizeOffset] = decode3(bytes);
  const [size, digestOffset] = decode3(bytes.subarray(sizeOffset));
  const digest2 = bytes.subarray(sizeOffset + digestOffset);
  if (digest2.byteLength !== size) {
    throw new Error("Incorrect length");
  }
  return new Digest(code2, size, digest2, bytes);
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
  /**
   * Creates a multihash digest.
   */
  constructor(code2, size, digest2, bytes) {
    __publicField(this, "code");
    __publicField(this, "size");
    __publicField(this, "digest");
    __publicField(this, "bytes");
    this.code = code2;
    this.size = size;
    this.digest = digest2;
    this.bytes = bytes;
  }
};
function format(link, base3) {
  const { bytes, version: version2 } = link;
  switch (version2) {
    case 0:
      return toStringV0(bytes, baseCache(link), base3 ?? base58btc.encoder);
    default:
      return toStringV1(bytes, baseCache(link), base3 ?? base32.encoder);
  }
}
var cache = /* @__PURE__ */ new WeakMap();
function baseCache(cid) {
  const baseCache2 = cache.get(cid);
  if (baseCache2 == null) {
    const baseCache3 = /* @__PURE__ */ new Map();
    cache.set(cid, baseCache3);
    return baseCache3;
  }
  return baseCache2;
}
var _a;
var CID = class _CID {
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param multihash - (Multi)hash of the of the content.
   */
  constructor(version2, code2, multihash, bytes) {
    __publicField(this, "code");
    __publicField(this, "version");
    __publicField(this, "multihash");
    __publicField(this, "bytes");
    __publicField(this, "/");
    __publicField(this, _a, "CID");
    this.code = code2;
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
        const { code: code2, multihash } = this;
        if (code2 !== DAG_PB_CODE) {
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
        const { code: code2, digest: digest2 } = this.multihash;
        const multihash = create(code2, digest2);
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
  toString(base3) {
    return format(this, base3);
  }
  toJSON() {
    return { "/": format(this) };
  }
  link() {
    return this;
  }
  // Legacy
  [(_a = Symbol.toStringTag, /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom"))]() {
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
      const { version: version2, code: code2, multihash, bytes } = value;
      return new _CID(version2, code2, multihash, bytes ?? encodeCID(version2, code2, multihash.bytes));
    } else if (value[cidSymbol] === true) {
      const { version: version2, multihash, code: code2 } = value;
      const digest2 = decode4(multihash);
      return _CID.create(version2, code2, digest2);
    } else {
      return null;
    }
  }
  /**
   * @param version - Version of the CID
   * @param code - Code of the codec content is encoded in, see https://github.com/multiformats/multicodec/blob/master/table.csv
   * @param digest - (Multi)hash of the of the content.
   */
  static create(version2, code2, digest2) {
    if (typeof code2 !== "number") {
      throw new Error("String codecs are no longer supported");
    }
    if (!(digest2.bytes instanceof Uint8Array)) {
      throw new Error("Invalid digest");
    }
    switch (version2) {
      case 0: {
        if (code2 !== DAG_PB_CODE) {
          throw new Error(`Version 0 CID must use dag-pb (code: ${DAG_PB_CODE}) block encoding`);
        } else {
          return new _CID(version2, code2, digest2, digest2.bytes);
        }
      }
      case 1: {
        const bytes = encodeCID(version2, code2, digest2.bytes);
        return new _CID(version2, code2, digest2, bytes);
      }
      default: {
        throw new Error("Invalid version");
      }
    }
  }
  /**
   * Simplified version of `create` for CIDv0.
   */
  static createV0(digest2) {
    return _CID.create(0, DAG_PB_CODE, digest2);
  }
  /**
   * Simplified version of `create` for CIDv1.
   *
   * @param code - Content encoding format code.
   * @param digest - Multihash of the content.
   */
  static createV1(code2, digest2) {
    return _CID.create(1, code2, digest2);
  }
  /**
   * Decoded a CID from its binary representation. The byte array must contain
   * only the CID with no additional bytes.
   *
   * An error will be thrown if the bytes provided do not contain a valid
   * binary representation of a CID.
   */
  static decode(bytes) {
    const [cid, remainder] = _CID.decodeFirst(bytes);
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
    const specs = _CID.inspectBytes(bytes);
    const prefixSize = specs.size - specs.multihashSize;
    const multihashBytes = coerce2(bytes.subarray(prefixSize, prefixSize + specs.multihashSize));
    if (multihashBytes.byteLength !== specs.multihashSize) {
      throw new Error("Incorrect length");
    }
    const digestBytes = multihashBytes.subarray(specs.multihashSize - specs.digestSize);
    const digest2 = new Digest(specs.multihashCode, specs.digestSize, digestBytes, multihashBytes);
    const cid = specs.version === 0 ? _CID.createV0(digest2) : _CID.createV1(specs.codec, digest2);
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
      const [i, length2] = decode3(initialBytes.subarray(offset));
      offset += length2;
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
  static parse(source, base3) {
    const [prefix, bytes] = parseCIDtoBytes(source, base3);
    const cid = _CID.decode(bytes);
    if (cid.version === 0 && source[0] !== "Q") {
      throw Error("Version 0 CID string must not include multibase prefix");
    }
    baseCache(cid).set(prefix, source);
    return cid;
  }
};
function parseCIDtoBytes(source, base3) {
  switch (source[0]) {
    // CIDv0 is parsed differently
    case "Q": {
      const decoder = base3 ?? base58btc;
      return [
        base58btc.prefix,
        decoder.decode(`${base58btc.prefix}${source}`)
      ];
    }
    case base58btc.prefix: {
      const decoder = base3 ?? base58btc;
      return [base58btc.prefix, decoder.decode(source)];
    }
    case base32.prefix: {
      const decoder = base3 ?? base32;
      return [base32.prefix, decoder.decode(source)];
    }
    case base36.prefix: {
      const decoder = base3 ?? base36;
      return [base36.prefix, decoder.decode(source)];
    }
    default: {
      if (base3 == null) {
        throw Error("To parse non base32, base36 or base58btc encoded CID multibase decoder must be provided");
      }
      return [source[0], base3.decode(source)];
    }
  }
}
function toStringV0(bytes, cache2, base3) {
  const { prefix } = base3;
  if (prefix !== base58btc.prefix) {
    throw Error(`Cannot string encode V0 in ${base3.name} encoding`);
  }
  const cid = cache2.get(prefix);
  if (cid == null) {
    const cid2 = base3.encode(bytes).slice(1);
    cache2.set(prefix, cid2);
    return cid2;
  } else {
    return cid;
  }
}
function toStringV1(bytes, cache2, base3) {
  const { prefix } = base3;
  const cid = cache2.get(prefix);
  if (cid == null) {
    const cid2 = base3.encode(bytes);
    cache2.set(prefix, cid2);
    return cid2;
  } else {
    return cid;
  }
}
var DAG_PB_CODE = 112;
var SHA_256_CODE = 18;
function encodeCID(version2, code2, multihash) {
  const codeOffset = encodingLength(version2);
  const hashOffset = codeOffset + encodingLength(code2);
  const bytes = new Uint8Array(hashOffset + multihash.byteLength);
  encodeTo(version2, bytes, 0);
  encodeTo(code2, bytes, codeOffset);
  bytes.set(multihash, hashOffset);
  return bytes;
}
var cidSymbol = /* @__PURE__ */ Symbol.for("@ipld/js-cid/CID");
var objectHasOwn = Object.hasOwn ?? Object.prototype.hasOwnProperty.call.bind(
  Object.prototype.hasOwnProperty
);
var textEncoder = new TextEncoder();
var objectHasOwn2 = Object.hasOwn ?? Object.prototype.hasOwnProperty.call.bind(
  Object.prototype.hasOwnProperty
);
var CEILING_SERVICES = /* @__PURE__ */ new Set(["tinycloud.kv", "tinycloud.sql", "tinycloud.vfs"]);
var GRANTABLE_ACTIONS = /* @__PURE__ */ new Map();
for (const entry of CAPABILITY_REGISTRY) {
  if (!CEILING_SERVICES.has(entry.service)) {
    continue;
  }
  if (entry.aliasOf !== void 0 || entry.implies !== void 0 || entry.urn.endsWith("/*")) {
    continue;
  }
  const existing = GRANTABLE_ACTIONS.get(entry.service);
  if (existing === void 0) {
    GRANTABLE_ACTIONS.set(entry.service, /* @__PURE__ */ new Set([entry.urn]));
    continue;
  }
  existing.add(entry.urn);
}
var base10_exports = {};
__export2(base10_exports, {
  base10: () => base10
});
var base10 = baseX({
  prefix: "9",
  name: "base10",
  alphabet: "0123456789"
});
var base16_exports = {};
__export2(base16_exports, {
  base16: () => base16,
  base16upper: () => base16upper
});
var base16 = rfc4648({
  prefix: "f",
  name: "base16",
  alphabet: "0123456789abcdef",
  bitsPerChar: 4
});
var base16upper = rfc4648({
  prefix: "F",
  name: "base16upper",
  alphabet: "0123456789ABCDEF",
  bitsPerChar: 4
});
var base2_exports = {};
__export2(base2_exports, {
  base2: () => base2
});
var base2 = rfc4648({
  prefix: "0",
  name: "base2",
  alphabet: "01",
  bitsPerChar: 1
});
var base256emoji_exports = {};
__export2(base256emoji_exports, {
  base256emoji: () => base256emoji
});
var alphabet = Array.from("\u{1F680}\u{1FA90}\u2604\u{1F6F0}\u{1F30C}\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}\u{1F30D}\u{1F30F}\u{1F30E}\u{1F409}\u2600\u{1F4BB}\u{1F5A5}\u{1F4BE}\u{1F4BF}\u{1F602}\u2764\u{1F60D}\u{1F923}\u{1F60A}\u{1F64F}\u{1F495}\u{1F62D}\u{1F618}\u{1F44D}\u{1F605}\u{1F44F}\u{1F601}\u{1F525}\u{1F970}\u{1F494}\u{1F496}\u{1F499}\u{1F622}\u{1F914}\u{1F606}\u{1F644}\u{1F4AA}\u{1F609}\u263A\u{1F44C}\u{1F917}\u{1F49C}\u{1F614}\u{1F60E}\u{1F607}\u{1F339}\u{1F926}\u{1F389}\u{1F49E}\u270C\u2728\u{1F937}\u{1F631}\u{1F60C}\u{1F338}\u{1F64C}\u{1F60B}\u{1F497}\u{1F49A}\u{1F60F}\u{1F49B}\u{1F642}\u{1F493}\u{1F929}\u{1F604}\u{1F600}\u{1F5A4}\u{1F603}\u{1F4AF}\u{1F648}\u{1F447}\u{1F3B6}\u{1F612}\u{1F92D}\u2763\u{1F61C}\u{1F48B}\u{1F440}\u{1F62A}\u{1F611}\u{1F4A5}\u{1F64B}\u{1F61E}\u{1F629}\u{1F621}\u{1F92A}\u{1F44A}\u{1F973}\u{1F625}\u{1F924}\u{1F449}\u{1F483}\u{1F633}\u270B\u{1F61A}\u{1F61D}\u{1F634}\u{1F31F}\u{1F62C}\u{1F643}\u{1F340}\u{1F337}\u{1F63B}\u{1F613}\u2B50\u2705\u{1F97A}\u{1F308}\u{1F608}\u{1F918}\u{1F4A6}\u2714\u{1F623}\u{1F3C3}\u{1F490}\u2639\u{1F38A}\u{1F498}\u{1F620}\u261D\u{1F615}\u{1F33A}\u{1F382}\u{1F33B}\u{1F610}\u{1F595}\u{1F49D}\u{1F64A}\u{1F639}\u{1F5E3}\u{1F4AB}\u{1F480}\u{1F451}\u{1F3B5}\u{1F91E}\u{1F61B}\u{1F534}\u{1F624}\u{1F33C}\u{1F62B}\u26BD\u{1F919}\u2615\u{1F3C6}\u{1F92B}\u{1F448}\u{1F62E}\u{1F646}\u{1F37B}\u{1F343}\u{1F436}\u{1F481}\u{1F632}\u{1F33F}\u{1F9E1}\u{1F381}\u26A1\u{1F31E}\u{1F388}\u274C\u270A\u{1F44B}\u{1F630}\u{1F928}\u{1F636}\u{1F91D}\u{1F6B6}\u{1F4B0}\u{1F353}\u{1F4A2}\u{1F91F}\u{1F641}\u{1F6A8}\u{1F4A8}\u{1F92C}\u2708\u{1F380}\u{1F37A}\u{1F913}\u{1F619}\u{1F49F}\u{1F331}\u{1F616}\u{1F476}\u{1F974}\u25B6\u27A1\u2753\u{1F48E}\u{1F4B8}\u2B07\u{1F628}\u{1F31A}\u{1F98B}\u{1F637}\u{1F57A}\u26A0\u{1F645}\u{1F61F}\u{1F635}\u{1F44E}\u{1F932}\u{1F920}\u{1F927}\u{1F4CC}\u{1F535}\u{1F485}\u{1F9D0}\u{1F43E}\u{1F352}\u{1F617}\u{1F911}\u{1F30A}\u{1F92F}\u{1F437}\u260E\u{1F4A7}\u{1F62F}\u{1F486}\u{1F446}\u{1F3A4}\u{1F647}\u{1F351}\u2744\u{1F334}\u{1F4A3}\u{1F438}\u{1F48C}\u{1F4CD}\u{1F940}\u{1F922}\u{1F445}\u{1F4A1}\u{1F4A9}\u{1F450}\u{1F4F8}\u{1F47B}\u{1F910}\u{1F92E}\u{1F3BC}\u{1F975}\u{1F6A9}\u{1F34E}\u{1F34A}\u{1F47C}\u{1F48D}\u{1F4E3}\u{1F942}");
var alphabetBytesToChars = alphabet.reduce((p, c, i) => {
  p[i] = c;
  return p;
}, []);
var alphabetCharsToBytes = alphabet.reduce((p, c, i) => {
  const codePoint = c.codePointAt(0);
  if (codePoint == null) {
    throw new Error(`Invalid character: ${c}`);
  }
  p[codePoint] = i;
  return p;
}, []);
function encode3(data) {
  return data.reduce((p, c) => {
    p += alphabetBytesToChars[c];
    return p;
  }, "");
}
function decode5(str) {
  const byts = [];
  for (const char of str) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null) {
      throw new Error(`Invalid character: ${char}`);
    }
    const byt = alphabetCharsToBytes[codePoint];
    if (byt == null) {
      throw new Error(`Non-base256emoji character: ${char}`);
    }
    byts.push(byt);
  }
  return new Uint8Array(byts);
}
var base256emoji = from({
  prefix: "\u{1F680}",
  name: "base256emoji",
  encode: encode3,
  decode: decode5
});
var base64_exports = {};
__export2(base64_exports, {
  base64: () => base64,
  base64pad: () => base64pad,
  base64url: () => base64url,
  base64urlpad: () => base64urlpad
});
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
var base8_exports = {};
__export2(base8_exports, {
  base8: () => base8
});
var base8 = rfc4648({
  prefix: "7",
  name: "base8",
  alphabet: "01234567",
  bitsPerChar: 3
});
var identity_exports = {};
__export2(identity_exports, {
  identity: () => identity
});
var identity = from({
  prefix: "\0",
  name: "identity",
  encode: (buf) => toString(buf),
  decode: (str) => fromString(str)
});
var textEncoder2 = new TextEncoder();
var textDecoder = new TextDecoder();
var identity_exports2 = {};
__export2(identity_exports2, {
  identity: () => identity2
});
var code = 0;
var name = "identity";
var encode4 = coerce2;
function digest(input, options2) {
  if (options2?.truncate != null && options2.truncate !== input.byteLength) {
    if (options2.truncate < 0 || options2.truncate > input.byteLength) {
      throw new Error(`Invalid truncate option, must be less than or equal to ${input.byteLength}`);
    }
    input = input.subarray(0, options2.truncate);
  }
  return create(code, encode4(input));
}
var identity2 = { code, name, encode: encode4, digest };
var sha2_exports = {};
__export2(sha2_exports, {
  sha256: () => sha2562,
  sha512: () => sha512
});
var DEFAULT_MIN_DIGEST_LENGTH = 20;
function from2({ name: name2, code: code2, encode: encode5, minDigestLength, maxDigestLength }) {
  return new Hasher(name2, code2, encode5, minDigestLength, maxDigestLength);
}
var Hasher = class {
  constructor(name2, code2, encode5, minDigestLength, maxDigestLength) {
    __publicField(this, "name");
    __publicField(this, "code");
    __publicField(this, "encode");
    __publicField(this, "minDigestLength");
    __publicField(this, "maxDigestLength");
    this.name = name2;
    this.code = code2;
    this.encode = encode5;
    this.minDigestLength = minDigestLength ?? DEFAULT_MIN_DIGEST_LENGTH;
    this.maxDigestLength = maxDigestLength;
  }
  digest(input, options2) {
    if (options2?.truncate != null) {
      if (options2.truncate < this.minDigestLength) {
        throw new Error(`Invalid truncate option, must be greater than or equal to ${this.minDigestLength}`);
      }
      if (this.maxDigestLength != null && options2.truncate > this.maxDigestLength) {
        throw new Error(`Invalid truncate option, must be less than or equal to ${this.maxDigestLength}`);
      }
    }
    if (input instanceof Uint8Array) {
      const result = this.encode(input);
      if (result instanceof Uint8Array) {
        return createDigest(result, this.code, options2?.truncate);
      }
      return result.then((digest2) => createDigest(digest2, this.code, options2?.truncate));
    } else {
      throw Error("Unknown type, must be binary type");
    }
  }
};
function createDigest(digest2, code2, truncate) {
  if (truncate != null && truncate !== digest2.byteLength) {
    if (truncate > digest2.byteLength) {
      throw new Error(`Invalid truncate option, must be less than or equal to ${digest2.byteLength}`);
    }
    digest2 = digest2.subarray(0, truncate);
  }
  return create(code2, digest2);
}
var sha2562 = from2({
  name: "sha2-256",
  code: 18,
  encode: (input) => coerce2(crypto2.createHash("sha256").update(input).digest())
});
var sha512 = from2({
  name: "sha2-512",
  code: 19,
  encode: (input) => coerce2(crypto2.createHash("sha512").update(input).digest())
});
var bases = { ...identity_exports, ...base2_exports, ...base8_exports, ...base10_exports, ...base16_exports, ...base32_exports, ...base36_exports, ...base58_exports, ...base64_exports, ...base256emoji_exports };
var hashes = { ...sha2_exports, ...identity_exports2 };
var textEncoder3 = new TextEncoder();
var objectHasOwn3 = Object.hasOwn ?? Object.prototype.hasOwnProperty.call.bind(
  Object.prototype.hasOwnProperty
);
var TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA = "xyz.tinycloud.exchange/transcript-bootstrap/v0";
var OWNER_NODE_ENDPOINT_SCHEMA = "xyz.tinycloud.exchange/owner-node-endpoint/v1";
var W3C_VC_CREDENTIAL_VERIFIER = "w3c.vc/credential/v1";
var objectHasOwn4 = Object.hasOwn ?? Object.prototype.hasOwnProperty.call.bind(
  Object.prototype.hasOwnProperty
);
var POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA = "xyz.tinycloud.policy/challenge/v0";
var POLICY_ENGINE_DENIAL_SCHEMA = "xyz.tinycloud.policy-engine/denial/v0";
var POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES = [
  "schema-invalid",
  "challenge-not-found",
  "challenge-expired",
  "challenge-nonce-consumed",
  "presentation-expired",
  "presentation-audience-mismatch",
  "presentation-evidence-missing",
  "digest-mismatch",
  "evidence-requirement-unknown",
  "evidence-requirement-duplicate",
  "holder-signature-invalid",
  "holder-signature-signer-mismatch",
  "id-mismatch",
  "requested-capabilities-exceeded",
  "requested-capabilities-hash-mismatch",
  "evidence-authority-missing",
  "evidence-credential-invalid",
  "evidence-domain-invalid",
  "evidence-domain-missing",
  "evidence-freshness-expired",
  "evidence-freshness-unestablishable",
  "evidence-issuer-missing",
  "evidence-issuer-untrusted",
  "evidence-presentation-invalid",
  "evidence-requirements-invalid",
  "evidence-verifier-unsupported",
  "enrollment-binding-mismatch",
  "enrollment-expired",
  "enrollment-not-yet-valid",
  "enrollment-out-of-scope",
  "enrollment-revoked",
  "enrollment-revoked-irreversible",
  "enrollment-status-rollback",
  "signature-invalid",
  "signer-not-authorized",
  "audience-mismatch",
  "capability-not-contained",
  "evidence-invalid",
  "evidence-missing",
  "evidence-stale",
  "evidence-subject-mismatch",
  "evidence-untrusted",
  "grant-ttl-exceeds-policy",
  "holder-did-mismatch",
  "holder-key-not-permitted",
  "holder-signature-invalid",
  "owner-mismatch",
  "policy-expired",
  "policy-inactive",
  "policy-not-found",
  "policy-not-satisfied",
  "policy-revoked",
  "policy-status-rollback",
  "rate-limited"
];
var JsonValueSchema = external_exports.lazy(
  () => external_exports.union([
    external_exports.string(),
    external_exports.number().finite(),
    external_exports.boolean(),
    external_exports.null(),
    external_exports.array(JsonValueSchema),
    external_exports.record(JsonValueSchema)
  ])
);
var Rfc3339Schema = external_exports.string().refine((value) => parseStrictRfc33392(value) !== void 0, {
  message: "must be strict RFC 3339 date-time with timezone"
});
var SignedRecordSchema = external_exports.object({
  schema: external_exports.string(),
  engineRecordId: external_exports.string(),
  ownerDid: external_exports.string(),
  endpoint: external_exports.string(),
  audience: external_exports.string(),
  supportedPolicyVersions: external_exports.array(external_exports.string()),
  supportedEvidenceVerifiers: external_exports.array(external_exports.string()),
  grantIssuerDid: external_exports.string(),
  expiresAt: Rfc3339Schema,
  signature: external_exports.object({
    suite: external_exports.string(),
    signerDid: external_exports.string(),
    value: external_exports.string()
  }).strict()
}).strict();
var PolicyEngineSchema = external_exports.object({
  endpoint: external_exports.string().url(),
  audience: external_exports.string(),
  supportedEvidenceVerifiers: external_exports.tuple([
    external_exports.literal(W3C_VC_CREDENTIAL_VERIFIER)
  ]),
  signedRecord: SignedRecordSchema
}).strict();
var OwnerNodeSchema = external_exports.object({
  schema: external_exports.literal(OWNER_NODE_ENDPOINT_SCHEMA),
  endpoint: external_exports.string().url(),
  spaceId: external_exports.string().min(1)
}).strict();
var ResourceHintSchema = external_exports.object({
  resourceType: external_exports.string(),
  resourceId: external_exports.string(),
  requestedCapabilities: external_exports.array(JsonValueSchema).min(1)
}).strict();
var BootstrapSchema = external_exports.object({
  schema: external_exports.literal(TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA),
  policyId: external_exports.string(),
  policyEngine: PolicyEngineSchema,
  ownerNode: OwnerNodeSchema,
  resourceHint: ResourceHintSchema
}).strict();
var SignatureSchema = external_exports.object({
  suite: external_exports.string(),
  signerDid: external_exports.string(),
  value: external_exports.string()
}).strict();
var ChallengeSchema = external_exports.object({
  schema: external_exports.literal(POLICY_ENGINE_CHALLENGE_RESPONSE_SCHEMA),
  challengeId: external_exports.string(),
  policyId: external_exports.string(),
  audience: external_exports.string(),
  nonce: external_exports.string().min(16),
  challengeExpiresAt: Rfc3339Schema,
  acceptedSuites: external_exports.array(external_exports.string()).min(1),
  requestedCapabilitiesTemplate: external_exports.array(JsonValueSchema).optional(),
  signature: SignatureSchema
}).strict();
var ChallengeResponseSchema = external_exports.object({ challenge: ChallengeSchema }).strict();
var DenialSchema = external_exports.object({
  schema: external_exports.literal(POLICY_ENGINE_DENIAL_SCHEMA),
  code: external_exports.enum(POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES),
  message: external_exports.string().optional()
}).strict();
var ErrorEnvelopeDenialSchema = external_exports.object({
  error: external_exports.object({
    code: external_exports.enum(POLICY_ENGINE_GRANT_PRESENTATION_DENIAL_CODES),
    message: external_exports.string().optional()
  }).strict()
}).strict();
var WireDelegationSchema = external_exports.object({
  delegationId: external_exports.string(),
  issuanceId: external_exports.string().min(1),
  issuerDid: external_exports.string(),
  holderDid: external_exports.string(),
  policyId: external_exports.string(),
  capabilityHashHex: external_exports.string().regex(/^[0-9a-f]{64}$/),
  revocationMode: external_exports.literal("refresh_only"),
  issuedAt: Rfc3339Schema,
  expiresAt: Rfc3339Schema,
  terminal: external_exports.boolean(),
  encoded: external_exports.string()
}).strict();
var ResolveResponseSchema = external_exports.object({ delegation: WireDelegationSchema }).strict();
var DelegateReceiptSchema = external_exports.object({
  cid: external_exports.string().min(1),
  activated: external_exports.array(external_exports.string()),
  skipped: external_exports.array(external_exports.string())
}).strict();
var SqlReadResponseSchema = external_exports.object({ rows: external_exports.array(JsonValueSchema) }).strict();
var KvReadResponseSchema = external_exports.object({ value: JsonValueSchema }).strict();
var LISTEN_SQL_STATEMENT_CATALOG = [
  {
    name: "listen.getConversation",
    sql: "SELECT id, title, source, source_id, source_url, started_at, ended_at, duration_secs, summary, metadata, transcript_json, transcript_text, created_at, updated_at FROM conversation WHERE id = ?",
    fixedParams: [{ index: 0, value: "{conversationId}" }]
  },
  {
    name: "listen.listParticipants",
    sql: "SELECT id, name, email, speaker_label FROM participant WHERE conversation_id = ? ORDER BY COALESCE(speaker_label, name), id",
    fixedParams: [{ index: 0, value: "{conversationId}" }]
  }
];
var LISTEN_SQL_STATEMENT_BY_NAME = new Map(
  LISTEN_SQL_STATEMENT_CATALOG.map((statement) => [
    statement.name,
    statement
  ])
);
function parseStrictRfc33392(value) {
  if (!/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
    value
  )) {
    return void 0;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return void 0;
  }
  const canonical = new Date(parsed).toISOString().replace(".000Z", "Z");
  const reparsed = Date.parse(value);
  return Date.parse(canonical) === reparsed ? parsed : void 0;
}
var ethereumAddressPattern = /^0x[a-fA-F0-9]{40}$/;
var EnsDataSchema2 = external_exports.object({
  /** ENS name/domain. */
  domain: external_exports.string().nullable().optional(),
  /** ENS avatar URL. */
  avatarUrl: external_exports.string().nullable().optional()
});
var PersistedTinyCloudSessionSchema = external_exports.object({
  /** The delegation header containing the UCAN */
  delegationHeader: external_exports.object({
    Authorization: external_exports.string()
  }),
  /** The delegation CID */
  delegationCid: external_exports.string(),
  /** The space ID for this session */
  spaceId: external_exports.string(),
  /** Additional spaces included in this session's capabilities. Key is logical name, value is full spaceId URI */
  spaces: external_exports.record(external_exports.string(), external_exports.string()).optional(),
  /** The verification method DID */
  verificationMethod: external_exports.string()
});
var PersistedSessionDataSchema = external_exports.object({
  /** User's Ethereum address */
  address: external_exports.string().regex(ethereumAddressPattern, "Invalid Ethereum address"),
  /** EIP-155 Chain ID */
  chainId: external_exports.number().int().positive(),
  /** Session key in JWK format (stringified) */
  sessionKey: external_exports.string(),
  /** The signed SIWE message */
  siwe: external_exports.string(),
  /** User's signature of the SIWE message */
  signature: external_exports.string(),
  /** TinyCloud delegation data if available */
  tinycloudSession: PersistedTinyCloudSessionSchema.optional(),
  /** Session expiration timestamp (ISO 8601 with timezone offset) */
  expiresAt: external_exports.string().datetime({ offset: true }),
  /** Session creation timestamp (ISO 8601 with timezone offset) */
  createdAt: external_exports.string().datetime({ offset: true }),
  /** Schema version for migrations */
  version: external_exports.string(),
  /** Optional ENS data */
  ens: EnsDataSchema2.optional(),
  /**
   * TinyCloud hosts this session was created against. Persisted so a
   * restored session resolves to the same node without re-running the
   * registry/fallback resolution (or the wallet sign-in flow). Optional
   * for backward compatibility with sessions persisted before this field
   * existed — those restore and lazily re-resolve their hosts.
   */
  tinycloudHosts: external_exports.array(external_exports.string()).optional()
});
var TinyCloudSessionSchema = external_exports.object({
  /** User's Ethereum address */
  address: external_exports.string().regex(ethereumAddressPattern, "Invalid Ethereum address"),
  /** EIP-155 Chain ID */
  chainId: external_exports.number().int().positive(),
  /** Session key ID */
  sessionKey: external_exports.string(),
  /** The space ID for this session */
  spaceId: external_exports.string(),
  /** Additional spaces included in this session's capabilities. Key is logical name, value is full spaceId URI */
  spaces: external_exports.record(external_exports.string(), external_exports.string()).optional(),
  /** The delegation CID */
  delegationCid: external_exports.string(),
  /** The delegation header for API calls */
  delegationHeader: external_exports.object({
    Authorization: external_exports.string()
  }),
  /** The verification method DID */
  verificationMethod: external_exports.string(),
  /** The session key JWK (required for invoke operations) */
  jwk: external_exports.object({}).passthrough(),
  /** The signed SIWE message */
  siwe: external_exports.string(),
  /** User's signature of the SIWE message */
  signature: external_exports.string()
});
var JWKSchema = external_exports.object({
  /** Key type (e.g., "EC", "RSA", "OKP") */
  kty: external_exports.string(),
  /** Curve for EC/OKP keys (e.g., "P-256", "Ed25519") */
  crv: external_exports.string().optional(),
  /** X coordinate for EC keys, public key for OKP */
  x: external_exports.string().optional(),
  /** Y coordinate for EC keys */
  y: external_exports.string().optional(),
  /** Private key value (d parameter) */
  d: external_exports.string().optional(),
  /** Public exponent for RSA keys */
  e: external_exports.string().optional(),
  /** Modulus for RSA keys */
  n: external_exports.string().optional(),
  /** Key ID */
  kid: external_exports.string().optional(),
  /** Algorithm */
  alg: external_exports.string().optional(),
  /** Key use (e.g., "sig", "enc") */
  use: external_exports.string().optional(),
  /** Key operations (e.g., ["sign", "verify"]) */
  key_ops: external_exports.array(external_exports.string()).optional()
});
var KeyTypeSchema = external_exports.enum(["main", "session", "ingested"]);
var KeyInfoSchema = external_exports.object({
  /** Unique identifier for this key */
  id: external_exports.string(),
  /** DID associated with this key */
  did: external_exports.string(),
  /** Type of key determining its authority level */
  type: KeyTypeSchema,
  /** Private key in JWK format */
  jwk: JWKSchema.optional(),
  /** Priority for key selection (lower = higher priority) */
  priority: external_exports.number()
});
var DelegationErrorSchema = external_exports.object({
  /** Error code for programmatic handling */
  code: external_exports.string(),
  /** Human-readable error message */
  message: external_exports.string(),
  /** The service that produced the error */
  service: external_exports.literal("delegation"),
  /** Original error if wrapping another error */
  cause: external_exports.instanceof(Error).optional(),
  /** Additional metadata about the error */
  meta: external_exports.record(external_exports.string(), external_exports.unknown()).optional()
});
var DelegationSchema = external_exports.object({
  /** Content identifier (CID) of the delegation */
  cid: external_exports.string(),
  /** DID of the delegate (the party receiving the delegation) */
  delegateDID: external_exports.string(),
  /** Space ID this delegation applies to */
  spaceId: external_exports.string(),
  /** Resource path this delegation grants access to */
  path: external_exports.string(),
  /** Actions this delegation authorizes */
  actions: external_exports.array(external_exports.string()),
  /** Exact ReCap caveats that constrain every action in this scope. */
  caveats: external_exports.array(external_exports.record(external_exports.string(), external_exports.unknown())).optional(),
  /** When this delegation expires (accepts Date or ISO string from JSON) */
  expiry: external_exports.coerce.date(),
  /** Whether this delegation has been revoked */
  isRevoked: external_exports.boolean(),
  /** DID of the delegator (the party granting the delegation) */
  delegatorDID: external_exports.string().optional(),
  /** When this delegation was created (accepts Date or ISO string from JSON) */
  createdAt: external_exports.coerce.date().optional(),
  /** Parent delegation CID if this is a sub-delegation */
  parentCid: external_exports.string().optional(),
  /** Whether sub-delegation is allowed */
  allowSubDelegation: external_exports.boolean().optional(),
  /** Authorization header (UCAN bearer token) */
  authHeader: external_exports.string().optional()
});
var DelegationStatusSchema = external_exports.object({
  cid: external_exports.string().min(1),
  status: external_exports.enum(["active", "revoked", "expired", "unavailable", "not_found"]),
  exists: external_exports.boolean(),
  active: external_exports.boolean(),
  revoked: external_exports.boolean(),
  expired: external_exports.boolean()
}).strict().superRefine((value, context) => {
  const valid = value.status === "active" ? value.exists && value.active && !value.revoked && !value.expired : value.status === "revoked" ? value.exists && !value.active && value.revoked && !value.expired : value.status === "expired" ? value.exists && !value.active && !value.revoked && value.expired : value.status === "unavailable" ? value.exists && !value.active && !value.revoked && !value.expired : !value.exists && !value.active && !value.revoked && !value.expired;
  if (!valid) {
    context.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "delegation status flags do not match status"
    });
  }
});
var CapabilityEntrySchema = external_exports.object({
  /** Resource URI this capability applies to */
  resource: external_exports.string(),
  /** Action this capability authorizes */
  action: external_exports.string(),
  /** Keys that can exercise this capability, ordered by priority */
  keys: external_exports.array(KeyInfoSchema),
  /** The delegation that grants this capability */
  delegation: DelegationSchema,
  /** When this capability expires (accepts Date or ISO string from JSON) */
  expiresAt: external_exports.coerce.date().optional()
});
var DelegationRecordSchema = external_exports.object({
  /** Content identifier (CID) of the delegation */
  cid: external_exports.string(),
  /** Space ID this delegation applies to */
  spaceId: external_exports.string(),
  /** DID of the delegator (grantor) */
  delegator: external_exports.string(),
  /** DID of the delegatee (recipient) */
  delegatee: external_exports.string(),
  /** Key ID used to sign/exercise this delegation */
  keyId: external_exports.string().optional(),
  /** Resource path pattern this delegation grants access to */
  path: external_exports.string(),
  /** Actions this delegation authorizes */
  actions: external_exports.array(external_exports.string()),
  /** When this delegation expires (accepts Date or ISO string from JSON) */
  expiry: external_exports.coerce.date().optional(),
  /** When this delegation becomes valid (not before) (accepts Date or ISO string) */
  notBefore: external_exports.coerce.date().optional(),
  /** Whether this delegation has been revoked */
  isRevoked: external_exports.boolean(),
  /** When this delegation was created (accepts Date or ISO string from JSON) */
  createdAt: external_exports.coerce.date(),
  /** Parent delegation CID if this is a sub-delegation */
  parentCid: external_exports.string().optional()
});
var CreateDelegationParamsSchema = external_exports.object({
  /** DID of the delegate (the party receiving the delegation) */
  delegateDID: external_exports.string(),
  /** Resource path this delegation grants access to */
  path: external_exports.string(),
  /** Actions to authorize */
  actions: external_exports.array(external_exports.string()),
  /** When this delegation expires (accepts Date or ISO string) */
  expiry: external_exports.coerce.date().optional(),
  /** Whether to disable sub-delegation */
  disableSubDelegation: external_exports.boolean().optional(),
  /** Optional statement for the SIWE message */
  statement: external_exports.string().optional()
});
var DelegationChainSchema = external_exports.array(DelegationSchema);
var DelegationChainV2Schema = external_exports.object({
  /** The root delegation from the original authority */
  root: DelegationSchema,
  /** Intermediate delegations in the chain (may be empty) */
  chain: external_exports.array(DelegationSchema),
  /** The final delegation to the current user */
  leaf: DelegationSchema
});
var DelegationDirectionSchema = external_exports.enum(["granted", "received", "all"]);
var DelegationFiltersSchema = external_exports.object({
  /** Filter by delegation direction */
  direction: DelegationDirectionSchema.optional(),
  /** Filter by resource path pattern */
  path: external_exports.string().optional(),
  /** Filter by required actions */
  actions: external_exports.array(external_exports.string()).optional(),
  /** Include revoked delegations */
  includeRevoked: external_exports.boolean().optional(),
  /** Filter by delegator DID */
  delegator: external_exports.string().optional(),
  /** Filter by delegatee DID */
  delegatee: external_exports.string().optional(),
  /** Only include delegations valid at this time */
  validAt: external_exports.coerce.date().optional(),
  /** Maximum number of results to return */
  limit: external_exports.number().optional(),
  /** Cursor for pagination */
  cursor: external_exports.string().optional()
});
var SpaceOwnershipSchema = external_exports.enum(["owned", "delegated"]);
var SpaceInfoSchema = external_exports.object({
  /** Space identifier */
  id: external_exports.string(),
  /** Human-readable name for the space */
  name: external_exports.string().optional(),
  /** DID of the space owner */
  owner: external_exports.string(),
  /** Whether user owns or has delegated access */
  type: SpaceOwnershipSchema,
  /** Permissions the user has in this space */
  permissions: external_exports.array(external_exports.string()).optional(),
  /** When the access expires (for delegated spaces) */
  expiresAt: external_exports.coerce.date().optional()
});
var ShareSchemaSchema = external_exports.enum(["base64", "compact", "ipfs"]);
var ShareLinkSchema = external_exports.object({
  /** Unique token identifying this share link */
  token: external_exports.string(),
  /** Full URL for sharing */
  url: external_exports.string(),
  /** The delegation this link grants access to */
  delegation: DelegationSchema,
  /** Encoding schema used for the link */
  schema: ShareSchemaSchema,
  /** When this share link expires */
  expiresAt: external_exports.coerce.date().optional(),
  /** Human-readable description of what is being shared */
  description: external_exports.string().optional()
});
function createShareLinkDataSchema(dataSchema) {
  return external_exports.object({
    /** The retrieved data */
    data: dataSchema,
    /** The delegation that authorized this access */
    delegation: DelegationSchema,
    /** The space the data belongs to */
    spaceId: external_exports.string(),
    /** The resource path that was accessed */
    path: external_exports.string()
  });
}
var ShareLinkDataSchema = createShareLinkDataSchema(external_exports.unknown());
var IngestOptionsSchema = external_exports.object({
  /** Whether to persist the delegation to storage */
  persist: external_exports.boolean().optional(),
  /** Whether to validate the full delegation chain */
  validateChain: external_exports.boolean().optional(),
  /** Name for the ingested key */
  keyName: external_exports.string().optional(),
  /** Whether to create a session key for this delegation */
  createSessionKey: external_exports.boolean().optional(),
  /** Override the priority for the ingested key */
  priority: external_exports.number().optional()
});
var GenerateShareParamsSchema = external_exports.object({
  /** Resource path to share */
  path: external_exports.string(),
  /** Actions to authorize */
  actions: external_exports.array(external_exports.string()).optional(),
  /** When the share link expires */
  expiry: external_exports.coerce.date().optional(),
  /** Encoding schema for the link */
  schema: ShareSchemaSchema.optional(),
  /** Human-readable description */
  description: external_exports.string().optional(),
  /** Base URL for the share link */
  baseUrl: external_exports.string().optional()
});
var DelegationManagerConfigSchema = external_exports.object({
  /** TinyCloud host URLs */
  hosts: external_exports.array(external_exports.string()),
  /** Active session for authentication */
  session: external_exports.unknown().refine(
    (val) => val !== null && typeof val === "object",
    { message: "Expected a ServiceSession object" }
  ),
  /** Platform-specific invoke function */
  invoke: external_exports.unknown().refine(
    (val) => typeof val === "function",
    { message: "Expected an invoke function" }
  ),
  /** Platform-specific invoke function for raw resource URIs */
  invokeAny: external_exports.unknown().refine(
    (val) => val === void 0 || typeof val === "function",
    { message: "Expected an invokeAny function or undefined" }
  ).optional(),
  /** Optional custom fetch implementation */
  fetch: external_exports.unknown().refine(
    (val) => val === void 0 || typeof val === "function",
    { message: "Expected a fetch function or undefined" }
  ).optional()
});
var KeyProviderSchema = external_exports.object({
  /** Generate a new session key, returns key ID */
  createSessionKey: external_exports.unknown().refine(
    (val) => typeof val === "function",
    { message: "Expected a function" }
  ),
  /** Get JWK for a key */
  getJWK: external_exports.unknown().refine(
    (val) => typeof val === "function",
    { message: "Expected a function" }
  ),
  /** Get DID for a key */
  getDID: external_exports.unknown().refine(
    (val) => typeof val === "function",
    { message: "Expected a function" }
  )
});
var DelegationApiResponseSchema = external_exports.object({
  /** SIWE message content */
  siwe: external_exports.string(),
  /** Signature of the SIWE message */
  signature: external_exports.string(),
  /** Delegation version */
  version: external_exports.number(),
  /** CID of the created delegation */
  cid: external_exports.string().optional()
});
var DelegatedResourceSchema = external_exports.object({
  /** Short-form service name, e.g. "kv", "sql", "duckdb", "capabilities", "hooks". */
  service: external_exports.string(),
  /** Full space id string, e.g. "tinycloud:pkh:eip155:1:0x....:default". */
  space: external_exports.string(),
  /** Resource path; empty string when the resource URI had no path segment. */
  path: external_exports.string(),
  /** Full-URN ability strings, e.g. ["tinycloud.kv/get", "tinycloud.kv/put"]. */
  actions: external_exports.array(external_exports.string()),
  /** Exact ReCap caveats that constrain every action in this scope. */
  caveats: external_exports.array(external_exports.record(external_exports.string(), external_exports.unknown())).optional()
});
var CreateDelegationWasmParamsSchema = external_exports.object({
  /** The session containing delegation credentials */
  session: external_exports.unknown().refine(
    (val) => val !== null && typeof val === "object",
    { message: "Expected a ServiceSession object" }
  ),
  /** DID of the delegate */
  delegateDID: external_exports.string(),
  /** Space ID this delegation applies to */
  spaceId: external_exports.string(),
  /**
   * Multi-resource abilities map: short-service → path → full-URN actions.
   * Matches the shape accepted by `prepareSession`.
   *
   * Example:
   * ```
   * {
   *   kv: {
   *     "com.listen.app/": ["tinycloud.kv/get", "tinycloud.kv/put"]
   *   },
   *   sql: {
   *     "com.listen.app/data.sqlite": ["tinycloud.sql/read"]
   *   }
   * }
   * ```
   */
  abilities: external_exports.record(external_exports.string(), external_exports.record(external_exports.string(), external_exports.array(external_exports.string()))),
  /** Expiration time in seconds since Unix epoch */
  expirationSecs: external_exports.number(),
  /** Optional not-before time in seconds since Unix epoch */
  notBeforeSecs: external_exports.number().optional()
});
var CreateDelegationWasmResultSchema = external_exports.object({
  /** Base64url-encoded UCAN delegation */
  delegation: external_exports.string(),
  /** CID of the delegation */
  cid: external_exports.string(),
  /** DID of the delegate */
  delegateDID: external_exports.string(),
  /** Expiration time */
  expiry: external_exports.coerce.date(),
  /**
   * All (service, space, path, actions) entries granted by this delegation.
   * Always non-empty on success.
   */
  resources: external_exports.array(DelegatedResourceSchema)
});
var SpaceConfigSchema = external_exports.object({
  /** The space identifier (full URI) */
  id: external_exports.string(),
  /** The short name of the space */
  name: external_exports.string(),
  /** Factory function to create a space-scoped KV service */
  createKV: external_exports.function(),
  /** Factory function to create a space-scoped Data Vault service */
  createVault: external_exports.function(),
  /** Optional factory function to create a space-scoped secrets service */
  createSecrets: external_exports.function().optional(),
  /** Factory function to create space-scoped delegations */
  createDelegations: external_exports.function(),
  /** Factory function to create space-scoped sharing */
  createSharing: external_exports.function(),
  /** Function to get space info */
  getInfo: external_exports.function()
});
var SpaceServiceConfigSchema = external_exports.object({
  /** TinyCloud host URLs */
  hosts: external_exports.array(external_exports.string()),
  /** Active session for authentication */
  session: external_exports.unknown(),
  /** Platform-specific invoke function */
  invoke: external_exports.function(),
  /** Optional custom fetch implementation */
  fetch: external_exports.function().optional(),
  /** Optional capability key registry for delegated space discovery */
  capabilityRegistry: external_exports.unknown().optional(),
  /** Factory function to create a space-scoped KV service */
  createKVService: external_exports.function().optional(),
  /** Factory function to create a space-scoped Data Vault service */
  createVaultService: external_exports.function().optional(),
  /** Factory function to create a space-scoped secrets service */
  createSecretsService: external_exports.function().optional(),
  /** User's PKH DID (derived from address or provided explicitly) */
  userDid: external_exports.string().optional(),
  /** Optional SharingService for v2 sharing links (client-side) */
  sharingService: external_exports.unknown().optional(),
  /** Factory function to create delegations using SIWE-based flow */
  createDelegation: external_exports.function().optional()
});
var SpaceDelegationParamsSchema = CreateDelegationParamsSchema.extend({
  /** The space ID to create the delegation for */
  spaceId: external_exports.string()
});
var ServerDelegationInfoSchema = external_exports.object({
  /** DID of the delegator */
  delegator: external_exports.string(),
  /** DID of the delegate */
  delegate: external_exports.string(),
  /** Parent delegation CIDs - accepts string or byte array format from server */
  parents: external_exports.array(external_exports.union([external_exports.string(), external_exports.array(external_exports.number())])),
  /** Expiration time (ISO8601 string) */
  expiry: external_exports.string().optional(),
  /** Not-before time (ISO8601 string) */
  not_before: external_exports.string().optional(),
  /** Issued-at time (ISO8601 string) */
  issued_at: external_exports.string().optional(),
  /** Capabilities granted by this delegation */
  capabilities: external_exports.array(
    external_exports.object({
      resource: external_exports.string(),
      ability: external_exports.string()
    })
  )
});
var ServerDelegationsResponseSchema = external_exports.record(
  external_exports.string(),
  ServerDelegationInfoSchema
);
var ServerOwnedSpaceSchema = external_exports.object({
  /** Space identifier */
  id: external_exports.string(),
  /** Space name (optional, can be derived from id) */
  name: external_exports.string().optional(),
  /** Owner DID */
  owner: external_exports.string(),
  /** Creation timestamp */
  createdAt: external_exports.string().optional()
});
var ServerOwnedSpacesResponseSchema = external_exports.array(ServerOwnedSpaceSchema);
var ServerCreateSpaceResponseSchema = external_exports.object({
  /** Space identifier */
  id: external_exports.string(),
  /** Space name */
  name: external_exports.string(),
  /** Owner DID */
  owner: external_exports.string(),
  /** Creation timestamp */
  createdAt: external_exports.string().optional()
});
var ServerSpaceInfoResponseSchema = external_exports.object({
  /** Space identifier */
  id: external_exports.string(),
  /** Space name (optional) */
  name: external_exports.string().optional(),
  /** Owner DID */
  owner: external_exports.string(),
  /** Ownership type */
  type: external_exports.enum(["owned", "delegated"]).optional(),
  /** Permissions the user has in this space */
  permissions: external_exports.array(external_exports.string()).optional(),
  /** Expiration for delegated access */
  expiresAt: external_exports.string().optional()
});
var EPHEMERAL_MS = 60 * 60 * 1e3;
var SIGNED_READ_URL_MS = 5 * 60 * 1e3;
var SESSION_MS = 7 * 24 * 60 * 60 * 1e3;
var SHARE_MS = 7 * 24 * 60 * 60 * 1e3;
var APP_MS = 30 * 24 * 60 * 60 * 1e3;
var MAX_MS = 10 * 365 * 24 * 60 * 60 * 1e3;
var EXPIRY = {
  EPHEMERAL_MS,
  SIGNED_READ_URL_MS,
  SESSION_MS,
  SHARE_MS,
  APP_MS,
  MAX_MS
};
var DEFAULT_SIGNED_READ_URL_EXPIRY_MS2 = EXPIRY.SIGNED_READ_URL_MS;
var DEFAULT_KNOWLEDGE_ROOT2 = "knowledge/index.md";
var ManifestValidationError2 = class extends Error {
  constructor(message) {
    super(`Manifest validation failed: ${message}`);
    this.name = "ManifestValidationError";
  }
};
var SERVICE_SHORT_TO_LONG2 = Object.freeze({
  kv: "tinycloud.kv",
  sql: "tinycloud.sql",
  duckdb: "tinycloud.duckdb",
  capabilities: "tinycloud.capabilities",
  hooks: "tinycloud.hooks",
  encryption: "tinycloud.encryption",
  delegation: "tinycloud.delegation"
});
var SERVICE_LONG_TO_SHORT2 = Object.freeze(
  Object.fromEntries(
    Object.entries(SERVICE_SHORT_TO_LONG2).map(([s, l]) => [l, s])
  )
);
function resolveManifestKnowledgeRoot2(knowledge) {
  if (knowledge === void 0) {
    return void 0;
  }
  if (knowledge === true) {
    return DEFAULT_KNOWLEDGE_ROOT2;
  }
  if (typeof knowledge !== "string" || knowledge.length === 0) {
    throw new ManifestValidationError2(
      "manifest.knowledge must be true or a knowledge/*.md root path"
    );
  }
  if (!/^knowledge\/.+\.md$/.test(knowledge)) {
    throw new ManifestValidationError2(
      "manifest.knowledge must be true or a knowledge/*.md root path"
    );
  }
  return knowledge;
}
var EncodedShareDataSchema = external_exports.object({
  /** Private key in JWK format (must include d parameter) */
  key: JWKSchema.refine(
    (jwk) => typeof jwk.d === "string" && jwk.d.length > 0,
    { message: "JWK must include private key (d parameter)" }
  ),
  /** DID of the key */
  keyDid: external_exports.string().min(1, "keyDid is required"),
  /** The delegation granting access */
  delegation: DelegationSchema,
  /** Resource path this link grants access to */
  path: external_exports.string().min(1, "path is required"),
  /** TinyCloud host URL */
  host: external_exports.string().url("host must be a valid URL"),
  /** Space ID */
  spaceId: external_exports.string().min(1, "spaceId is required"),
  /** Schema version (must be 1) */
  version: external_exports.literal(1)
});
var ReceiveOptionsSchema = external_exports.object({
  /**
   * Whether to automatically create a sub-delegation to the current session key.
   * Default: true
   */
  autoSubdelegate: external_exports.boolean().optional(),
  /**
   * Whether to use the current session key for operations (requires autoSubdelegate).
   * Default: true
   */
  useSessionKey: external_exports.boolean().optional(),
  /**
   * Ingestion options passed to CapabilityKeyRegistry.
   */
  ingestOptions: IngestOptionsSchema.optional()
});
var SharingServiceConfigSchema = external_exports.object({
  /** TinyCloud host URLs */
  hosts: external_exports.array(external_exports.string().url()).min(1, "At least one host URL is required"),
  /**
   * Active session for authentication.
   * Required for generate(), optional for receive().
   */
  session: external_exports.unknown().refine(
    (val) => val === void 0 || val !== null && typeof val === "object",
    { message: "Expected a ServiceSession object or undefined" }
  ).optional(),
  /** Platform-specific invoke function */
  invoke: external_exports.unknown().refine((val) => typeof val === "function", {
    message: "Expected an invoke function"
  }),
  /** Optional custom fetch implementation */
  fetch: external_exports.unknown().refine(
    (val) => val === void 0 || typeof val === "function",
    { message: "Expected a fetch function or undefined" }
  ).optional(),
  /** Key provider for cryptographic operations */
  keyProvider: KeyProviderSchema,
  /** Capability key registry for key/delegation management */
  registry: external_exports.unknown().refine(
    (val) => val !== null && typeof val === "object",
    { message: "Expected an ICapabilityKeyRegistry object" }
  ),
  /**
   * Delegation manager for creating delegations.
   * Required for generate(), optional for receive().
   */
  delegationManager: external_exports.unknown().refine(
    (val) => val === void 0 || val !== null && typeof val === "object",
    { message: "Expected a DelegationManager object or undefined" }
  ).optional(),
  /** Factory for creating KV service instances */
  createKVService: external_exports.unknown().refine(
    (val) => typeof val === "function",
    { message: "Expected a createKVService factory function" }
  ),
  /** Base URL for sharing links (e.g., "https://share.myapp.com") */
  baseUrl: external_exports.string().optional(),
  /**
   * Custom delegation creation function.
   */
  createDelegation: external_exports.unknown().refine((val) => val === void 0 || typeof val === "function", {
    message: "Expected a createDelegation function or undefined"
  }).optional(),
  /**
   * WASM function for client-side delegation creation.
   */
  createDelegationWasm: external_exports.unknown().refine((val) => val === void 0 || typeof val === "function", {
    message: "Expected a createDelegationWasm function or undefined"
  }).optional(),
  /** CID computation used to verify transportable child delegations. */
  computeCid: external_exports.unknown().refine((val) => val === void 0 || typeof val === "function", {
    message: "Expected a computeCid function or undefined"
  }).optional(),
  /**
   * Path prefix for KV operations.
   */
  pathPrefix: external_exports.string().optional(),
  /**
   * Session expiry time.
   */
  sessionExpiry: external_exports.date().optional(),
  /**
   * Callback to create a DIRECT delegation from wallet to share key.
   * This is the preferred method for long-lived share links because it
   * bypasses the session delegation chain entirely.
   */
  onRootDelegationNeeded: external_exports.unknown().refine((val) => val === void 0 || typeof val === "function", {
    message: "Expected an onRootDelegationNeeded function or undefined"
  }).optional()
});
var DEFAULT_EXPIRY_MS2 = EXPIRY.SHARE_MS;
var AutoApproveSpaceCreationHandler = class {
  /**
   * Always returns true to auto-approve space creation.
   */
  async confirmSpaceCreation() {
    return true;
  }
};
var defaultSpaceCreationHandler = new AutoApproveSpaceCreationHandler();
function equals3(a, b) {
  if (a === b) {
    return true;
  }
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
function asUint8Array(buf) {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function allocUnsafe(size = 0) {
  return asUint8Array(Buffer2.allocUnsafe(size));
}
var N12 = Math.pow(2, 7);
var N22 = Math.pow(2, 14);
var N32 = Math.pow(2, 21);
var N42 = Math.pow(2, 28);
var N52 = Math.pow(2, 35);
var N62 = Math.pow(2, 42);
var N72 = Math.pow(2, 49);
var MSB2 = 128;
var REST2 = 127;
function encodingLength2(value) {
  if (value < N12) {
    return 1;
  }
  if (value < N22) {
    return 2;
  }
  if (value < N32) {
    return 3;
  }
  if (value < N42) {
    return 4;
  }
  if (value < N52) {
    return 5;
  }
  if (value < N62) {
    return 6;
  }
  if (value < N72) {
    return 7;
  }
  if (Number.MAX_SAFE_INTEGER != null && value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Could not encode varint");
  }
  return 8;
}
function encodeUint8Array(value, buf, offset = 0) {
  switch (encodingLength2(value)) {
    case 8: {
      buf[offset++] = value & 255 | MSB2;
      value /= 128;
    }
    case 7: {
      buf[offset++] = value & 255 | MSB2;
      value /= 128;
    }
    case 6: {
      buf[offset++] = value & 255 | MSB2;
      value /= 128;
    }
    case 5: {
      buf[offset++] = value & 255 | MSB2;
      value /= 128;
    }
    case 4: {
      buf[offset++] = value & 255 | MSB2;
      value >>>= 7;
    }
    case 3: {
      buf[offset++] = value & 255 | MSB2;
      value >>>= 7;
    }
    case 2: {
      buf[offset++] = value & 255 | MSB2;
      value >>>= 7;
    }
    case 1: {
      buf[offset++] = value & 255;
      value >>>= 7;
      break;
    }
    default:
      throw new Error("unreachable");
  }
  return buf;
}
function decodeUint8Array(buf, offset) {
  let b = buf[offset];
  let res = 0;
  res += b & REST2;
  if (b < MSB2) {
    return res;
  }
  b = buf[offset + 1];
  res += (b & REST2) << 7;
  if (b < MSB2) {
    return res;
  }
  b = buf[offset + 2];
  res += (b & REST2) << 14;
  if (b < MSB2) {
    return res;
  }
  b = buf[offset + 3];
  res += (b & REST2) << 21;
  if (b < MSB2) {
    return res;
  }
  b = buf[offset + 4];
  res += (b & REST2) * N42;
  if (b < MSB2) {
    return res;
  }
  b = buf[offset + 5];
  res += (b & REST2) * N52;
  if (b < MSB2) {
    return res;
  }
  b = buf[offset + 6];
  res += (b & REST2) * N62;
  if (b < MSB2) {
    return res;
  }
  b = buf[offset + 7];
  res += (b & REST2) * N72;
  if (b < MSB2) {
    return res;
  }
  throw new RangeError("Could not decode varint");
}
function decodeUint8ArrayList(buf, offset) {
  let b = buf.get(offset);
  let res = 0;
  res += b & REST2;
  if (b < MSB2) {
    return res;
  }
  b = buf.get(offset + 1);
  res += (b & REST2) << 7;
  if (b < MSB2) {
    return res;
  }
  b = buf.get(offset + 2);
  res += (b & REST2) << 14;
  if (b < MSB2) {
    return res;
  }
  b = buf.get(offset + 3);
  res += (b & REST2) << 21;
  if (b < MSB2) {
    return res;
  }
  b = buf.get(offset + 4);
  res += (b & REST2) * N42;
  if (b < MSB2) {
    return res;
  }
  b = buf.get(offset + 5);
  res += (b & REST2) * N52;
  if (b < MSB2) {
    return res;
  }
  b = buf.get(offset + 6);
  res += (b & REST2) * N62;
  if (b < MSB2) {
    return res;
  }
  b = buf.get(offset + 7);
  res += (b & REST2) * N72;
  if (b < MSB2) {
    return res;
  }
  throw new RangeError("Could not decode varint");
}
function decode6(buf, offset = 0) {
  if (buf instanceof Uint8Array) {
    return decodeUint8Array(buf, offset);
  } else {
    return decodeUint8ArrayList(buf, offset);
  }
}
function concat(arrays, length2) {
  return asUint8Array(Buffer3.concat(arrays, length2));
}
function createCodec(name2, prefix, encode5, decode7) {
  return {
    name: name2,
    prefix,
    encoder: {
      name: name2,
      prefix,
      encode: encode5
    },
    decoder: {
      decode: decode7
    }
  };
}
var string = createCodec("utf8", "u", (buf) => {
  const decoder = new TextDecoder("utf8");
  return "u" + decoder.decode(buf);
}, (str) => {
  const encoder = new TextEncoder();
  return encoder.encode(str.substring(1));
});
var ascii = createCodec("ascii", "a", (buf) => {
  let string2 = "a";
  for (let i = 0; i < buf.length; i++) {
    string2 += String.fromCharCode(buf[i]);
  }
  return string2;
}, (str) => {
  str = str.substring(1);
  const buf = allocUnsafe(str.length);
  for (let i = 0; i < str.length; i++) {
    buf[i] = str.charCodeAt(i);
  }
  return buf;
});
var BASES = {
  utf8: string,
  "utf-8": string,
  hex: bases.base16,
  latin1: ascii,
  ascii,
  binary: ascii,
  ...bases
};
var bases_default = BASES;
function fromString2(string2, encoding = "utf8") {
  const base3 = bases_default[encoding];
  if (base3 == null) {
    throw new Error(`Unsupported encoding "${encoding}"`);
  }
  if (encoding === "utf8" || encoding === "utf-8") {
    return asUint8Array(Buffer4.from(string2, "utf-8"));
  }
  return base3.decoder.decode(`${base3.prefix}${string2}`);
}
function toString2(array, encoding = "utf8") {
  const base3 = bases_default[encoding];
  if (base3 == null) {
    throw new Error(`Unsupported encoding "${encoding}"`);
  }
  if (encoding === "utf8" || encoding === "utf-8") {
    return Buffer5.from(array.buffer, array.byteOffset, array.byteLength).toString("utf8");
  }
  return base3.encoder.encode(array).substring(1);
}
var InvalidMultiaddrError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "InvalidMultiaddrError");
  }
};
__publicField(InvalidMultiaddrError, "name", "InvalidMultiaddrError");
var ValidationError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "ValidationError");
  }
};
__publicField(ValidationError, "name", "ValidationError");
var InvalidParametersError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "InvalidParametersError");
  }
};
__publicField(InvalidParametersError, "name", "InvalidParametersError");
var UnknownProtocolError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "UnknownProtocolError");
  }
};
__publicField(UnknownProtocolError, "name", "UnknownProtocolError");
var CODE_IP4 = 4;
var CODE_TCP = 6;
var CODE_UDP = 273;
var CODE_DCCP = 33;
var CODE_IP6 = 41;
var CODE_IP6ZONE = 42;
var CODE_IPCIDR = 43;
var CODE_DNS = 53;
var CODE_DNS4 = 54;
var CODE_DNS6 = 55;
var CODE_DNSADDR = 56;
var CODE_SCTP = 132;
var CODE_UDT = 301;
var CODE_UTP = 302;
var CODE_UNIX = 400;
var CODE_P2P = 421;
var CODE_ONION = 444;
var CODE_ONION3 = 445;
var CODE_GARLIC64 = 446;
var CODE_GARLIC32 = 447;
var CODE_TLS = 448;
var CODE_SNI = 449;
var CODE_NOISE = 454;
var CODE_QUIC = 460;
var CODE_QUIC_V1 = 461;
var CODE_WEBTRANSPORT = 465;
var CODE_CERTHASH = 466;
var CODE_HTTP = 480;
var CODE_HTTP_PATH = 481;
var CODE_HTTPS = 443;
var CODE_WS = 477;
var CODE_WSS = 478;
var CODE_P2P_WEBSOCKET_STAR = 479;
var CODE_P2P_STARDUST = 277;
var CODE_P2P_WEBRTC_STAR = 275;
var CODE_P2P_WEBRTC_DIRECT = 276;
var CODE_WEBRTC_DIRECT = 280;
var CODE_WEBRTC = 281;
var CODE_P2P_CIRCUIT = 290;
var CODE_MEMORY = 777;
function bytesToString(base3) {
  return (buf) => {
    return toString2(buf, base3);
  };
}
function stringToBytes(base3) {
  return (buf) => {
    return fromString2(buf, base3);
  };
}
function bytes2port(buf) {
  const view = new DataView(buf.buffer);
  return view.getUint16(buf.byteOffset).toString();
}
function port2bytes(port) {
  const buf = new ArrayBuffer(2);
  const view = new DataView(buf);
  view.setUint16(0, typeof port === "string" ? parseInt(port) : port);
  return new Uint8Array(buf);
}
function onion2bytes(str) {
  const addr = str.split(":");
  if (addr.length !== 2) {
    throw new Error(`failed to parse onion addr: ["'${addr.join('", "')}'"]' does not contain a port number`);
  }
  if (addr[0].length !== 16) {
    throw new Error(`failed to parse onion addr: ${addr[0]} not a Tor onion address.`);
  }
  const buf = fromString2(addr[0], "base32");
  const port = parseInt(addr[1], 10);
  if (port < 1 || port > 65536) {
    throw new Error("Port number is not in range(1, 65536)");
  }
  const portBuf = port2bytes(port);
  return concat([buf, portBuf], buf.length + portBuf.length);
}
function onion32bytes(str) {
  const addr = str.split(":");
  if (addr.length !== 2) {
    throw new Error(`failed to parse onion addr: ["'${addr.join('", "')}'"]' does not contain a port number`);
  }
  if (addr[0].length !== 56) {
    throw new Error(`failed to parse onion addr: ${addr[0]} not a Tor onion3 address.`);
  }
  const buf = base32.decode(`b${addr[0]}`);
  const port = parseInt(addr[1], 10);
  if (port < 1 || port > 65536) {
    throw new Error("Port number is not in range(1, 65536)");
  }
  const portBuf = port2bytes(port);
  return concat([buf, portBuf], buf.length + portBuf.length);
}
function bytes2onion(buf) {
  const addrBytes = buf.subarray(0, buf.length - 2);
  const portBytes = buf.subarray(buf.length - 2);
  const addr = toString2(addrBytes, "base32");
  const port = bytes2port(portBytes);
  return `${addr}:${port}`;
}
var ip4ToBytes = function(ip) {
  ip = ip.toString().trim();
  const bytes = new Uint8Array(4);
  ip.split(/\./g).forEach((byte, index) => {
    const value = parseInt(byte, 10);
    if (isNaN(value) || value < 0 || value > 255) {
      throw new InvalidMultiaddrError("Invalid byte value in IP address");
    }
    bytes[index] = value;
  });
  return bytes;
};
var ip6ToBytes = function(ip) {
  let offset = 0;
  ip = ip.toString().trim();
  const sections = ip.split(":", 8);
  let i;
  for (i = 0; i < sections.length; i++) {
    const isv4 = isIPv4(sections[i]);
    let v4Buffer;
    if (isv4) {
      v4Buffer = ip4ToBytes(sections[i]);
      sections[i] = toString2(v4Buffer.subarray(0, 2), "base16");
    }
    if (v4Buffer != null && ++i < 8) {
      sections.splice(i, 0, toString2(v4Buffer.subarray(2, 4), "base16"));
    }
  }
  if (sections[0] === "") {
    while (sections.length < 8) {
      sections.unshift("0");
    }
  } else if (sections[sections.length - 1] === "") {
    while (sections.length < 8) {
      sections.push("0");
    }
  } else if (sections.length < 8) {
    for (i = 0; i < sections.length && sections[i] !== ""; i++) {
    }
    const argv = [i, 1];
    for (i = 9 - sections.length; i > 0; i--) {
      argv.push("0");
    }
    sections.splice.apply(sections, argv);
  }
  const bytes = new Uint8Array(offset + 16);
  for (i = 0; i < sections.length; i++) {
    if (sections[i] === "") {
      sections[i] = "0";
    }
    const word2 = parseInt(sections[i], 16);
    if (isNaN(word2) || word2 < 0 || word2 > 65535) {
      throw new InvalidMultiaddrError("Invalid byte value in IP address");
    }
    bytes[offset++] = word2 >> 8 & 255;
    bytes[offset++] = word2 & 255;
  }
  return bytes;
};
var ip4ToString = function(buf) {
  if (buf.byteLength !== 4) {
    throw new InvalidMultiaddrError("IPv4 address was incorrect length");
  }
  const result = [];
  for (let i = 0; i < buf.byteLength; i++) {
    result.push(buf[i]);
  }
  return result.join(".");
};
var ip6ToString = function(buf) {
  if (buf.byteLength !== 16) {
    throw new InvalidMultiaddrError("IPv6 address was incorrect length");
  }
  const result = [];
  for (let i = 0; i < buf.byteLength; i += 2) {
    const byte1 = buf[i];
    const byte2 = buf[i + 1];
    const tuple = `${byte1.toString(16).padStart(2, "0")}${byte2.toString(16).padStart(2, "0")}`;
    result.push(tuple);
  }
  const ip = result.join(":");
  try {
    const url = new URL(`http://[${ip}]`);
    return url.hostname.substring(1, url.hostname.length - 1);
  } catch {
    throw new InvalidMultiaddrError(`Invalid IPv6 address "${ip}"`);
  }
};
function ip6StringToValue(str) {
  try {
    const url = new URL(`http://[${str}]`);
    return url.hostname.substring(1, url.hostname.length - 1);
  } catch {
    throw new InvalidMultiaddrError(`Invalid IPv6 address "${str}"`);
  }
}
var decoders = Object.values(bases).map((c) => c.decoder);
var anybaseDecoder = (function() {
  let acc = decoders[0].or(decoders[1]);
  decoders.slice(2).forEach((d) => acc = acc.or(d));
  return acc;
})();
function mb2bytes(mbstr) {
  return anybaseDecoder.decode(mbstr);
}
function bytes2mb(base3) {
  return (buf) => {
    return base3.encoder.encode(buf);
  };
}
function integer(value) {
  const int = parseInt(value);
  if (int.toString() !== value) {
    throw new ValidationError("Value must be an integer");
  }
}
function positive(value) {
  if (value < 0) {
    throw new ValidationError("Value must be a positive integer, or zero");
  }
}
function maxValue(max) {
  return (value) => {
    if (value > max) {
      throw new ValidationError(`Value must be smaller than or equal to ${max}`);
    }
  };
}
function validate(...funcs) {
  return (value) => {
    for (const fn of funcs) {
      fn(value);
    }
  };
}
var validatePort = validate(integer, positive, maxValue(65535));
var V = -1;
var Registry = class {
  constructor() {
    __publicField(this, "protocolsByCode", /* @__PURE__ */ new Map());
    __publicField(this, "protocolsByName", /* @__PURE__ */ new Map());
  }
  getProtocol(key) {
    let codec;
    if (typeof key === "string") {
      codec = this.protocolsByName.get(key);
    } else {
      codec = this.protocolsByCode.get(key);
    }
    if (codec == null) {
      throw new UnknownProtocolError(`Protocol ${key} was unknown`);
    }
    return codec;
  }
  addProtocol(codec) {
    this.protocolsByCode.set(codec.code, codec);
    this.protocolsByName.set(codec.name, codec);
    codec.aliases?.forEach((alias) => {
      this.protocolsByName.set(alias, codec);
    });
  }
  removeProtocol(code2) {
    const codec = this.protocolsByCode.get(code2);
    if (codec == null) {
      return;
    }
    this.protocolsByCode.delete(codec.code);
    this.protocolsByName.delete(codec.name);
    codec.aliases?.forEach((alias) => {
      this.protocolsByName.delete(alias);
    });
  }
};
var registry = new Registry();
var codecs = [{
  code: CODE_IP4,
  name: "ip4",
  size: 32,
  valueToBytes: ip4ToBytes,
  bytesToValue: ip4ToString,
  validate: (value) => {
    if (!isIPv4(value)) {
      throw new ValidationError(`Invalid IPv4 address "${value}"`);
    }
  }
}, {
  code: CODE_TCP,
  name: "tcp",
  size: 16,
  valueToBytes: port2bytes,
  bytesToValue: bytes2port,
  validate: validatePort
}, {
  code: CODE_UDP,
  name: "udp",
  size: 16,
  valueToBytes: port2bytes,
  bytesToValue: bytes2port,
  validate: validatePort
}, {
  code: CODE_DCCP,
  name: "dccp",
  size: 16,
  valueToBytes: port2bytes,
  bytesToValue: bytes2port,
  validate: validatePort
}, {
  code: CODE_IP6,
  name: "ip6",
  size: 128,
  valueToBytes: ip6ToBytes,
  bytesToValue: ip6ToString,
  stringToValue: ip6StringToValue,
  validate: (value) => {
    if (!isIPv6(value)) {
      throw new ValidationError(`Invalid IPv6 address "${value}"`);
    }
  }
}, {
  code: CODE_IP6ZONE,
  name: "ip6zone",
  size: V
}, {
  code: CODE_IPCIDR,
  name: "ipcidr",
  size: 8,
  bytesToValue: bytesToString("base10"),
  valueToBytes: stringToBytes("base10")
}, {
  code: CODE_DNS,
  name: "dns",
  size: V
}, {
  code: CODE_DNS4,
  name: "dns4",
  size: V
}, {
  code: CODE_DNS6,
  name: "dns6",
  size: V
}, {
  code: CODE_DNSADDR,
  name: "dnsaddr",
  size: V
}, {
  code: CODE_SCTP,
  name: "sctp",
  size: 16,
  valueToBytes: port2bytes,
  bytesToValue: bytes2port,
  validate: validatePort
}, {
  code: CODE_UDT,
  name: "udt"
}, {
  code: CODE_UTP,
  name: "utp"
}, {
  code: CODE_UNIX,
  name: "unix",
  size: V,
  stringToValue: (str) => decodeURIComponent(str),
  valueToString: (val) => encodeURIComponent(val)
}, {
  code: CODE_P2P,
  name: "p2p",
  aliases: ["ipfs"],
  size: V,
  bytesToValue: bytesToString("base58btc"),
  valueToBytes: (val) => {
    if (val.startsWith("Q") || val.startsWith("1")) {
      return stringToBytes("base58btc")(val);
    }
    return CID.parse(val).multihash.bytes;
  }
}, {
  code: CODE_ONION,
  name: "onion",
  size: 96,
  bytesToValue: bytes2onion,
  valueToBytes: onion2bytes
}, {
  code: CODE_ONION3,
  name: "onion3",
  size: 296,
  bytesToValue: bytes2onion,
  valueToBytes: onion32bytes
}, {
  code: CODE_GARLIC64,
  name: "garlic64",
  size: V
}, {
  code: CODE_GARLIC32,
  name: "garlic32",
  size: V
}, {
  code: CODE_TLS,
  name: "tls"
}, {
  code: CODE_SNI,
  name: "sni",
  size: V
}, {
  code: CODE_NOISE,
  name: "noise"
}, {
  code: CODE_QUIC,
  name: "quic"
}, {
  code: CODE_QUIC_V1,
  name: "quic-v1"
}, {
  code: CODE_WEBTRANSPORT,
  name: "webtransport"
}, {
  code: CODE_CERTHASH,
  name: "certhash",
  size: V,
  bytesToValue: bytes2mb(base64url),
  valueToBytes: mb2bytes
}, {
  code: CODE_HTTP,
  name: "http"
}, {
  code: CODE_HTTP_PATH,
  name: "http-path",
  size: V,
  stringToValue: (str) => `/${decodeURIComponent(str)}`,
  valueToString: (val) => encodeURIComponent(val.substring(1))
}, {
  code: CODE_HTTPS,
  name: "https"
}, {
  code: CODE_WS,
  name: "ws"
}, {
  code: CODE_WSS,
  name: "wss"
}, {
  code: CODE_P2P_WEBSOCKET_STAR,
  name: "p2p-websocket-star"
}, {
  code: CODE_P2P_STARDUST,
  name: "p2p-stardust"
}, {
  code: CODE_P2P_WEBRTC_STAR,
  name: "p2p-webrtc-star"
}, {
  code: CODE_P2P_WEBRTC_DIRECT,
  name: "p2p-webrtc-direct"
}, {
  code: CODE_WEBRTC_DIRECT,
  name: "webrtc-direct"
}, {
  code: CODE_WEBRTC,
  name: "webrtc"
}, {
  code: CODE_P2P_CIRCUIT,
  name: "p2p-circuit"
}, {
  code: CODE_MEMORY,
  name: "memory",
  size: V
}];
codecs.forEach((codec) => {
  registry.addProtocol(codec);
});
function bytesToComponents(bytes) {
  const components = [];
  let i = 0;
  while (i < bytes.length) {
    const code2 = decode6(bytes, i);
    const codec = registry.getProtocol(code2);
    const codeLength = encodingLength2(code2);
    const size = sizeForAddr(codec, bytes, i + codeLength);
    let sizeLength = 0;
    if (size > 0 && codec.size === V) {
      sizeLength = encodingLength2(size);
    }
    const componentLength = codeLength + sizeLength + size;
    const component = {
      code: code2,
      name: codec.name,
      bytes: bytes.subarray(i, i + componentLength)
    };
    if (size > 0) {
      const valueOffset = i + codeLength + sizeLength;
      const valueBytes = bytes.subarray(valueOffset, valueOffset + size);
      component.value = codec.bytesToValue?.(valueBytes) ?? toString2(valueBytes);
    }
    components.push(component);
    i += componentLength;
  }
  return components;
}
function componentsToBytes(components) {
  let length2 = 0;
  const bytes = [];
  for (const component of components) {
    if (component.bytes == null) {
      const codec = registry.getProtocol(component.code);
      const codecLength = encodingLength2(component.code);
      let valueBytes;
      let valueLength = 0;
      let valueLengthLength = 0;
      if (component.value != null) {
        valueBytes = codec.valueToBytes?.(component.value) ?? fromString2(component.value);
        valueLength = valueBytes.byteLength;
        if (codec.size === V) {
          valueLengthLength = encodingLength2(valueLength);
        }
      }
      const bytes2 = new Uint8Array(codecLength + valueLengthLength + valueLength);
      let offset = 0;
      encodeUint8Array(component.code, bytes2, offset);
      offset += codecLength;
      if (valueBytes != null) {
        if (codec.size === V) {
          encodeUint8Array(valueLength, bytes2, offset);
          offset += valueLengthLength;
        }
        bytes2.set(valueBytes, offset);
      }
      component.bytes = bytes2;
    }
    bytes.push(component.bytes);
    length2 += component.bytes.byteLength;
  }
  return concat(bytes, length2);
}
function stringToComponents(string2) {
  if (string2.charAt(0) !== "/") {
    throw new InvalidMultiaddrError('String multiaddr must start with "/"');
  }
  const components = [];
  let collecting = "protocol";
  let value = "";
  let protocol = "";
  for (let i = 1; i < string2.length; i++) {
    const char = string2.charAt(i);
    if (char !== "/") {
      if (collecting === "protocol") {
        protocol += string2.charAt(i);
      } else {
        value += string2.charAt(i);
      }
    }
    const ended = i === string2.length - 1;
    if (char === "/" || ended) {
      const codec = registry.getProtocol(protocol);
      if (collecting === "protocol") {
        if (codec.size == null || codec.size === 0) {
          components.push({
            code: codec.code,
            name: codec.name
          });
          value = "";
          protocol = "";
          collecting = "protocol";
          continue;
        } else if (ended) {
          throw new InvalidMultiaddrError(`Component ${protocol} was missing value`);
        }
        collecting = "value";
      } else if (collecting === "value") {
        const component = {
          code: codec.code,
          name: codec.name
        };
        if (codec.size != null && codec.size !== 0) {
          if (value === "") {
            throw new InvalidMultiaddrError(`Component ${protocol} was missing value`);
          }
          component.value = codec.stringToValue?.(value) ?? value;
        }
        components.push(component);
        value = "";
        protocol = "";
        collecting = "protocol";
      }
    }
  }
  if (protocol !== "" && value !== "") {
    throw new InvalidMultiaddrError("Incomplete multiaddr");
  }
  return components;
}
function componentsToString(components) {
  return `/${components.flatMap((component) => {
    if (component.value == null) {
      return component.name;
    }
    const codec = registry.getProtocol(component.code);
    if (codec == null) {
      throw new InvalidMultiaddrError(`Unknown protocol code ${component.code}`);
    }
    return [
      component.name,
      codec.valueToString?.(component.value) ?? component.value
    ];
  }).join("/")}`;
}
function sizeForAddr(codec, bytes, offset) {
  if (codec.size == null || codec.size === 0) {
    return 0;
  }
  if (codec.size > 0) {
    return codec.size / 8;
  }
  return decode6(bytes, offset);
}
var inspect = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
var symbol = /* @__PURE__ */ Symbol.for("@multiformats/multiaddr");
function toComponents(addr) {
  if (addr == null) {
    addr = "/";
  }
  if (isMultiaddr(addr)) {
    return addr.getComponents();
  }
  if (addr instanceof Uint8Array) {
    return bytesToComponents(addr);
  }
  if (typeof addr === "string") {
    addr = addr.replace(/\/(\/)+/, "/").replace(/(\/)+$/, "");
    if (addr === "") {
      addr = "/";
    }
    return stringToComponents(addr);
  }
  if (Array.isArray(addr)) {
    return addr;
  }
  throw new InvalidMultiaddrError("Must be a string, Uint8Array, Component[], or another Multiaddr");
}
var _a2;
var _components;
var _string;
var _bytes;
var _Multiaddr = class _Multiaddr2 {
  constructor(addr = "/", options2 = {}) {
    __publicField(this, _a2, true);
    __privateAdd(this, _components);
    __privateAdd(this, _string);
    __privateAdd(this, _bytes);
    __privateSet(this, _components, toComponents(addr));
    if (options2.validate !== false) {
      validate2(this);
    }
  }
  get bytes() {
    if (__privateGet(this, _bytes) == null) {
      __privateSet(this, _bytes, componentsToBytes(__privateGet(this, _components)));
    }
    return __privateGet(this, _bytes);
  }
  toString() {
    if (__privateGet(this, _string) == null) {
      __privateSet(this, _string, componentsToString(__privateGet(this, _components)));
    }
    return __privateGet(this, _string);
  }
  toJSON() {
    return this.toString();
  }
  getComponents() {
    return [
      ...__privateGet(this, _components).map((c) => ({ ...c }))
    ];
  }
  encapsulate(addr) {
    const ma = new _Multiaddr2(addr);
    return new _Multiaddr2([
      ...__privateGet(this, _components),
      ...ma.getComponents()
    ], {
      validate: false
    });
  }
  decapsulate(addr) {
    const addrString = addr.toString();
    const s = this.toString();
    const i = s.lastIndexOf(addrString);
    if (i < 0) {
      throw new InvalidParametersError(`Address ${this.toString()} does not contain subaddress: ${addrString}`);
    }
    return new _Multiaddr2(s.slice(0, i), {
      validate: false
    });
  }
  decapsulateCode(code2) {
    let index;
    for (let i = __privateGet(this, _components).length - 1; i > -1; i--) {
      if (__privateGet(this, _components)[i].code === code2) {
        index = i;
        break;
      }
    }
    return new _Multiaddr2(__privateGet(this, _components).slice(0, index), {
      validate: false
    });
  }
  equals(addr) {
    return equals3(this.bytes, addr.bytes);
  }
  /**
   * Returns Multiaddr as a human-readable string
   * https://nodejs.org/api/util.html#utilinspectcustom
   *
   * @example
   * ```js
   * import { multiaddr } from '@multiformats/multiaddr'
   *
   * console.info(multiaddr('/ip4/127.0.0.1/tcp/4001'))
   * // 'Multiaddr(/ip4/127.0.0.1/tcp/4001)'
   * ```
   */
  [(_a2 = symbol, inspect)]() {
    return `Multiaddr(${this.toString()})`;
  }
};
_components = /* @__PURE__ */ new WeakMap();
_string = /* @__PURE__ */ new WeakMap();
_bytes = /* @__PURE__ */ new WeakMap();
function validate2(addr) {
  addr.getComponents().forEach((component) => {
    const codec = registry.getProtocol(component.code);
    if (component.value == null) {
      return;
    }
    codec.validate?.(component.value);
  });
}
function isMultiaddr(value) {
  return Boolean(value?.[symbol]);
}
var word = "[a-fA-F\\d:]";
var boundry = (options2) => options2 && options2.includeBoundaries ? `(?:(?<=\\s|^)(?=${word})|(?<=${word})(?=\\s|$))` : "";
var v4 = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}";
var v6segment = "[a-fA-F\\d]{1,4}";
var v6 = `
(?:
(?:${v6segment}:){7}(?:${v6segment}|:)|                                    // 1:2:3:4:5:6:7::  1:2:3:4:5:6:7:8
(?:${v6segment}:){6}(?:${v4}|:${v6segment}|:)|                             // 1:2:3:4:5:6::    1:2:3:4:5:6::8   1:2:3:4:5:6::8  1:2:3:4:5:6::1.2.3.4
(?:${v6segment}:){5}(?::${v4}|(?::${v6segment}){1,2}|:)|                   // 1:2:3:4:5::      1:2:3:4:5::7:8   1:2:3:4:5::8    1:2:3:4:5::7:1.2.3.4
(?:${v6segment}:){4}(?:(?::${v6segment}){0,1}:${v4}|(?::${v6segment}){1,3}|:)| // 1:2:3:4::        1:2:3:4::6:7:8   1:2:3:4::8      1:2:3:4::6:7:1.2.3.4
(?:${v6segment}:){3}(?:(?::${v6segment}){0,2}:${v4}|(?::${v6segment}){1,4}|:)| // 1:2:3::          1:2:3::5:6:7:8   1:2:3::8        1:2:3::5:6:7:1.2.3.4
(?:${v6segment}:){2}(?:(?::${v6segment}){0,3}:${v4}|(?::${v6segment}){1,5}|:)| // 1:2::            1:2::4:5:6:7:8   1:2::8          1:2::4:5:6:7:1.2.3.4
(?:${v6segment}:){1}(?:(?::${v6segment}){0,4}:${v4}|(?::${v6segment}){1,6}|:)| // 1::              1::3:4:5:6:7:8   1::8            1::3:4:5:6:7:1.2.3.4
(?::(?:(?::${v6segment}){0,5}:${v4}|(?::${v6segment}){1,7}|:))             // ::2:3:4:5:6:7:8  ::2:3:4:5:6:7:8  ::8             ::1.2.3.4
)(?:%[0-9a-zA-Z]{1,})?                                             // %eth0            %1
`.replace(/\s*\/\/.*$/gm, "").replace(/\n/g, "").trim();
var v46Exact = new RegExp(`(?:^${v4}$)|(?:^${v6}$)`);
var v4exact = new RegExp(`^${v4}$`);
var v6exact = new RegExp(`^${v6}$`);
var ipRegex = (options2) => options2 && options2.exact ? v46Exact : new RegExp(`(?:${boundry(options2)}${v4}${boundry(options2)})|(?:${boundry(options2)}${v6}${boundry(options2)})`, "g");
ipRegex.v4 = (options2) => options2 && options2.exact ? v4exact : new RegExp(`${boundry(options2)}${v4}${boundry(options2)}`, "g");
ipRegex.v6 = (options2) => options2 && options2.exact ? v6exact : new RegExp(`${boundry(options2)}${v6}${boundry(options2)}`, "g");
var { toString: toString3 } = Object.prototype;

// src/commands/manifest.ts
import { readFile as readFile7 } from "fs/promises";
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
      const raw = await loadManifestSource2(source);
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
      const knowledgeRoot = resolveManifestKnowledgeRoot2(parsed.knowledge);
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
        knowledgeRoot,
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
      if (knowledgeRoot) {
        process.stdout.write(`${theme.label("Knowledge")}: ${theme.value(knowledgeRoot)}
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
async function loadManifestSource2(source) {
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
  return readFile7(source, "utf8");
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
        names.map(async (name2) => {
          try {
            const p = await ProfileManager.getProfile(name2);
            return {
              name: p.name,
              host: p.host,
              did: p.did,
              posture: resolveProfilePosture(p),
              operatorType: resolveProfileOperatorType(p),
              active: name2 === config.defaultProfile
            };
          } catch {
            return {
              name: name2,
              host: null,
              did: null,
              posture: null,
              operatorType: null,
              active: name2 === config.defaultProfile
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
          const name2 = p.active ? theme.brand(p.name) : p.name;
          const host = theme.muted(p.host || "no host");
          const posture = p.posture ? theme.muted(String(p.posture)) : theme.muted("no posture");
          process.stdout.write(`${marker}${name2}  ${host}  ${posture}
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
  ).action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const host = options.host ?? globalOpts.host ?? "https://node.tinycloud.xyz";
      const posture = parseProfilePosture(options.posture);
      const operatorType = parseOperatorType(options.operator);
      if (await ProfileManager.profileExists(name2)) {
        throw new CLIError("PROFILE_EXISTS", `Profile "${name2}" already exists`, ExitCode.ERROR);
      }
      await ProfileManager.ensureConfigDir();
      const { jwk, did } = generateKey();
      await ProfileManager.setKey(name2, jwk);
      await ProfileManager.setProfile(name2, {
        name: name2,
        host,
        chainId: 1,
        spaceName: "default",
        did,
        sessionDid: did,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        posture,
        operatorType
      });
      outputJson({ profile: name2, did, host, posture, operatorType, created: true });
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("show [name]").description("Show profile details").action(async (name2, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profileName = name2 ?? ctx.profile;
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
        process.stdout.write(formatField("Default Space", p.defaultSpace || null) + "\n");
        process.stdout.write(formatField("Key", hasKey) + "\n");
        process.stdout.write(formatField("Session", hasSession) + "\n");
        process.stdout.write(formatField("Created", p.createdAt) + "\n");
      }
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("switch <name>").description("Set default profile").action(async (name2, _options, cmd) => {
    try {
      if (!await ProfileManager.profileExists(name2)) {
        throw new CLIError("PROFILE_NOT_FOUND", `Profile "${name2}" does not exist`, ExitCode.NOT_FOUND);
      }
      const config = await ProfileManager.getConfig();
      await ProfileManager.setConfig({ ...config, defaultProfile: name2 });
      outputJson({ defaultProfile: name2, switched: true });
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("set-default-space [name]").description("Set (or clear) the default space used when --space is omitted").option("--profile <name>", "Profile to modify (defaults to the active profile)").option("--unset", "Clear the default space so commands fall back to the primary space").addHelpText("after", `

The default space is a short space NAME (e.g. "applications"), resolved per
profile at command time. Precedence for every kv/sql command:
  explicit --space flag  >  profile defaultSpace  >  primary space.

Examples:
  $ tc profile set-default-space applications
  $ tc profile set-default-space applications --profile cli-test
  $ tc profile set-default-space --unset
`).action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext({
        ...globalOpts,
        profile: options.profile ?? globalOpts.profile
      });
      const profileName = ctx.profile;
      if (!options.unset && (name2 === void 0 || name2 === "")) {
        throw new CLIError(
          "USAGE_ERROR",
          "Provide a space name (e.g. `tc profile set-default-space applications`) or pass --unset.",
          ExitCode.USAGE_ERROR
        );
      }
      if (!options.unset && !/^[A-Za-z0-9_-]+$/.test(name2)) {
        throw new CLIError(
          "INVALID_SPACE",
          `Invalid space name "${name2}". Use a short name ([A-Za-z0-9_-]).`,
          ExitCode.USAGE_ERROR
        );
      }
      const p = await ProfileManager.getProfile(profileName);
      const defaultSpace = options.unset ? void 0 : name2;
      await ProfileManager.setProfile(profileName, { ...p, defaultSpace });
      outputJson({ profile: profileName, defaultSpace: defaultSpace ?? null, updated: true });
    } catch (error) {
      handleError(error);
    }
  });
  profile.command("delete <name>").description("Delete a profile").action(async (name2, _options, cmd) => {
    try {
      if (isInteractive()) {
        const rl = createInterface3({ input: process.stdin, output: process.stderr });
        const answer = await new Promise((resolve3) => {
          rl.question(`Delete profile "${name2}"? This cannot be undone. [y/N] `, resolve3);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          outputJson({ profile: name2, deleted: false, reason: "Cancelled by user" });
          return;
        }
      }
      await ProfileManager.deleteProfile(name2);
      outputJson({ profile: name2, deleted: true });
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

// src/commands/secrets.ts
import { readFile as readFile8 } from "fs/promises";
import { writeFile as writeFile5 } from "fs/promises";
import { join as join4 } from "path";
import { homedir } from "os";
import { invokeOperation as invokeOperation2 } from "@tinycloud/operations";
import {
  SECRET_DECRYPT_CAPABILITY,
  secretCapabilityAction
} from "@tinycloud/operations/secret-capabilities";
import { invokeSecretsGetWithLocalAuthorityRetry } from "@tinycloud/operations/cli-runtime";
var SECRETS_SPACE3 = "secrets";
var SECRET_KV_ABILITIES = {
  get: secretCapabilityAction("get"),
  put: secretCapabilityAction("put"),
  del: secretCapabilityAction("del"),
  list: secretCapabilityAction("list")
};
async function readStdin3() {
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
  return options.scope ? { scope: options.scope } : void 0;
}
async function resolveSecretSpace(input, profileName) {
  return resolveSpaceUri(input, profileName, { useProfileDefault: false });
}
function secretsServiceForSpace(node, spaceUri) {
  return spaceUri ? node.secretsForSpace(spaceUri) : node.secrets;
}
var SECRET_NAME_RE2 = /^[A-Z][A-Z0-9_]*$/;
var RESERVED_SECRET_SCOPES2 = /* @__PURE__ */ new Set(["default", "global"]);
function canonicalizeSecretScope2(scope) {
  if (scope === void 0) return void 0;
  const trimmed = scope.trim();
  if (trimmed === "") {
    throw new CLIError(
      "INVALID_SECRET_SCOPE",
      "Secret scope must be non-empty; omit scope for global secrets.",
      ExitCode.USAGE_ERROR
    );
  }
  const canonical = trimmed.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (canonical === "") {
    throw new CLIError(
      "INVALID_SECRET_SCOPE",
      "Secret scope must contain at least one letter or number.",
      ExitCode.USAGE_ERROR
    );
  }
  if (RESERVED_SECRET_SCOPES2.has(canonical)) {
    throw new CLIError(
      "INVALID_SECRET_SCOPE",
      `Secret scope ${JSON.stringify(scope)} is reserved; omit scope for global secrets.`,
      ExitCode.USAGE_ERROR
    );
  }
  return canonical;
}
function resolveSecretPath2(name2, options = {}) {
  const normalizedName = name2.trim();
  if (!SECRET_NAME_RE2.test(normalizedName)) {
    throw new CLIError(
      "INVALID_SECRET_NAME",
      `Invalid secret name ${JSON.stringify(name2)}. Secret names must match ${SECRET_NAME_RE2.source}.`,
      ExitCode.USAGE_ERROR
    );
  }
  const scope = canonicalizeSecretScope2(options.scope);
  const vaultKey = scope === void 0 ? `secrets/${normalizedName}` : `secrets/scoped/${scope}/${normalizedName}`;
  return {
    name: normalizedName,
    ...scope !== void 0 ? { scope } : {},
    vaultKey,
    permissionPaths: {
      vault: `vault/${vaultKey}`
    }
  };
}
function resolveSecretListPrefix2(options = {}) {
  const scope = canonicalizeSecretScope2(options.scope);
  return scope === void 0 ? "vault/secrets/" : `vault/secrets/scoped/${scope}/`;
}
function resolveProfilesDir() {
  const home = process.env.TC_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join4(home, ".tinycloud", "profiles");
}
async function ensureSecretsNode(ctx, options) {
  const auth = authOptions(options);
  if (auth?.privateKey) {
    return ensureAuthenticated(ctx, auth);
  }
  const profile = await ProfileManager.getProfile(ctx.profile).catch(() => null);
  if (profile?.authMethod === "openkey" && canRequestOwnerPermissions(profile)) {
    const session = await ProfileManager.getSession(ctx.profile);
    if (!session || isStoredSessionExpired(session)) {
      await withSpinner(
        session ? "Refreshing TinyCloud session..." : "Creating TinyCloud session...",
        () => refreshOpenKeySession(ctx.profile, ctx.host)
      );
    }
  }
  return ensureAuthenticated(ctx, auth);
}
async function runSecretOperation(params) {
  const first = await runSecretOperationAttempt(params.label, params.operation);
  if (first.ok || !shouldRequestSecretPermissions(first.error)) {
    return first;
  }
  const profile = await ProfileManager.getProfile(params.ctx.profile);
  if (!canRequestOwnerPermissions(profile)) {
    return first;
  }
  const requested = secretPermissionEntries({
    action: params.action,
    name: params.name,
    options: params.scopeOptions,
    space: params.space,
    node: params.node
  });
  await withSpinner(
    "Requesting secret permissions...",
    () => ensureDelegationAuthority({
      ctx: params.ctx,
      profile,
      node: params.node,
      requested,
      expiryOption: void 0,
      reason: secretPermissionReason(params.action, params.name),
      yes: true,
      force: true,
      openKeyAcquisition: params.openKeyAcquisition
    })
  );
  return runSecretOperationAttempt(params.label, params.operation);
}
function secretPermissionReason(action, name2) {
  const target = name2 ? ` secret "${name2}"` : " secrets";
  return `Allow \`tc secrets ${action}${name2 ? ` ${name2}` : ""}\` to access${target} with the required TinyCloud permissions.`;
}
async function runSecretOperationAttempt(label, operation) {
  try {
    return await withSpinner(label, operation);
  } catch (error) {
    const permissionError = thrownPermissionError(error);
    if (permissionError) return permissionError;
    throw error;
  }
}
async function invokeCanonicalSecretGet(params) {
  const auth = authOptions(params.options);
  const target = {
    profile: params.ctx.profile,
    host: params.ctx.host,
    allowOwnerProfile: true,
    ...auth ?? {}
  };
  const input = {
    name: params.name,
    ...params.scope === void 0 ? {} : { scope: params.scope },
    ...params.space === void 0 ? {} : { space: params.space }
  };
  const invoke = () => withSpinner(
    params.label,
    () => auth?.privateKey ? invokeSecretsGetWithLocalAuthorityRetry(target, input) : invokeOperation2("tinycloud.secrets.get", 1, target, input)
  );
  const first = await invoke();
  if (first.status !== "authority_required") return first;
  if (auth?.privateKey !== void 0) return first;
  if (first.context.posture !== "owner-openkey" && first.context.posture !== "local-owner-key") {
    return first;
  }
  const profile = await ProfileManager.getProfile(params.ctx.profile);
  if (!canRequestOwnerPermissions(profile)) return first;
  const node = params.node ?? await ensureSecretsNode(params.ctx, params.options);
  await withSpinner(
    "Requesting secret permissions...",
    () => ensureDelegationAuthority({
      ctx: params.ctx,
      profile,
      node,
      requested: first.missing,
      expiryOption: void 0,
      reason: secretPermissionReason("get", params.name),
      yes: true,
      force: true,
      openKeyAcquisition: params.openKeyAcquisition
    })
  );
  return invoke();
}
function throwCanonicalSecretGetError(result, name2) {
  switch (result.status) {
    case "authority_required":
      throw new CLIError(
        "PERMISSION_DENIED",
        "Permission denied while reading secret",
        ExitCode.ERROR
      );
    case "setup_required":
      throw new CLIError("NOT_FOUND", `Secret "${name2}" not found`, ExitCode.NOT_FOUND);
    case "error":
      throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
    case "ok":
      throw new Error("Expected a failed canonical secret result.");
  }
}
function canRequestOwnerPermissions(profile) {
  const posture = resolveProfilePosture(profile);
  return posture === "owner-openkey" || posture === "local-owner-key";
}
function shouldRequestSecretPermissions(error) {
  if (error.code !== "PERMISSION_DENIED") return false;
  return /permission|session expired|autosign|capabilit/i.test(error.message);
}
function thrownPermissionError(error) {
  const record = error;
  const message = typeof record?.message === "string" ? record.message : String(error);
  const code2 = typeof record?.code === "string" ? record.code : "PERMISSION_DENIED";
  if (code2 !== "PERMISSION_DENIED" && !/permission|session expired|autosign|capabilit/i.test(message)) {
    return null;
  }
  return {
    ok: false,
    error: {
      code: "PERMISSION_DENIED",
      message
    }
  };
}
function isMissingFileError(error) {
  const typed = error;
  return typed?.code === "ENOENT";
}
function hasPermissionAction(actions, action) {
  return actions.some(
    (entry) => entry === action || entry.endsWith(`/${action.split("/").at(-1)}`) || entry === action.split("/").at(-1)
  );
}
function delegationCoversPath(permissions, path, space = SECRETS_SPACE3) {
  return permissions.some((permission) => {
    if (permission.service !== "tinycloud.kv") return false;
    if (!permissionTargetsSpace(permission, space)) return false;
    if (!hasPermissionAction(permission.actions, secretCapabilityAction("get"))) return false;
    return permission.path === path || permission.path.endsWith("/") && path.startsWith(permission.path);
  });
}
function spaceMatches(granted, requested) {
  return granted === requested;
}
function permissionTargetsSpace(permission, expectedSpace) {
  if (permission.service !== "tinycloud.kv") return false;
  if (typeof permission.space !== "string") return false;
  const space = permission.space.trim();
  if (space === "") return false;
  return spaceMatches(space, expectedSpace);
}
function delegationCoversDecrypt(permissions, networkId) {
  return permissions.some((permission) => {
    if (permission.service !== "tinycloud.encryption") return false;
    if (!hasPermissionAction(permission.actions, SECRET_DECRYPT_CAPABILITY)) return false;
    return permission.path === networkId;
  });
}
function parseDelegationExpiry(expiry) {
  const parsed = expiry instanceof Date ? expiry : typeof expiry === "number" ? new Date(expiry) : new Date(String(expiry));
  if (Number.isNaN(parsed.getTime())) {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      "Delegation must include a valid expiry.",
      ExitCode.USAGE_ERROR
    );
  }
  return parsed;
}
function normalizePortableDelegation2(value) {
  if (value === null || typeof value !== "object") {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      "Delegation source must contain a PortableDelegation object.",
      ExitCode.USAGE_ERROR
    );
  }
  const candidate = value;
  const authorization = candidate.delegationHeader;
  if (typeof candidate.cid !== "string" || typeof candidate.spaceId !== "string" || typeof candidate.path !== "string" || !Array.isArray(candidate.actions) || typeof candidate.delegateDID !== "string" || typeof candidate.ownerAddress !== "string" || typeof candidate.chainId !== "number" || typeof authorization !== "object" || authorization === null || typeof authorization.Authorization !== "string") {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      "Delegation source must contain a PortableDelegation object.",
      ExitCode.USAGE_ERROR
    );
  }
  return {
    ...candidate,
    actions: [...candidate.actions],
    expiry: parseDelegationExpiry(candidate.expiry),
    delegationHeader: { Authorization: authorization.Authorization }
  };
}
function normalizeDelegationCandidates(value, source) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeDelegationCandidates(entry, source));
  }
  if (value === null || typeof value !== "object") {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      `Delegation source "${source}" must be a delegation file or imported profile reference.`,
      ExitCode.USAGE_ERROR
    );
  }
  const candidate = value;
  if (candidate.delegation !== void 0) {
    const delegation2 = normalizePortableDelegation2(candidate.delegation);
    return [{
      delegation: delegation2,
      permissions: Array.isArray(candidate.permissions) && candidate.permissions.length > 0 ? candidate.permissions : permissionsFromDelegation2(delegation2)
    }];
  }
  const delegation = normalizePortableDelegation2(candidate);
  return [{
    delegation,
    permissions: permissionsFromDelegation2(delegation)
  }];
}
function permissionsFromDelegation2(delegation) {
  if (delegation.resources?.length) {
    return delegation.resources.map((resource) => ({
      service: resource.service.startsWith("tinycloud.") ? resource.service : `tinycloud.${resource.service}`,
      space: resource.space,
      path: resource.path,
      actions: [...resource.actions]
    }));
  }
  const service = delegation.actions[0]?.includes("/") ? delegation.actions[0].slice(0, delegation.actions[0].indexOf("/")) : "tinycloud.unknown";
  return [{
    service,
    space: delegation.spaceId,
    path: delegation.path,
    actions: [...delegation.actions]
  }];
}
async function loadDelegationCandidates(source) {
  try {
    const raw = JSON.parse(await readFile8(source, "utf8"));
    return normalizeDelegationCandidates(raw, source);
  } catch (error) {
    if (!isMissingFileError(error)) {
      if (error instanceof SyntaxError) {
        throw new CLIError(
          "INVALID_DELEGATION_SOURCE",
          `Delegation source "${source}" must be valid JSON.`,
          ExitCode.USAGE_ERROR
        );
      }
      throw new CLIError(
        "INVALID_DELEGATION_SOURCE",
        `Delegation source "${source}" could not be read.`,
        ExitCode.USAGE_ERROR
      );
    }
  }
  try {
    const importedPath = join4(resolveProfilesDir(), source, "additional-delegations.json");
    const raw = JSON.parse(await readFile8(importedPath, "utf8"));
    return normalizeDelegationCandidates(raw, source);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    if (error instanceof SyntaxError) {
      throw new CLIError(
        "INVALID_DELEGATION_SOURCE",
        `Delegation source "${source}" must be valid JSON.`,
        ExitCode.USAGE_ERROR
      );
    }
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      `Delegation source "${source}" could not be read.`,
      ExitCode.USAGE_ERROR
    );
  }
}
function selectDelegationCandidate(candidates, source, secretPath, space = SECRETS_SPACE3) {
  const liveCandidates = candidates.filter((candidate) => candidate.delegation.expiry.getTime() > Date.now());
  if (liveCandidates.length === 0) {
    throw new CLIError(
      "DELEGATION_EXPIRED",
      `Delegation source "${source}" has no live delegations.`,
      ExitCode.PERMISSION_DENIED
    );
  }
  const secretsSpaceCandidates = liveCandidates.filter(
    (candidate) => candidate.permissions.some((permission) => permissionTargetsSpace(permission, space))
  );
  if (secretsSpaceCandidates.length === 0) {
    throw new CLIError(
      "PERMISSION_DENIED",
      `Delegation source "${source}" does not target secrets space "${space}".`,
      ExitCode.PERMISSION_DENIED
    );
  }
  const exact = secretsSpaceCandidates.find(
    (candidate) => delegationCoversPath(candidate.permissions, secretPath, space)
  );
  if (exact) {
    return exact;
  }
  throw new CLIError(
    "PERMISSION_DENIED",
    `Delegation source "${source}" does not cover secret "${secretPath}".`,
    ExitCode.PERMISSION_DENIED
  );
}
async function resolveDelegatedSecretSource(source, secretPath, space = SECRETS_SPACE3) {
  const candidates = await loadDelegationCandidates(source);
  if (candidates.length === 0) {
    throw new CLIError(
      "DELEGATION_NOT_FOUND",
      `Delegation source "${source}" did not resolve to any imported delegations.`,
      ExitCode.PERMISSION_DENIED
    );
  }
  const selected = selectDelegationCandidate(candidates, source, secretPath, space);
  return { ...selected, source };
}
function mapEncryptionResultError(error) {
  const code2 = error.code || "DECRYPTION_FAILED";
  const exitCode = code2 === "PERMISSION_DENIED" ? ExitCode.PERMISSION_DENIED : code2 === "NOT_FOUND" ? ExitCode.NOT_FOUND : code2 === "NETWORK_ERROR" || code2 === "TRANSPORT_ERROR" ? ExitCode.NETWORK_ERROR : ExitCode.ERROR;
  return new CLIError(code2, error.message, exitCode);
}
function parseDecryptedSecretPayload(data, secretPath) {
  const text = new TextDecoder().decode(data);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CLIError(
      "INVALID_SECRET_PAYLOAD",
      `Delegated secret "${secretPath}" did not decrypt to valid JSON.`,
      ExitCode.ERROR
    );
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.value !== "string") {
    throw new CLIError(
      "INVALID_SECRET_PAYLOAD",
      `Delegated secret "${secretPath}" did not decrypt to { value: string }.`,
      ExitCode.ERROR
    );
  }
  return parsed.value;
}
async function readDelegatedSecretValue(params) {
  if (!delegationCoversPath(params.permissions, params.secretPath, params.space ?? SECRETS_SPACE3)) {
    throw new CLIError(
      "PERMISSION_DENIED",
      `Delegation "${params.delegationCid}" does not cover secret "${params.secretPath}".`,
      ExitCode.PERMISSION_DENIED
    );
  }
  const access = await params.node.useDelegation(params.delegation);
  if (typeof access?.kv?.get !== "function") {
    throw new CLIError(
      "DELEGATION_INVALID",
      `Delegation "${params.delegationCid}" did not resolve delegated KV access.`,
      ExitCode.ERROR
    );
  }
  const envelopeResult = await access.kv.get(params.secretPath, {
    raw: true,
    prefix: ""
  });
  if (!envelopeResult.ok) {
    if (envelopeResult.error.code === "NOT_FOUND" || envelopeResult.error.code === "KEY_NOT_FOUND" || envelopeResult.error.code === "KV_NOT_FOUND") {
      throw new CLIError(
        "NOT_FOUND",
        `Secret "${params.name}" not found`,
        ExitCode.NOT_FOUND
      );
    }
    if (envelopeResult.error.code === "PERMISSION_DENIED") {
      throw new CLIError(
        "PERMISSION_DENIED",
        `Delegation "${params.delegationCid}" does not cover secret "${params.secretPath}".`,
        ExitCode.PERMISSION_DENIED
      );
    }
    throw new CLIError(
      envelopeResult.error.code,
      envelopeResult.error.message,
      ExitCode.ERROR
    );
  }
  const rawEnvelope = envelopeResult.data.data;
  if (typeof rawEnvelope !== "string") {
    throw new CLIError(
      "INVALID_ENVELOPE",
      `Secret "${params.secretPath}" did not contain an encrypted envelope.`,
      ExitCode.ERROR
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(rawEnvelope);
  } catch {
    throw new CLIError(
      "INVALID_ENVELOPE",
      `Secret "${params.secretPath}" did not contain an encrypted envelope.`,
      ExitCode.ERROR
    );
  }
  const networkId = envelope.networkId;
  if (typeof networkId !== "string") {
    throw new CLIError(
      "INVALID_ENVELOPE",
      `Secret "${params.secretPath}" did not contain an encrypted envelope.`,
      ExitCode.ERROR
    );
  }
  if (!delegationCoversDecrypt(params.permissions, networkId)) {
    throw new CLIError(
      "PERMISSION_DENIED",
      `Delegation "${params.delegationCid}" does not include ${SECRET_DECRYPT_CAPABILITY} for ${networkId}.`,
      ExitCode.PERMISSION_DENIED
    );
  }
  const decrypted = await params.node.encryption.decryptEnvelope(
    envelope,
    { proofs: [params.delegationCid] }
  );
  if (!decrypted.ok) {
    throw mapEncryptionResultError(decrypted.error);
  }
  return parseDecryptedSecretPayload(decrypted.data, params.secretPath);
}
function isStoredSessionExpired(session) {
  const record = session;
  const direct = parseDate(record.expiresAt ?? record.expiry ?? record.expirationTime);
  if (direct) return direct.getTime() <= Date.now();
  if (typeof record.siwe !== "string") return false;
  const match = record.siwe.match(/^Expiration Time:\s*(.+)$/im);
  const expiry = match ? parseDate(match[1].trim()) : null;
  return expiry !== null && expiry.getTime() <= Date.now();
}
function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date2 = new Date(value < 1e10 ? value * 1e3 : value);
    return Number.isNaN(date2.getTime()) ? null : date2;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function secretKvAbility(action) {
  return SECRET_KV_ABILITIES[action];
}
function secretPermissionEntries(params) {
  const path = params.action === "list" ? resolveSecretListPrefix2(params.options) : resolveSecretPath2(params.name ?? "", params.options).permissionPaths.vault;
  const permissions = [{
    service: "tinycloud.kv",
    space: params.space ?? SECRETS_SPACE3,
    path,
    actions: [secretKvAbility(params.action)],
    skipPrefix: true
  }];
  if (params.action === "get") {
    const networkId = "getEncryptionNetworkIdForSpace" in params.node && typeof params.node.getEncryptionNetworkIdForSpace === "function" ? params.node.getEncryptionNetworkIdForSpace(params.space ?? SECRETS_SPACE3) : params.node.getDefaultEncryptionNetworkId();
    permissions.push({
      service: "tinycloud.encryption",
      path: networkId,
      actions: [SECRET_DECRYPT_CAPABILITY],
      skipPrefix: true
    });
  }
  return permissions;
}
function formatSecretScopeFlag(options) {
  return options?.scope ? ` --scope ${JSON.stringify(options.scope)}` : "";
}
function outputSecretDoctor(result) {
  if (shouldOutputJson()) {
    outputJson(result);
    return;
  }
  process.stderr.write(formatSection("Secrets") + "\n");
  for (const check of result.checks) {
    process.stdout.write(formatCheck(check.ok, check.name, check.detail) + "\n");
    if (check.hint) {
      process.stdout.write(`  ${theme.hint(check.hint)}
`);
    }
  }
  process.stdout.write("\n");
  if (result.healthy) {
    process.stdout.write(theme.success("Secrets checks passed.") + "\n");
  } else {
    const failed = result.checks.filter((check) => check.ok === false).length;
    process.stdout.write(theme.warn(`${failed} secrets check${failed > 1 ? "s" : ""} need attention.`) + "\n");
  }
}
function registerSecretsCommand(program2, openKeyAcquisition) {
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
  network.command("init [name]").description("Create a secrets encryption network if needed").option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)").action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const descriptor = await withSpinner(
        "Ensuring encryption network...",
        () => node.ensureEncryptionNetwork(name2 ?? "default")
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
  secrets.command("doctor [name]").description("Check secrets setup and optional secret access").option("--scope <scope>", "Logical secret scope").option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)").option("--network <name>", "Encryption network name", "default").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureSecretsNode(ctx, options);
      const networkName = options.network ?? "default";
      const networkId = networkName.startsWith("urn:tinycloud:encryption:") ? networkName : node.getDefaultEncryptionNetworkId(networkName);
      const descriptor = await withSpinner(
        "Checking secrets encryption network...",
        () => node.getEncryptionNetwork(networkName)
      );
      const checks = [
        descriptor ? {
          name: "Encryption network",
          ok: descriptor.state === "active" ? true : "warn",
          detail: `${networkName} (${descriptor.state})`
        } : {
          name: "Encryption network",
          ok: false,
          detail: `${networkName} not found`,
          hint: `tc secrets network init ${networkName}`
        }
      ];
      let secret;
      if (name2) {
        const scopeOptions = resolveSecretScope(options);
        const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
        const secrets2 = secretsServiceForSpace(node, spaceUri);
        const resolved = resolveSecretPath2(name2, scopeOptions);
        const result = await runSecretOperation({
          ctx,
          node,
          action: "get",
          name: name2,
          scopeOptions,
          space: spaceUri,
          label: `Checking secret ${name2}...`,
          operation: () => secrets2.get(name2, scopeOptions)
        });
        if (result.ok) {
          secret = {
            name: resolved.name,
            path: resolved.permissionPaths.vault,
            ...resolved.scope ? { scope: resolved.scope } : {},
            exists: true,
            readable: true
          };
          checks.push({
            name: "Secret access",
            ok: true,
            detail: `${resolved.permissionPaths.vault} readable`
          });
        } else {
          const notFound = result.error.code === "NOT_FOUND" || result.error.code === "KEY_NOT_FOUND";
          secret = {
            name: resolved.name,
            path: resolved.permissionPaths.vault,
            ...resolved.scope ? { scope: resolved.scope } : {},
            exists: !notFound,
            readable: false
          };
          checks.push({
            name: "Secret access",
            ok: false,
            detail: notFound ? `${resolved.permissionPaths.vault} not found` : result.error.message,
            hint: notFound ? `tc secrets put ${resolved.name}${formatSecretScopeFlag(scopeOptions)} <value>` : `Ask the owner profile to grant ${secretCapabilityAction("get")} and ${SECRET_DECRYPT_CAPABILITY}.`
          });
        }
      } else {
        checks.push({
          name: "Secret access",
          ok: "warn",
          detail: "skipped; pass a secret name to verify read access"
        });
      }
      outputSecretDoctor({
        healthy: checks.every((check) => check.ok !== false),
        network: {
          name: networkName,
          networkId,
          exists: descriptor !== null,
          ...descriptor?.state ? { state: descriptor.state } : {}
        },
        ...secret ? { secret } : {},
        checks
      });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("list").description("List secrets").option("--scope <scope>", "Logical secret scope").option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureSecretsNode(ctx, options);
      const scopeOptions = resolveSecretScope(options);
      const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
      const secrets2 = secretsServiceForSpace(node, spaceUri);
      const result = await runSecretOperation({
        ctx,
        node,
        action: "list",
        scopeOptions,
        space: spaceUri,
        label: "Listing secrets...",
        operation: () => secrets2.list(scopeOptions)
      });
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      const secretNames = Array.isArray(result.data) ? result.data : [];
      outputJson({
        secrets: secretNames,
        count: secretNames.length,
        ...options.scope ? { scope: options.scope } : {},
        ...spaceUri ? { space: spaceUri } : {}
      });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("get <name>").description("Get a secret value").option("--scope <scope>", "Logical secret scope").option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)").option("--raw", "Output raw value (no JSON wrapping)").option("--value-only", "Output only the secret value (alias for --raw)").option("-o, --output <file>", "Write value to file").option("--delegation <source>", "Delegation file path or imported profile name").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const scopeOptions = resolveSecretScope(options);
      const legacySpaceUri = await resolveSecretSpace(options.space, ctx.profile);
      const secretPath = resolveSecretPath2(name2, scopeOptions).permissionPaths.vault;
      if (options.delegation) {
        const delegated = await resolveDelegatedSecretSource(
          options.delegation,
          secretPath,
          legacySpaceUri ?? SECRETS_SPACE3
        );
        const effectiveHost = globalOpts.host ?? delegated.delegation.host ?? ctx.host;
        const delegatedCtx = { ...ctx, host: effectiveHost };
        const node = await ensureSecretsNode(delegatedCtx, options);
        const value2 = await withSpinner(
          `Getting secret ${name2}...`,
          () => readDelegatedSecretValue({
            node,
            delegation: delegated.delegation,
            delegationCid: delegated.delegation.cid,
            permissions: delegated.permissions,
            secretPath,
            space: legacySpaceUri ?? SECRETS_SPACE3,
            name: name2
          })
        );
        if (options.output) {
          await writeFile5(options.output, value2);
          outputJson({ name: name2, written: options.output });
          return;
        }
        if (options.raw) {
          process.stdout.write(value2);
          return;
        }
        outputJson({ name: name2, value: value2 });
        return;
      }
      const privateKey = authOptions(options)?.privateKey;
      const spaceUri = privateKey !== void 0 && options.space !== void 0 && !options.space.startsWith("tinycloud:") ? options.space : legacySpaceUri;
      const result = await invokeCanonicalSecretGet({
        ctx,
        name: name2,
        ...scopeOptions?.scope === void 0 ? {} : { scope: scopeOptions.scope },
        ...spaceUri === void 0 ? {} : { space: spaceUri },
        options,
        label: `Getting secret ${name2}...`,
        openKeyAcquisition
      });
      if (result.status !== "ok") {
        throwCanonicalSecretGetError(result, name2);
      }
      const value = result.output.value;
      if (options.output) {
        await writeFile5(options.output, value);
        outputJson({ name: name2, written: options.output });
        return;
      }
      if (options.raw || options.valueOnly) {
        process.stdout.write(value);
        return;
      }
      outputJson({ name: name2, value });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("put <name> [value]").description("Store a secret").option("--scope <scope>", "Logical secret scope").option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name2, value, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureSecretsNode(ctx, options);
      const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
      const secrets2 = secretsServiceForSpace(node, spaceUri);
      let secretValue;
      const sources = [value !== void 0, !!options.file, !!options.stdin].filter(Boolean);
      if (sources.length === 0) {
        throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (sources.length > 1) {
        throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
      }
      if (options.file) {
        secretValue = await readFile8(options.file, "utf-8");
      } else if (options.stdin) {
        secretValue = (await readStdin3()).toString("utf-8");
      } else {
        secretValue = value;
      }
      const scopeOptions = resolveSecretScope(options);
      const result = await runSecretOperation({
        ctx,
        node,
        action: "put",
        name: name2,
        scopeOptions,
        space: spaceUri,
        label: `Storing secret ${name2}...`,
        operation: () => secrets2.put(name2, secretValue, scopeOptions)
      });
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name: name2, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  secrets.command("delete <name>").description("Delete a secret").option("--scope <scope>", "Logical secret scope").option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureSecretsNode(ctx, options);
      const scopeOptions = resolveSecretScope(options);
      const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
      const secrets2 = secretsServiceForSpace(node, spaceUri);
      const result = await runSecretOperation({
        ctx,
        node,
        action: "del",
        name: name2,
        scopeOptions,
        space: spaceUri,
        label: `Deleting secret ${name2}...`,
        operation: () => secrets2.delete(name2, scopeOptions)
      });
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name: name2, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
  network.command("grant <recipientDid> [name]").description("Grant decrypt permission for a secrets encryption network").option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)").action(async (recipientDid, name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx, authOptions(options));
      const networkName = name2 ?? "default";
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
      const open2 = (await import("open")).default;
      await open2("https://secrets.tinycloud.xyz");
      outputJson({ opened: "https://secrets.tinycloud.xyz" });
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
      const expiry = parseExpiry2(options.expiry);
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

// src/commands/space.ts
import { randomBytes as randomBytes2 } from "crypto";
import { mkdir as mkdir3, writeFile as writeFile6 } from "fs/promises";
import { dirname as dirname3 } from "path";
function didWithoutFragment2(did) {
  const fragment = did.indexOf("#");
  return fragment === -1 ? did : did.slice(0, fragment);
}
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
  space.command("create <name>").alias("host").description("Create (host) one of your owned spaces by name").action(async (name2, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const node = await ensureAuthenticated(ctx);
      const spaceId = await node.hostOwnedSpace(name2);
      outputJson({ spaceId, name: name2, hosted: true });
    } catch (error) {
      handleError(error);
    }
  });
  space.command("host-request <name>").description("Emit a request asking the space owner to host it (delegate-only)").option("--emit [file]", "Write the request artifact to file (or stdout when no path)").addHelpText("after", `

A delegate cannot host a space \u2014 only its owner (root authority) can. This
emits a tinycloud.host.request artifact naming the space and its owner so you
can hand it to the owner; they run \`tc space host <name>\` and confirm.

If you ARE the owner of the resolved space, this refuses and tells you to host
it directly with \`tc space host <name>\` (no request needed).
`).action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profile = await ProfileManager.getProfile(ctx.profile);
      const spaceId = await resolveHostSpace(name2, ctx.profile);
      const spaceName = spaceNameFromUri(spaceId);
      if (await isRootAuthority(spaceId, ctx.profile)) {
        throw new CLIError(
          "ALREADY_ROOT_AUTHORITY",
          `You are the owner of ${spaceId}. Host it directly: tc space host ${spaceName}`,
          ExitCode.USAGE_ERROR
        );
      }
      const requesterDid = didWithoutFragment2(profile.sessionDid ?? profile.did);
      const ownerDid = ownerDidFromSpaceUri(spaceId);
      if (!ownerDid) {
        throw new CLIError(
          "UNRESOLVABLE_OWNER",
          `Cannot determine the owner of ${spaceId}; host-request needs a pkh space URI.`,
          ExitCode.USAGE_ERROR
        );
      }
      const artifact = {
        kind: "tinycloud.host.request",
        version: 1,
        requestId: `hostreq_${Date.now().toString(36)}_${randomBytes2(4).toString("hex")}`,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        spaceName,
        spaceId,
        ownerDid,
        requesterDid,
        host: ctx.host
      };
      await emitHostRequestArtifact(artifact, options.emit);
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
  space.command("switch <name>").description("Switch active space").action(async (name2, _options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const profile = await ProfileManager.getProfile(ctx.profile);
      await ProfileManager.setProfile(ctx.profile, { ...profile, spaceName: name2 });
      outputJson({ profile: ctx.profile, spaceName: name2, switched: true });
    } catch (error) {
      handleError(error);
    }
  });
}
async function emitHostRequestArtifact(artifact, emitOption) {
  if (typeof emitOption === "string" && emitOption.length > 0) {
    await mkdir3(dirname3(emitOption), { recursive: true });
    await writeFile6(emitOption, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    outputJson({
      emitted: true,
      path: emitOption,
      requestId: artifact.requestId,
      spaceName: artifact.spaceName,
      spaceId: artifact.spaceId,
      ownerDid: artifact.ownerDid
    });
    return;
  }
  outputJson(artifact);
}

// src/commands/sql.ts
import { writeFile as writeFile7 } from "fs/promises";
import { resolve as resolve2 } from "path";
async function dbHandle(node, dbName, spaceInput, profileName) {
  const spaceUri = await resolveSpaceUri(spaceInput, profileName);
  const sql = spaceUri ? node.sqlForSpace(spaceUri) : node.sql;
  return { handle: sql.db(dbName), spaceUri };
}
async function throwSqlError(error, spaceUri, profileName, prefix) {
  const hosted = await unhostedSpaceError(error, spaceUri, profileName);
  if (hosted) throw hosted;
  const message = prefix ? `${prefix}${error.message}` : error.message;
  throw new CLIError(error.code, message, ExitCode.ERROR, error.meta);
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
      const { handle, spaceUri } = await dbHandle(node, options.db, options.space, ctx.profile);
      const result = await withSpinner(
        "Running query...",
        () => handle.query(sqlStr, params)
      );
      if (!result.ok) {
        await throwSqlError(result.error, spaceUri, ctx.profile);
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
      const { handle, spaceUri } = await dbHandle(node, options.db, options.space, ctx.profile);
      const result = await withSpinner(
        "Executing statement...",
        () => handle.execute(sqlStr, params)
      );
      if (!result.ok) {
        await throwSqlError(result.error, spaceUri, ctx.profile);
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
      const { handle, spaceUri } = await dbHandle(node, options.db, options.space, ctx.profile);
      const result = await withSpinner(
        "Exporting database...",
        () => handle.export()
      );
      if (!result.ok) {
        await throwSqlError(result.error, spaceUri, ctx.profile);
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
      const { handle: fromHandle, spaceUri: fromSpaceUriResolved } = await dbHandle(node, options.fromDb, fromSpaceInput, ctx.profile);
      const { handle: toHandle, spaceUri: toSpaceUriResolved } = await dbHandle(node, options.toDb, toSpaceInput, ctx.profile);
      let tables;
      if (options.table && options.table.length > 0) {
        tables = options.table.flatMap((t) => t.split(",").map((s) => s.trim()).filter(Boolean));
      } else {
        const listing = await fromHandle.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        if (!listing.ok) {
          await throwSqlError(listing.error, fromSpaceUriResolved, ctx.profile, "Cannot list source tables: ");
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
          await throwSqlError(countResult.error, fromSpaceUriResolved, ctx.profile, `Cannot count rows in source table "${table}": `);
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
          await throwSqlError(fetched.error, fromSpaceUriResolved, ctx.profile, `Failed to read "${entry.table}": `);
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
            await throwSqlError(writeResult.error, toSpaceUriResolved, ctx.profile, `Insert into "${entry.table}" failed after ${entry.copied} row(s): `);
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
function quoteIdent(name2) {
  return `"${name2.replace(/"/g, '""')}"`;
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
          (name2) => inspectProfile({
            name: name2,
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
  const session = await readSession2(params.name, issues);
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
async function readProfile(name2, issues) {
  try {
    return await ProfileManager.getProfile(name2);
  } catch (error) {
    issues.push(`profile: ${messageFromError(error)}`);
    return null;
  }
}
async function readSession2(name2, issues) {
  try {
    return asRecord(await ProfileManager.getSession(name2));
  } catch (error) {
    issues.push(`session: ${messageFromError(error)}`);
    return null;
  }
}
async function readHasKey(name2, issues) {
  try {
    return await ProfileManager.getKey(name2) !== null;
  } catch (error) {
    issues.push(`key: ${messageFromError(error)}`);
    return false;
  }
}
async function readDelegations(name2, issues) {
  try {
    return await loadAdditionalDelegations(name2);
  } catch (error) {
    issues.push(`delegations: ${messageFromError(error)}`);
    return [];
  }
}
function inspectDelegation(entry) {
  const expiry = parseDate2(entry.delegation.expiry);
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
    const parsed = parseDate2(session[key]);
    if (parsed) return parsed;
  }
  if (typeof session.siwe !== "string") return null;
  const match = session.siwe.match(/^Expiration Time:\s*(.+)$/im);
  return match ? parseDate2(match[1].trim()) : null;
}
function parseDate2(value) {
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
  const name2 = profile.default ? `${profile.name} (default)` : profile.name;
  const host = profile.host ? theme.muted(profile.host) : theme.muted("no host");
  const summary = [
    `${marker} ${profile.active ? theme.brand(name2) : name2}`,
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
      lines.push(`    ${formatDelegation2(delegation)}`);
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
function formatDelegation2(delegation) {
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

// src/commands/vault.ts
import { readFile as readFile9 } from "fs/promises";
import { writeFile as writeFile8 } from "fs/promises";
import { PrivateKeySigner as PrivateKeySigner2 } from "@tinycloud/node-sdk";
async function readStdin4() {
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
        putValue = new Uint8Array(await readFile9(options.file));
      } else if (options.stdin) {
        putValue = new Uint8Array(await readStdin4());
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
        await writeFile8(options.output, content);
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

// src/commands/vars.ts
import { readFile as readFile10 } from "fs/promises";
import { writeFile as writeFile9 } from "fs/promises";
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
  vars.command("get <name>").description("Get a variable value").option("--raw", "Output raw value (no JSON wrapping)").option("-o, --output <file>", "Write value to file").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey2(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
      const result = await withSpinner(`Getting variable ${name2}...`, () => prefixedKv.get(name2));
      if (!result.ok) {
        if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
          throw new CLIError("NOT_FOUND", `Variable "${name2}" not found`, ExitCode.NOT_FOUND);
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
        await writeFile9(options.output, value);
        outputJson({ name: name2, written: options.output });
        return;
      }
      if (options.raw) {
        process.stdout.write(value);
        return;
      }
      outputJson({ name: name2, value });
    } catch (error) {
      handleError(error);
    }
  });
  vars.command("put <name> [value]").description("Set a variable").option("--file <path>", "Read value from file").option("--stdin", "Read value from stdin").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name2, value, options, cmd) => {
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
        varValue = await readFile10(options.file, "utf-8");
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
      const result = await withSpinner(`Setting variable ${name2}...`, () => prefixedKv.put(name2, payload));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name: name2, written: true });
    } catch (error) {
      handleError(error);
    }
  });
  vars.command("delete <name>").description("Delete a variable").option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)").action(async (name2, options, cmd) => {
    try {
      const globalOpts = cmd.optsWithGlobals();
      const ctx = await ProfileManager.resolveContext(globalOpts);
      const privateKey = resolvePrivateKey2(options);
      const node = await ensureAuthenticated(ctx, { privateKey });
      const prefixedKv = node.kv.withPrefix(VARIABLES_PREFIX);
      const result = await withSpinner(`Deleting variable ${name2}...`, () => prefixedKv.delete(name2));
      if (!result.ok) {
        throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
      }
      outputJson({ name: name2, deleted: true });
    } catch (error) {
      handleError(error);
    }
  });
}

// src/command-registry.ts
function registerTinyCloudCommands(program2) {
  registerInitCommand(program2);
  registerAuthCommand(program2);
  registerKvCommand(program2);
  registerSpaceCommand(program2);
  registerDelegationCommand(program2);
  registerShareCommand(program2);
  registerNodeCommand(program2);
  registerProfileCommand(program2);
  registerCompletionCommand(program2);
  registerVaultCommand(program2);
  registerSecretsCommand(program2);
  registerVarsCommand(program2);
  registerDoctorCommand(program2);
  registerSqlCommand(program2);
  registerDuckdbCommand(program2);
  registerManifestCommand(program2);
  registerUpgradeCommand(program2);
  registerStatusCommand(program2);
  registerAccountCommand(program2);
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
registerTinyCloudCommands(program);
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
//# sourceMappingURL=index.js.map
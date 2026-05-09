import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".tinycloud");
export const PROFILES_DIR = join(CONFIG_DIR, "profiles");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const DEFAULT_HOST = "https://node.tinycloud.xyz";
export const DEFAULT_OPENKEY_HOST = "https://openkey.so";
export const DEFAULT_PROFILE = "default";
export const DEFAULT_CHAIN_ID = 1;

export const ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE_ERROR: 2,
  AUTH_REQUIRED: 3,
  NOT_FOUND: 4,
  PERMISSION_DENIED: 5,
  NETWORK_ERROR: 6,
  NODE_ERROR: 7,
} as const;

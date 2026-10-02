import {
  profilesPath,
  tinycloudConfigPath,
  tinycloudHomePath,
} from "@tinycloud/operations/state";

// Keep the legacy constants API, but resolve the same TC_HOME-aware store as
// operations so CLI and MCP processes address one shared profile directory.
export const CONFIG_DIR = tinycloudHomePath();
export const PROFILES_DIR = profilesPath();
export const CONFIG_FILE = tinycloudConfigPath();

// Production TinyCloud node. `node.tinycloud.xyz` does not resolve.
export const DEFAULT_HOST = "https://tee.node.tinycloud.xyz";
// OpenKey serves browser approval and its device API from distinct origins.
export const DEFAULT_OPENKEY_HOST = "https://openkey.so";
export const DEFAULT_OPENKEY_DEVICE_API_HOST = "https://api.openkey.so";
// Share service origin bound into OpenKey device authorizations.
export const DEFAULT_SHARE_ORIGIN = "https://share.tinycloud.xyz";
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

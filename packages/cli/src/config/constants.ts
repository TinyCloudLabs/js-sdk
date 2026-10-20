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

/**
 * How long a login commit or an import rollback waits for the profile lock.
 * Both run after slow work that must not be lost, so they wait out a crashed
 * holder: longer than the store's 30 s stale-lock threshold, after which a
 * dead holder's lock is reclaimed.
 */
export const PROFILE_COMMIT_LOCK_TIMEOUT_MS = 45_000;

export const ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE_ERROR: 2,
  AUTH_REQUIRED: 3,
  NOT_FOUND: 4,
  PERMISSION_DENIED: 5,
  NETWORK_ERROR: 6,
  NODE_ERROR: 7,
  /** `tc secrets wait` only: the deadline passed while a secret was still missing. */
  PENDING: 8,
  /** A write was refused because the owner's TinyCloud storage is full. */
  STORAGE_FULL: 10,
  /** Interrupted by SIGINT/SIGTERM (`CANCELLED`). */
  CANCELLED: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * The advice for an OpenKey profile whose space is not hosted yet. `tc space
 * host` cannot help it: that command needs a signer, and an OpenKey session
 * has none. OpenKey hosts the space itself, in the background after approval.
 */
export const OPENKEY_SPACE_SETUP_RETRY_HINT =
  "Wait a minute and retry; approving again in OpenKey re-runs the setup.";

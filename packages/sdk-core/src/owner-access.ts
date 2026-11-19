import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { CAPABILITIES, DUCKDB, HOOKS, KV, SQL } from "@tinycloud/bootstrap";
import type { AbilitiesMap, Manifest } from "./manifest";

/** App id of the generic manifest when sign-in has no web address to name it. */
export const GENERIC_APP_ID_WITHOUT_HOST = "node.app";

// DNS labels only: no `_`, so no host name can spell a `_<port>` or `o_<hash>` id.
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_AND_PORT = /^(.*?)(?::(\d{1,5}))?$/;
const DEFAULT_PORTS = new Set([80, 443]);

/**
 * The app id the generic manifest uses for a sign-in from `host`: the host
 * name reversed (`notes.example.com` → `com.example.notes`), with a
 * non-default port after `_` (`notes.example.com:8443` →
 * `com.example.notes_8443`; 80 and 443 are dropped). A host that is not a DNS
 * name (an IPv6 literal, a label with `_`) gets `o_` and the first 16 hex of
 * the SHA-256 of the lowercased host and port. {@link GENERIC_APP_ID_WITHOUT_HOST}
 * when there is no host.
 */
export function genericAppId(host: string | null | undefined): string {
  const value = host?.trim().toLowerCase();
  if (!value) return GENERIC_APP_ID_WITHOUT_HOST;
  const [, rawName = "", rawPort] = HOST_AND_PORT.exec(value)!;
  const name = rawName.replace(/\.$/, "");
  const port = rawPort === undefined || DEFAULT_PORTS.has(Number(rawPort)) ? undefined : String(Number(rawPort));
  const labels = name.split(".");
  if (!labels.every((label) => HOST_LABEL.test(label))) {
    const origin = port === undefined ? name : `${name}:${port}`;
    return `o_${bytesToHex(sha256(new TextEncoder().encode(origin))).slice(0, 16)}`;
  }
  const appId = labels.reverse().join(".");
  return port === undefined ? appId : `${appId}_${port}`;
}

/**
 * The manifest a sign-in uses when the app declared nothing (no `manifest`,
 * `capabilityRequest` or `defaultActions`): the standard tier (kv
 * get/put/del/list/metadata and sql read/write, plus capabilities read) on the
 * app's own folder `applications/<app id>/`, for the default 7 days. No
 * public space, no account rows, no encryption network.
 */
export function genericAppManifest(host: string | null | undefined): Manifest {
  const appId = genericAppId(host);
  return { app_id: appId, name: appId, includePublicSpace: false };
}

/** The console line a sign-in with the generic manifest prints once. */
export function genericAppManifestWarning(manifest: Manifest): string {
  return (
    `TinyCloud: this app signed in without a manifest, so its session covers only its own folder ` +
    `(applications/${manifest.app_id}/) and lasts 7 days. To ask for what your app needs, pass a manifest: ` +
    "https://docs.tinycloud.xyz/reference/protocol/app-manifests"
  );
}

let warnedWithoutAppHost = false;

/**
 * Once per process: a sign-in without a manifest and without a domain uses a
 * folder every such app shares (`node.app`, or `xyz.tinycloud.app` for the web
 * SDK outside a browser), so tell the developer how to get one of its own.
 */
export function warnOnceWithoutAppHost(appId: string): void {
  if (warnedWithoutAppHost) return;
  warnedWithoutAppHost = true;
  console.warn(
    `TinyCloud: this app has no domain, so it shares the folder applications/${appId}/ with every other app ` +
    'that has none. Set `domain` (for example `domain: "notes.example.com"`) or pass a manifest to give it a folder of its own.',
  );
}

/**
 * Every kv, sql, duckdb and hooks action plus capabilities read on one of the
 * owner's own spaces: the full-access request for owner tools (a CLI holding
 * the owner key, scripts, agent wallets on their own space). Spread it into a
 * `TinyCloudNode` config so the grant is named where it is asked for:
 *
 * ```ts
 * new TinyCloudNode({ privateKey, ...ownerFullAccess("default") });
 * ```
 *
 * A session signed this way also covers `vault/secrets/` in the `secrets`
 * space and the account's default encryption network, as plain owner
 * sessions always have. Apps declare a `manifest` instead.
 */
export function ownerFullAccess(space = "default"): {
  prefix: string;
  defaultActions: AbilitiesMap;
} {
  return {
    prefix: space,
    defaultActions: {
      kv: {
        "": [KV.PUT, KV.GET, KV.DEL, KV.LIST, KV.METADATA],
      },
      sql: {
        "": [SQL.READ, SQL.WRITE, SQL.SCHEMA, SQL.ADMIN, SQL.EXPORT],
      },
      duckdb: {
        "": [
          DUCKDB.READ,
          DUCKDB.WRITE,
          DUCKDB.ADMIN,
          DUCKDB.DESCRIBE,
          DUCKDB.EXPORT,
          DUCKDB.IMPORT,
          DUCKDB.EXECUTE,
        ],
      },
      capabilities: {
        "": [CAPABILITIES.READ],
      },
      hooks: {
        "": [HOOKS.SUBSCRIBE, HOOKS.REGISTER, HOOKS.LIST, HOOKS.UNREGISTER],
      },
    },
  };
}

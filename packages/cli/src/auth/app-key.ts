import { constants as fsConstants } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  EXACT_APP_KEY_MAX_LIFETIME_MS,
  buildExactAppKeyProof,
  openExactAppKeyClient,
  prepareExactAppKeyRequest,
  verifyExactAppKeyProof,
  type ExactAppKeyClient,
  type ExactAppKeyProof,
  type ExactAppKeyRequest,
  type PreparedExactAppKeyRequest,
} from "@tinycloud/node-sdk/encryption-keys";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore, profilePath } from "@tinycloud/operations/state";
import { ExitCode } from "../config/constants.js";
import { writeJsonDurable } from "../config/storage.js";
import { assertNodeSupportsNamedKeys } from "../lib/named-keys.js";
import { CLIError } from "../output/errors.js";
import { recordRegistryFallbackWarning } from "../output/warnings.js";
import { ownerIdentitySigner, startPreparedOpenKeyHandoff, type HandoffPrepared } from "./prepared-openkey.js";

const FILE = "app-key-permit.json";
/** What `--expiry` defaults to for one app key: the owner may shorten it, never lengthen it. */
export const APP_KEY_DEFAULT_LIFETIME_MS = 60 * 60 * 1_000;

/** The one approval this profile holds. It exists only after `auth login --keys <full-app-key> --app-key`. */
export interface AppKeyPermit {
  readonly version: 1;
  /** The node that accepted the approval. */
  readonly host: string;
  readonly request: Omit<ExactAppKeyRequest, "optIn">;
  readonly proof: ExactAppKeyProof;
}

function permitFile(profile: string): string {
  return join(profilePath(profile), FILE);
}

function unusable(profile: string, why: string): CLIError {
  return new CLIError(
    "APP_KEY_PERMIT_INVALID",
    `The saved app-key approval for profile "${profile}" ${why}. Sign in with \`${CLI_NAME} --profile ${profile} auth login --keys <full-app-key> --app-key\` for a new approval.`,
    ExitCode.AUTH_REQUIRED,
  );
}

/** The saved approval, `undefined` when the profile has none. Everything in it is re-verified before any use. */
export async function loadAppKeyPermit(profile: string): Promise<AppKeyPermit | undefined> {
  let handle: FileHandle | undefined;
  try {
    // O_NOFOLLOW: a symlink is never followed; O_NONBLOCK: a FIFO cannot hang the open.
    handle = await open(permitFile(profile), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw unusable(profile, "has loose file permissions");
    const stored = JSON.parse(await handle.readFile("utf8")) as Partial<AppKeyPermit> | null;
    if (stored?.version !== 1 || typeof stored.host !== "string" || typeof stored.request?.path !== "string" ||
      typeof stored.request.ownerDid !== "string" || typeof stored.request.requestedSiwe !== "string" ||
      typeof stored.request.sessionKey !== "object" || stored.request.sessionKey === null ||
      typeof stored.proof !== "object" || stored.proof === null) {
      throw unusable(profile, "is damaged");
    }
    return stored as AppKeyPermit;
  } catch (error) {
    if (error instanceof CLIError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unusable(profile, "can't be read");
  } finally {
    await handle?.close();
  }
}

export async function removeAppKeyPermit(profile: string): Promise<void> {
  await rm(permitFile(profile), { force: true });
}

function appKeyNode(profileName: string, host: string, ownerDid: string, registryUrl: string | undefined): TinyCloudNode {
  return new TinyCloudNode({
    registryCacheStore: createProfileRegistryCacheStore(profileName),
    registrySequenceStore: createProfileRegistrySequenceStore(profileName),
    onRegistryFallback: recordRegistryFallbackWarning,
    ...(registryUrl === undefined ? {} : { tinycloudRegistryUrl: registryUrl }),
    host,
    signer: ownerIdentitySigner(ownerDid),
    includeAccountRegistryPermissions: false,
    autoBootstrapAccount: false,
    autoCreateSpace: false,
    enablePublicSpace: false,
  });
}

const APP_KEY_APPROVAL_NOTE = (fullKey: string): string =>
  `On the OpenKey page, approve the one request for the key "${fullKey}". It lets this profile create that key and decrypt with it, and nothing else. You may shorten the time it lasts, never lengthen it.\n`;

export interface AppKeyLoginOptions {
  readonly profileName: string;
  readonly host: string;
  readonly openKeyHost: string;
  readonly ownerDid: string;
  readonly fullKey: string;
  readonly lifetimeMs: number | undefined;
  readonly registryUrl: string | undefined;
  readonly paste: boolean | undefined;
  readonly noPopup: boolean | undefined;
  /** Create the profile this approval belongs to when it does not exist yet; called only once the owner's approval verified. */
  readonly ensureProfile: () => Promise<void>;
  /** Refuse a profile that holds an ordinary sign-in; called before anything is requested. */
  readonly assertDedicatedProfile: () => Promise<void>;
}

export interface AppKeyLoginResult {
  readonly profile: string;
  readonly appKey: string;
  readonly ownerDid: string;
  readonly host: string;
  readonly expiresAt: string;
}

/**
 * `auth login --keys <full-app-key> --app-key`: ask the owner to approve exactly one app key, verify the signed
 * result locally, have the node accept it, and only then save it. Nothing is saved on any refusal.
 */
export async function loginWithAppKey(options: AppKeyLoginOptions): Promise<AppKeyLoginResult> {
  const lifetimeMs = options.lifetimeMs ?? APP_KEY_DEFAULT_LIFETIME_MS;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > EXACT_APP_KEY_MAX_LIFETIME_MS) {
    throw new CLIError("INVALID_EXPIRY", "An app-key sign-in lasts at most 7d. Use --expiry with a duration up to 7d.", ExitCode.USAGE_ERROR);
  }
  let built: PreparedExactAppKeyRequest;
  try {
    built = prepareExactAppKeyRequest(options.fullKey, options.ownerDid, lifetimeMs);
  } catch {
    throw new CLIError(
      "INVALID_KEY_PATH",
      `--keys "${options.fullKey}" is not one exact app key. Use apps/<app id>/<key>, for example apps/xyz.tinycloud.share/xyz.tinycloud.tinyapps.contacts/seal-v1.`,
      ExitCode.USAGE_ERROR,
    );
  }
  await options.assertDedicatedProfile();
  await assertNodeSupportsNamedKeys(options.host);

  const sessionDid = /^URI: (.+)$/m.exec(built.prepared.siwe)?.[1];
  if (sessionDid === undefined) throw new CLIError("INVALID_ARGUMENT", "Could not prepare the app-key approval.", ExitCode.ERROR);
  process.stderr.write(APP_KEY_APPROVAL_NOTE(options.fullKey));
  const handoff = await startPreparedOpenKeyHandoff({
    prepared: {
      siwe: built.prepared.siwe, jwk: built.request.sessionKey as HandoffPrepared["jwk"],
      host: options.host, verificationMethod: sessionDid,
    },
    openKeyHost: options.openKeyHost,
    appKey: built.appKey,
    noPopup: options.noPopup,
    paste: options.paste,
  });
  try {
    const signed = await handoff.result;
    let proof: ExactAppKeyProof;
    try {
      proof = buildExactAppKeyProof(built, signed);
    } catch {
      throw new CLIError("OPENKEY_RESULT_INVALID", "OpenKey returned an approval that does not match this request. Nothing was saved.", ExitCode.PERMISSION_DENIED);
    }
    const verdict = verifyExactAppKeyProof(built.request, proof);
    if (!verdict.ok) {
      throw new CLIError(
        "OPENKEY_RESULT_INVALID",
        `OpenKey returned an approval that is not exactly the one requested (${verdict.reason}). Nothing was saved.`,
        ExitCode.PERMISSION_DENIED,
      );
    }
    await options.ensureProfile();
    // The node must accept the approval before it is saved.
    await openExactAppKeyClient(appKeyNode(options.profileName, options.host, options.ownerDid, options.registryUrl), built.request, proof);
    const { optIn: _optIn, ...request } = built.request;
    await writeJsonDurable(permitFile(options.profileName), { version: 1, host: options.host, request, proof } satisfies AppKeyPermit);
    await handoff.complete(true);
    return {
      profile: options.profileName, appKey: options.fullKey, ownerDid: options.ownerDid,
      host: options.host, expiresAt: verdict.expiresAt,
    };
  } catch (error) {
    await handoff.complete(false);
    throw error;
  }
}

/** A saved approval that passed every local check for one key on one node. */
export interface VerifiedAppKey {
  readonly profileName: string;
  readonly host: string;
  readonly ownerDid: string;
  readonly request: ExactAppKeyRequest;
  readonly proof: ExactAppKeyProof;
}

/** The saved approval for `path` on this profile and host, verified locally only. No network is touched. */
export async function verifiedSavedAppKey(profileName: string, host: string, path: string): Promise<VerifiedAppKey> {
  const permit = await loadAppKeyPermit(profileName);
  if (permit === undefined) {
    throw new CLIError(
      "KEYS_NOT_GRANTED",
      `Profile "${profileName}" has no app-key approval. Sign in with \`${CLI_NAME} --profile ${profileName} auth login --keys <full-app-key> --app-key\`.`,
      ExitCode.PERMISSION_DENIED,
    );
  }
  if (path !== permit.request.path) {
    throw new CLIError(
      "KEY_OUTSIDE_GRANTED_PREFIX",
      `This profile's approval covers only "${permit.request.path}", not "${path}".`,
      ExitCode.PERMISSION_DENIED,
    );
  }
  if (new URL(host).origin !== new URL(permit.host).origin) {
    throw new CLIError(
      "APP_KEY_HOST_MISMATCH",
      `This profile's approval is for ${permit.host}, not ${host}. To use ${host}, sign in on a new profile.`,
      ExitCode.PERMISSION_DENIED,
    );
  }
  const request: ExactAppKeyRequest = { ...permit.request, optIn: true };
  const verdict = verifyExactAppKeyProof(request, permit.proof);
  if (!verdict.ok) {
    const expires = Date.parse(/^Expiration Time: (.+)$/m.exec(permit.proof.siwe)?.[1] ?? "");
    if (Number.isFinite(expires) && expires <= Date.now()) {
      throw new CLIError(
        "APP_KEY_EXPIRED",
        `The app-key approval for profile "${profileName}" has expired. Sign in with \`${CLI_NAME} --profile ${profileName} auth login --keys <full-app-key> --app-key\` for a new approval.`,
        ExitCode.AUTH_REQUIRED,
      );
    }
    throw unusable(profileName, "does not verify");
  }
  return { profileName, host, ownerDid: permit.request.ownerDid, request, proof: permit.proof };
}

/** Have the node accept the verified approval and return the client that can use exactly that key. */
export function openVerifiedAppKey(approval: VerifiedAppKey, registryUrl: string | undefined): Promise<ExactAppKeyClient> {
  const node = appKeyNode(approval.profileName, approval.host, approval.ownerDid, registryUrl);
  return openExactAppKeyClient(node, approval.request, approval.proof);
}

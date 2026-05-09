import { Command } from "commander";
import { createInterface } from "node:readline";
import type { PermissionEntry, PortableDelegation } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, shouldOutputJson, formatField, formatTable, isInteractive, withSpinner } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode, DEFAULT_CHAIN_ID, DEFAULT_OPENKEY_HOST } from "../config/constants.js";
import type { ProfileConfig } from "../config/types.js";

/**
 * Resolve the OpenKey base URL for a profile.
 * Order: TC_OPENKEY_HOST env override → profile.openkeyHost → default.
 *
 * No prompts, no migration. To use a self-hosted OpenKey for a profile,
 * edit `~/.tinycloud/profiles/<profile>/profile.json` and add an
 * "openkeyHost": "https://openkey.localhost" field.
 */
function resolveOpenKeyHost(profile: ProfileConfig): string {
  return process.env.TC_OPENKEY_HOST ?? profile.openkeyHost ?? DEFAULT_OPENKEY_HOST;
}
import { startAuthFlow } from "../auth/browser-auth.js";
import {
  generateLocalIdentity,
  deriveAddress,
  addressToDID,
  localKeySignIn,
  generateKey,
} from "../auth/local-key.js";
import { theme } from "../output/theme.js";
import type { AuthMethod } from "../config/types.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import {
  appendAdditionalDelegation,
  appendGrantHistory,
  compactPermission,
  loadAdditionalDelegations,
  loadManifestPermissions,
  loadPermissionRequest,
  parseCapSpec,
  permissionsFromDelegation,
  readGrantHistory,
  storedAdditionalDelegation,
} from "../lib/permissions.js";

/**
 * Prompt user to choose an auth method interactively.
 * Returns "local" for non-interactive (CI/headless) environments.
 */
async function promptAuthMethod(): Promise<AuthMethod> {
  if (!isInteractive()) {
    return "local";
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise<AuthMethod>((resolve) => {
    process.stderr.write("\n" + theme.heading("Choose authentication method:") + "\n");
    process.stderr.write(`  ${theme.accent("1)")} OpenKey ${theme.muted("(browser-based, for interactive use)")}\n`);
    process.stderr.write(`  ${theme.accent("2)")} Local key ${theme.muted("(Ethereum private key, for agents/CI)")}\n\n`);

    rl.question("Enter choice [1]: ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "2" || trimmed.toLowerCase() === "local") {
        resolve("local");
      } else {
        resolve("openkey");
      }
    });
  });
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Authentication management");

  auth
    .command("login")
    .description("Authenticate with TinyCloud")
    .option("--paste", "Use manual paste mode instead of browser callback")
    .option("--method <method>", "Authentication method: local or openkey")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        // Determine auth method
        let method: AuthMethod;
        if (options.method) {
          if (options.method !== "local" && options.method !== "openkey") {
            throw new CLIError(
              "INVALID_METHOD",
              `Invalid auth method "${options.method}". Use "local" or "openkey".`,
              ExitCode.USAGE_ERROR,
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

  auth
    .command("logout")
    .description("Clear session (keep key)")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        await ProfileManager.clearSession(ctx.profile);
        outputJson({ profile: ctx.profile, authenticated: false });
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command("status")
    .description("Show current authentication state")
    .action(async (_options, cmd) => {
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
            address: profile?.address ?? null,
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

  auth
    .command("request")
    .description("Request additional TinyCloud permissions for the active session")
    .option(
      "--cap <spec>",
      "Capability spec: tinycloud.<service>:<space>:<path>:<actions-csv> (repeatable)",
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option("--permission <file>", "JSON permission request: { \"permissions\": PermissionEntry[] }")
    .option("--manifest <fileOrBase64>", "Manifest file, base64:<json>, or raw base64 JSON")
    .option("--yes", "Skip local-key TTY confirmation", false)
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const profile = await ProfileManager.getProfile(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
        const requested = await collectRequestedPermissions(options, ctx.profile);

        if (requested.length === 0) {
          throw new CLIError(
            "NO_CAPS_REQUESTED",
            "Provide at least one --cap, --permission, or --manifest.",
            ExitCode.USAGE_ERROR,
          );
        }

        const node = await ensureAuthenticated(ctx);

        // Fast path: master's grantRuntimePermissions / hasRuntimePermissions
        // already does the diff against the live session + existing runtime
        // grants; no need to compute it ourselves.
        if (node.hasRuntimePermissions(requested)) {
          outputJson({ changed: false, missing: [], added: [] });
          return;
        }

        if (profile.authMethod === "openkey") {
          const key = await ProfileManager.getKey(ctx.profile);
          if (!key) {
            throw new CLIError("NO_KEY", `No key found for profile "${ctx.profile}". Run \`tc init\` first.`, ExitCode.AUTH_REQUIRED);
          }
          const delegationCids: string[] = [];
          let expiry: string | undefined;
          const openkeyHost = resolveOpenKeyHost(profile);
          for (const group of groupPermissionsBySpace(requested)) {
            const delegationData = await startAuthFlow(profile.did, {
              jwk: key,
              host: ctx.host,
              permissions: group,
              openkeyHost,
            });
            const delegation = portableFromOpenKeyDelegation(delegationData, group, ctx.host);
            const stored = storedAdditionalDelegation(delegation, group);
            await appendAdditionalDelegation(ctx.profile, stored);
            await node.useRuntimeDelegation(delegation);
            delegationCids.push(delegation.cid);
            expiry = delegation.expiry.toISOString();
            await appendGrantHistory(ctx.profile, {
              addedCaps: group,
              source: options.manifest ? "manifest" : "cli",
              delegationCid: delegation.cid,
              expiry,
            });
          }
          outputJson({
            changed: delegationCids.length > 0,
            added: requested,
            delegationCid: delegationCids[0],
            delegationCids,
            expiry,
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
            ExitCode.USAGE_ERROR,
          );
        }
        void session;

        // Local-key flow: master's grantRuntimePermissions handles signing
        // through the SDK's wallet-mode signer, groups by space, and skips
        // anything already covered by the session or an existing grant.
        const delegations = await node.grantRuntimePermissions(requested);
        const delegationCids: string[] = [];
        let expiry: string | undefined;
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
            expiry,
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
          expiry,
        });
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command("caps")
    .description("Show granted capabilities for the active session")
    .option("--diff <spec>", "Show missing capabilities for a spec")
    .option("--history", "Show recent permission grants")
    .action(async (options, cmd) => {
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
                entry.addedCaps.map(compactPermission).join("; "),
              ]),
            ) + "\n");
          }
          return;
        }

        const node = await ensureAuthenticated(ctx);
        const runtimeDelegations = node.getRuntimePermissionDelegations();
        // Granted view = permissions covered by appended runtime delegations.
        // The base-session SIWE recap isn't enumerated here because the
        // node-sdk doesn't expose it as a list — `hasRuntimePermissions()`
        // is the trusted answer for "is this covered?".
        const granted = runtimeDelegations.flatMap(permissionsFromDelegation);

        if (options.diff) {
          const requested = [await parseCapSpec(options.diff, ctx.profile)];
          const covered = node.hasRuntimePermissions(requested);
          outputJson({
            requested,
            changed: !covered,
            covered,
            // `missing` retained for backwards-compatible callers.
            missing: covered ? [] : requested,
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
              entry.actions.join(", "),
            ]),
          ) + "\n");
        }
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command("whoami")
    .description("Show identity information")
    .action(async (_options, cmd) => {
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
            address: profile.address ?? null,
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

async function collectRequestedPermissions(
  options: {
    cap?: string[];
    permission?: string;
    manifest?: string;
  },
  profile: string,
): Promise<PermissionEntry[]> {
  const permissions: PermissionEntry[] = [];
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

async function confirmPermissionRequest(permissions: PermissionEntry[]): Promise<void> {
  process.stderr.write("\n" + theme.heading("Additional Permissions") + "\n");
  for (const permission of permissions) {
    const dangerous = isDangerousPermission(permission);
    const line = `  ${compactPermission(permission)}`;
    process.stderr.write((dangerous ? theme.warn(line) : theme.value(line)) + "\n");
  }
  process.stderr.write("\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question("Approve local-key delegation? [y/N] ", resolve);
  });
  rl.close();

  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CLIError("REQUEST_CANCELLED", "Permission request cancelled.", ExitCode.ERROR);
  }
}

function isDangerousPermission(permission: PermissionEntry): boolean {
  if (permission.path === "" || permission.path === "/") return true;
  return permission.actions.some((action) =>
    action.includes("*") ||
    action.endsWith("/write") ||
    action.endsWith("/admin") ||
    action.endsWith("/ddl") ||
    action.endsWith("/del"),
  );
}

function groupPermissionsBySpace(permissions: PermissionEntry[]): PermissionEntry[][] {
  const groups = new Map<string, PermissionEntry[]>();
  for (const permission of permissions) {
    const group = groups.get(permission.space) ?? [];
    group.push(permission);
    groups.set(permission.space, group);
  }
  return Array.from(groups.values());
}

function portableFromOpenKeyDelegation(
  data: Record<string, unknown>,
  permissions: PermissionEntry[],
  host: string,
): PortableDelegation {
  const primary = permissions[0];
  const returnedSpace = String(data.spaceId ?? primary.space);
  const expectedSpaces = new Set(permissions.map((permission) => permission.space));
  if (expectedSpaces.size !== 1 || !expectedSpaces.has(returnedSpace)) {
    throw new CLIError(
      "OPENKEY_SCOPE_MISMATCH",
      `OpenKey returned delegation for ${returnedSpace}, expected ${Array.from(expectedSpaces).join(", ")}.`,
      ExitCode.PERMISSION_DENIED,
    );
  }
  const expiry = inferDelegationExpiry(data);
  return {
    cid: String(data.delegationCid),
    delegationHeader: data.delegationHeader as { Authorization: string },
    spaceId: returnedSpace,
    path: primary.path,
    actions: primary.actions,
    resources: permissions.map((permission) => ({
      service: permission.service.startsWith("tinycloud.")
        ? permission.service.slice("tinycloud.".length)
        : permission.service,
      space: permission.space,
      path: permission.path,
      actions: [...permission.actions],
    })),
    expiry,
    delegateDID: String(data.verificationMethod),
    ownerAddress: String(data.address ?? ""),
    chainId: typeof data.chainId === "number" ? data.chainId : DEFAULT_CHAIN_ID,
    host,
  };
}

function inferDelegationExpiry(data: Record<string, unknown>): Date {
  const direct = data.expiry ?? data.expiresAt;
  if (typeof direct === "string") {
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + 60 * 60 * 1000);
}

/**
 * Handle local Ethereum key authentication.
 * Generates or reuses a local private key, creates a did:pkh identity,
 * and signs in to TinyCloud directly (no browser needed).
 */
async function handleLocalAuth(profileName: string, host: string): Promise<void> {
  const profile = await ProfileManager.getProfile(profileName).catch(() => null);

  let privateKey: string;
  let address: string;
  let did: string;

  if (profile?.authMethod === "local" && profile.privateKey && profile.address) {
    // Reuse existing local key
    privateKey = profile.privateKey;
    address = profile.address;
    did = profile.did;

    if (isInteractive()) {
      process.stderr.write(theme.muted("Using existing local key") + "\n");
      process.stderr.write(formatField("Address", address) + "\n");
    }
  } else {
    // Generate new local identity
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

  // We also need a session key (Ed25519 JWK) for the profile
  const hasKey = await ProfileManager.getKey(profileName);
  if (!hasKey) {
    const { jwk } = await withSpinner("Generating session key...", async () => {
      return generateKey();
    });
    await ProfileManager.setKey(profileName, jwk);
  }

  // Sign in using the private key
  const sessionResult = await withSpinner("Signing in...", async () => {
    return localKeySignIn({ privateKey, host });
  });

  // Store session data
  await ProfileManager.setSession(profileName, {
    authMethod: "local",
    address,
    chainId: DEFAULT_CHAIN_ID,
    spaceId: sessionResult.spaceId,
  });

  // Update profile
  await ProfileManager.setProfile(profileName, {
    name: profileName,
    host,
    chainId: DEFAULT_CHAIN_ID,
    spaceName: "default",
    did,
    primaryDid: did,
    spaceId: sessionResult.spaceId,
    createdAt: profile?.createdAt ?? new Date().toISOString(),
    authMethod: "local",
    privateKey,
    address,
  });

  outputJson({
    authenticated: true,
    profile: profileName,
    did,
    address,
    spaceId: sessionResult.spaceId,
    authMethod: "local",
  });
}

/**
 * Handle OpenKey (browser-based) authentication.
 * This is the original auth flow.
 */
async function handleOpenKeyAuth(profileName: string, host: string, paste?: boolean): Promise<void> {
  const key = await ProfileManager.getKey(profileName);
  if (!key) {
    throw new CLIError(
      "NO_KEY",
      `No key found for profile "${profileName}". Run \`tc init\` first.`,
      ExitCode.AUTH_REQUIRED,
    );
  }

  // Get DID from profile
  const profile = await ProfileManager.getProfile(profileName);

  // Start browser auth flow
  const delegationData = await startAuthFlow(profile.did, {
    paste,
    jwk: key,
    host,
    openkeyHost: resolveOpenKeyHost(profile),
  });

  // Store session
  await ProfileManager.setSession(profileName, delegationData);

  // Update profile with primary DID if present
  const updatedProfile = {
    ...profile,
    authMethod: "openkey" as const,
  };

  if (delegationData.spaceId) {
    updatedProfile.spaceId = delegationData.spaceId;
    updatedProfile.primaryDid = delegationData.primaryDid as string | undefined;
  }

  await ProfileManager.setProfile(profileName, updatedProfile);

  outputJson({
    authenticated: true,
    profile: profileName,
    did: profile.did,
    spaceId: delegationData.spaceId,
    authMethod: "openkey",
  });
}

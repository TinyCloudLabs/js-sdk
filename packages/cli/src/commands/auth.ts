import { Command } from "commander";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { IncomingMessage } from "node:http";
import { grantAuthRequest, principalDidEquals, type PermissionEntry, type PortableDelegation, type TinyCloudSession } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, shouldOutputJson, formatField, formatTable, isInteractive, withSpinner } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode, DEFAULT_CHAIN_ID, DEFAULT_OPENKEY_HOST } from "../config/constants.js";
import {
  resolveProfileOperatorType,
  resolveProfilePosture,
  type AuthMethod,
  type ProfileConfig,
} from "../config/types.js";

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
  keyToDID,
} from "../auth/local-key.js";
import { theme } from "../output/theme.js";
import { bootstrapDelegatedSession, ensureAuthenticated } from "../lib/sdk.js";
import {
  appendAdditionalDelegation,
  appendPermissionRequestArtifact,
  createPermissionRequestArtifact,
  getLastPermissionRequestArtifact,
  getPermissionRequestArtifact,
  isDelegationImportArtifact,
  isPermissionRequestArtifact,
  appendGrantHistory,
  compactPermission,
  loadAdditionalDelegations,
  loadManifestPermissions,
  loadPermissionRequest,
  parseCapSpec,
  permissionsFromDelegation,
  readGrantHistory,
  resolvePermissionSpaces,
  storedAdditionalDelegation,
  type PermissionRequestArtifact,
} from "../lib/permissions.js";

/** The one function dependency used by owner OpenKey permission acquisition. */
export type OpenKeyAcquisition = typeof startAuthFlow;

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
    .option("--no-popup", "Print the OpenKey URL without opening a browser")
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
          await handleOpenKeyAuth(ctx.profile, ctx.host, {
            paste: options.paste,
            noPopup: options.popup === false,
          });
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
    .command("rotate")
    .description("Rotate the active profile session key")
    .option("--paste", "Use manual paste mode instead of browser callback")
    .option("--no-popup", "Print the OpenKey URL without opening a browser")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        await rotateAuthKey(ctx.profile, ctx.host, {
          paste: options.paste,
          noPopup: options.popup === false,
        });
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
            address: profile?.address ?? null,
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

  auth
    .command("request")
    .description("Create a TinyCloud permission request artifact")
    .option(
      "--cap <spec>",
      "Capability spec: tinycloud.<service>:<space>:<path>:<actions-csv> (repeatable)",
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option("--permission <file>", "JSON permission request: { \"permissions\": PermissionEntry[] }")
    .option("--manifest <fileOrBase64>", "Manifest file, base64:<json>, or raw base64 JSON")
    .option(
      "--expiry <duration>",
      "Lifetime of the granted delegation. ms-format string (e.g. \"7d\", \"30m\") or raw milliseconds. Defaults to 7d, capped by the active session's expiry.",
    )
    .option("--emit [file]", "Emit the request artifact to stdout, or write it to file when provided")
    .option("--grant", "Grant the requested permissions immediately with this owner profile")
    .option("--yes", "Skip local-key TTY confirmation", false)
    .option("--no-popup", "Print the OpenKey URL without opening a browser when granting with OpenKey")
    .action(async (options, cmd) => {
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
            ExitCode.USAGE_ERROR,
          );
        }

        if (!options.grant) {
          const artifact = createPermissionRequestArtifact({
            profileName: ctx.profile,
            profile,
            host: ctx.host,
            requested,
            requestedExpiry: expiryOption,
          });
          await appendPermissionRequestArtifact(ctx.profile, artifact);
          await emitPermissionRequestArtifact(artifact, options.emit);
          return;
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
              reason: permissionGrantReason(
                "Grant requested TinyCloud permissions from `tc auth request --grant`.",
                group,
              ),
              openkeyHost,
              expiry: expiryOption,
              noPopup: options.popup === false,
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

        // Local-key flow: master's grantRuntimePermissions handles signing
        // through the SDK's wallet-mode signer, groups by space, and skips
        // anything already covered by the session or an existing grant.
        const delegations = await node.grantRuntimePermissions(
          requested,
          expiryOption !== undefined ? { expiry: expiryOption } : undefined,
        );
        await persistCurrentLocalSession(ctx.profile, profile, node.restorableSession);
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
    .command("import [source]")
    .description("Import a TinyCloud delegation or permission request artifact")
    .option("--stdin", "Read the JSON artifact from stdin")
    .option("--paste", "Read the JSON artifact from stdin")
    .action(async (source: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const raw = await readAuthArtifactSource(source, {
          stdin: options.stdin === true || options.paste === true,
        });
        const parsed = JSON.parse(raw) as unknown;

        if (isPermissionRequestArtifact(parsed)) {
          await appendPermissionRequestArtifact(ctx.profile, parsed);
          outputJson({
            imported: true,
            kind: parsed.kind,
            requestId: parsed.requestId,
            requested: parsed.requested,
            next: `tc auth retry ${parsed.requestId}`,
          });
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
          imported.permissions,
        ));

        // A delegation whose audience is this profile's own session key can be
        // installed as a runtime grant (useRuntimeDelegation activates it for
        // matching service calls). A cross-user delegation — audience is this
        // profile's stable identity DID or another principal — cannot: the node
        // rejects runtime delegations that don't target the session key. Persist
        // it and let the read path activate it via useDelegation in wallet mode.
        const targetsSessionKey =
          typeof imported.delegation.delegateDID === "string" &&
          principalDidEquals(imported.delegation.delegateDID, node.sessionDid);
        let activated = false;
        if (targetsSessionKey) {
          await node.useRuntimeDelegation(imported.delegation);
          activated = true;
        }
        await appendGrantHistory(ctx.profile, {
          addedCaps: imported.permissions,
          source: "cli",
          delegationCid: imported.delegation.cid,
          expiry: imported.delegation.expiry.toISOString(),
        });

        outputJson({
          imported: true,
          activated,
          kind: "tinycloud.auth.delegation",
          requestId: imported.requestId ?? null,
          delegationCid: imported.delegation.cid,
          permissions: imported.permissions,
          expiry: imported.delegation.expiry.toISOString(),
        });
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command("grant [request]")
    .description("Grant a TinyCloud permission request artifact to its requester")
    .option("--stdin", "Read the JSON request artifact from stdin")
    .option("--paste", "Read the JSON request artifact from stdin")
    .option("--yes", "Skip local-key TTY confirmation", false)
    .action(async (source: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const profile = await ProfileManager.getProfile(ctx.profile);
        const raw = await readAuthArtifactSource(source, {
          stdin: options.stdin === true || options.paste === true,
        });
        const parsed = JSON.parse(raw) as unknown;

        if (!isPermissionRequestArtifact(parsed)) {
          throw new CLIError(
            "INVALID_AUTH_REQUEST",
            "Auth grant requires a tinycloud.auth.request artifact.",
            ExitCode.USAGE_ERROR,
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
          yes: options.yes === true,
        });

        // The grant logic lives in the SDK (grantAuthRequest) so it is callable
        // programmatically; this command is a thin wrapper. The CLI request
        // artifact is a structural superset of AuthRequestArtifact.
        const grant = await grantAuthRequest(node, resolvedRequest);
        outputJson(grant);
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command("retry [requestId]")
    .description("Check whether a stored permission request is now satisfied")
    .option("--last", "Use the latest stored permission request for this profile")
    .option("--exec", "Run the captured command when the request is covered")
    .action(async (requestId: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const artifact = options.last
          ? await getLastPermissionRequestArtifact(ctx.profile)
          : requestId
            ? await getPermissionRequestArtifact(ctx.profile, requestId)
            : null;

        if (!artifact) {
          throw new CLIError(
            "REQUEST_NOT_FOUND",
            options.last
              ? `No stored permission requests exist for profile "${ctx.profile}".`
              : "Provide a requestId or use --last.",
            ExitCode.NOT_FOUND,
          );
        }

        const node = await ensureAuthenticated(ctx);
        const covered = node.hasRuntimePermissions(artifact.requested);
        if (options.exec) {
          if (!covered) {
            throw new CLIError(
              "PERMISSIONS_MISSING",
              `Request ${artifact.requestId} is not covered yet. Import a delegation, then retry with --exec.`,
              ExitCode.PERMISSION_DENIED,
            );
          }
          if (!artifact.command?.argv?.length) {
            throw new CLIError(
              "COMMAND_NOT_CAPTURED",
              `Request ${artifact.requestId} does not include a captured command.`,
              ExitCode.USAGE_ERROR,
            );
          }
          await execCapturedCommand(artifact.command);
          return;
        }

        outputJson({
          requestId: artifact.requestId,
          covered,
          missing: covered ? [] : artifact.requested,
          command: artifact.command ?? null,
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
            address: profile.address ?? null,
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

async function emitPermissionRequestArtifact(
  artifact: PermissionRequestArtifact,
  emitOption: unknown,
): Promise<void> {
  if (typeof emitOption === "string" && emitOption.length > 0) {
    await mkdir(dirname(emitOption), { recursive: true });
    await writeFile(emitOption, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    outputJson({
      emitted: true,
      path: emitOption,
      requestId: artifact.requestId,
      requested: artifact.requested,
    });
    return;
  }
  outputJson(artifact);
}

async function readAuthArtifactSource(
  source: string | undefined,
  options: { stdin: boolean },
): Promise<string> {
  if (options.stdin || source === "-" || (!source && !isInteractive())) {
    return readStdin();
  }

  if (!source) {
    throw new CLIError(
      "IMPORT_SOURCE_REQUIRED",
      "Provide an artifact file, URL, or use --stdin.",
      ExitCode.USAGE_ERROR,
    );
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    return readUrl(source);
  }

  return readFile(source, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readUrl(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const getter = source.startsWith("https://") ? httpsGet : httpGet;
    const request = getter(source, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        readUrl(new URL(response.headers.location, source).toString()).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new CLIError(
          "IMPORT_FETCH_FAILED",
          `Failed to fetch ${source}: HTTP ${status}.`,
          ExitCode.ERROR,
        ));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}

function normalizeDelegationImport(value: unknown): {
  requestId?: string;
  delegation: PortableDelegation;
  permissions: PermissionEntry[];
} {
  if (isDelegationImportArtifact(value)) {
    const delegation = normalizePortableDelegation(value.delegation);
    return {
      requestId: value.requestId,
      delegation,
      permissions: Array.isArray(value.permissions) && value.permissions.length > 0
        ? value.permissions
        : permissionsFromDelegation(delegation),
    };
  }

  if (isStoredDelegationLike(value)) {
    const delegation = normalizePortableDelegation(value.delegation);
    return {
      delegation,
      permissions: Array.isArray(value.permissions) && value.permissions.length > 0
        ? value.permissions
        : permissionsFromDelegation(delegation),
    };
  }

  if (isPortableDelegationLike(value)) {
    const delegation = normalizePortableDelegation(value);
    return {
      delegation,
      permissions: permissionsFromDelegation(delegation),
    };
  }

  throw new CLIError(
    "INVALID_AUTH_IMPORT",
    "Auth import must be a tinycloud.auth.delegation artifact, a portable delegation, or a tinycloud.auth.request artifact.",
    ExitCode.USAGE_ERROR,
  );
}

function isStoredDelegationLike(value: unknown): value is {
  delegation: PortableDelegation;
  permissions?: PermissionEntry[];
} {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { delegation?: unknown };
  return isPortableDelegationLike(candidate.delegation);
}

function isPortableDelegationLike(value: unknown): value is PortableDelegation {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PortableDelegation>;
  return (
    typeof candidate.cid === "string" &&
    typeof candidate.spaceId === "string" &&
    typeof candidate.path === "string" &&
    Array.isArray(candidate.actions) &&
    candidate.delegationHeader !== undefined &&
    typeof candidate.delegationHeader === "object"
  );
}

function normalizePortableDelegation(delegation: PortableDelegation): PortableDelegation {
  const rawExpiry = (delegation as PortableDelegation & { expiry: unknown }).expiry;
  const expiry = rawExpiry instanceof Date ? rawExpiry : new Date(String(rawExpiry));
  if (Number.isNaN(expiry.getTime())) {
    throw new CLIError(
      "INVALID_AUTH_IMPORT",
      "Imported delegation must include a valid expiry.",
      ExitCode.USAGE_ERROR,
    );
  }
  return { ...delegation, expiry };
}

export async function ensureDelegationAuthority(params: {
  ctx: { profile: string; host: string };
  profile: ProfileConfig;
  node: Awaited<ReturnType<typeof ensureAuthenticated>>;
  requested: PermissionEntry[];
  expiryOption: string | number | undefined;
  reason: string;
  yes: boolean;
  force?: boolean;
  /** Test seam for the browser acquisition boundary; production uses startAuthFlow. */
  openKeyAcquisition?: OpenKeyAcquisition;
}): Promise<void> {
  if (!params.force && params.node.hasRuntimePermissions(params.requested)) return;

  if (params.profile.authMethod === "openkey") {
    const key = await ProfileManager.getKey(params.ctx.profile);
    if (!key) {
      throw new CLIError(
        "NO_KEY",
        `No key found for profile "${params.ctx.profile}". Run \`tc init\` first.`,
        ExitCode.AUTH_REQUIRED,
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
        expiry: params.expiryOption,
      });
      const delegation = portableFromOpenKeyDelegation(delegationData, group, params.ctx.host);
      await appendAdditionalDelegation(
        params.ctx.profile,
        storedAdditionalDelegation(delegation, group),
      );
      await params.node.useRuntimeDelegation(delegation);
      await appendGrantHistory(params.ctx.profile, {
        addedCaps: group,
        source: "cli",
        delegationCid: delegation.cid,
        expiry: delegation.expiry.toISOString(),
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
      ExitCode.USAGE_ERROR,
    );
  }

  const delegations = await params.node.grantRuntimePermissions(
    params.requested,
    params.expiryOption !== undefined ? { expiry: params.expiryOption } : undefined,
  );
  for (const delegation of delegations) {
    const covering = permissionsFromDelegation(delegation);
    await appendAdditionalDelegation(
      params.ctx.profile,
      storedAdditionalDelegation(delegation, covering),
    );
    await appendGrantHistory(params.ctx.profile, {
      addedCaps: covering,
      source: "cli",
      delegationCid: delegation.cid,
      expiry: delegation.expiry.toISOString(),
    });
  }
}

function permissionGrantReason(context: string, permissions: PermissionEntry[]): string {
  const first = permissions[0];
  const summary = first ? compactPermission(first) : "no permissions";
  const more = permissions.length > 1
    ? ` and ${permissions.length - 1} more permission${permissions.length === 2 ? "" : "s"}`
    : "";
  return `${context} Requested: ${summary}${more}.`;
}

function execCapturedCommand(command: { argv: string[]; cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...command.argv], {
      cwd: command.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new CLIError(
          "COMMAND_SIGNAL",
          `Captured command exited from signal ${signal}.`,
          ExitCode.ERROR,
        ));
        return;
      }
      if (code && code !== 0) {
        process.exitCode = code;
      }
      resolve();
    });
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
    action.endsWith("/schema") ||
    action.endsWith("/del"),
  );
}

/**
 * Parse the `--expiry` flag into either a ms-format string ("7d", "30m") or
 * raw milliseconds. Returns undefined for missing input so the caller falls
 * back to the SDK's DEFAULT_DELEGATION_EXPIRY_MS.
 *
 * Pure-numeric strings are coerced to numbers so a shell-quoted ms count
 * (`--expiry 86400000`) works, but anything that contains a unit suffix
 * (`"7d"`, `"30m"`) is forwarded as-is to parseExpiry which understands
 * the ms-format vocabulary.
 */
function parseExpiryOption(raw: unknown): string | number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CLIError(
      "INVALID_EXPIRY",
      `--expiry must be a string (e.g. "7d", "30m") or a millisecond integer.`,
      ExitCode.USAGE_ERROR,
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

export function groupPermissionsBySpace(permissions: PermissionEntry[]): PermissionEntry[][] {
  const groups = new Map<string, PermissionEntry[]>();
  const rawEntries: PermissionEntry[] = [];
  for (const permission of permissions) {
    if (isRawPermission(permission)) {
      rawEntries.push(permission);
      continue;
    }
    // Key by address-normalized space so multiple caps on the same space batch
    // into one OpenKey round-trip even when one cap's address is checksummed and
    // another is lowercase. The space NAME stays case-sensitive, so genuinely
    // different names are NOT merged. Entries keep their original space string.
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

function isRawPermission(permission: PermissionEntry): boolean {
  return permission.service === "tinycloud.encryption" &&
    permission.path.startsWith("urn:tinycloud:encryption:");
}

/**
 * Normalize a space identifier for case-insensitive comparison of its
 * embedded Ethereum address ONLY.
 *
 * Space URIs are `tinycloud:pkh:eip155:<chain>:<0xADDR>:<name>`. Ethereum
 * addresses are case-insensitive, but OpenKey returns the EIP-55 checksummed
 * form (mixed case) while the CLI builds the lowercase form, so a byte-for-byte
 * compare spuriously fails. Lowercase ONLY the `eip155:<chain>:0x<addr>` address
 * segment and leave everything else — crucially the space NAME, which repo
 * parsers treat as case-sensitive — byte-exact.
 */
function normalizeSpaceForCompare(space: string): string {
  return space.replace(
    /(eip155:\d+:)(0x[0-9a-fA-F]{40})/,
    (_match, prefix: string, addr: string) => prefix + addr.toLowerCase(),
  );
}

export function returnedSpaceMatchesExpected(returnedSpace: string, expectedSpace: string): boolean {
  if (normalizeSpaceForCompare(returnedSpace) === normalizeSpaceForCompare(expectedSpace)) {
    return true;
  }

  if (!returnedSpace.startsWith("tinycloud:")) return false;
  // expectedSpace may be a bare space NAME; the NAME is case-sensitive, so
  // compare the returned URI's name segment byte-exact.
  const returnedName = returnedSpace.slice(returnedSpace.lastIndexOf(":") + 1);
  return returnedName === expectedSpace;
}

export function portableFromOpenKeyDelegation(
  data: Record<string, unknown>,
  permissions: PermissionEntry[],
  host: string,
): PortableDelegation {
  const primary = permissions.find((permission) => !isRawPermission(permission)) ?? permissions[0];
  const returnedSpace = String(data.spaceId ?? primary.space ?? "encryption");
  // Normalize for the size check so that multiple caps on the same space that
  // only differ by address checksum casing collapse to one expected space.
  const expectedSpaces = new Set(
    permissions
      .filter((permission) => !isRawPermission(permission))
      .map((permission) => normalizeSpaceForCompare(permission.space)),
  );
  const matchesExpectedSpace = expectedSpaces.size === 1 &&
    returnedSpaceMatchesExpected(returnedSpace, Array.from(expectedSpaces)[0]!);
  if (expectedSpaces.size > 0 && !matchesExpectedSpace) {
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
      space: isRawPermission(permission) ? permission.space : returnedSpace,
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
    ExitCode.ERROR,
  );
}

function parseDelegationExpiryField(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const parsed = new Date(value < 10_000_000_000 ? value * 1000 : value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

async function rotateAuthKey(
  profileName: string,
  host: string,
  options: { paste?: boolean; noPopup?: boolean } = {},
): Promise<void> {
  const profile = await ProfileManager.getProfile(profileName);
  const posture = resolveProfilePosture(profile);
  const oldDid = profile.sessionDid ?? profile.did;

  if (posture === "delegate-session") {
    throw new CLIError(
      "ROTATE_DELEGATE_SESSION_UNSUPPORTED",
      `Profile "${profileName}" is a delegated session. Request or import a new owner delegation instead of rotating it locally.`,
      ExitCode.PERMISSION_DENIED,
    );
  }

  if (profile.authMethod === "local" || posture === "local-owner-key") {
    if (!profile.privateKey) {
      throw new CLIError(
        "LOCAL_OWNER_KEY_REQUIRED",
        `Profile "${profileName}" does not have a local owner private key. Run \`tc auth login --method local\` first.`,
        ExitCode.AUTH_REQUIRED,
      );
    }

    await ProfileManager.clearSession(profileName);
    const result = await handleLocalAuth(profileName, host, {
      emitOutput: false,
      forceSessionKey: true,
    });
    outputRotationResult(result.profile, profileName, oldDid, "local");
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
    authMethod: "openkey",
  });

  const result = await refreshOpenKeySession(profileName, host, {
    paste: options.paste,
    noPopup: options.noPopup,
  });
  outputRotationResult(result.profile, profileName, oldDid, "openkey");
}

function outputRotationResult(
  profile: ProfileConfig,
  profileName: string,
  oldDid: string,
  authMethod: AuthMethod,
): void {
  outputJson({
    rotated: true,
    profile: profileName,
    oldDid,
    did: profile.did,
    sessionDid: profile.sessionDid ?? null,
    authMethod,
    spaceId: profile.spaceId ?? null,
  });
}

async function persistCurrentLocalSession(
  profileName: string,
  profile: ProfileConfig,
  session: TinyCloudSession | undefined,
): Promise<void> {
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
    signature: session.signature,
  });

  if (profile.sessionDid !== session.verificationMethod || profile.spaceId !== session.spaceId) {
    await ProfileManager.setProfile(profileName, {
      ...profile,
      sessionDid: session.verificationMethod,
      spaceId: session.spaceId,
    });
  }
}

type LocalAuthResult = {
  profile: ProfileConfig;
  sessionResult: Awaited<ReturnType<typeof localKeySignIn>>;
};

/**
 * Handle local Ethereum key authentication.
 * Generates or reuses a local private key, creates a did:pkh identity,
 * and signs in to TinyCloud directly (no browser needed).
 */
async function handleLocalAuth(
  profileName: string,
  host: string,
  options: { emitOutput?: boolean; forceSessionKey?: boolean } = {},
): Promise<LocalAuthResult> {
  const profile = await ProfileManager.getProfile(profileName).catch(() => null);
  const posture = profile ? resolveProfilePosture(profile) : null;

  let privateKey: string;
  let address: string;
  let did: string;
  let sessionDid = profile?.sessionDid;

  if ((profile?.authMethod === "local" || posture === "local-owner-key") && profile.privateKey) {
    // Reuse existing local key
    privateKey = profile.privateKey;
    address = profile.address ?? await deriveAddress(privateKey);
    did = profile.did.startsWith("did:pkh:")
      ? profile.did
      : addressToDID(address, profile.chainId ?? DEFAULT_CHAIN_ID);

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
  if (options.forceSessionKey || !hasKey) {
    const { jwk, did: generatedSessionDid } = await withSpinner("Generating session key...", async () => {
      return generateKey();
    });
    await ProfileManager.setKey(profileName, jwk);
    sessionDid = generatedSessionDid;
  } else if (!sessionDid) {
    sessionDid = keyToDID(hasKey);
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
    delegationHeader: sessionResult.delegationHeader,
    delegationCid: sessionResult.delegationCid,
    jwk: sessionResult.jwk,
    verificationMethod: sessionResult.verificationMethod,
    siwe: sessionResult.siwe,
    signature: sessionResult.signature,
  });
  sessionDid = sessionResult.verificationMethod;

  // Update profile
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
    createdAt: profile?.createdAt ?? new Date().toISOString(),
    posture: profile?.posture ?? "local-owner-key",
    operatorType: profile?.operatorType ?? "human",
    authMethod: "local",
    privateKey,
    address,
  } satisfies ProfileConfig;

  await ProfileManager.setProfile(profileName, updatedProfile);

  if (options.emitOutput ?? true) {
    outputJson({
      authenticated: true,
      profile: profileName,
      did,
      sessionDid,
      address,
      spaceId: sessionResult.spaceId,
      authMethod: "local",
    });
  }

  return { profile: updatedProfile, sessionResult };
}

/**
 * Handle OpenKey (browser-based) authentication.
 * This is the original auth flow.
 */
async function handleOpenKeyAuth(
  profileName: string,
  host: string,
  options: { paste?: boolean; noPopup?: boolean } = {},
): Promise<void> {
  const { profile, delegationData } = await refreshOpenKeySession(profileName, host, options);

  outputJson({
    authenticated: true,
    profile: profileName,
    did: profile.did,
    spaceId: delegationData.spaceId,
    authMethod: "openkey",
  });
}

/**
 * If the OpenKey callback returned a public-only JWK (no `d`), splice the
 * private parameter from the profile's `key.json` back in so the persisted
 * session is usable for WASM signing later.
 *
 * Why this exists: `browser-auth.ts:publicJwkForDelegation` strips `d` before
 * sending the JWK to OpenKey, OpenKey echoes the public-only JWK back, and
 * the previous code path persisted it verbatim. Downstream callers
 * (`tc kv get`, `tc sql execute`) then hit `Missing private key parameter in
 * JWK` because `sdk.ts` preferred `session.jwk` over `key.json`.
 *
 * Note: `key` here is the profile's full JWK (loaded from `key.json` above)
 * and is exported with `d`. If the delegation flow ever evolves so OpenKey
 * legitimately returns a session JWK with its own private parameter, this
 * function leaves that JWK untouched.
 */
export function mergePrivateJwkIntoSession(
  session: Record<string, unknown>,
  key: object,
): Record<string, unknown> {
  const sessionJwk = session.jwk;
  if (!sessionJwk || typeof sessionJwk !== "object") {
    return session;
  }
  const sessionJwkRecord = sessionJwk as Record<string, unknown>;
  const sessionD = sessionJwkRecord.d;
  if (typeof sessionD === "string" && sessionD.length > 0) {
    return session;
  }
  const keyD = (key as Record<string, unknown>).d;
  if (typeof keyD !== "string" || keyD.length === 0) {
    return session;
  }
  return {
    ...session,
    jwk: { ...sessionJwkRecord, d: keyD },
  };
}

export async function refreshOpenKeySession(
  profileName: string,
  host: string,
  options: { paste?: boolean; noPopup?: boolean } = {},
): Promise<{ profile: ProfileConfig; delegationData: Record<string, unknown> }> {
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
    paste: options.paste,
    noPopup: options.noPopup,
    jwk: key,
    host,
    openkeyHost: resolveOpenKeyHost(profile),
  });

  // Defensive: OpenKey only ever receives the public JWK (see
  // browser-auth.ts `publicJwkForDelegation`), so any JWK it echoes back is
  // public-only. Persisting that verbatim shadows the full keypair in
  // key.json and breaks anything that needs the WASM signer (kv/sql). Merge
  // the private parameter from key.json back in before writing session.json.
  const sanitizedSession = mergePrivateJwkIntoSession(delegationData, key);

  // Store session
  await ProfileManager.setSession(profileName, sanitizedSession);

  // Update profile with owner DID if present
  const updatedProfile = {
    ...profile,
    sessionDid: profile.sessionDid ?? profile.did,
    posture: profile.posture ?? "owner-openkey",
    operatorType: profile.operatorType ?? "human",
    authMethod: "openkey" as const,
  };

  if (sanitizedSession.spaceId) {
    updatedProfile.spaceId = sanitizedSession.spaceId as string;
    updatedProfile.ownerDid = sanitizedSession.ownerDid as string | undefined;
  }

  await ProfileManager.setProfile(profileName, updatedProfile);

  return { profile: updatedProfile, delegationData: sanitizedSession };
}

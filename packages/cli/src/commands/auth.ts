import { Command } from "commander";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { IncomingMessage } from "node:http";
import { grantAuthRequest, principalDidEquals, type PermissionEntry, type PortableDelegation, type RuntimeDelegationActivator, type TinyCloudNode, type TinyCloudSession } from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";
import { ProfileManager } from "../config/profiles.js";
import {
  outputJson,
  outputWarnings,
  operationWarnings,
  shouldOutputJson,
  formatField,
  formatTable,
  isInteractive,
  withSpinner,
} from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode, DEFAULT_CHAIN_ID, DEFAULT_OPENKEY_HOST, DEFAULT_SHARE_ORIGIN } from "../config/constants.js";
import {
  resolveProfileOperatorType,
  resolveProfilePosture,
  type AuthMethod,
  type CLIContext,
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
  acquireDeviceDelegation,
  loginWithDeviceAuthorization,
  mergePrivateJwkIntoSession,
  resolveDeviceApiHost,
} from "../auth/device-auth.js";
import {
  expectedOwnerFor,
  declinedPermissions,
  parseRequestedExpiry,
  pinnedOwner,
  grantRequestPermissions,
  scopedLoginPermissions,
  validateLoginPermissions,
  verifyScopedLogin,
  verifySignedSession,
  type RequestedExpiry,
  openKeyExpiryParam,
  withoutTrustFields,
  withVerifiedAuthority,
} from "../auth/scoped-login.js";
import { isRawEncryptionPermission, isVerifiedRawEncryptionPermission } from "../lib/raw-encryption.js";
import { canonicalOwnerDid } from "../lib/owner-did.js";
import { assertNotLocalOwner, assertSessionReplaceable, commitLogin, readProfileSnapshot } from "../auth/login-commit.js";
import { openKeyPrimaryFlag, ownerLoginPermissions, warnIfNotPrimaryKey, withOwnerKeyPrimary } from "../auth/owner-key.js";
import { SHARE_PUBLISHING_MANIFEST_REF } from "../share/publishing-manifest.js";
export { mergePrivateJwkIntoSession } from "../auth/device-auth.js";
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
import { withSignInHint } from "../auth/session-expired.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import {
  appendAdditionalDelegation,
  appendAdditionalDelegations,
  appendPermissionRequestArtifact,
  createPermissionRequestArtifact,
  getLastPermissionRequestArtifact,
  getPermissionRequestArtifact,
  isCompatiblePermissionRequestArtifact,
  isPermissionRequestArtifact,
  appendGrantHistory,
  cliGrantRecord,
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
    return "openkey";
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
    .option("--device", "Approve on another device (e.g. a phone) through OpenKey device authorization; requires a KV-scoped --manifest (SQL and secret decrypt need browser or --paste login)")
    .option("--paste", "Use manual paste mode instead of browser callback")
    .option("--no-popup", "Print the OpenKey URL without opening a browser")
    .option("--method <method>", "Authentication method: local or openkey")
    .option("--manifest <fileOrBase64>", `Request only this manifest's permissions (one space, plus raw encryption network entries such as a secrets decrypt grant); ${SHARE_PUBLISHING_MANIFEST_REF} covers \`tc share publish\``)
    .option("--expiry <duration>", "OpenKey session lifetime, e.g. 1h or 7d (device login: at most 30d, default 30d)")
    .option("--owner <did>", "Sign in as this owner (did:pkh:eip155:CHAIN:ADDRESS): OpenKey preselects that key, e.g. one that is not the account's primary key, and an approval by any other identity is refused. With --manifest, also names the secrets owner for a manifest's `secrets` on a profile with no recorded owner")
    .option("--replace-session", "Scoped or device login: replace this profile's live session even though the new scope would narrow, change or shorten it (prefer a new profile)")
    .action(async (options, cmd) => {
      try {
        if (options.device && options.paste) {
          throw new CLIError("INVALID_ARGUMENT", "--device and --paste are mutually exclusive.", ExitCode.USAGE_ERROR);
        }
        const scoped = options.device || options.manifest || options.expiry || options.owner;
        if (scoped && options.method === "local") {
          throw new CLIError("INVALID_ARGUMENT", "--device, --manifest, --expiry and --owner require OpenKey login.", ExitCode.USAGE_ERROR);
        }
        if (options.device && !options.manifest) {
          throw new CLIError(
            "MANIFEST_REQUIRED",
            `Device login requests an explicit scope. Pass --manifest FILE, or --manifest ${SHARE_PUBLISHING_MANIFEST_REF} for Share publishing.`,
            ExitCode.USAGE_ERROR,
          );
        }
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const owner = options.owner === undefined ? undefined : canonicalOwnerDid(options.owner);
        const permissions = options.manifest
          ? await loadManifestPermissions(options.manifest, ctx.profile, { allowLogicalSpaces: true, ownerDid: owner, device: options.device === true })
          : undefined;

        // Only an explicit --host becomes the profile's host; TC_HOST and a
        // discovered local node stay one-off.
        const persistHost = globalOpts.host !== undefined;

        if (options.device) {
          const { profile, result } = await loginWithDeviceAuthorization({
            profileName: ctx.profile,
            nodeOrigin: ctx.host,
            shareOrigin: DEFAULT_SHARE_ORIGIN,
            permissions: permissions!,
            ...(options.expiry === undefined ? {} : { expiry: parseRequestedExpiry(parseExpiryOption(options.expiry)!) }),
            reason: "Allow this TinyCloud CLI profile to use the permissions in the requested manifest.",
            expectedOwner: owner,
            replaceSession: options.replaceSession === true,
            persistHost,
          });
          reportDeclined(result.declined);
          outputJson({
            authenticated: true,
            profile: ctx.profile,
            did: profile.did,
            ownerDid: result.ownerDid,
            spaceId: result.spaceId,
            host: ctx.host,
            authMethod: "openkey",
            mode: "device",
            scoped: true,
            permissions: result.approved,
            declined: result.declined,
            expiresAt: result.expiresAt,
          });
          return;
        }

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
          method = scoped ? "openkey" : await promptAuthMethod();
        }
        if (method === "openkey" && !options.paste && options.popup !== false &&
          !process.stdin.isTTY && !process.stderr.isTTY) {
          throw new CLIError(
            "INTERACTIVE_LOGIN_REQUIRED",
            "Browser login needs a visible approval URL and would wait silently here. Use `--paste` to print the URL and provide the owner's code on stdin.",
            ExitCode.USAGE_ERROR,
          );
        }

        if (method === "local") {
          await handleLocalAuth(ctx.profile, ctx.host);
        } else {
          await handleOpenKeyAuth(ctx.profile, ctx.host, {
            paste: options.paste,
            noPopup: options.popup === false,
            permissions,
            expiry: parseExpiryOption(options.expiry),
            expectedOwner: owner,
            replaceSession: options.replaceSession === true,
            persistHost,
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
        // Refuse a profile that does not exist rather than report it logged out.
        await ProfileManager.getProfile(ctx.profile);
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
            ownerKeyPrimary: profile?.ownerKeyPrimary ?? null,
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
          process.stdout.write(formatField("Primary Key", profile?.ownerKeyPrimary ?? "unknown") + "\n");
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
    .option("--device", "With --grant: approve on another device (e.g. a phone) through OpenKey device authorization (KV-scoped; SQL needs browser login)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const profile = await ProfileManager.getProfile(ctx.profile);
        if (options.device && (!options.grant || resolveProfilePosture(profile) !== "owner-openkey")) {
          throw new CLIError("INVALID_ARGUMENT", "--device requires --grant on an OpenKey owner profile.", ExitCode.USAGE_ERROR);
        }
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

        if (profile.authMethod === "openkey" || options.device) {
          const key = await ProfileManager.getKey(ctx.profile);
          if (!key) {
            throw new CLIError("NO_KEY", `No key found for profile "${ctx.profile}". Run \`tc --profile ${ctx.profile} auth rotate\` to create a new key and sign in.`, ExitCode.AUTH_REQUIRED);
          }
          const openkeyHost = resolveOpenKeyHost(profile);
          const grants: StagedOpenKeyGrant[] = [];
          const expiryCap = expiryOption === undefined ? undefined : parseRequestedExpiry(expiryOption);
          const proof: PortableGrantProof = {
            key,
            sessionDid: profile.sessionDid ?? profile.did,
            expectedOwner: pinnedOwner(profile),
            expiry: expiryCap,
          };
          const declined: PermissionEntry[] = [];
          for (const group of groupPermissionsBySpace(requested)) {
            const reason = permissionGrantReason(
              "Grant requested TinyCloud permissions from `tc auth request --grant`.",
              group,
            );
            const request = grantRequestPermissions(group, profile.spaceId ?? profile.spaceName);
            let delegationData: Record<string, unknown>;
            if (options.device) {
              const approval = await acquireDeviceDelegation({
                sessionDid: keyToDID(key),
                jwk: key,
                nodeOrigin: ctx.host,
                shareOrigin: DEFAULT_SHARE_ORIGIN,
                permissions: request,
                expiry: parseRequestedExpiry(expiryOption ?? "7d"),
                reason,
                expectedOwner: pinnedOwner(profile),
                openkeyHost: resolveDeviceApiHost(profile),
              });
              declined.push(...approval.declined);
              delegationData = approval.session;
            } else {
              delegationData = await startAuthFlow(profile.did, {
                jwk: key,
                host: ctx.host,
                permissions: request,
                reason,
                openkeyHost,
                expiry: expiryCap === undefined ? undefined : openKeyExpiryParam(expiryCap),
                noPopup: options.popup === false,
              });
            }
            const delegation = portableFromOpenKeyDelegation(delegationData, request, ctx.host, proof);
            grants.push({ delegation, effective: permissionsFromDelegation(delegation) });
          }
          await activateAndStoreOpenKeyGrants(ctx.profile, ctx.host, node, grants, options.manifest ? "manifest" : "cli");
          const delegationCids = grants.map(({ delegation }) => delegation.cid);
          const expiry = grants.at(-1)?.delegation.expiry.toISOString();
          reportDeclined(declined);
          outputJson({
            changed: delegationCids.length > 0,
            added: grants.flatMap(({ effective }) => effective),
            delegationCid: delegationCids[0],
            delegationCids,
            expiry,
            ...(options.device ? { declined } : {}),
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
        // Sol MAJOR-9: accumulate EFFECTIVE grants across every signed
        // local delegation so the CLI's `added` output matches what was
        // actually granted, never the originally-requested set.
        const localEffective: typeof requested = [];
        for (const delegation of delegations) {
          const covering = permissionsFromDelegation(delegation);
          localEffective.push(...covering);
          await appendAdditionalDelegation(ctx.profile, await cliGrantRecord(node, delegation, covering, ctx.host));
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
          added: localEffective,
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

        if (isCompatiblePermissionRequestArtifact(parsed)) {
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

        if (isRequestBoundDelegationEnvelope(parsed)) {
          await importRequestBoundDelegationWithBootstrap(ctx, parsed);
          return;
        }

        const imported = normalizeDelegationImport(parsed);
        // Loaded on use: a static import would evaluate the operations
        // delegation-binding bundle in every command that registers `auth`.
        const { activateUnboundCompactImport, storedDelegationKind } = await import(
          "@tinycloud/operations/delegation-binding"
        );
        const kind = storedDelegationKind({ delegation: imported.delegation });
        if (kind === "refused") {
          throw new CLIError(
            "INVALID_AUTH_IMPORT",
            "Imported delegation must carry exactly one string Authorization header.",
            ExitCode.USAGE_ERROR,
          );
        }
        let node;
        try {
          node = await ensureAuthenticated(ctx);
        } catch (error) {
          const profile = await ProfileManager.getProfile(ctx.profile);
          const session = await ProfileManager.getSession(ctx.profile);
          if (session || resolveProfilePosture(profile) !== "delegate-session") throw error;
          node = (await bootstrapDelegatedSession(ctx, imported.delegation)).node;
        }
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
        let permissions = imported.permissions;
        if (targetsSessionKey && kind === "compact") {
          // No stored request contains this compact UCAN, so it is validated as
          // replay validates it and bound to exactly the capabilities it signs.
          // Replay then holds the stored record to that binding.
          const record = await activateUnboundCompactImport(
            node as unknown as RuntimeDelegationActivator,
            imported.delegation,
            ctx.host,
          );
          await appendAdditionalDelegation(ctx.profile, record);
          permissions = record.permissions;
          activated = true;
        } else {
          await appendAdditionalDelegation(ctx.profile, storedAdditionalDelegation(
            imported.delegation,
            imported.permissions,
          ));
          if (targetsSessionKey) {
            await node.useRuntimeDelegation({
              ...imported.delegation,
              delegationHeader: { Authorization: imported.delegation.delegationHeader.Authorization },
            });
            activated = true;
          }
        }
        await appendGrantHistory(ctx.profile, {
          addedCaps: permissions,
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
          permissions,
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

        if (!isCompatiblePermissionRequestArtifact(parsed)) {
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
          const command = isPermissionRequestArtifact(artifact) ? artifact.command : undefined;
          if (!command?.argv?.length) {
            throw new CLIError(
              "COMMAND_NOT_CAPTURED",
              `Request ${artifact.requestId} does not include a captured command.`,
              ExitCode.USAGE_ERROR,
            );
          }
          await execCapturedCommand(command);
          return;
        }

        outputJson({
          requestId: artifact.requestId,
          covered,
          missing: covered ? [] : artifact.requested,
          command: isPermissionRequestArtifact(artifact) ? artifact.command ?? null : null,
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

export async function readAuthArtifactSource(
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
  if (isLegacyDelegationImportArtifact(value)) {
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

function isLegacyDelegationImportArtifact(value: unknown): value is {
  requestId?: string;
  delegation: PortableDelegation;
  permissions?: PermissionEntry[];
} {
  // A legacy envelope is genuinely unbound only when it has no requestId
  // member. Request-bound v1 shape always belongs to the canonical route,
  // even when its request is stale or unknown locally.
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; version?: unknown; requestId?: unknown; delegation?: unknown };
  return candidate.kind === "tinycloud.auth.delegation" &&
    candidate.version === 1 &&
    !Object.hasOwn(candidate, "requestId") &&
    candidate.delegation !== null &&
    typeof candidate.delegation === "object";
}

function isRequestBoundDelegationEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; version?: unknown; requestId?: unknown; delegation?: unknown };
  return candidate.kind === "tinycloud.auth.delegation" &&
    candidate.version === 1 &&
    Object.hasOwn(candidate, "requestId");
}

type AuthImportOutput = {
  cid: string;
  effectivePermissions: PermissionEntry[];
  expiry: string;
  activated: true;
};

async function importRequestBoundDelegationWithBootstrap(
  ctx: { profile: string; host: string },
  artifact: unknown,
): Promise<void> {
  const session = await ProfileManager.getSession(ctx.profile);
  if (session !== null) {
    await importRequestBoundDelegation(ctx, artifact);
    return;
  }

  const profile = await ProfileManager.getProfile(ctx.profile);
  if (resolveProfilePosture(profile) !== "delegate-session") {
    await importRequestBoundDelegation(ctx, artifact);
    return;
  }

  const candidate = artifact as { delegation: PortableDelegation };
  const delegation = normalizePortableDelegation(candidate.delegation);
  const bootstrap = await bootstrapDelegatedSession(ctx, delegation);
  try {
    await importRequestBoundDelegation(ctx, artifact);
  } catch (error) {
    await bootstrap.abandon(error);
  }
}

async function importRequestBoundDelegation(
  ctx: { profile: string; host: string },
  artifact: unknown,
): Promise<void> {
  const result = await invokeOperation(
    "tinycloud.auth.import",
    1,
    // `tc auth import` is a direct human CLI invocation. This explicit opt-in
    // preserves owner-profile imports under the operations owner posture gate;
    // it has no effect on delegate-session execution.
    { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true },
    artifact,
  );

  const warnings = operationWarnings(result.warnings);
  const metadata = warnings.length === 0 ? undefined : { warnings };
  switch (result.status) {
    case "ok": {
      const output = result.output as AuthImportOutput;
      // Diagnostics follow the command's output, never precede a failure of it.
      outputJson({
        imported: true,
        activated: output.activated,
        kind: "tinycloud.auth.delegation",
        requestId: typeof artifact === "object" && artifact !== null &&
          typeof (artifact as { requestId?: unknown }).requestId === "string"
          ? (artifact as { requestId: string }).requestId
          : null,
        delegationCid: output.cid,
        permissions: output.effectivePermissions,
        expiry: output.expiry,
      });
      outputWarnings(warnings);
      return;
    }
    case "authority_required":
      throw new CLIError(
        "AUTHORITY_REQUIRED",
        "The active session requires additional authority before importing this delegation.",
        ExitCode.PERMISSION_DENIED,
        metadata,
      );
    case "setup_required":
      throw new CLIError(
        "SETUP_REQUIRED",
        "The active profile requires setup before importing this delegation.",
        ExitCode.ERROR,
        metadata,
      );
    case "error":
      throw withSignInHint(cliErrorFromService({ ...result.error, meta: metadata }), ctx.profile, result.context.posture);
  }
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

interface StagedOpenKeyGrant {
  delegation: PortableDelegation;
  effective: PermissionEntry[];
}

/** Validate and activate the complete batch before committing any stored authority. */
async function activateAndStoreOpenKeyGrants(
  profileName: string,
  host: string,
  node: TinyCloudNode,
  grants: StagedOpenKeyGrant[],
  source: "cli" | "manifest",
): Promise<void> {
  if (grants.length === 0) return;
  // Bound before anything is activated: a grant whose signed authority the
  // replay rule cannot read fails the batch rather than be stored unusable.
  const records = await Promise.all(grants.map(({ delegation, effective }) =>
    cliGrantRecord(node, delegation, effective, host)));
  for (const { delegation } of grants) await node.useRuntimeDelegation(delegation);
  await ProfileManager.withLock(profileName, async () => {
    for (const { delegation, effective } of grants) {
      await appendGrantHistory(profileName, {
        addedCaps: effective,
        source,
        delegationCid: delegation.cid,
        expiry: delegation.expiry.toISOString(),
      });
    }
    // A stored record for the same CID that carries a request binding is kept.
    await appendAdditionalDelegations(profileName, records);
  });
}

export async function ensureDelegationAuthority(params: {
  ctx: { profile: string; host: string };
  profile: ProfileConfig;
  node: TinyCloudNode;
  requested: PermissionEntry[];
  expiryOption: string | number | undefined;
  reason: string;
  yes: boolean;
  force?: boolean;
  /**
   * Space a decrypt-only grant is requested in. OpenKey signs only a request
   * with one space; defaults to the profile's primary space.
   */
  anchorSpace?: string;
  /** Test seam for the browser acquisition boundary; production uses startAuthFlow. */
  openKeyAcquisition?: OpenKeyAcquisition;
}): Promise<void> {
  if (!params.force && params.node.hasRuntimePermissions(params.requested)) return;

  if (params.profile.authMethod === "openkey") {
    const key = await ProfileManager.getKey(params.ctx.profile);
    if (!key) {
      throw new CLIError(
        "NO_KEY",
        `No key found for profile "${params.ctx.profile}". Run \`tc --profile ${params.ctx.profile} auth rotate\` to create a new key and sign in.`,
        ExitCode.AUTH_REQUIRED,
      );
    }
    const openkeyHost = resolveOpenKeyHost(params.profile);
    const acquireOpenKey = params.openKeyAcquisition ?? startAuthFlow;
    const expiryCap = params.expiryOption === undefined ? undefined : parseRequestedExpiry(params.expiryOption);
    const proof: PortableGrantProof = {
      key,
      sessionDid: params.profile.sessionDid ?? params.profile.did,
      expectedOwner: pinnedOwner(params.profile),
      expiry: expiryCap,
    };
    const anchorSpace = params.anchorSpace ?? params.profile.spaceId ?? params.profile.spaceName;
    const grants: StagedOpenKeyGrant[] = [];
    for (const group of groupPermissionsBySpace(params.requested)) {
      // capabilities/read is part of the request, so the signed proof may
      // carry it without broadening the grant.
      const request = grantRequestPermissions(group, anchorSpace);
      const delegationData = await acquireOpenKey(params.profile.did, {
        jwk: key,
        host: params.ctx.host,
        permissions: request,
        reason: permissionGrantReason(params.reason, group),
        openkeyHost,
        expiry: expiryCap === undefined ? undefined : openKeyExpiryParam(expiryCap),
      });
      const delegation = portableFromOpenKeyDelegation(delegationData, request, params.ctx.host, proof);
      grants.push({ delegation, effective: permissionsFromDelegation(delegation) });
    }
    await activateAndStoreOpenKeyGrants(params.ctx.profile, params.ctx.host, params.node, grants, "cli");
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
      await cliGrantRecord(params.node, delegation, covering, params.ctx.host),
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
    device?: boolean;
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
    permissions.push(...await loadManifestPermissions(options.manifest, profile, { device: options.device === true }));
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
    if (isRawEncryptionPermission(permission)) {
      rawEntries.push(permission);
      continue;
    }
    // Key by address-normalized space so multiple caps on the same space batch
    // into one OpenKey round-trip even when one cap's address is checksummed and
    // another is lowercase. The space NAME stays case-sensitive, so genuinely
    // different names are NOT merged. Entries keep their original space string.
    const key = normalizePkhIdentifier(permission.space ?? "");
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

export interface PortableGrantProof {
  key: object;
  sessionDid: string;
  expectedOwner?: string;
  expiry?: RequestedExpiry;
}

/** A portable grant contains only authority from the owner-signed ReCap. */
export function portableFromOpenKeyDelegation(
  data: Record<string, unknown>,
  requested: PermissionEntry[],
  host: string,
  proof: PortableGrantProof,
): PortableDelegation {
  const { session, legacyNested } = verifyScopedLogin(data, proof.key, proof.sessionDid, requested, {
    expectedOwner: proof.expectedOwner,
    expiry: proof.expiry,
    purpose: "grant",
  });
  if (legacyNested.length > 0) {
    throw new CLIError(
      "OPENKEY_GRANT_BROADENED",
      "OpenKey signed decrypt inside the space instead of on the raw network. The OpenKey deployment is too old for agent secret reads.",
      ExitCode.PERMISSION_DENIED,
    );
  }
  const returnedSpace = data.spaceId as string; // Bound to the signed proof by verifyScopedLogin.
  const effective = session.permissions;
  // The headline resource is a requested data entry, not the
  // capabilities/read every OpenKey grant carries or a raw network.
  const spaced = effective.filter((permission) => !isRawEncryptionPermission(permission));
  const primary = spaced.find((permission) => permission.service !== "tinycloud.capabilities") ?? spaced[0] ?? effective[0]!;
  const resources = effective.map((permission) => ({
    service: permission.service.slice("tinycloud.".length),
    space: isVerifiedRawEncryptionPermission(permission) ? "encryption" : returnedSpace,
    path: permission.path,
    actions: [...permission.actions],
    ...(permission.caveats === undefined ? {} : { caveats: structuredClone(permission.caveats) }),
  }));
  const ownerParts = session.ownerDid.split(":");
  return {
    cid: data.delegationCid as string,
    delegationHeader: data.delegationHeader as { Authorization: string },
    spaceId: returnedSpace,
    path: primary.path,
    actions: [...primary.actions],
    resources,
    expiry: new Date(session.expiresAt),
    delegateDID: data.verificationMethod as string,
    ownerAddress: ownerParts[4]!,
    chainId: Number(ownerParts[3]),
    host,
    // Verified above; replay rebuilds the CACAO from it before trusting the grant.
    siweProof: { siwe: data.siwe as string, signature: data.signature as string },
  };
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

    // The new session replaces the old one in local login's compare-and-commit;
    // if the profile changed meanwhile, the commit refuses and keeps it.
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

  // One transaction: a concurrent login commit either lands before (and this
  // rotation then discards its session) or sees the new key and refuses.
  await ProfileManager.withLock(profileName, async () => {
    const current = await ProfileManager.getProfile(profileName);
    await ProfileManager.setKey(profileName, jwk);
    await ProfileManager.clearSession(profileName);
    await ProfileManager.setProfile(profileName, {
      ...current,
      host,
      did,
      sessionDid: did,
      posture: current.posture ?? "owner-openkey",
      operatorType: current.operatorType ?? "human",
      authMethod: "openkey",
    });
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

  await ProfileManager.withLock(profileName, async () => {
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
      await ProfileManager.updateProfile(profileName, (current) => ({
        ...current,
        sessionDid: session.verificationMethod,
        spaceId: session.spaceId,
      }));
    }
  });
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
  const snapshot = await readProfileSnapshot(profileName);
  const profile = snapshot.profile;
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
  const hasKey = snapshot.key;
  let key: object;
  if (options.forceSessionKey || !hasKey) {
    const { jwk, did: generatedSessionDid } = await withSpinner("Generating session key...", async () => {
      return generateKey();
    });
    key = jwk;
    sessionDid = generatedSessionDid;
  } else {
    key = hasKey;
    sessionDid ??= keyToDID(hasKey);
  }

  // Sign in using the private key
  const sessionResult = await withSpinner("Signing in...", async () => {
    return localKeySignIn({ privateKey, host });
  });

  const session = {
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
  };
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

  await commitLogin(profileName, snapshot, { key, session, profile: updatedProfile });

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
 * Handle OpenKey (browser-based) authentication. With `permissions`, only the
 * manifest's scope is requested and the signed proof is verified first.
 */
async function handleOpenKeyAuth(
  profileName: string,
  host: string,
  options: OpenKeyLoginOptions = {},
): Promise<void> {
  const { profile, delegationData, declined, legacyNested } = await refreshOpenKeySession(profileName, host, options);

  reportDeclined(declined, legacyNested);
  outputJson({
    authenticated: true,
    profile: profileName,
    did: profile.did,
    spaceId: delegationData.spaceId,
    authMethod: "openkey",
    ...(options.permissions
      ? {
          scoped: true,
          ownerDid: profile.ownerDid,
          host,
          permissions: delegationData.permissions,
          declined,
          expiresAt: delegationData.expiresAt,
          activation: delegationData.hostActivated === true ? "confirmed-by-openkey" : "unverified",
        }
      : {}),
  });
}

/** Tell the operator which requested capabilities the owner unchecked or OpenKey signed incorrectly. */
function reportDeclined(declined: PermissionEntry[], signed?: PermissionEntry[]): void {
  if (declined.length === 0) return;
  process.stderr.write(
    `${theme.warn("Not granted in this session:")}\n${declined.map((permission) => `  ${compactPermission(permission)}`).join("\n")}\n`,
  );
  if (declined.some((permission) => isRawEncryptionPermission(permission) &&
    signed?.some((entry) => isRawEncryptionPermission(entry) &&
      !isVerifiedRawEncryptionPermission(entry) &&
      normalizePkhIdentifier(entry.path) === normalizePkhIdentifier(permission.path)))) {
    process.stderr.write(`${theme.warn("OpenKey signed decrypt inside the space; the TinyCloud node refuses that. The OpenKey deployment is too old for agent secret reads.")}\n`);
  }
}

interface OpenKeyLoginOptions {
  paste?: boolean;
  noPopup?: boolean;
  /** Manifest scope for first login: one space, verified before persistence. */
  permissions?: PermissionEntry[];
  expiry?: string | number;
  expectedOwner?: string;
  /** Scoped login: replace a live session the approved scope would narrow. */
  replaceSession?: boolean;
  /** Record `host` as the profile host (an explicit `--host`). */
  persistHost?: boolean;
  openKeyAcquisition?: OpenKeyAcquisition;
}

export async function refreshOpenKeySession(
  profileName: string,
  host: string,
  options: OpenKeyLoginOptions = {},
): Promise<{ profile: ProfileConfig; delegationData: Record<string, unknown>; declined: PermissionEntry[]; legacyNested: PermissionEntry[] }> {
  const snapshot = await readProfileSnapshot(profileName);
  // A missing profile is PROFILE_NOT_FOUND, not a missing key: `tc init` alone
  // would create the default profile instead of this one.
  const profile = snapshot.profile ?? await ProfileManager.getProfile(profileName);
  const key = snapshot.key;
  if (!key) {
    throw new CLIError(
      "NO_KEY",
      `No key found for profile "${profileName}". Run \`tc --profile ${profileName} auth rotate\` to create a new key and sign in.`,
      ExitCode.AUTH_REQUIRED,
    );
  }
  // The requested scope: the manifest plus the capability read OpenKey needs to sign it.
  if (options.permissions !== undefined) validateLoginPermissions(options.permissions);
  const permissions = options.permissions === undefined ? undefined : scopedLoginPermissions(options.permissions);
  if (permissions !== undefined) {
    assertNotLocalOwner(profileName, profile, "Scoped browser login");
  }
  // Resolve before consent so an invalid --expiry, owner conflict or live
  // session in use never opens OpenKey.
  const expiry = options.expiry === undefined ? undefined : parseRequestedExpiry(options.expiry);
  const openKeyExpiry = expiry === undefined ? undefined : openKeyExpiryParam(expiry);
  const expectedOwner = expectedOwnerFor(profileName, profile, options.expectedOwner);
  if (permissions !== undefined && options.replaceSession !== true) {
    const estimatedExpiry = expiry === undefined ? undefined : new Date(Date.now() + expiry.durationMs).toISOString();
    assertSessionReplaceable(profileName, snapshot, expectedOwner, permissions, estimatedExpiry);
  }

  // Start browser auth flow
  const acquireOpenKey = options.openKeyAcquisition ?? startAuthFlow;
  const delegationData = await acquireOpenKey(profile.did, {
    paste: options.paste,
    noPopup: options.noPopup,
    jwk: key,
    host,
    openkeyHost: resolveOpenKeyHost(profile),
    // A plain login with --owner names that owner's space, so OpenKey
    // preselects its key; the signed owner is verified below.
    permissions: permissions ?? (options.expectedOwner === undefined ? undefined : ownerLoginPermissions(expectedOwner!)),
    expiry: openKeyExpiry,
    ...(permissions ? { reason: "Allow this TinyCloud CLI profile to use the permissions in the requested manifest." } : {}),
  });

  // Scoped login persists only signed, verified authority. Every path checks
  // the signed proof whenever it carries one, the profile records an owner
  // (which it must keep) or --expiry was requested; the owner recorded on the
  // profile only ever comes from a verified proof.
  // OpenKey only ever receives the public JWK (browser-auth.ts
  // `publicJwkForDelegation`), so any JWK it echoes back is public-only;
  // persisting it verbatim would shadow key.json and break the WASM signer
  // (kv/sql). Merge the private parameter back in before writing session.json.
  const sessionDid = profile.sessionDid ?? profile.did;
  let sanitizedSession: Record<string, unknown>;
  let verifiedOwner: string | undefined;
  let declined: PermissionEntry[] = [];
  let legacyNested: PermissionEntry[] = [];
  if (permissions) {
    const verified = verifyScopedLogin(delegationData, key, sessionDid, permissions, { expectedOwner, expiry });
    sanitizedSession = verified.session;
    legacyNested = verified.legacyNested;
    verifiedOwner = sanitizedSession.ownerDid as string;
    declined = declinedPermissions(permissions, sanitizedSession.permissions as PermissionEntry[], verifiedOwner);
  } else {
    // Authority fields (owner, permissions, expiry, trust marker) come only
    // from a verified proof; an unverified callback contributes none of them.
    const carriesProof = typeof delegationData.siwe === "string" && typeof delegationData.signature === "string";
    const merged = mergePrivateJwkIntoSession(delegationData, key);
    if (carriesProof || expiry !== undefined || expectedOwner !== undefined) {
      const signed = verifySignedSession(delegationData, key, sessionDid, { expectedOwner, expiry });
      verifiedOwner = signed.ownerDid;
      sanitizedSession = withVerifiedAuthority(merged, signed);
    } else {
      // Not a proof: also drop a lone SIWE or signature, so an unsigned
      // `Expiration Time` is never read as this session's expiry.
      sanitizedSession = Object.fromEntries(Object.entries(withoutTrustFields(merged)).filter(([name]) => name !== "siwe" && name !== "signature"));
    }
  }

  // OpenKey's unsigned `primary` flag describes the key that signed, so it is
  // recorded only beside a verified owner.
  const ownerKeyPrimary = verifiedOwner === undefined ? undefined : openKeyPrimaryFlag(delegationData);
  const updatedProfile: ProfileConfig = withOwnerKeyPrimary({
    ...profile,
    host: options.persistHost === true || !profile.host ? host : profile.host,
    sessionDid: profile.sessionDid ?? profile.did,
    posture: profile.posture ?? "owner-openkey",
    operatorType: profile.operatorType ?? "human",
    authMethod: "openkey" as const,
    ...(typeof sanitizedSession.spaceId === "string" ? { spaceId: sanitizedSession.spaceId } : {}),
    ...(verifiedOwner === undefined ? {} : { ownerDid: verifiedOwner }),
  }, ownerKeyPrimary);

  await commitLogin(profileName, snapshot, {
    key,
    session: sanitizedSession,
    profile: updatedProfile,
    ...(permissions && verifiedOwner
      ? { approved: { scope: sanitizedSession.permissions as PermissionEntry[], ownerDid: verifiedOwner, replaceSession: options.replaceSession === true } }
      : {}),
  });
  warnIfNotPrimaryKey(verifiedOwner, ownerKeyPrimary);

  return { profile: updatedProfile, delegationData: sanitizedSession, declined, legacyNested };
}

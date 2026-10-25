import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ACCOUNT_REGISTRY_SPACE } from "@tinycloud/node-sdk";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture } from "../config/types.js";
import { outputJson, shouldOutputJson, formatTable } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { isRootAuthority, ownerDidFromSpaceUri, resolveHostSpace, spaceNameFromUri, type HostRequestArtifact } from "../lib/host.js";
import { theme } from "../output/theme.js";

function didWithoutFragment(did: string): string {
  const fragment = did.indexOf("#");
  return fragment === -1 ? did : did.slice(0, fragment);
}

export function registerSpaceCommand(program: Command): void {
  const space = program.command("space").description("Space management");

  space
    .command("list")
    .description("List spaces")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        // The account registry (`account/spaces/{space_id}`) lists the owner's
        // spaces without `tinycloud.space/list`, which no wallet SIWE session
        // (OpenKey or local key) carries (TC-1083).
        const accountSpaceId = node.accountSpaceId;
        // `tinycloud.space/list` is invoked with the base session only, on its own space root.
        // A walletless restored session (OpenKey owner or delegate) has `node.spaceId`, its primary space;
        // the session space below is read from `restorableSession.spaceId`.
        const sessionCapabilities = node.getVerifiedSessionCapabilities();
        const sessionSpaceId = node.restorableSession?.spaceId;
        const sessionSpace = sessionSpaceId?.slice(sessionSpaceId.lastIndexOf(":") + 1);
        let spaces: Array<{ id: string; name?: string; owner: string }>;
        if (accountSpaceId !== undefined && node.hasRuntimePermissions([{
          service: "tinycloud.kv",
          space: accountSpaceId,
          path: "spaces/",
          actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
        }])) {
          const result = await node.account.spaces.list();
          if (!result.ok) throw cliErrorFromService(result.error);
          spaces = result.data.map((s) => ({
            id: s.spaceId,
            name: s.name,
            owner: s.ownerDid,
            type: s.type,
            permissions: s.permissions,
            status: s.status,
            registeredAt: s.registeredAt,
            updatedAt: s.updatedAt,
            expiresAt: s.expiresAt,
          }));
        } else if (sessionCapabilities.length === 0 || sessionCapabilities.some((capability) =>
          capability.service === "tinycloud.space" && capability.space === sessionSpace &&
          capability.path === "" && capability.actions.includes("tinycloud.space/list"))) {
          // A session without a signed recap cannot be checked up front; the node decides.
          const result = await node.spaces.list();
          if (!result.ok) throw cliErrorFromService(result.error);
          spaces = result.data;
        } else {
          const profile = await ProfileManager.getProfile(ctx.profile);
          const cap = "tinycloud.kv:account:spaces/:get,list";
          const hint = resolveProfilePosture(profile) === "delegate-session"
            ? `Ask the space owner to grant it. Create the request with: ${CLI_NAME} --profile ${ctx.profile} auth request --cap ${cap} --emit`
            : `Grant it to this session with: ${CLI_NAME} --profile ${ctx.profile} auth request --grant --cap ${cap}. ` +
              "The default OpenKey owner sign-in covers only the default space, so it includes neither.";
          throw new CLIError(
            "PERMISSION_DENIED",
            "Listing spaces needs tinycloud.kv/get and tinycloud.kv/list on the account space's spaces/ registry " +
              `(${accountSpaceId ?? ACCOUNT_REGISTRY_SPACE}), or tinycloud.space/list. This session holds neither.`,
            ExitCode.PERMISSION_DENIED,
            { hint },
          );
        }

        if (shouldOutputJson()) {
          outputJson({ spaces, count: spaces.length });
        } else {
          if (spaces.length === 0) {
            process.stdout.write(theme.muted("No spaces found.") + "\n");
          } else {
            const rows = spaces.map((s) => [s.id, s.name || "—", s.owner || "—"]);
            process.stdout.write(formatTable(["Space ID", "Name", "Owner"], rows) + "\n");
          }
        }
      } catch (error) {
        return handleError(error);
      }
    });

  space
    .command("create <name>")
    .alias("host")
    .description("Create (host) one of your owned spaces by name")
    .action(async (name: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const spaceId = await node.hostOwnedSpace(name);
        outputJson({ spaceId, name, hosted: true });
      } catch (error) {
        return handleError(error);
      }
    });

  space
    .command("host-request <name>")
    .description("Emit a request asking the space owner to host it (delegate-only)")
    .option("--emit [file]", "Write the request artifact to file (or stdout when no path)")
    .addHelpText("after", `

A delegate cannot host a space — only its owner (root authority) can. This
emits a tinycloud.host.request artifact naming the space and its owner so you
can hand it to the owner; they run \`${CLI_NAME} space host <name>\` and confirm.

If you ARE the owner of the resolved space, this refuses and tells you to host
it directly with \`${CLI_NAME} space host <name>\` (no request needed).
`)
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });
        const profile = await ProfileManager.getProfile(ctx.profile);

        // Pure local emit — no node contact, mirroring `tc auth request --emit`.
        const spaceId = await resolveHostSpace(name, ctx.profile);
        const spaceName = spaceNameFromUri(spaceId);

        if (await isRootAuthority(spaceId, ctx.profile)) {
          throw new CLIError(
            "ALREADY_ROOT_AUTHORITY",
            `You are the owner of ${spaceId}. Host it directly: ${CLI_NAME} space host ${spaceName}`,
            ExitCode.USAGE_ERROR,
          );
        }

        const requesterDid = didWithoutFragment(profile.sessionDid ?? profile.did);
        const ownerDid = ownerDidFromSpaceUri(spaceId);
        if (!ownerDid) {
          throw new CLIError(
            "UNRESOLVABLE_OWNER",
            `Cannot determine the owner of ${spaceId}; host-request needs a pkh space URI.`,
            ExitCode.USAGE_ERROR,
          );
        }

        const artifact: HostRequestArtifact = {
          kind: "tinycloud.host.request",
          version: 1,
          requestId: `hostreq_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
          createdAt: new Date().toISOString(),
          spaceName,
          spaceId,
          ownerDid,
          requesterDid,
          host: ctx.host,
        };

        await emitHostRequestArtifact(artifact, options.emit);
      } catch (error) {
        return handleError(error);
      }
    });

  space
    .command("info [space-id]")
    .description("Get space info")
    .action(async (spaceId: string | undefined, _options, cmd) => {
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
          host: ctx.host,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  space
    .command("switch <name>")
    .description("Switch active space")
    .action(async (name: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });

        await ProfileManager.updateProfile(ctx.profile, (profile) => ({ ...profile, spaceName: name }));

        outputJson({ profile: ctx.profile, spaceName: name, switched: true });
      } catch (error) {
        return handleError(error);
      }
    });
}

async function emitHostRequestArtifact(
  artifact: HostRequestArtifact,
  emitOption: unknown,
): Promise<void> {
  if (typeof emitOption === "string" && emitOption.length > 0) {
    await mkdir(dirname(emitOption), { recursive: true });
    await writeFile(emitOption, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    outputJson({
      emitted: true,
      path: emitOption,
      requestId: artifact.requestId,
      spaceName: artifact.spaceName,
      spaceId: artifact.spaceId,
      ownerDid: artifact.ownerDid,
    });
    return;
  }
  outputJson(artifact);
}

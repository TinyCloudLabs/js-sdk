import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProfileManager } from "../config/profiles.js";
import { outputJson, shouldOutputJson, formatTable } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
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
            const rows = result.data.map((s: any) => [
              s.id || s.spaceId || "—",
              s.name || "—",
              s.owner || "—",
            ]);
            process.stdout.write(formatTable(["Space ID", "Name", "Owner"], rows) + "\n");
          }
        }
      } catch (error) {
        handleError(error);
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
        handleError(error);
      }
    });

  space
    .command("host-request <name>")
    .description("Emit a request asking the space owner to host it (delegate-only)")
    .option("--emit [file]", "Write the request artifact to file (or stdout when no path)")
    .addHelpText("after", `

A delegate cannot host a space — only its owner (root authority) can. This
emits a tinycloud.host.request artifact naming the space and its owner so you
can hand it to the owner; they run \`tc space host <name>\` and confirm.

If you ARE the owner of the resolved space, this refuses and tells you to host
it directly with \`tc space host <name>\` (no request needed).
`)
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const profile = await ProfileManager.getProfile(ctx.profile);

        // Pure local emit — no node contact, mirroring `tc auth request --emit`.
        const spaceId = await resolveHostSpace(name, ctx.profile);
        const spaceName = spaceNameFromUri(spaceId);

        if (await isRootAuthority(spaceId, ctx.profile)) {
          throw new CLIError(
            "ALREADY_ROOT_AUTHORITY",
            `You are the owner of ${spaceId}. Host it directly: tc space host ${spaceName}`,
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
        handleError(error);
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
        handleError(error);
      }
    });

  space
    .command("switch <name>")
    .description("Switch active space")
    .action(async (name: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        const profile = await ProfileManager.getProfile(ctx.profile);
        await ProfileManager.setProfile(ctx.profile, { ...profile, spaceName: name });

        outputJson({ profile: ctx.profile, spaceName: name, switched: true });
      } catch (error) {
        handleError(error);
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

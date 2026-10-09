import { Command } from "commander";
import { ProfileManager } from "../config/profiles.js";
import { resolveSpaceUri } from "../lib/space.js";
import { outputJson } from "../output/formatter.js";
import { handleError } from "../output/errors.js";
import { sessionExpiresAt } from "../auth/scoped-login.js";

export function registerContextCommand(program: Command): void {
  program.command("context")
    .description("Report selected identity, host, space and local session state as JSON (does not test access)")
    .option("--space <name|uri>", "Resolve this space in the selected profile")
    .action(async (options, cmd: Command) => {
      try {
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const profile = await ProfileManager.getProfile(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
        const spaceId = await resolveSpaceUri(options.space, ctx.profile) ??
          (typeof session?.spaceId === "string" ? session.spaceId : profile.spaceId ?? null);
        const expiresAt = sessionExpiresAt(session);
        let root = cmd;
        while (root.parent) root = root.parent;
        outputJson({
          schemaVersion: 1,
          cliVersion: root.version() ?? null,
          profile: ctx.profile,
          ownerDid: profile.ownerDid ?? null,
          sessionDid: profile.sessionDid ?? profile.did,
          host: ctx.host,
          spaceId,
          session: {
            state: session === null ? "missing" : expiresAt === null ? "unknown-expiry" : Date.parse(expiresAt) <= Date.now() ? "expired" : "present",
            expiresAt,
            evidence: "local-metadata",
          },
          access: "not-tested",
        });
      } catch (error) {
        return handleError(error);
      }
    });
}

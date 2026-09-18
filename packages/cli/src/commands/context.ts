import { Command } from "commander";
import cliPackage from "../../package.json";
import { ProfileManager } from "../config/profiles.js";
import { resolveSpaceUri } from "../lib/space.js";
import { outputJson } from "../output/formatter.js";
import { handleError } from "../output/errors.js";

export function registerContextCommand(program: Command): void {
  program.command("context")
    .description("Report selected identity, host, space and local session state as JSON (does not test access)")
    .option("--space <name|uri>", "Resolve this space in the selected profile")
    .action(async (options, cmd) => {
      try {
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const profile = await ProfileManager.getProfile(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
        const spaceId = await resolveSpaceUri(options.space, ctx.profile) ??
          (typeof session?.spaceId === "string" ? session.spaceId : profile.spaceId ?? null);
        const expiryValues = [session?.expiresAt, session?.expiry, session?.expirationTime,
          typeof session?.siwe === "string" ? session.siwe.match(/^Expiration Time:\s*(.+)$/m)?.[1] : undefined];
        const expiry = expiryValues.find((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
        const expiresAt = typeof expiry === "string" ? new Date(expiry).toISOString() : null;
        outputJson({
          schemaVersion: 1,
          cliVersion: cliPackage.version,
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
        handleError(error);
      }
    });
}

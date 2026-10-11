import { Command } from "commander";
import { ProfileManager } from "../config/profiles.js";
import { DEFAULT_HOST } from "../config/constants.js";
import { outputJson, shouldOutputJson, formatCheck, formatSection } from "../output/formatter.js";
import { theme } from "../output/theme.js";
import { handleError } from "../output/errors.js";

interface DoctorResult {
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  healthy: boolean;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run diagnostic checks")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const checks: DoctorResult["checks"] = [];

        // 1. Node.js version
        const nodeVersion = process.version;
        const nodeOk = parseInt(nodeVersion.slice(1)) >= 18;
        checks.push({ name: "Node.js", ok: nodeOk, detail: nodeVersion });

        // 2. Profile configured
        let profileName = globalOpts.profile;
        let profileOk = false;
        let profileDetail = "";
        try {
          const config = await ProfileManager.getConfig();
          profileName = profileName || config.defaultProfile;
          const profile = await ProfileManager.getProfile(profileName);
          profileOk = true;
          profileDetail = `"${profileName}" at ${profile.host}`;
        } catch {
          profileDetail = profileName ? `"${profileName}" not found` : "no profiles configured";
        }
        checks.push({ name: "Profile", ok: profileOk, detail: profileDetail });

        // 3. Key exists
        let keyOk = false;
        let keyDetail = "";
        if (profileOk && profileName) {
          try {
            const key = await ProfileManager.getKey(profileName);
            keyOk = key !== null;
            if (keyOk) {
              const profile = await ProfileManager.getProfile(profileName);
              keyDetail = profile.did ? `${profile.did.slice(0, 20)}...` : "key found";
            } else {
              keyDetail = "no key — run tc init";
            }
          } catch {
            keyDetail = "error reading key";
          }
        } else {
          keyDetail = "skipped (no profile)";
        }
        checks.push({ name: "Key", ok: keyOk, detail: keyDetail });

        // 4. Session active
        let sessionOk = false;
        let sessionDetail = "";
        if (profileOk && profileName) {
          try {
            const session = await ProfileManager.getSession(profileName);
            sessionOk = session !== null;
            sessionDetail = sessionOk ? "active" : "no session — run tc auth login";
          } catch {
            sessionDetail = "error reading session";
          }
        } else {
          sessionDetail = "skipped (no profile)";
        }
        checks.push({ name: "Session", ok: sessionOk, detail: sessionDetail });

        // 5. Node reachable
        let nodeReachable = false;
        let nodeDetail = "";
        try {
          const host = profileOk && profileName
            ? (await ProfileManager.getProfile(profileName)).host
            : globalOpts.host || DEFAULT_HOST;
          const start = Date.now();
          const response = await fetch(`${host}/health`);
          const latency = Date.now() - start;
          nodeReachable = response.ok;
          nodeDetail = nodeReachable
            ? `${host} (${latency}ms)`
            : `${host} returned ${response.status}`;
        } catch (e) {
          nodeDetail = `unreachable — ${e instanceof Error ? e.message : "connection failed"}`;
        }
        checks.push({ name: "Node", ok: nodeReachable, detail: nodeDetail });

        // 6. Space exists (only if session active)
        let spaceOk = false;
        let spaceDetail = "";
        if (sessionOk && profileName) {
          try {
            const profile = await ProfileManager.getProfile(profileName);
            spaceOk = Boolean(profile.spaceId);
            spaceDetail = spaceOk
              ? `${profile.spaceId!.slice(0, 16)}...`
              : "no space — run tc space create";
          } catch {
            spaceDetail = "error checking space";
          }
        } else {
          spaceDetail = "skipped (no session)";
        }
        checks.push({ name: "Space", ok: spaceOk, detail: spaceDetail });

        const result: DoctorResult = {
          checks,
          healthy: checks.every((c) => c.ok),
        };

        if (shouldOutputJson()) {
          outputJson(result);
        } else {
          process.stderr.write(formatSection("Diagnostics") + "\n");
          for (const check of checks) {
            process.stdout.write(formatCheck(check.ok, check.name, check.detail) + "\n");
          }
          process.stdout.write("\n");
          if (result.healthy) {
            process.stdout.write(theme.success("All checks passed.") + "\n");
          } else {
            const failed = checks.filter((c) => !c.ok).length;
            process.stdout.write(theme.warn(`${failed} check${failed > 1 ? "s" : ""} need attention.`) + "\n");
          }
        }
      } catch (error) {
        return handleError(error);
      }
    });
}

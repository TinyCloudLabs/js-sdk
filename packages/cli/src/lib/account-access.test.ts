import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { parseCapSpec } from "./permissions.js";
import { accountCapSpecs, accountPermissionEntries, assertAccountAccess, capSpecs } from "./account-access.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OWNER = `tinycloud:pkh:eip155:1:${ADDRESS}`;

function profileWithOwner() {
  spyOn(ProfileManager, "getSession").mockResolvedValue(null as never);
  return spyOn(ProfileManager, "getProfile").mockResolvedValue({
    name: "work",
    address: ADDRESS,
    chainId: 1,
    authMethod: "openkey",
  } as never);
}

describe("assertAccountAccess", () => {
  afterEach(() => {
    mock.restore();
  });

  test("asks about the owner's full account space and passes when covered", async () => {
    profileWithOwner();
    let asked: { space?: string }[] = [];
    await assertAccountAccess({ hasRuntimePermissions: (entries: { space?: string }[]) => ((asked = entries), true) } as never, "work");
    expect(asked).toHaveLength(accountPermissionEntries().length);
    expect(asked.every((entry) => entry.space === `${OWNER}:account`)).toBe(true);
  });

  test("throws a typed permission-denied error naming the grant command", async () => {
    profileWithOwner();
    let thrown: unknown;
    try {
      await assertAccountAccess({ hasRuntimePermissions: () => false } as never, "work");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CLIError);
    const error = thrown as CLIError;
    expect(error.code).toBe("ACCOUNT_ACCESS_REQUIRED");
    expect(error.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    expect(String(error.metadata?.hint)).toStartWith("Grant account access, then retry: tc --profile work auth request --grant --cap ");
    // The headless / blocked-loopback fallback is the same command plus --paste.
    expect(String(error.metadata?.hint)).toMatch(/\nIf the browser cannot reach the CLI, re-run with --paste: tc --profile work auth request --grant .* --paste$/);
  });

  test("quotes a profile name that is not a plain word in the printed commands", async () => {
    profileWithOwner();
    const error = await assertAccountAccess({ hasRuntimePermissions: () => false } as never, "my work's", "registry").catch((e: unknown) => e) as CLIError;
    expect(String(error.metadata?.hint)).toContain("tc --profile 'my work'\\''s' auth request --grant");
  });

  test("revoke: a local-key profile passes without asking the session, an OpenKey one names `delegation revoke`", async () => {
    const asked: unknown[] = [];
    const node = { hasRuntimePermissions: (entries: unknown) => (asked.push(entries), false) } as never;
    const getProfile = spyOn(ProfileManager, "getProfile");
    getProfile.mockResolvedValue({ name: "work", authMethod: "local" } as never);
    await assertAccountAccess(node, "work", "revoke", "bafycid");
    expect(asked).toEqual([]);

    getProfile.mockResolvedValue({ name: "work", authMethod: "openkey" } as never);
    const error = await assertAccountAccess(node, "work", "revoke", "bafycid").catch((e: unknown) => e) as CLIError;
    expect(error.code).toBe("ACCOUNT_REVOKE_UNSUPPORTED");
    expect(error.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    expect(String(error.metadata?.hint)).toBe("Revoke it with: tc --profile work delegation revoke bafycid");
    expect(asked).toEqual([]);
  });

  test.each(["registry", "remove", "spaces", "delegations"] as const)("every printed --cap for %s parses back to the permission it stands for", async (need) => {
    profileWithOwner();
    const parsed = await Promise.all(accountCapSpecs(need).map((spec) => parseCapSpec(spec, "work")));
    const wanted = accountPermissionEntries(need);
    expect(parsed).toHaveLength(wanted.length);
    parsed.forEach((entry, index) => {
      expect(entry.service).toBe(wanted[index]!.service);
      expect(entry.path).toBe(wanted[index]!.path);
      expect([...entry.actions].sort()).toEqual([...wanted[index]!.actions].sort());
    });
  });

  test("a full space URI cap parses back too", async () => {
    profileWithOwner();
    const [spec] = capSpecs([{ service: "tinycloud.capabilities", space: `${OWNER}:photos`, path: "", actions: ["tinycloud.capabilities/read"] }]);
    const entry = await parseCapSpec(spec!, "work");
    expect(entry).toMatchObject({ service: "tinycloud.capabilities", space: `${OWNER}:photos`, path: "", actions: ["tinycloud.capabilities/read"] });
  });
});

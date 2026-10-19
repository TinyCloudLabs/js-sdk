import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { parseCapSpec } from "./permissions.js";
import { accountCapSpecs, accountPermissionEntries, assertAccountAccess } from "./account-access.js";

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
    await assertAccountAccess({ hasRuntimePermissions: (entries) => ((asked = entries), true) }, "work");
    expect(asked).toHaveLength(accountPermissionEntries().length);
    expect(asked.every((entry) => entry.space === `${OWNER}:account`)).toBe(true);
  });

  test("throws a typed permission-denied error naming the grant command", async () => {
    profileWithOwner();
    let thrown: unknown;
    try {
      await assertAccountAccess({ hasRuntimePermissions: () => false }, "work");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CLIError);
    const error = thrown as CLIError;
    expect(error.code).toBe("ACCOUNT_ACCESS_REQUIRED");
    expect(error.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    expect(String(error.metadata?.hint)).toStartWith("Grant account access, then retry: tc --profile work auth request --grant --cap ");
  });

  test("every printed --cap parses back to the account permission it stands for", async () => {
    profileWithOwner();
    const parsed = await Promise.all(accountCapSpecs().map((spec) => parseCapSpec(spec, "work")));
    const wanted = accountPermissionEntries();
    expect(parsed).toHaveLength(wanted.length);
    parsed.forEach((entry, index) => {
      expect(entry.service).toBe(wanted[index]!.service);
      expect(entry.path).toBe(wanted[index]!.path);
      expect([...entry.actions].sort()).toEqual([...wanted[index]!.actions].sort());
    });
  });
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TinyCloudNode } from "@tinycloud/node-sdk";

import { createInvocationRuntime } from "./runtime.js";
import { readJson, sessionPath, writeJsonAtomic } from "./state.js";
import { createAuthRuntimeFixture } from "../test-support/auth-runtime.js";

// Both runtime kinds (MCP stdio and CLI operations) restore a stored session whose original grant has ended through its
// saved lease. The node's renewal check is stood in for; its own behaviour is node-sdk's to test.
let home: string;
beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/tinycloud-operations-renewal-`);
  process.env.TC_HOME = home;
});
afterEach(async () => {
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

async function leasedFixture() {
  const fixture = await createAuthRuntimeFixture();
  const session = await readJson<Record<string, unknown>>(sessionPath(fixture.profile));
  await writeJsonAtomic(sessionPath(fixture.profile), { ...session,
    renewal: { receipt: { leaseAuthorization: "saved-lease", leaseExpiresAt: new Date(Date.now() + 86_400_000).toISOString() } } });
  return fixture;
}

for (const requirement of ["authenticated", "restored"] as const) {
  test(`a ${requirement} runtime restores an ended original grant through its saved lease`, async () => {
    const fixture = await leasedFixture();
    const restore = TinyCloudNode.prototype.restoreSession;
    const expired = spyOn(TinyCloudNode.prototype, "restoreSession").mockImplementation(async () => {
      throw Object.assign(new Error("expired"), { code: "AUTH_EXPIRED" });
    });
    const leases: string[] = [];
    const renewed = spyOn(TinyCloudNode.prototype, "restoreSessionWithRenewal").mockImplementation(async function (this: TinyCloudNode, data, lease) {
      leases.push(lease);
      await restore.call(this, data);
    });
    try {
      const runtime = await createInvocationRuntime({ profile: fixture.profile }, requirement);
      expect(runtime.ok).toBe(true);
      expect(leases).toEqual(["saved-lease"]);
    } finally {
      expired.mockRestore(); renewed.mockRestore(); fixture.hermetic.stop();
    }
  });

  test(`a ${requirement} runtime whose lease the node reports as ended asks for a new sign-in`, async () => {
    const fixture = await leasedFixture();
    const expired = spyOn(TinyCloudNode.prototype, "restoreSession").mockImplementation(async () => {
      throw Object.assign(new Error("expired"), { code: "AUTH_EXPIRED" });
    });
    const renewed = spyOn(TinyCloudNode.prototype, "restoreSessionWithRenewal").mockImplementation(async () => {
      throw Object.assign(new Error("ended"), { code: "RENEWAL_LEASE_EXPIRED" });
    });
    try {
      const runtime = await createInvocationRuntime({ profile: fixture.profile }, requirement);
      expect(runtime.ok).toBe(false);
      if (!runtime.ok) expect(runtime.error.code).toBe("AUTH_REQUIRED");
    } finally {
      expired.mockRestore(); renewed.mockRestore(); fixture.hermetic.stop();
    }
  });
}

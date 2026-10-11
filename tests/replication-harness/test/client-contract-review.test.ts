import { describe, expect, test } from "bun:test";
import type { ClientConstructor, SharedFixtureFactory } from "../src/contracts/frozen";
import { createCliClient } from "../src/clients/cli-client";
import { forgetSdkIdentityKeys, registerSdkIdentityPrivateKey, sdkIdentityPrivateKey } from "../src/clients/identity";
import { createSdkClient } from "../src/clients/sdk-client";
import { createSharedEndpointStorageDeviceFixture } from "../src/clients/shared-fixture";

// These assignments are intentional compile-time checks against the frozen S0 entry points.
const clientConstructors: readonly [ClientConstructor, ClientConstructor] = [createCliClient, createSdkClient];
const sharedFixtureFactory: SharedFixtureFactory = createSharedEndpointStorageDeviceFixture;
void clientConstructors;
void sharedFixtureFactory;

describe("SDK-only identity material", () => {
  test("generates a stable process-local owner key per run identity", () => {
    const runId = `review-${crypto.randomUUID()}`;
    const first = sdkIdentityPrivateKey(runId, "sdk-owner");
    const second = sdkIdentityPrivateKey(runId, "sdk-owner");
    const cliKey = "ab".repeat(32);
    registerSdkIdentityPrivateKey(runId, "cli-owner", cliKey);
    const other = sdkIdentityPrivateKey(runId, "sdk-owner-2");
    expect(sdkIdentityPrivateKey(runId, "cli-owner")).toBe(cliKey);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    forgetSdkIdentityKeys(runId);
  });
});

import { expect, test } from "bun:test";
import { createPrimarySpace } from "./space-hosting";
import type { SpaceCreationContext, SpaceHostResult } from "@tinycloud/sdk-core";

const context: SpaceCreationContext = {
  spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
  address: "0x0000000000000000000000000000000000000001",
  chainId: 1,
  host: "https://node.example",
};
const hosted: SpaceHostResult = { success: true, status: 200 };
const handler = { confirmSpaceCreation: async () => true };

test("sign-out during confirmation aborts before host delegation and recording", async () => {
  const controller = new AbortController();
  let answer!: (approved: boolean) => void;
  let markConfirmationStarted!: () => void;
  const confirmationStarted = new Promise<void>((resolve) => { markConfirmationStarted = resolve; });
  let hostCalls = 0;
  let recorded = false;
  const pending = createPrimarySpace({
    handler: { confirmSpaceCreation: () => new Promise<boolean>((resolve) => { answer = resolve; markConfirmationStarted(); }) },
    context,
    guard: async () => {},
    host: async () => { hostCalls++; return hosted; },
    onHosted: () => { recorded = true; },
    activate: async () => hosted,
    signal: controller.signal,
  });
  await confirmationStarted;
  controller.abort(new Error("signed out"));
  answer(true);
  await expect(pending).rejects.toThrow("signed out");
  expect(hostCalls).toBe(0);
  expect(recorded).toBe(false);
});

test("sign-out after host signing but before its response prevents local hosting state", async () => {
  const controller = new AbortController();
  let resolveHost!: (result: SpaceHostResult) => void;
  let markHostStarted!: () => void;
  const hostStarted = new Promise<void>((resolve) => { markHostStarted = resolve; });
  let recorded = false;
  const pending = createPrimarySpace({
    handler,
    context,
    guard: async () => {},
    host: () => new Promise<SpaceHostResult>((resolve) => { resolveHost = resolve; markHostStarted(); }),
    onHosted: () => { recorded = true; },
    activate: async () => hosted,
    signal: controller.signal,
  });
  await hostStarted;
  controller.abort(new Error("signed out"));
  resolveHost(hosted);
  await expect(pending).rejects.toThrow("signed out");
  expect(recorded).toBe(false);
});


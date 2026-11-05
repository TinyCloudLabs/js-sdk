import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { profilePath, readJson } from "@tinycloud/operations/state";
import { acquireApprovalRequest } from "./approval-request.js";
import { scopedLoginPermissions } from "./scoped-login.js";
import { onboardingPermissions } from "./onboarding-scope.js";

test("both task spaces persist as one 1/1 approval, and interruption resumes the same link", async () => {
  const manager = new NodeWasmBindings().createSessionManager();
  const key = JSON.parse(manager.jwk("default")!);
  const did = manager.getDID("default");
  await ProfileManager.setProfile("one-approval", { name: "one-approval", host: "https://node.test", did, sessionDid: did, authMethod: "openkey", chainId: 1, spaceName: "applications", createdAt: new Date().toISOString() });
  await ProfileManager.setKey("one-approval", key);
  let creates = 0;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    creates++;
    const record = JSON.parse(init!.body as string);
    return Response.json({ id: "aaaaaaaaaaaaaaaaaaaaaaaaaa", expiresAt: record.header.expiresAt }, { status: 201 });
  });
  const urls: string[] = [];
  const options = { profileName: "one-approval", jwk: key, host: "https://node.test", permissions: scopedLoginPermissions(onboardingPermissions("apps,feed")),
    expiry: "30d", noPopup: true, approvalWait: { deadlineMs: Date.now() + 1000, step: 1, of: 1 },
    onApprovalRequest: ({ approvalUrl }: { approvalUrl: string }) => { urls.push(approvalUrl); } };
  try {
    await expect(acquireApprovalRequest(did, options)).rejects.toMatchObject({ code: "APPROVAL_PENDING" });
    const stopped = new Error("fixture interruption");
    await expect(acquireApprovalRequest(did, { ...options, onApprovalRequest: ({ approvalUrl }) => { urls.push(approvalUrl); throw stopped; } })).rejects.toBe(stopped);
    expect(creates).toBe(1);
    expect(urls[0]).toBe(urls[1]);
    const pending = await readJson<Array<{ request: { permissions: Array<{ space: string }> } }>>(join(profilePath("one-approval"), "approval-pending.json"));
    expect(pending).toHaveLength(1);
    expect(new Set(pending![0]!.request.permissions.map(p => p.space))).toEqual(new Set(["account", "applications"]));
  } finally { fetch.mockRestore(); }
});

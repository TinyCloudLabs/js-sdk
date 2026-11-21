import { afterEach, expect, spyOn, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { InvitationApprovalOutcome } from "@tinycloud/operations/invitation-approval";
import { ExitCode } from "../config/constants.js";
import { createEmailInviteApprover, type EmailInviteApprovalRequest } from "./invite-approval.js";

const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const link = { status: "pending" as const, approvalUrl: "https://openkey.example/l/abc#key", requestId: "a".repeat(26), expiresAt: "2099-01-01T00:00:00.000Z" };
const approved = { status: "approved" as const, shareId: "d4".repeat(16), accessExpiresAt: "2099-01-01T00:00:00.000Z", resumed: true };
const request: EmailInviteApprovalRequest = {
  node: {} as TinyCloudNode, profile: "work", recipientEmail: "reader@example.com", subjectName: "note.md", subjectKind: "file",
  accessExpiresAt: new Date("2099-01-01T00:00:00.000Z"), contentSha256: "sha-one", requestedDurationMs: 60_000,
};
/** The stable error shape the operations package throws (it bundles its own class per entry point). */
function operationFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "OperationInvocationError", operationError: { code, message } });
}
function approverOver(outcomes: Array<InvitationApprovalOutcome | Error>, profile: { ownerDid?: string; openkeyHost?: string } = { ownerDid }) {
  const asked: unknown[] = [];
  const pauses: number[] = [];
  const queue = [...outcomes];
  const approve = createEmailInviteApprover({
    requestApproval: async (input) => {
      asked.push(input);
      const next = queue.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { pauses.push(ms); },
    getProfile: async () => profile,
  });
  return { approve, asked, pauses };
}

afterEach(() => { delete process.env.TC_OPENKEY_HOST; });

test("it shows the link once, asks again until the approval arrives, and returns the installed key", async () => {
  const links: string[] = [];
  const { approve, asked, pauses } = approverOver([link, link, approved], { ownerDid, openkeyHost: "https://configured.example" });
  const result = await approve({ ...request, onApprovalRequest: (shown) => { links.push(shown.approvalUrl); } });
  expect(result).toEqual({ shareId: approved.shareId, accessExpiresAt: approved.accessExpiresAt, resumed: true });
  expect(links).toEqual([link.approvalUrl]);
  expect(pauses).toEqual([2000, 2000]);
  expect(asked).toHaveLength(3);
  expect(asked[0]).toMatchObject({ profile: "work", ownerDid, recipientEmail: "reader@example.com", contentSha256: "sha-one", requestedDurationMs: 60_000, openkeyHost: "https://configured.example" });
});

test("without a hook the link goes to stderr, and the browser stays closed when a popup is off", async () => {
  process.env.TC_NO_POPUP = "1";
  const written = spyOn(console, "error").mockImplementation(() => {});
  try {
    await approverOver([link, approved]).approve(request);
    expect(String(written.mock.calls[0]![0])).toContain(link.approvalUrl);
  } finally {
    written.mockRestore();
    delete process.env.TC_NO_POPUP;
  }
});

test("a profile that records no owner account is refused before OpenKey is asked", async () => {
  const { approve, asked } = approverOver([], {});
  await expect(approve(request)).rejects.toMatchObject({ code: "APPROVAL_REQUEST_CONTEXT_REQUIRED", exitCode: ExitCode.USAGE_ERROR });
  expect(asked).toEqual([]);
});

test.each([
  ["APPROVAL_RESULT_INVALID", "APPROVAL_RESULT_INVALID", ExitCode.PERMISSION_DENIED],
  ["NODE_UNREACHABLE", "UNAVAILABLE", ExitCode.NETWORK_ERROR],
  ["APPROVAL_REQUEST_EXPIRED", "APPROVAL_REQUEST_EXPIRED", ExitCode.AUTH_REQUIRED],
  ["APPROVAL_RESULT_EXPIRED", "APPROVAL_RESULT_EXPIRED", ExitCode.AUTH_REQUIRED],
  ["APPROVAL_UNAVAILABLE", "APPROVAL_REQUEST_UNAVAILABLE", ExitCode.PENDING],
])("the operations error %s ends the wait as %s", async (code, cliCode, exitCode) => {
  const { approve } = approverOver([operationFailure(code, "refused")]);
  await expect(approve(request)).rejects.toMatchObject({ code: cliCode, exitCode, message: "refused" });
});

test("OpenKey not answering while waiting is asked again; five misses in a row end the wait", async () => {
  const down = () => operationFailure("APPROVAL_UNAVAILABLE", "down");
  const { approve, pauses } = approverOver([link, down(), down(), approved]);
  expect((await approve({ ...request, onApprovalRequest: () => {} })).shareId).toBe(approved.shareId);
  expect(pauses).toHaveLength(3);
  const failing = approverOver([link, down(), down(), down(), down(), down()]);
  await expect(failing.approve({ ...request, onApprovalRequest: () => {} })).rejects.toMatchObject({ code: "APPROVAL_REQUEST_UNAVAILABLE" });
});

test("a different request appearing while waiting means the shown one lapsed", async () => {
  const { approve } = approverOver([link, { ...link, requestId: "b".repeat(26) }]);
  await expect(approve({ ...request, onApprovalRequest: () => {} })).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED", exitCode: ExitCode.AUTH_REQUIRED });
});

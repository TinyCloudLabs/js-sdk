import { expect, test } from "bun:test";
import { delegateWithGiveBack, NODE_WITHOUT_GIVE_BACK_WARNING, OVER_31_DAYS_WARNING, shellWord } from "./revoke-controls.js";

const DAY = 24 * 60 * 60 * 1000;
const live = { cid: "bafy-live", delegateDID: "did:key:z6MkAgent" };
const control = { cid: "bafy-control", targetCid: "bafy-live" };
const command = (name: string) => `tinycloud feed disconnect --agent ${shellWord(name)}`;

function fakeNode(outcome: () => unknown) {
  const calls: Array<{ holderMayRevoke?: boolean }> = [];
  const node = { delegateTo: async (_to: string, _permissions: unknown, options?: { holderMayRevoke?: boolean }) => {
    calls.push({ holderMayRevoke: options?.holderMayRevoke });
    return outcome();
  } };
  return { node: node as never, calls };
}
const run = (node: never, expiry: number, warnings: string[], withdrawn: string[] = []) =>
  delegateWithGiveBack(node, "did:key:z6MkAgent", [], { expiry, requireActivation: true }, command, async (cid) => { withdrawn.push(cid); }, (line) => warnings.push(line));

test("a node that supports the give-back grant returns it, with no warning", async () => {
  const { node, calls } = fakeNode(() => ({ delegation: live, revokeControl: control }));
  const warnings: string[] = [];
  expect(await run(node, DAY, warnings)).toEqual({ delegation: live, revokeControl: control });
  expect(calls).toEqual([{ holderMayRevoke: true }]);
  expect(warnings).toEqual([]);
});

test("an old node's refusal of the grant still connects, with no grant and the exact node warning", async () => {
  const { node } = fakeNode(() => { throw Object.assign(new Error("refused"), { delegation: live, revokeControlRefused: true }); });
  const warnings: string[] = [];
  expect(await run(node, DAY, warnings)).toEqual({ delegation: live });
  expect(warnings).toEqual([
    "This node doesn't support the agent giving back its access. The connection works, and you can still revoke it yourself:\n  tinycloud feed disconnect --agent bafy-live",
  ]);
  expect(warnings[0]).toBe(NODE_WITHOUT_GIVE_BACK_WARNING(command("bafy-live")));
});

test("any other failure is not swallowed, and a delegation that went live without its grant is withdrawn first", async () => {
  for (const [failure, live_] of [
    [Object.assign(new Error("connection reset"), { delegation: live }), true],
    [Object.assign(new Error("500 - boom"), { delegation: live, revokeControlRefused: false }), true],
    [new Error("Requested capabilities exceed current session."), false],
  ] as const) {
    const { node } = fakeNode(() => { throw failure; });
    const warnings: string[] = [];
    const withdrawn: string[] = [];
    await expect(run(node, DAY, warnings, withdrawn)).rejects.toBe(failure);
    expect(warnings).toEqual([]);
    expect(withdrawn).toEqual(live_ ? ["bafy-live"] : []);
  }
});

test("a refused grant keeps the live delegation: nothing is withdrawn", async () => {
  const { node } = fakeNode(() => { throw Object.assign(new Error("refused"), { delegation: live, revokeControlRefused: true }); });
  const withdrawn: string[] = [];
  await run(node, DAY, [], withdrawn);
  expect(withdrawn).toEqual([]);
});

test("a failing withdrawal does not hide the original failure", async () => {
  const failure = Object.assign(new Error("connection reset"), { delegation: live });
  const { node } = fakeNode(() => { throw failure; });
  await expect(delegateWithGiveBack(node, "did:key:z6MkAgent", [], { expiry: DAY, requireActivation: true }, command,
    async () => { throw new Error("revoke failed"); }, () => undefined)).rejects.toBe(failure);
});

test("a name with a space or a quote is quoted in the printed command; a plain one is not", () => {
  expect(command("my agent")).toBe("tinycloud feed disconnect --agent 'my agent'");
  expect(command("it's")).toBe("tinycloud feed disconnect --agent 'it'\\''s'");
  expect(command("plain-agent_1")).toBe("tinycloud feed disconnect --agent plain-agent_1");
  expect(NODE_WITHOUT_GIVE_BACK_WARNING(command("my agent"))).toBe(
    "This node doesn't support the agent giving back its access. The connection works, and you can still revoke it yourself:\n  tinycloud feed disconnect --agent 'my agent'",
  );
});

test("over 31 days the delegation is issued without the grant and the exact 31-days warning is printed, and that line only", async () => {
  const { node, calls } = fakeNode(() => ({ delegation: live }));
  const warnings: string[] = [];
  expect(await run(node, 40 * DAY, warnings)).toEqual({ delegation: live });
  expect(calls).toEqual([{ holderMayRevoke: undefined }]);
  expect(warnings).toEqual([
    "Connections longer than 31 days can't let the agent give back its access. The connection works, and you can still revoke it yourself:\n  tinycloud feed disconnect --agent bafy-live",
  ]);
  expect(warnings[0]).toBe(OVER_31_DAYS_WARNING(command("bafy-live")));
});

test("exactly 31 days still gets the grant", async () => {
  const { node, calls } = fakeNode(() => ({ delegation: live, revokeControl: control }));
  await run(node, 31 * DAY, []);
  expect(calls).toEqual([{ holderMayRevoke: true }]);
});

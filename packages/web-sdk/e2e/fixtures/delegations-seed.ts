import type { StubDelegationRowSeed, StubDelegationsSeed, StubSeed } from "../../src/ui/stub/index";

// Example delegations shaped like the settings mockup's. Every name, DID and CID is a placeholder.
const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000c41d0";
const SPACE = (name: string) => `tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000c41d0:${name}`;
const KV_ACTIONS = { get: "tinycloud.kv/get", put: "tinycloud.kv/put", list: "tinycloud.kv/list" } as const;

interface Spec {
  readonly cid: string;
  readonly group: "this-app" | "to-others" | "received";
  readonly label: string;
  readonly did: string;
  readonly space: string;
  readonly paths: readonly string[];
  readonly actions: readonly (keyof typeof KV_ACTIONS)[];
  readonly createdMin: number;
  readonly expMin: number;
  readonly terminal: boolean;
  readonly soon?: boolean;
}

const SPECS: readonly Spec[] = [
  { cid: "bafyEXAMPLEd1k2dq", group: "this-app", label: "Fieldnotes · this browser", did: "did:key:z6MkEXAMPLEaW9d", space: "Personal", paths: ["notes/", "recordings/"], actions: ["get", "put", "list"], createdMin: -1068, expMin: 372, terminal: false },
  // A helper the app started holds its own key, not the session's, so the real grouping lists it with the others.
  { cid: "bafyEXAMPLEd2r8uv", group: "to-others", label: "Fieldnotes · local copy", did: "did:key:z6MkEXAMPLEd4Lp", space: "Personal", paths: ["notes/", "recordings/"], actions: ["get", "put", "list"], createdMin: -1068, expMin: 108, terminal: true, soon: true },
  { cid: "bafyEXAMPLEd3m3we", group: "to-others", label: "Fieldnotes · audio transcriber", did: "did:key:z6MkEXAMPLEt5Zc", space: "Personal", paths: ["recordings/"], actions: ["get", "list"], createdMin: -1068, expMin: 372, terminal: true },
  { cid: "bafyEXAMPLEd4p9ax", group: "to-others", label: "Research helper", did: "did:key:z6MkEXAMPLEv2Hn", space: "Personal", paths: ["notes/"], actions: ["get", "list"], createdMin: -2880, expMin: 7440, terminal: true },
  { cid: "bafyEXAMPLEd5c7hs", group: "to-others", label: "Exo", did: "did:key:z6MkEXAMPLEe1Xo", space: "Personal", paths: ["recordings/"], actions: ["get", "put", "list"], createdMin: -25920, expMin: 16100, terminal: false },
  { cid: "bafyEXAMPLEd6u1ny", group: "to-others", label: "calendar-sync", did: "did:key:z6MkEXAMPLEj6Mk", space: "Work", paths: ["notes/meetings/"], actions: ["get", "put", "list"], createdMin: -12960, expMin: 1210, terminal: true },
  { cid: "bafyEXAMPLEd7w4bz", group: "to-others", label: "Secret Manager", did: "did:key:z6MkEXAMPLEs0Gb", space: "Work", paths: ["secrets/"], actions: ["get"], createdMin: -57600, expMin: -4320, terminal: false },
];

/** The mockup's seven rows. Dates are relative to `now`; the expired one carries the node's expired status. */
export function mockupRows(now: number = Date.now()): StubDelegationRowSeed[] {
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  return SPECS.map((spec) => ({
    cid: spec.cid,
    direction: "granted",
    status: spec.expMin < 0 ? "expired" : "active",
    group: spec.group,
    label: { text: spec.label, source: "stub" },
    delegatorDid: OWNER,
    delegateDid: spec.did,
    resources: spec.paths.map((path) => ({
      resource: `${SPACE(spec.space)}/kv/${path}`,
      actions: spec.actions.map((action) => KV_ACTIONS[action]),
    })),
    parents: [],
    issuedAt: at(spec.createdMin),
    notBefore: null,
    expiresAt: at(spec.expMin),
    expiringSoon: spec.soon === true,
    ...(spec.terminal ? { terminal: true } : {}),
  }));
}

/** A grant for a later page: another helper with its own CID, read and list on notes/. */
export function laterRow(n: number, now: number = Date.now()): StubDelegationRowSeed {
  return {
    cid: `bafyEXAMPLElate${n}`,
    direction: "granted",
    status: "active",
    group: "to-others",
    label: { text: `Late helper ${n}`, source: "stub" },
    delegatorDid: OWNER,
    delegateDid: `did:key:z6MkEXAMPLElate${n}`,
    resources: [{ resource: `${SPACE("Personal")}/kv/notes/`, actions: [KV_ACTIONS.get, KV_ACTIONS.list] }],
    parents: [],
    issuedAt: new Date(now - 86_400_000).toISOString(),
    notBefore: null,
    expiresAt: new Date(now + 10 * 86_400_000).toISOString(),
    expiringSoon: false,
  };
}

/** A delegation that was granted to this account by someone else. */
export function receivedRow(now: number = Date.now()): StubDelegationRowSeed {
  return {
    cid: "bafyEXAMPLEr1q2zz",
    direction: "received",
    status: "active",
    group: "received",
    // The real mapper names every row after its delegate, which for a received grant is the user.
    label: { text: "did:pkh:eip155…0c41d0", source: "derived" },
    delegatorDid: "did:key:z6MkEXAMPLEg7Qa",
    delegateDid: OWNER,
    resources: [{ resource: `${SPACE("Shared")}/kv/lab-notes/`, actions: [KV_ACTIONS.get, KV_ACTIONS.list] }],
    parents: [],
    issuedAt: new Date(now - 3 * 86_400_000).toISOString(),
    notBefore: null,
    expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    expiringSoon: false,
  };
}

/** The init script that pins the stub seed before the page loads. */
export function seedScript(delegations: StubDelegationsSeed): string {
  const seed: StubSeed = { delegations };
  return `window.__TC_STUB_SEED__ = ${JSON.stringify(JSON.stringify(seed))};`;
}

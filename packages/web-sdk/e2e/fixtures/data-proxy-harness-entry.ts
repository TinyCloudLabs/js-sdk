// Browser harness for the Delegations e2e through the REAL panel-data adapter (production wiring: the lazy
// proxy and `createRealPanelData`), over a fake node host. Bundled by `build:e2e-data-proxy` into
// e2e/.build/data-proxy. Two accounts, A and B, each with its own delegations and cursors; `switchAccount`
// does what tcw does on a principal change: reset the panel client, then arm the data again.
import type { AccountDelegationRecord } from "@tinycloud/sdk-core";
import { registerUiClient, type UiClientHandle } from "../../src/ui/index";

// "S" is an account whose app session holds one grant listed under the bare DID while `sessionDid` is a DID URL with a fragment.
type Account = "A" | "B" | "S";

interface Call {
  readonly name: string;
  readonly args?: unknown;
}

const calls: Call[] = [];
const revokes: string[] = [];

const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000c41d0";
const SPACE = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000c41d0:default";

function record(cid: string, delegateDid: string, status: AccountDelegationRecord["status"] = "active"): AccountDelegationRecord {
  return {
    cid,
    direction: "granted",
    delegatorDid: OWNER,
    delegateDid,
    resources: [{ resource: `${SPACE}/kv/notes/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list"], caveats: [] }],
    parents: [],
    issuedAt: new Date(Date.now() - 3_600_000),
    notBefore: null,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    status,
  };
}

// Delegate DIDs differ in the first 14 and last 6 characters, the part the adapter's short form keeps, so each card has its own name.
export const DELEGATE = (account: Account, n: number) => `did:key:z6Mk${account}DelegateExampleBase0${n}`;

interface Pages {
  readonly first: AccountDelegationRecord[];
  readonly cursor?: string;
  readonly second?: AccountDelegationRecord[];
}

const SESSION_KEY = "z6MkSessionFake";
const SESSION_BARE = `did:key:${SESSION_KEY}`;

const DATA: Record<Account, Pages> = {
  A: {
    first: [1, 2, 3].map((n) => record(`bafyAccountA${n}`, DELEGATE("A", n))),
    cursor: "A-page-2",
    second: [4, 5].map((n) => record(`bafyAccountA${n}`, DELEGATE("A", n))),
  },
  B: {
    first: [1, 2].map((n) => record(`bafyAccountB${n}`, DELEGATE("B", n))),
  },
  S: {
    first: [record("bafyOwnSession", SESSION_BARE), record("bafyHelper", DELEGATE("S", 1))],
  },
};

let account: Account = "A";
let signedIn = true;

// Read gate: while closed, delegations reads wait on it, so a read stays in flight across an account switch.
let gate: Promise<void> | undefined;
let openGate: (() => void) | undefined;
const faults = { denyDelegations: false };

// Account index reads (the Overview's spaces and applications lists). "missing" is a brand-new account whose
// index tables do not exist yet; "down" is any other failure; "ok" lists nothing.
let indexMode: "ok" | "missing" | "down" = "ok";
let indexReads = 0;
const indexRead = () => {
  indexReads += 1;
  if (indexMode === "missing") {
    return {
      ok: false as const,
      error: { code: "SQL_ERROR", message: "SQL query failed: 400 - SQLite error: no such table: spaces", service: "sql" },
    };
  }
  if (indexMode === "down") {
    return { ok: false as const, error: { code: "NETWORK_ERROR", message: "Failed to fetch", service: "sql" } };
  }
  return empty;
};

const removed = new Set<string>();
const live = (items: AccountDelegationRecord[]) => items.filter((r) => !removed.has(r.cid));

const empty = { ok: true as const, data: [] };

const host = {
  account: {
    index: {
      spaces: { async list() { return indexRead(); } },
      applications: { async list() { return indexRead(); } },
    },
  },
  delegations: {
    async query(options: { direction?: string; limit?: number; cursor?: string }) {
      // The page and the account are fixed when the read starts, like a request already on the wire.
      const asked = account;
      calls.push({ name: "delegations.query", args: { ...options } });
      if (gate) await gate;
      if (faults.denyDelegations) {
        return { ok: false as const, error: { code: "PERMISSION_DENIED", message: "denied", service: "delegation" } };
      }
      const pages = DATA[asked];
      if (options.cursor !== undefined) {
        if (options.cursor !== pages.cursor) return { ok: true as const, data: { schemaVersion: 2 as const, items: [] } };
        return { ok: true as const, data: { schemaVersion: 2 as const, items: live(pages.second ?? []) } };
      }
      return {
        ok: true as const,
        data: {
          schemaVersion: 2 as const,
          items: live(pages.first),
          ...(pages.cursor ? { nextCursor: pages.cursor } : {}),
        },
      };
    },
    async status(cid: string) {
      calls.push({ name: "delegations.status", args: cid });
      return { ok: true as const, data: { status: "active" as const } };
    },
    async revoke(cid: string) {
      calls.push({ name: "delegations.revoke", args: cid });
      revokes.push(cid);
      removed.add(cid);
      return { ok: true as const, data: { revoked: true as const, cid } };
    },
  },
  storage: {
    async status() {
      return { ok: true as const, data: { usedBytes: 1024, limitBytes: 1048576, state: "ok" as const } };
    },
  },
  hosts: ["https://node.example.test"],
  get did() {
    return `did:key:z6MkAccount${account}Example`;
  },
  get sessionDid() {
    return account === "S" ? `${SESSION_BARE}#${SESSION_KEY}` : SESSION_BARE;
  },
  async activeNodeIdentity() {
    return { origin: "https://node.example.test", nodeDid: "did:key:z6MkNodeFake" };
  },
};

const source = {
  signedIn: () => signedIn,
  storage: host.storage,
};

let handle: UiClientHandle | undefined;

const w = window as unknown as Record<string, unknown>;
w.__tc = {
  mount(options: { signedIn?: boolean; name?: string } = {}) {
    handle?.unregister();
    signedIn = options.signedIn ?? true;
    handle = registerUiClient({
      ui: { developerMode: false },
      source: source as never,
      manifestAppId: () => "e2e-data-proxy",
      manifestName: () => options.name,
    });
    w.tc = { ui: handle.api };
    return true;
  },
  // Stands in for tcw's sign-in or restore.
  async arm() {
    handle?.armPrefetch(host as never);
    await import("../../src/ui/panel-data-entry");
    return true;
  },
  // A different principal signs in over the live session: tcw resets the panel client, then arms again.
  async switchAccount(to: Account) {
    account = to;
    handle?.reset();
    handle?.armPrefetch(host as never);
    await import("../../src/ui/panel-data-entry");
    return true;
  },
  signOut() {
    signedIn = false;
    handle?.reset();
    return true;
  },
  hold(closed: boolean) {
    if (closed && !gate) {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    } else if (!closed && gate) {
      const release = openGate;
      gate = undefined;
      openGate = undefined;
      release?.();
    }
    return true;
  },
  deny(on: boolean) {
    faults.denyDelegations = on;
    return true;
  },
  index(mode: "ok" | "missing" | "down") {
    indexMode = mode;
    return true;
  },
  indexReads() {
    return indexReads;
  },
  calls() {
    return calls.map((c) => ({ ...c }));
  },
  revokes() {
    return revokes.slice();
  },
};

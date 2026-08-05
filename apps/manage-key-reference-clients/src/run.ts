import { NotesOAuthClient } from "./notes-client";
import type {
  EstablishManageKeySessionOptions,
  EstablishManageKeySessionResult,
} from "@tinycloud/web-sdk";
import {
  provisionReferenceApplicationsSpace,
  startReferenceOAuthIssuer,
} from "./reference-oauth-issuer";
import { TasksOAuthClient } from "./tasks-client";

type ManageKeySession = Pick<EstablishManageKeySessionResult, "client">;
type EstablishSession = (
  options: EstablishManageKeySessionOptions,
) => Promise<EstablishManageKeySessionResult>;

export async function runReferenceClients() {
  const issuer = startReferenceOAuthIssuer();
  try {
    const notes = await new NotesOAuthClient(issuer.baseUrl).signIn();
    const tasks = await new TasksOAuthClient(issuer.baseUrl).authenticate();
    if (
      notes.identity.address !== tasks.identity.address ||
      notes.identity.did !== tasks.identity.did ||
      notes.identity.spaceId !== tasks.identity.spaceId
    ) {
      throw new Error("Independent OAuth clients resolved different canonical identities");
    }
    return { notes, tasks, events: [...issuer.events] };
  } finally {
    issuer.stop();
  }
}

/**
 * Real-node variant of the two independent OAuth clients. The applications
 * space is provisioned by the owner before either narrowly scoped grant signs
 * its one TinyCloud session.
 */
export async function runReferenceClientsWithTinyCloud(host: string) {
  await provisionReferenceApplicationsSpace(host);
  const issuer = startReferenceOAuthIssuer();
  try {
    const notes = await new NotesOAuthClient(issuer.baseUrl).signIn();
    const tasks = await new TasksOAuthClient(issuer.baseUrl).authenticate();
    const establishManageKeySession = await loadSessionHelper();
    const notesSession = await establishManageKeySession({
      identity: notes.identity,
      signer: { endpoint: `${issuer.baseUrl}/api/delegate/sign`, token: notes.accessToken, scopes: "openid notes.read tinycloud:manage-key" },
      tinycloud: tinycloudConfig(host, notes.identity.spaceId),
    });
    const tasksSession = await establishManageKeySession({
      identity: tasks.identity,
      signer: { endpoint: `${issuer.baseUrl}/api/delegate/sign`, token: tasks.bearer, scopes: "openid tasks.write tinycloud:manage-key" },
      tinycloud: tinycloudConfig(host, tasks.identity.spaceId),
    });
    await assertRoundTrip(notesSession, "notes");
    await assertRoundTrip(tasksSession, "tasks");
    return { notes, tasks, events: [...issuer.events] };
  } finally {
    issuer.stop();
  }
}

function tinycloudConfig(
  host: string,
  spaceId: string,
): EstablishManageKeySessionOptions["tinycloud"] {
  return {
    tinycloudHosts: [host],
    autoDiscoverLocalNode: false,
    autoCreateSpace: false,
    persistSession: false,
    includeAccountRegistryPermissions: false,
    spacePrefix: "applications",
    capabilityRequest: {
      manifests: [],
      resources: [{
        service: "tinycloud.kv",
        space: spaceId,
        path: "manage-key-reference/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      }],
      delegationTargets: [],
      registryRecords: [],
      expiryMs: 60 * 60 * 1000,
      includePublicSpace: false,
    },
  };
}

async function assertRoundTrip(session: ManageKeySession, client: string): Promise<void> {
  const key = `manage-key-reference/${client}.bin`;
  const bytes = new Uint8Array([client.length, 0, 255]);
  const put = await session.client.kv.put(key, bytes, { contentType: "application/octet-stream" });
  if (!put.ok) throw new Error(`${client} TinyCloud write failed`);
  const get = await session.client.kv.get<Uint8Array>(key, { binary: true });
  if (!get.ok || !Buffer.from(get.data.data).equals(Buffer.from(bytes))) {
    throw new Error(`${client} TinyCloud byte round-trip failed`);
  }
}

async function loadSessionHelper(): Promise<EstablishSession> {
  installMinimalDom();
  const { establishManageKeySession } = await import("@tinycloud/web-sdk");
  return establishManageKeySession;
}

function installMinimalDom(): void {
  const global = globalThis as any;
  global.HTMLElement ??= class { attachShadow() { return { innerHTML: "", querySelector: () => null }; } };
  global.customElements ??= { define: () => undefined, get: () => undefined };
  global.window ??= { addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true, location: { hostname: "manage-key-reference.local" } };
  global.document ??= { createElement: () => ({ setAttribute: () => undefined, appendChild: () => undefined, remove: () => undefined, style: {} }), body: { appendChild: () => undefined, style: {} } };
}

if (import.meta.main) {
  const { notes, tasks, events } = await runReferenceClients();
  console.log(JSON.stringify({
    notes: { did: notes.identity.did, spaceId: notes.identity.spaceId },
    tasks: { did: tasks.identity.did, spaceId: tasks.identity.spaceId },
    oauthEvents: events,
  }, null, 2));
}

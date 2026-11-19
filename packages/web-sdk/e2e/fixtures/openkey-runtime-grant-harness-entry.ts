// Browser harness for the OpenKey runtime-grant spec. Bundled by `build:e2e-openkey-grant` into
// e2e/.build/openkey-grant.bundle.js. It runs the REAL TinyCloudWeb.requestPermissions and the REAL `@openkey/sdk`
// OpenKey class, whose connect() and signMessage() each open a popup with window.open. Only the node (no WASM, no
// network) and the OpenKey widget pages (served by the spec) are stand-ins. The spec makes every call from a real click.
import { OpenKey } from "@openkey/sdk";
import { TinyCloudWeb } from "../../src/modules/tcw";

const ALICE = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const ENTRY = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };
const OPENKEY_HOST = "https://openkey.test";

interface Outcome {
  ok: boolean;
  code?: string;
  name?: string;
  message?: string;
}

const signatures: string[] = [];
const outcomes: Outcome[] = [];

function stubNode() {
  return {
    address: ALICE,
    isSessionOnly: false,
    spaceId: "space-1",
    session: { address: ALICE, chainId: 1, sessionKey: "k", siwe: "s", signature: "g" },
    hasRuntimePermissions: () => false,
    getRuntimePermissionDelegations: () => [],
    grantRuntimePermissions: async (_entries: unknown, grant?: { signMessage?: (siwe: string) => Promise<string> }) => {
      signatures.push(await grant!.signMessage!("prepared-siwe"));
      return [];
    },
  };
}

let tcw: TinyCloudWeb | undefined;

(window as unknown as { __grant: unknown }).__grant = {
  /** A restored page: the OpenKey client was never connected. */
  restore(mode: "popup" | "iframe") {
    const client = new OpenKey({ host: OPENKEY_HOST, appName: "grant-harness", mode } as never);
    const instance = Object.create(TinyCloudWeb.prototype) as TinyCloudWeb;
    Object.assign(instance, {
      session: () => undefined,
      config: { openkey: { client, mode } },
      signOutCount: 0,
      signOutInFlight: 0,
      _manifest: { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] },
      _node: stubNode(),
      _testHooks: { showModal: async () => ({ approved: true }) },
    });
    tcw = instance;
    signatures.length = 0;
    outcomes.length = 0;
  },
  /** The app's Allow button: call it from a click handler, so the call has the click's user activation. */
  async allow(): Promise<void> {
    try {
      await tcw!.requestPermissions([ENTRY] as never);
      outcomes.push({ ok: true });
    } catch (error) {
      const { code, name, message } = error as Outcome;
      outcomes.push({ ok: false, code, name, message });
    }
  },
  /**
   * Control: connect() then signMessage() from ONE click in popup mode, as a grant that connected and signed in one go
   * would. The spec shows the browser blocks the second popup.
   */
  async connectThenSignInOneClick(): Promise<void> {
    const client = new OpenKey({ host: OPENKEY_HOST, appName: "grant-harness", mode: "popup" } as never);
    try {
      const auth = await client.connect({ mode: "popup" });
      signatures.push((await client.signMessage({ message: "prepared-siwe", keyId: auth.keyId }, { mode: "popup" })).signature);
      outcomes.push({ ok: true });
    } catch (error) {
      const { code, name, message } = error as Outcome;
      outcomes.push({ ok: false, code, name, message });
    }
  },
  state: () => ({ signatures: [...signatures], outcomes: [...outcomes] }),
};

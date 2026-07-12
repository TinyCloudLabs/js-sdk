global.HTMLElement = class {};
global.customElements = { define() {}, get() { return undefined; } };

const { TinyCloudWeb } = require("../dist/index.cjs");

describe("TinyCloudWeb sharing delegation", () => {
  it("exposes delegateReceivedShare through the browser client", async () => {
    const delegateReceivedShare = jest.fn(async () => ({
      ok: false,
      error: { code: "INVALID_TOKEN", message: "fixture" },
    }));
    const client = Object.create(TinyCloudWeb.prototype);
    Object.defineProperty(client, "_node", {
      value: { sharing: { delegateReceivedShare } },
      configurable: true,
    });

    await client.sharing.delegateReceivedShare("tc1:fixture", {
      delegateDID: "did:key:z6MkBrowserRecipient",
    });

    expect(delegateReceivedShare).toHaveBeenCalledWith("tc1:fixture", {
      delegateDID: "did:key:z6MkBrowserRecipient",
    });
  });
});

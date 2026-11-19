/*
 * The permission prompt describes `tinycloud.delegation/list` in OpenKey's words, not the generic fallback row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

class StubShadowRoot {
  innerHTML = "";
  querySelector() {
    return null;
  }
  addEventListener() {}
}

class StubHTMLElement {
  shadowRoot: StubShadowRoot | null = null;
  attachShadow() {
    this.shadowRoot = new StubShadowRoot();
    return this.shadowRoot;
  }
}

const saved = {
  HTMLElement: (globalThis as any).HTMLElement,
  customElements: (globalThis as any).customElements,
};

beforeAll(() => {
  (globalThis as any).HTMLElement = StubHTMLElement;
  (globalThis as any).customElements = { define: () => {}, get: () => undefined };
});

afterAll(() => {
  (globalThis as any).HTMLElement = saved.HTMLElement;
  (globalThis as any).customElements = saved.customElements;
});

describe("delegation list permission prompt", () => {
  for (const actions of [["list"], ["tinycloud.delegation/list"]]) {
    test(`actions ${JSON.stringify(actions)} show the described row`, async () => {
      const { TinyCloudPermissionRequestModal } = await import("../src/notifications/PermissionRequestModal");
      const modal: any = new TinyCloudPermissionRequestModal({
        appName: "Example App",
        additional: [{ service: "tinycloud.delegation", space: "applications", path: "", actions }],
      });

      const html: string = modal.shadowRoot.innerHTML;
      expect(html).toContain("See which apps and links can reach your data, and the names of what each can reach");
      expect(html).toContain("See who has access to your data, what it reaches (by name) and when it ends. Keys and contents aren&#39;t shown.");
      expect(html).not.toContain("perform list on the resource shown below");
    });
  }

  test("another delegation action is titled with its plain action name", async () => {
    const { TinyCloudPermissionRequestModal } = await import("../src/notifications/PermissionRequestModal");
    const modal: any = new TinyCloudPermissionRequestModal({
      appName: "Example App",
      additional: [{ service: "tinycloud.delegation", space: "applications", path: "", actions: ["tinycloud.delegation/revoke"] }],
    });

    expect(modal.shadowRoot.innerHTML).toContain("Manage your delegations (revoke)");
    expect(modal.shadowRoot.innerHTML).not.toContain("Use tinycloud.delegation");
  });
});

global.HTMLElement = class {};
global.customElements = {
  define() {},
  get() {
    return undefined;
  },
};

const { TinyCloudWeb } = require("../dist/index.cjs");

test("TinyCloudWeb exposes spaceId from the underlying node wrapper", () => {
  const tcw = Object.create(TinyCloudWeb.prototype);
  tcw._node = { spaceId: "space-123" };

  expect(tcw.spaceId).toBe("space-123");
});

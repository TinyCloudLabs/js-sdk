import { expect, test } from "bun:test";
import { appKeyHostBinding } from "./appKeyHostBinding";

test("app key ids bind to the reversed SIWE host", () => {
  expect(appKeyHostBinding("listen.tinycloud.xyz", "xyz.tinycloud.listen")).toBe(true);
  expect(appKeyHostBinding("listen.tinycloud.xyz", "xyz.tinycloud.listen.worker")).toBe(true);
  expect(appKeyHostBinding("listen.tinycloud.xyz", "xyz.tinycloud.listener")).toBe(false);
  expect(appKeyHostBinding("localhost", "xyz.tinycloud.listen")).toBe(false);
  expect(appKeyHostBinding("127.0.0.1", "1.0.0.127")).toBe(false);
  expect(appKeyHostBinding("listen.tinycloud.xyz:8443", "xyz.tinycloud.listen")).toBe(false);
});

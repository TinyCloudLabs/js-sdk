import { expect, test } from "bun:test";
import { appKeyHostBinding, isAppKeyHostBound } from "./appKeyHostBinding";

test("app key ids bind to the reversed SIWE host", () => {
  expect(appKeyHostBinding("listen.tinycloud.xyz", "xyz.tinycloud.listen")).toBe(true);
  expect(appKeyHostBinding("listen.tinycloud.xyz", "xyz.tinycloud.listen.worker")).toBe(true);
  expect(appKeyHostBinding("listen.tinycloud.xyz", "xyz.tinycloud.listener")).toBe(false);
  expect(appKeyHostBinding("localhost", "xyz.tinycloud.listen")).toBe(false);
  expect(appKeyHostBinding("127.0.0.1", "1.0.0.127")).toBe(false);
  expect(appKeyHostBinding("listen.tinycloud.xyz:8443", "xyz.tinycloud.listen")).toBe(false);
});

test("isAppKeyHostBound answers the host-binding question for origins", () => {
  const appId = "chat.tinycloud.tinychat";
  expect(isAppKeyHostBound(appId, "https://tinycloud.chat")).toBe(true);
  expect(isAppKeyHostBound(appId, new URL("https://tinycloud.chat/path?q=1"))).toBe(true);
  expect(isAppKeyHostBound(appId, "tinycloud.chat")).toBe(true);
  expect(isAppKeyHostBound("chat.tinycloud.tinychat.worker", "https://tinycloud.chat")).toBe(true);
  for (const origin of [
    "http://localhost:3000", "localhost", "https://tauri.localhost", "https://x.pages.dev",
    "https://evil-tinycloud.chat", "https://tinycloud.chat.evil.com", "https://tinycloud.chat:8443",
    "not a url://", "https://127.0.0.1",
  ]) {
    expect(isAppKeyHostBound(appId, origin)).toBe(false);
  }
});

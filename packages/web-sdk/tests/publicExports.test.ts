import { expect, test } from "bun:test";
import type {
  EstablishManageKeySessionOptions,
  EstablishManageKeySessionResult,
} from "../src/index";

(globalThis as any).HTMLElement = class {};
(globalThis as any).customElements = {
  define: () => undefined,
  get: () => undefined,
};
(globalThis as any).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  location: { hostname: "test.local" },
};
(globalThis as any).document = {
  createElement: () => ({
    setAttribute: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    style: {},
  }),
  body: {
    appendChild: () => undefined,
    style: {},
  },
};

type Assert<T extends true> = T;
type HelperTypesReachable =
  EstablishManageKeySessionOptions["signer"] extends object
    ? EstablishManageKeySessionResult["identity"] extends object
      ? true
      : false
    : false;
const hasHelperTypes: Assert<HelperTypesReachable> = true;
type BootstrapCannotBeSilentlyEnabled =
  "autoBootstrapAccount" extends keyof EstablishManageKeySessionOptions["tinycloud"]
    ? false
    : true;
const rejectsBootstrapOverride: Assert<BootstrapCannotBeSilentlyEnabled> = true;

test("exports establishManageKeySession and its public types from the web facade", async () => {
  const webSdk = await import("../src/index");
  expect(typeof webSdk.establishManageKeySession).toBe("function");
  expect(hasHelperTypes).toBe(true);
  expect(rejectsBootstrapOverride).toBe(true);
});

import { expect, test } from "bun:test";
import type { CaveatedDelegationUnsupportedError as SdkCoreError } from "@tinycloud/sdk-core";
import type { CaveatedDelegationUnsupportedError as WebError } from "../src/index";
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
type SamePublicError = WebError extends SdkCoreError
  ? SdkCoreError extends WebError
    ? true
    : false
  : false;
const hasPublicError: Assert<SamePublicError> = true;
type HelperTypesReachable =
  EstablishManageKeySessionOptions["signer"] extends object
    ? EstablishManageKeySessionResult["identity"] extends object
      ? true
      : false
    : false;
const hasHelperTypes: Assert<HelperTypesReachable> = true;

test("exports CaveatedDelegationUnsupportedError from the web facade", () => {
  expect(hasPublicError).toBe(true);
});

test("exports establishManageKeySession and its public types from the web facade", async () => {
  const webSdk = await import("../src/index");
  expect(typeof webSdk.establishManageKeySession).toBe("function");
  expect(hasHelperTypes).toBe(true);
});

import { expect, test } from "bun:test";
import type { CaveatedDelegationUnsupportedError as SdkCoreError } from "@tinycloud/sdk-core";
import type { CaveatedDelegationUnsupportedError as WebError } from "../src/index";
import type {
  EstablishOpenKeySessionOptions,
  EstablishOpenKeySessionResult,
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
  EstablishOpenKeySessionOptions["providerToken"] extends string | undefined
    ? EstablishOpenKeySessionResult["status"] extends string
      ? true
      : false
    : false;
const hasHelperTypes: Assert<HelperTypesReachable> = true;

test("exports CaveatedDelegationUnsupportedError from the web facade", () => {
  expect(hasPublicError).toBe(true);
});

test("exports establishOpenKeySession and its public types from the web facade", async () => {
  const webSdk = await import("../src/index");
  expect(typeof webSdk.establishOpenKeySession).toBe("function");
  expect(hasHelperTypes).toBe(true);
});

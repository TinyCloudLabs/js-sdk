/**
 * Tests for WASM validation utilities.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  validateWasmOutput,
  validateCreateDelegationWasmOutput,
  validateInvokeWasmOutput,
  validatePrepareSessionWasmOutput,
  validateCompleteSessionSetupWasmOutput,
  validateSiweToDelegationHeadersWasmOutput,
  CreateDelegationWasmRawResultSchema,
  InvokeWasmResultSchema,
  PrepareSessionWasmResultSchema,
  SessionWasmResultSchema,
  SiweToDelegationHeadersWasmResultSchema,
} from "./wasm-validation.js";
import { z } from "zod";

describe("WASM Validation Utilities", () => {
  // Store original NODE_ENV
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  describe("validateWasmOutput", () => {
    const TestSchema = z.object({
      name: z.string(),
      value: z.number(),
    });

    it("should validate and return data in development mode", () => {
      process.env.NODE_ENV = "development";
      const validData = { name: "test", value: 42 };

      const result = validateWasmOutput(TestSchema, validData, "testFn");

      expect(result.data).toEqual(validData);
      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
    });

    it("should return issues for invalid data in development mode", () => {
      process.env.NODE_ENV = "development";
      const invalidData = { name: "test", value: "not a number" } as unknown;

      // Capture console.warn
      const warns: unknown[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args);

      const result = validateWasmOutput(TestSchema, invalidData, "testFn");

      console.warn = originalWarn;

      expect(result.data).toEqual(invalidData as { name: string; value: number });
      expect(result.validated).toBe(true);
      expect(result.issues).toBeDefined();
      expect(result.issues!.length).toBeGreaterThan(0);
      expect(warns.length).toBe(1);
    });

    it("should skip validation in production mode", () => {
      process.env.NODE_ENV = "production";
      const invalidData = { name: "test", value: "not a number" } as unknown;

      const result = validateWasmOutput(TestSchema, invalidData, "testFn");

      expect(result.data).toEqual(invalidData as { name: string; value: number });
      expect(result.validated).toBe(false);
      expect(result.issues).toBeUndefined();
    });

    it("should skip validation with no NODE_ENV set (defaults to dev)", () => {
      delete process.env.NODE_ENV;
      const validData = { name: "test", value: 42 };

      const result = validateWasmOutput(TestSchema, validData, "testFn");

      expect(result.validated).toBe(true);
    });
  });

  describe("validateCreateDelegationWasmOutput", () => {
    // The raw result shape now carries a `resources` array instead
    // of flat path/actions fields. These tests cover both single-
    // and multi-resource results as well as the three expiry
    // encodings the Rust WASM layer may emit (number seconds, ISO
    // string, or Date after serde conversion).
    const singleResource = [
      {
        service: "kv",
        space: "tinycloud:pkh:eip155:1:0xabc:default",
        path: "/shared/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ];

    it("should validate a correct createDelegation result", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        delegation: "eyJhbGciOiJFUzI1NksifQ...",
        cid: "bafyreih...",
        delegateDID: "did:key:z6Mk...",
        resources: singleResource,
        expiry: 1704067200,
      };

      const result = validateCreateDelegationWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
      expect(result.data.delegation).toBe(validResult.delegation);
    });

    it("should accept expiry as Date object", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        delegation: "eyJhbGciOiJFUzI1NksifQ...",
        cid: "bafyreih...",
        delegateDID: "did:key:z6Mk...",
        resources: singleResource,
        expiry: new Date("2024-01-01T00:00:00Z"),
      };

      const result = validateCreateDelegationWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
    });

    it("should accept expiry as ISO string", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        delegation: "eyJhbGciOiJFUzI1NksifQ...",
        cid: "bafyreih...",
        delegateDID: "did:key:z6Mk...",
        resources: singleResource,
        expiry: "2024-01-01T00:00:00Z",
      };

      const result = validateCreateDelegationWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
    });

    it("should validate a multi-resource result", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        delegation: "eyJhbGciOiJFUzI1NksifQ...",
        cid: "bafyreih...",
        delegateDID: "did:key:z6Mk...",
        expiry: 1704067200,
        resources: [
          {
            service: "kv",
            space: "tinycloud:pkh:eip155:1:0xabc:default",
            path: "com.listen.app/",
            actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
          },
          {
            service: "sql",
            space: "tinycloud:pkh:eip155:1:0xabc:default",
            path: "com.listen.app/data.sqlite",
            actions: ["tinycloud.sql/read"],
          },
        ],
      };

      const result = validateCreateDelegationWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
      expect(result.data.resources.length).toBe(2);
    });

    it("should report issues for missing required fields", () => {
      process.env.NODE_ENV = "development";
      const invalidResult = {
        delegation: "eyJhbGciOiJFUzI1NksifQ...",
        // missing cid, delegateDID, resources, etc.
      };

      // Suppress console.warn for this test
      const originalWarn = console.warn;
      console.warn = () => {};

      const result = validateCreateDelegationWasmOutput(invalidResult);

      console.warn = originalWarn;

      expect(result.validated).toBe(true);
      expect(result.issues).toBeDefined();
      expect(result.issues!.length).toBeGreaterThan(0);
    });
  });

  describe("validateInvokeWasmOutput", () => {
    it("should validate a correct invoke result", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        headers: {
          Authorization: "Bearer xxx",
          "Content-Type": "application/json",
        },
        body: '{"action":"get","path":"/data"}',
      };

      const result = validateInvokeWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
    });

    it("should report issues for invalid headers type", () => {
      process.env.NODE_ENV = "development";
      const invalidResult = {
        headers: "not an object",
        body: "{}",
      };

      const originalWarn = console.warn;
      console.warn = () => {};

      const result = validateInvokeWasmOutput(invalidResult);

      console.warn = originalWarn;

      expect(result.issues).toBeDefined();
    });
  });

  describe("validatePrepareSessionWasmOutput", () => {
    it("should validate a correct prepareSession result", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        siweMessage: "localhost wants you to sign in...",
        jwk: {
          kty: "EC",
          crv: "secp256k1",
          x: "base64urlX",
          d: "base64urlD",
        },
        verificationMethod: "did:key:z6Mk...#z6Mk...",
      };

      const result = validatePrepareSessionWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("validateCompleteSessionSetupWasmOutput", () => {
    it("should validate a correct session result", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        delegationHeader: {
          Authorization: "Bearer xxx",
        },
        delegationCid: "bafyreih...",
        jwk: {
          kty: "EC",
          crv: "secp256k1",
          x: "base64urlX",
        },
        spaceId: "tinycloud:pkh:eip155:1:0x123...:default",
        verificationMethod: "did:key:z6Mk...#z6Mk...",
      };

      const result = validateCompleteSessionSetupWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("validateSiweToDelegationHeadersWasmOutput", () => {
    it("should validate a correct siweToDelegationHeaders result", () => {
      process.env.NODE_ENV = "development";
      const validResult = {
        Authorization: "Bearer xxx",
      };

      const result = validateSiweToDelegationHeadersWasmOutput(validResult);

      expect(result.validated).toBe(true);
      expect(result.issues).toBeUndefined();
    });

    it("should report issues for missing Authorization", () => {
      process.env.NODE_ENV = "development";
      const invalidResult = {};

      const originalWarn = console.warn;
      console.warn = () => {};

      const result = validateSiweToDelegationHeadersWasmOutput(invalidResult);

      console.warn = originalWarn;

      expect(result.issues).toBeDefined();
    });
  });

  describe("Schema exports", () => {
    it("should export CreateDelegationWasmRawResultSchema", () => {
      expect(CreateDelegationWasmRawResultSchema).toBeDefined();
      expect(CreateDelegationWasmRawResultSchema.safeParse).toBeInstanceOf(Function);
    });

    it("should export InvokeWasmResultSchema", () => {
      expect(InvokeWasmResultSchema).toBeDefined();
      expect(InvokeWasmResultSchema.safeParse).toBeInstanceOf(Function);
    });

    it("should export PrepareSessionWasmResultSchema", () => {
      expect(PrepareSessionWasmResultSchema).toBeDefined();
      expect(PrepareSessionWasmResultSchema.safeParse).toBeInstanceOf(Function);
    });

    it("should export SessionWasmResultSchema", () => {
      expect(SessionWasmResultSchema).toBeDefined();
      expect(SessionWasmResultSchema.safeParse).toBeInstanceOf(Function);
    });

    it("should export SiweToDelegationHeadersWasmResultSchema", () => {
      expect(SiweToDelegationHeadersWasmResultSchema).toBeDefined();
      expect(SiweToDelegationHeadersWasmResultSchema.safeParse).toBeInstanceOf(Function);
    });
  });
});

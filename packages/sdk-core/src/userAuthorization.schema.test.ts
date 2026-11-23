/**
 * Tests for UserAuthorization configuration schemas.
 */

import { describe, it, expect } from "bun:test";
import {
  PartialSiweMessageSchema,
  UserAuthorizationConfigSchema,
  validateUserAuthorizationConfig,
  validatePartialSiweMessage,
} from "./userAuthorization.schema";

describe("PartialSiweMessageSchema", () => {
  it("should accept minimal fields", () => {
    const result = PartialSiweMessageSchema.safeParse({
      address: "0x1234567890123456789012345678901234567890",
    });
    expect(result.success).toBe(true);
  });

  it("should accept all fields", () => {
    const result = PartialSiweMessageSchema.safeParse({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 1,
      uri: "https://example.com",
      version: "1",
      domain: "example.com",
      statement: "Sign in to Example",
      nonce: "abc123",
      issuedAt: "2024-01-01T00:00:00Z",
      expirationTime: "2024-01-02T00:00:00Z",
      notBefore: "2024-01-01T00:00:00Z",
      requestId: "req-123",
      resources: ["https://example.com/resource"],
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid chainId", () => {
    const result = PartialSiweMessageSchema.safeParse({
      chainId: 1,
    });
    expect(result.success).toBe(true);
  });

  it("should reject zero chainId", () => {
    const result = PartialSiweMessageSchema.safeParse({
      chainId: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-integer chainId", () => {
    const result = PartialSiweMessageSchema.safeParse({
      chainId: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("should accept resources array", () => {
    const result = PartialSiweMessageSchema.safeParse({
      resources: ["https://a.com", "https://b.com"],
    });
    expect(result.success).toBe(true);
  });

  it("should reject non-array resources", () => {
    const result = PartialSiweMessageSchema.safeParse({
      resources: "https://example.com",
    });
    expect(result.success).toBe(false);
  });
});

describe("UserAuthorizationConfigSchema", () => {
  // Mock signer object
  const mockSigner = {
    getAddress: async () => "0x1234567890123456789012345678901234567890",
    signMessage: async () => "0xsignature",
    getChainId: async () => 1,
  };

  it("should accept minimal config with signer", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
    });
    expect(result.success).toBe(true);
  });

  it("should reject null signer", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: null,
    });
    expect(result.success).toBe(false);
  });

  it("should reject primitive signer", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: "not an object",
    });
    expect(result.success).toBe(false);
  });

  it("should accept sessionStorage object", () => {
    const mockStorage = {
      saveSession: async () => {},
      loadSession: async () => null,
      clearSession: async () => {},
    };
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      sessionStorage: mockStorage,
    });
    expect(result.success).toBe(true);
  });

  it("should reject non-object sessionStorage", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      sessionStorage: "not an object",
    });
    expect(result.success).toBe(false);
  });

  it("should accept siweConfig object", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      siweConfig: { domain: "example.com" },
    });
    expect(result.success).toBe(true);
  });

  it("should accept extensions array", () => {
    const mockExtension = {
      namespace: "test",
      capabilities: [],
    };
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      extensions: [mockExtension],
    });
    expect(result.success).toBe(true);
  });

  it("should reject non-array extensions", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      extensions: { namespace: "test" },
    });
    expect(result.success).toBe(false);
  });

  it("should reject primitive in extensions array", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      extensions: ["not an object"],
    });
    expect(result.success).toBe(false);
  });

  it("should accept auto-sign strategy", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      signStrategy: { type: "auto-sign" },
    });
    expect(result.success).toBe(true);
  });

  it("should accept auto-reject strategy", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      signStrategy: { type: "auto-reject" },
    });
    expect(result.success).toBe(true);
  });

  it("should accept callback strategy", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      signStrategy: {
        type: "callback",
        handler: async () => ({ approved: true }),
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept event-emitter strategy", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      signStrategy: {
        type: "event-emitter",
        emitter: new EventTarget(),
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept spaceCreationHandler", () => {
    const handler = {
      confirmSpaceCreation: async () => true,
    };
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      spaceCreationHandler: handler,
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid spaceCreationHandler", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      spaceCreationHandler: { notValid: true },
    });
    expect(result.success).toBe(false);
  });

  it("should accept autoCreateSpace boolean", () => {
    expect(
      UserAuthorizationConfigSchema.safeParse({
        signer: mockSigner,
        autoCreateSpace: true,
      }).success
    ).toBe(true);
    expect(
      UserAuthorizationConfigSchema.safeParse({
        signer: mockSigner,
        autoCreateSpace: false,
      }).success
    ).toBe(true);
  });

  it("should reject non-boolean autoCreateSpace", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      autoCreateSpace: "true",
    });
    expect(result.success).toBe(false);
  });

  it("should accept spacePrefix string", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      spacePrefix: "myapp",
    });
    expect(result.success).toBe(true);
  });

  it("should accept tinycloudHosts array", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      tinycloudHosts: ["https://a.com", "https://b.com"],
    });
    expect(result.success).toBe(true);
  });

  it("should reject non-array tinycloudHosts", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      tinycloudHosts: "https://node.tinycloud.xyz",
    });
    expect(result.success).toBe(false);
  });

  it("should accept sessionExpirationMs", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      sessionExpirationMs: 86400000, // 24 hours
    });
    expect(result.success).toBe(true);
  });

  it("should reject negative sessionExpirationMs", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      sessionExpirationMs: -1000,
    });
    expect(result.success).toBe(false);
  });

  it("should reject zero sessionExpirationMs", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      sessionExpirationMs: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should accept full config", () => {
    const result = UserAuthorizationConfigSchema.safeParse({
      signer: mockSigner,
      sessionStorage: { saveSession: async () => {} },
      siweConfig: { domain: "example.com" },
      domain: "example.com",
      extensions: [{ namespace: "storage" }],
      signStrategy: { type: "auto-sign" },
      spaceCreationHandler: { confirmSpaceCreation: async () => true },
      autoCreateSpace: true,
      spacePrefix: "default",
      tinycloudHosts: ["https://node.tinycloud.xyz"],
      sessionExpirationMs: 86400000,
    });
    expect(result.success).toBe(true);
  });
});

describe("validateUserAuthorizationConfig", () => {
  const mockSigner = {
    getAddress: async () => "0x1234567890123456789012345678901234567890",
  };

  it("should return ok result for valid config", () => {
    const result = validateUserAuthorizationConfig({
      signer: mockSigner,
      domain: "example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.domain).toBe("example.com");
    }
  });

  it("should return error result for missing signer", () => {
    const result = validateUserAuthorizationConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("authorization");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });

  it("should return error result for invalid sign strategy", () => {
    const result = validateUserAuthorizationConfig({
      signer: mockSigner,
      signStrategy: { type: "invalid" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("validatePartialSiweMessage", () => {
  it("should return ok result for valid message", () => {
    const result = validatePartialSiweMessage({
      address: "0x1234567890123456789012345678901234567890",
      chainId: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.address).toBe(
        "0x1234567890123456789012345678901234567890"
      );
      expect(result.data.chainId).toBe(1);
    }
  });

  it("should return ok result for empty message", () => {
    const result = validatePartialSiweMessage({});
    expect(result.ok).toBe(true);
  });

  it("should return error result for invalid chainId", () => {
    const result = validatePartialSiweMessage({
      chainId: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("authorization");
    }
  });
});

/**
 * Tests for storage.schema.ts Zod schemas.
 */

import { describe, expect, it } from "bun:test";
import {
  PersistedSessionDataSchema,
  PersistedTinyCloudSessionSchema,
  TinyCloudSessionSchema,
  EnsDataSchema,
  validatePersistedSessionData,
  validateTinyCloudSession,
  validatePersistedTinyCloudSession,
} from "./storage.schema";

// =============================================================================
// Test Fixtures
// =============================================================================

const validAddress = "0x1234567890123456789012345678901234567890";
const validTimestamp = "2026-02-01T12:00:00.000Z";

const validPersistedTinyCloudSession = {
  delegationHeader: { Authorization: "Bearer token123" },
  delegationCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  spaceId: "space123",
  verificationMethod: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
};

const validPersistedSessionData = {
  address: validAddress,
  chainId: 1,
  sessionKey: '{"kty":"EC","crv":"P-256"}',
  siwe: "example.com wants you to sign in...",
  signature: "0xabcdef1234567890",
  tinycloudSession: validPersistedTinyCloudSession,
  expiresAt: validTimestamp,
  createdAt: validTimestamp,
  version: "1.0.0",
  ens: {
    domain: "example.eth",
    avatarUrl: "https://example.com/avatar.png",
  },
};

const validTinyCloudSession = {
  address: validAddress,
  chainId: 1,
  sessionKey: "session-key-id",
  spaceId: "space123",
  delegationCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  delegationHeader: { Authorization: "Bearer token123" },
  verificationMethod: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  jwk: { kty: "EC", crv: "P-256" },
  siwe: "example.com wants you to sign in...",
  signature: "0xabcdef1234567890",
};

// =============================================================================
// EnsDataSchema Tests
// =============================================================================

describe("EnsDataSchema", () => {
  it("accepts valid ENS data with all fields", () => {
    const result = EnsDataSchema.safeParse({
      domain: "example.eth",
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(result.success).toBe(true);
  });

  it("accepts ENS data with null values", () => {
    const result = EnsDataSchema.safeParse({
      domain: null,
      avatarUrl: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = EnsDataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts ENS data with only domain", () => {
    const result = EnsDataSchema.safeParse({
      domain: "vitalik.eth",
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// PersistedTinyCloudSessionSchema Tests
// =============================================================================

describe("PersistedTinyCloudSessionSchema", () => {
  it("accepts valid persisted TinyCloud session", () => {
    const result = PersistedTinyCloudSessionSchema.safeParse(
      validPersistedTinyCloudSession
    );
    expect(result.success).toBe(true);
  });

  it("rejects missing delegationHeader", () => {
    const data = { ...validPersistedTinyCloudSession };
    delete (data as Record<string, unknown>).delegationHeader;
    const result = PersistedTinyCloudSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects missing spaceId", () => {
    const data = { ...validPersistedTinyCloudSession };
    delete (data as Record<string, unknown>).spaceId;
    const result = PersistedTinyCloudSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects invalid delegationHeader structure", () => {
    const data = {
      ...validPersistedTinyCloudSession,
      delegationHeader: { InvalidKey: "value" },
    };
    const result = PersistedTinyCloudSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// PersistedSessionDataSchema Tests
// =============================================================================

describe("PersistedSessionDataSchema", () => {
  it("accepts valid persisted session data", () => {
    const result = PersistedSessionDataSchema.safeParse(validPersistedSessionData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.address).toBe(validAddress);
      expect(result.data.chainId).toBe(1);
    }
  });

  it("accepts session data without optional tinycloudSession", () => {
    const data = { ...validPersistedSessionData };
    delete (data as Record<string, unknown>).tinycloudSession;
    const result = PersistedSessionDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts session data without optional ens", () => {
    const data = { ...validPersistedSessionData };
    delete (data as Record<string, unknown>).ens;
    const result = PersistedSessionDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  describe("tinycloudHosts (host rehydration)", () => {
    it("round-trips tinycloudHosts through parse", () => {
      const hosts = ["https://node.example.test", "https://backup.example.test"];
      const data = { ...validPersistedSessionData, tinycloudHosts: hosts };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tinycloudHosts).toEqual(hosts);
      }
    });

    it("validates without tinycloudHosts (back-compat with old sessions)", () => {
      const data = { ...validPersistedSessionData };
      delete (data as Record<string, unknown>).tinycloudHosts;
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tinycloudHosts).toBeUndefined();
      }
    });

    it("rejects non-string entries in tinycloudHosts", () => {
      const data = {
        ...validPersistedSessionData,
        tinycloudHosts: ["https://ok.test", 42],
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe("address validation", () => {
    it("rejects address without 0x prefix", () => {
      const data = {
        ...validPersistedSessionData,
        address: "1234567890123456789012345678901234567890",
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid Ethereum address");
      }
    });

    it("rejects address with wrong length", () => {
      const data = {
        ...validPersistedSessionData,
        address: "0x123456789",
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects address with invalid characters", () => {
      const data = {
        ...validPersistedSessionData,
        address: "0xGGGG567890123456789012345678901234567890",
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("accepts lowercase address", () => {
      const data = {
        ...validPersistedSessionData,
        address: "0xabcdef7890123456789012345678901234567890",
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("accepts checksummed address", () => {
      const data = {
        ...validPersistedSessionData,
        address: "0xAbCdEf7890123456789012345678901234567890",
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("chainId validation", () => {
    it("rejects negative chainId", () => {
      const data = {
        ...validPersistedSessionData,
        chainId: -1,
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects zero chainId", () => {
      const data = {
        ...validPersistedSessionData,
        chainId: 0,
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects floating point chainId", () => {
      const data = {
        ...validPersistedSessionData,
        chainId: 1.5,
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("accepts common chain IDs", () => {
      const chainIds = [1, 5, 10, 137, 42161, 8453];
      for (const chainId of chainIds) {
        const data = { ...validPersistedSessionData, chainId };
        const result = PersistedSessionDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      }
    });
  });

  describe("timestamp validation", () => {
    it("rejects invalid expiresAt timestamp", () => {
      const data = {
        ...validPersistedSessionData,
        expiresAt: "not-a-date",
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects invalid createdAt timestamp", () => {
      const data = {
        ...validPersistedSessionData,
        createdAt: "2026/02/01",
      };
      const result = PersistedSessionDataSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("accepts various ISO 8601 formats", () => {
      const timestamps = [
        "2026-02-01T00:00:00Z",
        "2026-02-01T12:30:45.123Z",
        "2026-02-01T12:30:45+00:00",
        "2026-02-01T12:30:45-05:00",
      ];
      for (const timestamp of timestamps) {
        const data = {
          ...validPersistedSessionData,
          expiresAt: timestamp,
          createdAt: timestamp,
        };
        const result = PersistedSessionDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      }
    });
  });

  it("rejects empty object", () => {
    const result = PersistedSessionDataSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = PersistedSessionDataSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined", () => {
    const result = PersistedSessionDataSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// TinyCloudSessionSchema Tests
// =============================================================================

describe("TinyCloudSessionSchema", () => {
  it("accepts valid TinyCloud session", () => {
    const result = TinyCloudSessionSchema.safeParse(validTinyCloudSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.spaceId).toBe("space123");
    }
  });

  it("rejects missing spaceId", () => {
    const data = { ...validTinyCloudSession };
    delete (data as Record<string, unknown>).spaceId;
    const result = TinyCloudSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects missing jwk", () => {
    const data = { ...validTinyCloudSession };
    delete (data as Record<string, unknown>).jwk;
    const result = TinyCloudSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("accepts jwk with various structures", () => {
    const jwks = [
      { kty: "EC", crv: "P-256" },
      { kty: "OKP", crv: "Ed25519", x: "abc" },
      { kty: "RSA", n: "...", e: "AQAB" },
    ];
    for (const jwk of jwks) {
      const data = { ...validTinyCloudSession, jwk };
      const result = TinyCloudSessionSchema.safeParse(data);
      expect(result.success).toBe(true);
    }
  });
});

// =============================================================================
// Validation Function Tests
// =============================================================================

describe("validatePersistedSessionData", () => {
  it("returns ok result for valid data", () => {
    const result = validatePersistedSessionData(validPersistedSessionData);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.address).toBe(validAddress);
    }
  });

  it("returns error result for invalid data", () => {
    const result = validatePersistedSessionData({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("session");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });

  it("returns error with validation issues for invalid address", () => {
    const result = validatePersistedSessionData({
      ...validPersistedSessionData,
      address: "invalid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["address"] })
      );
    }
  });
});

describe("validateTinyCloudSession", () => {
  it("returns ok result for valid data", () => {
    const result = validateTinyCloudSession(validTinyCloudSession);
    expect(result.ok).toBe(true);
  });

  it("returns error result for invalid data", () => {
    const result = validateTinyCloudSession({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("validatePersistedTinyCloudSession", () => {
  it("returns ok result for valid data", () => {
    const result = validatePersistedTinyCloudSession(validPersistedTinyCloudSession);
    expect(result.ok).toBe(true);
  });

  it("returns error result for invalid data", () => {
    const result = validatePersistedTinyCloudSession({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

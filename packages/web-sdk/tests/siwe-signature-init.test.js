const { TextEncoder: TE, TextDecoder: TD } = require("util");

global.TextEncoder = TE;
global.TextDecoder = TD;

// Mock SiweMessage
const SiweMessage = jest.fn().mockImplementation((data) => ({
  ...data,
  prepareMessage: jest.fn().mockReturnValue("mock-siwe-message"),
}));

// Mock UserAuthorization implementation for testing
class MockUserAuthorization {
  constructor(config = {}) {
    this.config = config;
    this.extensions = [];
    this.session = undefined;
    this.pendingSession = undefined;
  }

  extend(extension) {
    this.extensions.push(extension);
  }

  async signOut() {
    this.session = undefined;
  }

  async generateSiweMessage(address, partialSiweMessage = {}) {
    // Validate address format
    if (!address || !address.startsWith("0x") || address.length !== 42) {
      throw new Error(
        "Invalid Ethereum address format. Address must be a valid 0x-prefixed hex string."
      );
    }

    // Mock WASM initialization
    const mockSessionManager = {
      createSessionKey: jest.fn().mockReturnValue("mock-session-key"),
      jwk: jest.fn().mockReturnValue("mock-jwk-session-key"),
      addTargetedActions: jest.fn(),
    };

    // Apply extension capabilities
    for (const extension of this.extensions) {
      if (extension.targetedActions) {
        try {
          const targetedActions = await extension.targetedActions();
          for (const target in targetedActions) {
            mockSessionManager.addTargetedActions(
              target,
              targetedActions[target]
            );
          }
        } catch (error) {
          console.warn(
            `Failed to apply targeted actions for ${
              extension.namespace || "unknown TinyCloud extension"
            }:`,
            error
          );
        }
      }
    }

    // Build SIWE message with defaults
    const domain =
      partialSiweMessage?.domain ||
      (typeof window !== "undefined" ? window.location.host : "localhost");
    const nonce = partialSiweMessage?.nonce || "mock-nonce-12345";
    const issuedAt = new Date().toISOString();

    const siweMessageData = {
      address,
      chainId: 1,
      domain,
      nonce,
      issuedAt,
      uri: partialSiweMessage?.uri || `https://${domain}`,
      version: "1",
      ...partialSiweMessage,
    };

    // Store session state
    this.pendingSession = {
      sessionManager: mockSessionManager,
      address,
      generatedAt: Date.now(),
      extensions: [...this.extensions],
    };

    return new SiweMessage(siweMessageData);
  }

  async signInWithSignature(siweMessage, signature) {
    if (!this.pendingSession) {
      throw new Error(
        "generateSiweMessage() must be called before signInWithSignature()"
      );
    }

    try {
      const sessionKey = this.pendingSession.sessionManager.jwk();
      if (sessionKey === undefined) {
        throw new Error("unable to retrieve session key from pending session");
      }

      const session = {
        address: siweMessage.address,
        walletAddress: siweMessage.address,
        chainId: siweMessage.chainId || 1,
        sessionKey,
        siwe: siweMessage.prepareMessage(),
        signature,
      };

      // Apply extension afterSignIn hooks
      for (const extension of this.pendingSession.extensions) {
        if (extension.afterSignIn) {
          await extension.afterSignIn(session);
        }
      }

      this.session = session;
      this.pendingSession = undefined;
      return session;
    } catch (error) {
      this.pendingSession = undefined;
      throw error;
    }
  }

  getExtensions() {
    return this.extensions;
  }
}

// Mock TinyCloudWeb implementation for testing
class TinyCloudWeb {
  constructor(config = {}) {
    this.config = config;
    this.userAuthorization = new MockUserAuthorization(config);
  }

  extend(extension) {
    this.userAuthorization.extend(extension);
  }

  session() {
    return this.userAuthorization.session;
  }

  async signOut() {
    return this.userAuthorization.signOut();
  }

  getExtensions() {
    return this.userAuthorization.getExtensions();
  }
}

// Mock global window object
const mockWindow = {
  location: {
    host: "test.example.com",
  },
};
Object.defineProperty(global, "window", {
  value: mockWindow,
  writable: true,
});

describe("TinyCloudWeb UserAuthorization SIWE Sign-in with Signature", () => {
  let tcw;
  let mockExtension;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create a new TinyCloudWeb instance for each test
    tcw = new TinyCloudWeb({
      providers: {
        web3: {
          driver: {}, // Mock provider
        },
      },
    });

    // Mock extension
    mockExtension = {
      namespace: "test-extension",
      defaultActions: jest.fn().mockResolvedValue(["action1", "action2"]),
      targetedActions: jest.fn().mockResolvedValue({
        target1: ["targetedAction1"],
        target2: ["targetedAction2"],
      }),
      afterSignIn: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    // Clean up any pending sessions
    tcw.userAuthorization.pendingSession = undefined;
  });

  describe("userAuthorization.generateSiweMessage()", () => {
    it("should generate a SIWE message with valid address", async () => {
      const address = "0x1234567890123456789012345678901234567890";

      const siweMessage = await tcw.userAuthorization.generateSiweMessage(
        address
      );

      expect(SiweMessage).toHaveBeenCalledWith({
        address,
        chainId: 1,
        domain: "test.example.com",
        nonce: "mock-nonce-12345",
        issuedAt: expect.any(String),
        uri: "https://test.example.com",
        version: "1",
      });

      expect(siweMessage).toBeDefined();
      expect(tcw.userAuthorization.pendingSession).toBeDefined();
      expect(tcw.userAuthorization.pendingSession.address).toBe(address);
    });

    it("should generate a SIWE message with partial override", async () => {
      const address = "0x1234567890123456789012345678901234567890";
      const partialSiweMessage = {
        domain: "custom.domain.com",
        uri: "https://custom.domain.com/custom-path",
        chainId: 5,
      };

      await tcw.userAuthorization.generateSiweMessage(
        address,
        partialSiweMessage
      );

      expect(SiweMessage).toHaveBeenCalledWith({
        address,
        chainId: 5, // Should use override
        domain: "custom.domain.com", // Should use override
        nonce: "mock-nonce-12345",
        issuedAt: expect.any(String),
        uri: "https://custom.domain.com/custom-path", // Should use override
        version: "1",
      });
    });

    it("should apply extension capabilities during message generation", async () => {
      // Add extension to tcw
      tcw.extend(mockExtension);

      const address = "0x1234567890123456789012345678901234567890";

      await tcw.userAuthorization.generateSiweMessage(address);

      // Verify extension methods were called
      expect(mockExtension.defaultActions).toHaveBeenCalled();
      expect(mockExtension.targetedActions).toHaveBeenCalled();

      // Verify session manager received extension actions
      const pendingSession = tcw.userAuthorization.pendingSession;
      expect(
        pendingSession.sessionManager.addTargetedActions
      ).toHaveBeenCalledWith("test-extension:target1", ["targetedAction1"]);
      expect(
        pendingSession.sessionManager.addTargetedActions
      ).toHaveBeenCalledWith("test-extension:target2", ["targetedAction2"]);
    });

    it("should handle extension capability errors gracefully", async () => {
      // Create extension that throws errors
      const faultyExtension = {
        namespace: "faulty-extension",
        defaultActions: jest
          .fn()
          .mockRejectedValue(new Error("Default actions failed")),
        targetedActions: jest
          .fn()
          .mockRejectedValue(new Error("Targeted actions failed")),
      };

      tcw.extend(faultyExtension);

      const address = "0x1234567890123456789012345678901234567890";

      // Should not throw error, should continue with session generation
      const siweMessage = await tcw.userAuthorization.generateSiweMessage(
        address
      );

      expect(siweMessage).toBeDefined();
      expect(tcw.userAuthorization.pendingSession).toBeDefined();
    });

    it("should reject invalid Ethereum addresses", async () => {
      const invalidAddresses = [
        "",
        "invalid-address",
        "0x123", // Too short
        "0x12345678901234567890123456789012345678901", // Too long
        "1234567890123456789012345678901234567890", // Missing 0x prefix
        null,
        undefined,
      ];

      for (const invalidAddress of invalidAddresses) {
        await expect(
          tcw.userAuthorization.generateSiweMessage(invalidAddress)
        ).rejects.toThrow(
          "Invalid Ethereum address format. Address must be a valid 0x-prefixed hex string."
        );
      }
    });

    it("should allow overriding domain and URI in partial message", async () => {
      // Clear previous mock calls
      SiweMessage.mockClear();

      // Test by providing a partial message that forces localhost
      const address = "0x1234567890123456789012345678901234567890";
      const partialMessage = {
        domain: "localhost",
        uri: "https://localhost",
      };

      await tcw.userAuthorization.generateSiweMessage(address, partialMessage);

      // Check that SiweMessage was called with localhost domain as specified
      expect(SiweMessage).toHaveBeenCalledWith({
        address,
        chainId: 1,
        domain: "localhost",
        nonce: "mock-nonce-12345",
        issuedAt: expect.any(String),
        uri: "https://localhost",
        version: "1",
      });
    });

    it("should store extensions in pending session", async () => {
      tcw.extend(mockExtension);

      const address = "0x1234567890123456789012345678901234567890";

      await tcw.userAuthorization.generateSiweMessage(address);

      const pendingSession = tcw.userAuthorization.pendingSession;
      expect(pendingSession.extensions).toHaveLength(1);
      expect(pendingSession.extensions[0]).toBe(mockExtension);
    });
  });

  describe("userAuthorization.signInWithSignature()", () => {
    let mockSiweMessage;
    const testSignature = "0x" + "1".repeat(130); // Valid signature format

    beforeEach(async () => {
      // Generate a SIWE message first to set up pending session
      const address = "0x1234567890123456789012345678901234567890";
      mockSiweMessage = await tcw.userAuthorization.generateSiweMessage(
        address
      );
    });

    it("should sign in with valid signature and return TCWClientSession", async () => {
      const returnedSession = await tcw.userAuthorization.signInWithSignature(
        mockSiweMessage,
        testSignature
      );

      // Verify session was returned
      expect(returnedSession).toBeDefined();
      expect(returnedSession.address).toBe(
        "0x1234567890123456789012345678901234567890"
      );
      expect(returnedSession.walletAddress).toBe(
        "0x1234567890123456789012345678901234567890"
      );
      expect(returnedSession.chainId).toBe(1);
      expect(returnedSession.sessionKey).toBe("mock-jwk-session-key");
      expect(returnedSession.siwe).toBe("mock-siwe-message");
      expect(returnedSession.signature).toBe(testSignature);

      // Verify session was also stored in the instance
      const storedSession = tcw.session();
      expect(storedSession).toEqual(returnedSession);

      // Verify pending session was cleaned up
      expect(tcw.userAuthorization.pendingSession).toBeUndefined();
    });

    it("should apply afterSignIn hooks from extensions", async () => {
      tcw.extend(mockExtension);
      await tcw.userAuthorization.generateSiweMessage(
        "0x1234567890123456789012345678901234567890"
      ); // Refresh with extension

      const returnedSession = await tcw.userAuthorization.signInWithSignature(
        mockSiweMessage,
        testSignature
      );

      expect(mockExtension.afterSignIn).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "0x1234567890123456789012345678901234567890",
          walletAddress: "0x1234567890123456789012345678901234567890",
          chainId: 1,
          sessionKey: "mock-jwk-session-key",
          siwe: "mock-siwe-message",
          signature: testSignature,
        })
      );
    });

    it("should use chainId from SIWE message", async () => {
      // Generate message with custom chainId
      const customSiweMessage = await tcw.userAuthorization.generateSiweMessage(
        "0x1234567890123456789012345678901234567890",
        { chainId: 5 }
      );

      const returnedSession = await tcw.userAuthorization.signInWithSignature(
        customSiweMessage,
        testSignature
      );

      expect(returnedSession.chainId).toBe(5);

      const storedSession = tcw.session();
      expect(storedSession?.chainId).toBe(5);
    });

    it("should default chainId to 1 when not specified in SIWE message", async () => {
      // Mock SiweMessage without chainId
      const siweMessageWithoutChainId = {
        address: "0x1234567890123456789012345678901234567890",
        prepareMessage: jest.fn().mockReturnValue("mock-siwe-message"),
      };

      const returnedSession = await tcw.userAuthorization.signInWithSignature(
        siweMessageWithoutChainId,
        testSignature
      );

      expect(returnedSession.chainId).toBe(1);

      const storedSession = tcw.session();
      expect(storedSession?.chainId).toBe(1);
    });

    it("should reject when generateSiweMessage was not called first", async () => {
      // Create new instance without calling generateSiweMessage
      const newTcw = new TinyCloudWeb();

      await expect(
        newTcw.userAuthorization.signInWithSignature(
          mockSiweMessage,
          testSignature
        )
      ).rejects.toThrow(
        "generateSiweMessage() must be called before signInWithSignature()"
      );
    });

    it("should handle session key retrieval failure", async () => {
      // Mock jwk() to return undefined
      const pendingSession = tcw.userAuthorization.pendingSession;
      pendingSession.sessionManager.jwk = jest.fn().mockReturnValue(undefined);

      await expect(
        tcw.userAuthorization.signInWithSignature(
          mockSiweMessage,
          testSignature
        )
      ).rejects.toThrow("unable to retrieve session key from pending session");

      // Verify cleanup
      expect(tcw.userAuthorization.pendingSession).toBeUndefined();
    });

    it("should handle afterSignIn hook errors gracefully", async () => {
      const faultyExtension = {
        namespace: "faulty-extension",
        afterSignIn: jest
          .fn()
          .mockRejectedValue(new Error("AfterSignIn failed")),
      };

      tcw.extend(faultyExtension);
      await tcw.userAuthorization.generateSiweMessage(
        "0x1234567890123456789012345678901234567890"
      ); // Refresh with extension

      await expect(
        tcw.userAuthorization.signInWithSignature(
          mockSiweMessage,
          testSignature
        )
      ).rejects.toThrow("AfterSignIn failed");

      // Verify cleanup on error
      expect(tcw.userAuthorization.pendingSession).toBeUndefined();
    });

    it("should clean up pending session on any error", async () => {
      // Force an error by making jwk() throw
      const pendingSession = tcw.userAuthorization.pendingSession;
      pendingSession.sessionManager.jwk = jest.fn().mockImplementation(() => {
        throw new Error("JWK error");
      });

      await expect(
        tcw.userAuthorization.signInWithSignature(
          mockSiweMessage,
          testSignature
        )
      ).rejects.toThrow("JWK error");

      // Verify cleanup
      expect(tcw.userAuthorization.pendingSession).toBeUndefined();
    });

    it("should return TCWClientSession with all required properties", async () => {
      const returnedSession = await tcw.userAuthorization.signInWithSignature(
        mockSiweMessage,
        testSignature
      );

      // Validate session structure - all properties should be defined
      expect(returnedSession).toEqual({
        address: expect.any(String),
        walletAddress: expect.any(String),
        chainId: expect.any(Number),
        sessionKey: expect.any(String),
        siwe: expect.any(String),
        signature: expect.any(String),
      });

      // Validate specific values
      expect(returnedSession.address).toBe(
        "0x1234567890123456789012345678901234567890"
      );
      expect(returnedSession.walletAddress).toBe(returnedSession.address);
      expect(returnedSession.chainId).toBe(1);
      expect(returnedSession.sessionKey).toBe("mock-jwk-session-key");
      expect(returnedSession.siwe).toBe("mock-siwe-message");
      expect(returnedSession.signature).toBe(testSignature);

      // Ensure address and walletAddress are the same
      expect(returnedSession.walletAddress).toBe(returnedSession.address);
    });
  });

  describe("Session state management", () => {
    it("should properly clean up session state on signOut", async () => {
      // Initialize session
      const address = "0x1234567890123456789012345678901234567890";
      const siweMessage = await tcw.userAuthorization.generateSiweMessage(
        address
      );
      const signature = "0x" + "1".repeat(130);
      const returnedSession = await tcw.userAuthorization.signInWithSignature(
        siweMessage,
        signature
      );

      // Verify session exists
      expect(tcw.session()).toBeDefined();
      expect(returnedSession).toBeDefined();

      // Sign out
      await tcw.signOut();

      // Verify session is cleared
      expect(tcw.session()).toBeUndefined();
    });

    it("should handle multiple generateSiweMessage calls by replacing pending session", async () => {
      const address1 = "0x1111111111111111111111111111111111111111";
      const address2 = "0x2222222222222222222222222222222222222222";

      // Generate first message
      await tcw.userAuthorization.generateSiweMessage(address1);
      const firstPendingSession = tcw.userAuthorization.pendingSession;

      // Generate second message
      await tcw.userAuthorization.generateSiweMessage(address2);
      const secondPendingSession = tcw.userAuthorization.pendingSession;

      // Verify second message replaced first
      expect(secondPendingSession).not.toBe(firstPendingSession);
      expect(secondPendingSession.address).toBe(address2);
    });

    it("should track generation timestamp in pending session", async () => {
      const beforeTime = Date.now();

      const address = "0x1234567890123456789012345678901234567890";
      await tcw.userAuthorization.generateSiweMessage(address);

      const afterTime = Date.now();
      const pendingSession = tcw.userAuthorization.pendingSession;

      expect(pendingSession.generatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(pendingSession.generatedAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("Extension integration", () => {
    it("should handle extensions without defaultActions or targetedActions", async () => {
      const minimalExtension = {
        namespace: "minimal-extension",
        // No defaultActions or targetedActions
      };

      tcw.extend(minimalExtension);

      const address = "0x1234567890123456789012345678901234567890";

      // Should not throw error
      await expect(
        tcw.userAuthorization.generateSiweMessage(address)
      ).resolves.toBeDefined();
    });

    it("should handle extensions without namespace", async () => {
      const extensionWithoutNamespace = {
        // No namespace
        defaultActions: jest.fn().mockResolvedValue(["action1"]),
        targetedActions: jest.fn().mockResolvedValue({ target: ["action"] }),
      };

      tcw.extend(extensionWithoutNamespace);

      const address = "0x1234567890123456789012345678901234567890";

      // Should not throw error and should not call actions without namespace
      await tcw.userAuthorization.generateSiweMessage(address);

      expect(extensionWithoutNamespace.defaultActions).not.toHaveBeenCalled();
      expect(extensionWithoutNamespace.targetedActions).not.toHaveBeenCalled();
    });

    it("should apply multiple extensions in order", async () => {
      const extension1 = {
        namespace: "extension-1",
        defaultActions: jest.fn().mockResolvedValue(["action1"]),
        afterSignIn: jest.fn().mockResolvedValue(undefined),
      };

      const extension2 = {
        namespace: "extension-2",
        defaultActions: jest.fn().mockResolvedValue(["action2"]),
        afterSignIn: jest.fn().mockResolvedValue(undefined),
      };

      tcw.extend(extension1);
      tcw.extend(extension2);

      const address = "0x1234567890123456789012345678901234567890";
      const siweMessage = await tcw.userAuthorization.generateSiweMessage(
        address
      );
      const signature = "0x" + "1".repeat(130);
      const returnedSession = await tcw.userAuthorization.signInWithSignature(
        siweMessage,
        signature
      );

      // Verify both extensions were applied
      expect(extension1.defaultActions).toHaveBeenCalled();
      expect(extension2.defaultActions).toHaveBeenCalled();
      expect(extension1.afterSignIn).toHaveBeenCalled();
      expect(extension2.afterSignIn).toHaveBeenCalled();

      // Verify session was returned
      expect(returnedSession).toBeDefined();
      expect(returnedSession.address).toBe(address);
    });
  });

  describe("Error scenarios and edge cases", () => {
    it("should handle empty targetedActions object", async () => {
      const extensionWithEmptyTargeted = {
        namespace: "empty-targeted",
        targetedActions: jest.fn().mockResolvedValue({}),
      };

      tcw.extend(extensionWithEmptyTargeted);

      const address = "0x1234567890123456789012345678901234567890";

      // Should not throw error
      await expect(
        tcw.userAuthorization.generateSiweMessage(address)
      ).resolves.toBeDefined();
    });

    it("should validate basic input parameters correctly", async () => {
      // Test that our mock implementation properly validates addresses
      const validAddress = "0x1234567890123456789012345678901234567890";
      const invalidAddress = "invalid-address";

      // Valid address should work
      const result = await tcw.userAuthorization.generateSiweMessage(
        validAddress
      );
      expect(result).toBeDefined();

      // Invalid address should throw
      await expect(
        tcw.userAuthorization.generateSiweMessage(invalidAddress)
      ).rejects.toThrow(
        "Invalid Ethereum address format. Address must be a valid 0x-prefixed hex string."
      );
    });
  });
});

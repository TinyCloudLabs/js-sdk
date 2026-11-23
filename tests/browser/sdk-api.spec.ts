/**
 * Standalone SDK API browser tests.
 *
 * Exercises the TinyCloudWeb SDK directly via page.evaluate(),
 * without going through the example app UI.
 *
 * Uses a minimal test page that loads the web-sdk bundle via ESM import.
 * Mock ethereum provider is injected via page.addInitScript().
 */
import { test, expect, Page } from '@playwright/test';

// Hardhat account 0 — well-known test key
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * Mock ethereum wallet script for injection.
 * Loads ethers.js from CDN for real cryptographic signatures.
 * Reuses the same pattern as the example app's mock-wallet.ts.
 */
function getMockWalletScript(): string {
  return `
    (function() {
      const TEST_PRIVATE_KEY = '${TEST_PRIVATE_KEY}';
      const TEST_ADDRESS = '${TEST_ADDRESS}';

      let signingReady = false;
      let signMessageFn = null;
      let ethersLoadPromise = null;

      function loadEthersFromCDN() {
        if (ethersLoadPromise) return ethersLoadPromise;
        ethersLoadPromise = new Promise((resolve, reject) => {
          if (window.ethers && window.ethers.Wallet) {
            resolve();
            return;
          }
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js';
          script.onload = () => resolve();
          script.onerror = (e) => reject(e);
          document.head.appendChild(script);
        });
        return ethersLoadPromise;
      }

      function tryGetEthersSigner() {
        if (window.ethers && window.ethers.Wallet) {
          try {
            const wallet = new window.ethers.Wallet(TEST_PRIVATE_KEY);
            signMessageFn = (msg) => wallet.signMessage(msg);
            signingReady = true;
            return true;
          } catch (e) { /* ignore */ }
        }
        return false;
      }

      window.ethereum = {
        isMetaMask: true,
        selectedAddress: TEST_ADDRESS,
        chainId: '0x1',
        networkVersion: '1',
        _events: {},
        on(event, callback) {
          if (!this._events[event]) this._events[event] = [];
          this._events[event].push(callback);
          return this;
        },
        removeListener(event, callback) {
          if (this._events[event]) {
            this._events[event] = this._events[event].filter(cb => cb !== callback);
          }
          return this;
        },
        removeAllListeners(event) {
          if (event) delete this._events[event];
          else this._events = {};
          return this;
        },
        emit(event, ...args) {
          if (this._events[event]) this._events[event].forEach(cb => cb(...args));
          return true;
        },
        async request({ method, params }) {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [TEST_ADDRESS];
            case 'eth_chainId':
              return '0x1';
            case 'net_version':
              return '1';
            case 'personal_sign': {
              const message = params?.[0];
              if (!message) throw new Error('personal_sign: missing message');
              if (!signingReady) {
                if (!tryGetEthersSigner()) {
                  await loadEthersFromCDN();
                  if (!tryGetEthersSigner()) {
                    throw new Error('Signing not ready');
                  }
                }
              }
              let messageToSign;
              if (typeof message === 'string' && message.startsWith('0x')) {
                const bytes = [];
                for (let i = 2; i < message.length; i += 2) {
                  bytes.push(parseInt(message.substr(i, 2), 16));
                }
                messageToSign = new Uint8Array(bytes);
              } else {
                messageToSign = message;
              }
              return await signMessageFn(messageToSign);
            }
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain':
              return null;
            case 'eth_getBalance':
              return '0x56bc75e2d63100000';
            case 'eth_blockNumber':
              return '0x1';
            case 'eth_getCode':
              return '0x';
            case 'eth_call':
              return '0x';
            case 'eth_estimateGas':
              return '0x5208';
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }];
            default:
              console.log('[MockWallet] Unhandled:', method);
              return null;
          }
        },
        send(method, params) { return this.request({ method, params }); },
        sendAsync(payload, callback) {
          this.request(payload)
            .then(result => callback(null, { result }))
            .catch(error => callback(error));
        },
        isConnected() { return true; }
      };
      window.ethereum.providers = [window.ethereum];
      console.log('[MockWallet] Injected');
    })();
  `;
}

/**
 * Wait for the SDK to finish loading on the test page.
 */
async function waitForSdkLoad(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__SDK_LOADED === true || (window as any).__SDK_ERROR,
    { timeout: 30000 }
  );

  const error = await page.evaluate(() => (window as any).__SDK_ERROR);
  if (error) {
    throw new Error(`SDK failed to load: ${error}`);
  }
}

test.describe('Standalone SDK API Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Inject mock wallet before any page scripts run
    await page.addInitScript(getMockWalletScript());
  });

  test('should load the SDK bundle in browser', async ({ page }) => {
    await page.goto('/test-page.html');
    await waitForSdkLoad(page);

    const loaded = await page.evaluate(() => (window as any).__SDK_LOADED);
    expect(loaded).toBe(true);

    // Check that TinyCloudWeb is available
    const hasTCW = await page.evaluate(() => typeof (window as any).TinyCloudWeb === 'function');
    expect(hasTCW).toBe(true);

    // Check exports include expected classes
    const exports = await page.evaluate(() => (window as any).__SDK_EXPORTS as string[]);
    expect(exports).toContain('TinyCloudWeb');
    expect(exports).toContain('KVService');
  });

  test('should create TinyCloudWeb instance with provider', async ({ page }) => {
    await page.goto('/test-page.html');
    await waitForSdkLoad(page);

    const result = await page.evaluate(async () => {
      const TCW = (window as any).TinyCloudWeb;
      try {
        const tcw = new TCW({
          provider: (window as any).ethereum,
          tinycloudHosts: ['https://node.tinycloud.xyz'],
        });

        return {
          success: true,
          isWalletConnected: tcw.isWalletConnected,
          hasProvider: !!tcw.provider,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    expect(result.success).toBe(true);
    expect(result.isWalletConnected).toBe(true);
    expect(result.hasProvider).toBe(true);
  });
});

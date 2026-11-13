// Browser-compatible replacement for @noble/hashes/crypto
// This provides the crypto functionality that @noble/hashes needs in a browser environment

// Use the browser's built-in crypto; there is no fallback random source
const getWebCrypto = () => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  if (typeof window !== 'undefined' && window.crypto) {
    return window.crypto;
  }
  if (typeof self !== 'undefined' && self.crypto) {
    return self.crypto;
  }
  return undefined;
};

// Create a crypto object that matches what @noble/hashes expects
export const crypto = {
  web: getWebCrypto(),
  node: undefined, // Disable node crypto in browser
  
  // Provide the methods that @noble/hashes might need
  getRandomValues: function(array) {
    const webCrypto = getWebCrypto();
    if (webCrypto && webCrypto.getRandomValues) {
      return webCrypto.getRandomValues(array);
    }
    // Keys and nonces come from here: refuse rather than use a non-cryptographic source. The message stays short
    // because it ships in the root bundle.
    throw new Error("crypto.getRandomValues is unavailable");
  }
};

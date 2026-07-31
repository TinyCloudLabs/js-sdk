import type { EIP1193Provider } from "viem";

/** The provider shapes accepted by browser wallet adapters. */
export type BrowserWalletProvider =
  | EIP1193Provider
  | {
      provider?: EIP1193Provider;
      send(method: string, params?: unknown[]): Promise<unknown>;
    };

/** The EIP-1193 provider used by the browser-facing SDK. */
export type BrowserProvider = EIP1193Provider;

/**
 * Normalizes injected providers and legacy provider wrappers to EIP-1193.
 */
export function toEip1193Provider(
  provider: BrowserWalletProvider,
): EIP1193Provider {
  if ("request" in provider && typeof provider.request === "function") {
    return provider as EIP1193Provider;
  }

  if (
    "provider" in provider &&
    provider.provider &&
    typeof provider.provider.request === "function"
  ) {
    return provider.provider;
  }

  if ("send" in provider && typeof provider.send === "function") {
    return {
      request: ({ method, params }) =>
        provider.send(method, Array.isArray(params) ? params : []),
      on: () => undefined,
      removeListener: () => undefined,
    } as EIP1193Provider;
  }

  throw new Error("The wallet provider does not implement EIP-1193 request");
}

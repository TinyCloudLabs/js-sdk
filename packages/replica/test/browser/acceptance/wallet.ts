import { isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Counts `personal_sign` requests; the page reads it to prove renewal never prompts the wallet. */
export const walletCounter = { requests: 0 };

export function testWallet(walletKey: string) {
  if (!isHex(walletKey)) throw new Error("test wallet key must be hex");
  const account = privateKeyToAccount(walletKey);
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return "0x1";
        case "personal_sign": {
          walletCounter.requests += 1;
          const hexMessage = Array.isArray(params) ? params[0] : undefined;
          if (typeof hexMessage !== "string" || !isHex(hexMessage)) {
            throw new Error("personal_sign: message is not hex");
          }
          return account.signMessage({ message: { raw: hexMessage } });
        }
        default:
          throw new Error(`test wallet: unsupported method ${method}`);
      }
    },
  };
}

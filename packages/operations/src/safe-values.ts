/**
 * Values allowed to cross the operation error and context channels.
 *
 * These are intentionally strict. A mismatch detail is useful only when it
 * identifies the same kind of value the runtime actually compares; treating
 * every string as safe would turn the detail field into an exfiltration path.
 */
export function safeOriginHost(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.origin === "null"
  ) {
    return undefined;
  }

  const originWithOptionalSlash = `${parsed.origin}/`;
  if (value !== parsed.origin && value !== originWithOptionalSlash) {
    return undefined;
  }
  return parsed.origin;
}

export function safeSessionDid(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;

  const [principal, fragment, ...extra] = value.split("#");
  if (
    extra.length > 0 ||
    (fragment !== undefined && !/^[A-Za-z0-9._:-]+$/.test(fragment))
  ) {
    return undefined;
  }

  if (isEd25519DidKey(principal) || isEip155PkhDid(principal)) {
    return principal;
  }
  return undefined;
}

function isEd25519DidKey(value: string): boolean {
  if (!value.startsWith("did:key:z")) return false;
  const bytes = decodeBase58(value.slice("did:key:z".length));
  return (
    bytes !== undefined &&
    bytes.length === 34 &&
    bytes[0] === 0xed &&
    bytes[1] === 0x01
  );
}

function isEip155PkhDid(value: string): boolean {
  return /^did:pkh:eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/.test(value);
}

function decodeBase58(value: string): Uint8Array | undefined {
  if (value.length === 0) return undefined;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) return undefined;
    let carry = index;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! * 58;
      digits[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const character of value) {
    if (character !== "1") break;
    digits.push(0);
  }
  return Uint8Array.from(digits.reverse());
}

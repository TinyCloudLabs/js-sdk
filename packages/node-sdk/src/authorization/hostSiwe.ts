/** Add the bounded host lifetime before any wallet signature. */
export function withHostExpiry(siwe: string, now: Date, hostingYears: number, requestedExpiry?: string): string {
  if (/[\r\u0085\u2028\u2029]/.test(siwe)) {
    throw new Error("Host SIWE contains an unsupported line separator");
  }
  const lines = siwe.split("\n");
  if (lines.some((line) => line.startsWith("Expiration Time:"))) {
    throw new Error("Host SIWE already contains Expiration Time");
  }
  // SIWE has an optional single-line statement, then fixed URI/version/chain/nonce/time fields.
  const uriIndex = lines[3] === "" ? 4 : 5;
  const issuedAtIndex = uriIndex + 4;
  if (!lines[uriIndex]?.startsWith("URI: ") || !lines[issuedAtIndex]?.startsWith("Issued At: ")) {
    throw new Error("Host SIWE has no positional Issued At field");
  }

  const ceiling = new Date(now);
  const day = ceiling.getUTCDate();
  ceiling.setUTCDate(1);
  ceiling.setUTCFullYear(ceiling.getUTCFullYear() + hostingYears);
  const lastDay = new Date(Date.UTC(ceiling.getUTCFullYear(), ceiling.getUTCMonth() + 1, 0)).getUTCDate();
  ceiling.setUTCDate(Math.min(day, lastDay));
  const requested = requestedExpiry === undefined ? ceiling.getTime() : Date.parse(requestedExpiry);
  if (!Number.isFinite(requested) || requested <= now.getTime()) {
    throw new Error("Host expiry must be a valid future timestamp");
  }
  const expiry = new Date(Math.min(requested, ceiling.getTime())).toISOString();
  lines.splice(issuedAtIndex + 1, 0, `Expiration Time: ${expiry}`);
  return lines.join("\n");
}

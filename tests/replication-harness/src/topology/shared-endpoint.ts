import { createHash } from "node:crypto";
import { HarnessError } from "../contracts/common";

/**
 * Compute the shared edge URL before fixture preparation.
 * Retries use new 127/8 IPs, then 127.0.0.1 with deterministic alternate ports for Docker Desktop/macOS hosts that cannot bind secondary loopback addresses.
 */
export function sharedProxyEndpoint(topoId: string, port: number, attempt = 0): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HarnessError("TOPOLOGY_INVALID", `invalid shared proxy port ${port}`);
  const digest = createHash("sha256").update(`${topoId}\0${attempt}`).digest();
  if (attempt < 2) return `http://127.${digest[0] % 254 + 1}.${digest[1] % 254 + 1}.${digest[2] % 254 + 1}:${port}`;
  let fallbackPort = 40_000 + digest.readUInt16BE(3) % 20_000;
  if (fallbackPort === port) fallbackPort = 40_000 + (fallbackPort - 39_999) % 20_000;
  return `http://127.0.0.1:${fallbackPort}`;
}

export function sharedProxyEndpointDetails(value: string): { endpoint: string; host: string; port: number } | undefined {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HarnessError("TOPOLOGY_INVALID", `invalid endpoint override: ${value}`); }
  if (url.protocol !== "http:" || !/^127(?:\.\d{1,3}){3}$/.test(url.hostname) || !url.port) return undefined;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
  const octets = url.hostname.split(".").map(Number);
  const port = Number(url.port);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HarnessError("TOPOLOGY_INVALID", `invalid shared proxy endpoint: ${value}`);
  }
  return { endpoint: url.origin, host: url.hostname, port };
}

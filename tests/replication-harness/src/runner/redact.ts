import { Buffer } from "node:buffer";

const REDACTED = "[REDACTED]";

function encodedForms(value: string): string[] {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const url = encoded.replaceAll("+", "-").replaceAll("/", "_");
  return [value, JSON.stringify(value).slice(1, -1), encoded, url, url.replace(/=+$/, "")];
}
function hexForms(value: Uint8Array): string[] {
  const hex = Buffer.from(value).toString("hex");
  return hex ? [hex, hex.toUpperCase()] : [];
}
function secretForms(secret: string): { text: string[]; bytes: Uint8Array[]; multiline: string[] } {
  const text = new Set<string>();
  for (const source of [secret, JSON.stringify(secret).slice(1, -1)]) {
    for (const form of encodedForms(source)) text.add(form);
  }
  const bytes = [...text].map((form) => new TextEncoder().encode(form));
  const base64 = secret.replaceAll("-", "+").replaceAll("_", "/");
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(base64) && base64.length % 4 !== 1) {
    const decoded = Buffer.from(secret, "base64url");
    if (decoded.length && decoded.toString("base64url") === secret.replace(/=+$/, "")) bytes.push(new Uint8Array(decoded));
  }
  const multiline = new Set([secret]);
  for (const hex of [...text].flatMap((value) => hexForms(new TextEncoder().encode(value)))) {
    text.add(hex);
    multiline.add(hex);
  }
  for (const value of bytes) {
    for (const hex of hexForms(value)) {
      text.add(hex);
      multiline.add(hex);
    }
  }
  const unique = new Map(bytes.map((value) => [Buffer.from(value).toString("hex"), value]));
  return { text: [...text].filter((form) => form.length > 0).sort((a, b) => b.length - a.length),
    bytes: [...unique.values()].sort((a, b) => b.length - a.length), multiline: [...multiline].filter(Boolean) };
}
function allForms(secrets: readonly string[]): { text: string[]; bytes: Uint8Array[]; multiline: string[] } {
  const text = new Set<string>();
  const bytes = new Map<string, Uint8Array>();
  const multiline = new Set<string>();
  for (const secret of new Set(secrets)) {
    if (!secret) continue;
    const forms = secretForms(secret);
    for (const form of forms.text) text.add(form);
    for (const form of forms.bytes) bytes.set(Buffer.from(form).toString("hex"), form);
    for (const form of forms.multiline) multiline.add(form);
  }
  return { text: [...text].sort((a, b) => b.length - a.length), bytes: [...bytes.values()].sort((a, b) => b.length - a.length),
    multiline: [...multiline].sort((a, b) => b.length - a.length) };
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function redactText(input: string, secrets: readonly string[]): string {
  const forms = allForms(secrets);
  let result = input;
  for (const form of forms.text) result = result.split(form).join(REDACTED);
  if (result.includes("\n") || result.includes("\r")) for (const form of forms.multiline) {
    const pattern = form.split("").map(escapeRegExp).join("(?:\\r?\\n)*");
    result = result.replace(new RegExp(pattern, "g"), REDACTED);
  }
  return result;
}
function replaceBytes(input: Uint8Array, patterns: readonly Uint8Array[]): Uint8Array {
  let output = input;
  const replacement = new TextEncoder().encode(REDACTED);
  for (const needle of patterns) {
    const chunks: Uint8Array[] = [];
    let start = 0;
    for (let index = 0; index <= output.length - needle.length; index++) {
      let matches = true;
      for (let offset = 0; offset < needle.length; offset++) if (output[index + offset] !== needle[offset]) { matches = false; break; }
      if (!matches) continue;
      chunks.push(output.slice(start, index), replacement);
      start = index + needle.length;
      index = start - 1;
    }
    if (chunks.length) {
      chunks.push(output.slice(start));
      const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
      output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    }
  }
  return output;
}
export function redactBytes(input: Uint8Array, secrets: readonly string[]): Uint8Array {
  return replaceBytes(input, allForms(secrets).bytes);
}
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactText(value, secrets) as T;
  if (value instanceof Uint8Array) return redactBytes(value, secrets) as T;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) {
      return [...redactBytes(Uint8Array.from(value), secrets)] as T;
    }
    return value.map((item) => redactValue(item, secrets)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets), redactValue(item, secrets)])) as T;
  }
  return value;
}

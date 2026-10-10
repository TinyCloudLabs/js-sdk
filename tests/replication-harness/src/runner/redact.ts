import { Buffer } from "node:buffer";

const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 16;

type RedactionForms = { text: string[]; bytes: Uint8Array[]; multiline: string[] };
type FormCache = {
  seen: Set<string>;
  text: Set<string>;
  bytes: Map<string, Uint8Array>;
  multiline: Set<string>;
  compiled: RedactionForms;
};
const formCache = new WeakMap<readonly string[], FormCache>();

function encodedForms(value: string): string[] {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const url = encoded.replaceAll("+", "-").replaceAll("/", "_");
  return [value, JSON.stringify(value).slice(1, -1), encoded, url, url.replace(/=+$/, "")];
}
function hexForms(value: Uint8Array): string[] {
  const hex = Buffer.from(value).toString("hex");
  return hex ? [hex, hex.toUpperCase()] : [];
}
function secretForms(secret: string): RedactionForms {
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
  return { text: [...text].filter(Boolean), bytes: [...unique.values()], multiline: [...multiline].filter(Boolean) };
}

function allForms(secrets: readonly string[]): RedactionForms {
  let cached = formCache.get(secrets);
  if (!cached) {
    cached = { seen: new Set(), text: new Set(), bytes: new Map(), multiline: new Set(), compiled: { text: [], bytes: [], multiline: [] } };
    formCache.set(secrets, cached);
  }
  let changed = false;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH || cached.seen.has(secret)) continue;
    cached.seen.add(secret);
    const forms = secretForms(secret);
    for (const form of forms.text) cached.text.add(form);
    for (const value of forms.bytes) cached.bytes.set(Buffer.from(value).toString("hex"), value);
    for (const form of forms.multiline) cached.multiline.add(form);
    changed = true;
  }
  if (changed) {
    cached.compiled = {
      text: [...cached.text].sort((a, b) => b.length - a.length),
      bytes: [...cached.bytes.values()].sort((a, b) => b.length - a.length),
      multiline: [...cached.multiline].sort((a, b) => b.length - a.length),
    };
  }
  return cached.compiled;
}

function stripLineBreaks(input: string): { text: string; originalIndices: number[] } {
  const characters: string[] = [];
  const originalIndices: number[] = [];
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character === "\r" || character === "\n") continue;
    characters.push(character);
    originalIndices.push(index);
  }
  return { text: characters.join(""), originalIndices };
}

function redactMultiline(input: string, patterns: readonly string[]): string {
  const strippedInput = stripLineBreaks(input);
  if (strippedInput.text.length === input.length || strippedInput.text.length === 0) return input;
  const spans: { start: number; end: number }[] = [];
  for (const pattern of patterns) {
    const needle = stripLineBreaks(pattern).text;
    if (!needle) continue;
    let offset = 0;
    while (offset <= strippedInput.text.length - needle.length) {
      const index = strippedInput.text.indexOf(needle, offset);
      if (index < 0) break;
      spans.push({ start: strippedInput.originalIndices[index]!, end: strippedInput.originalIndices[index + needle.length - 1]! + 1 });
      offset = index + needle.length;
    }
  }
  if (!spans.length) return input;
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  let output = "";
  let offset = 0;
  for (const span of merged) {
    output += input.slice(offset, span.start) + REDACTED;
    offset = span.end;
  }
  return output + input.slice(offset);
}

export function redactText(input: string, secrets: readonly string[]): string {
  const forms = allForms(secrets);
  let result = input;
  for (const form of forms.text) result = result.split(form).join(REDACTED);
  if (result.includes("\n") || result.includes("\r")) result = redactMultiline(result, forms.multiline);
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

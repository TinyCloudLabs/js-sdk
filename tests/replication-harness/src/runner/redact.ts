const REDACTED = "[REDACTED]";
export function redactText(input: string, secrets: readonly string[]): string {
  let result = input;
  for (const secret of [...new Set(secrets)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets), redactValue(item, secrets)])) as T;
  }
  return value;
}
export function redactBytes(input: Uint8Array, secrets: readonly string[]): Uint8Array {
  let output = input;
  const replacement = new TextEncoder().encode(REDACTED);
  for (const secret of [...new Set(secrets)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    const needle = new TextEncoder().encode(secret);
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

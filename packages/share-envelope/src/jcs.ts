/**
 * RFC 8785 (JCS) canonical JSON serialization — in-house implementation.
 *
 * Why no dependency: on any ECMA-262 engine, `JSON.stringify` of a primitive
 * already matches JCS exactly — RFC 8785 §3.2.2.3 defines number
 * serialization as ECMAScript's Number::toString, and §3.2.2.2 defines string
 * escaping as ECMAScript's JSON quoting (short escapes \b \t \n \f \r \" \\,
 * lowercase \u00xx for remaining control chars). So canonicalization reduces
 * to recursive property sorting by UTF-16 code units (the default JS string
 * comparison) plus rejecting values JSON cannot represent.
 */

function isPlainRecord(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * RFC 8785 §3.2.2.2 requires REJECTING strings that are not valid Unicode —
 * i.e. unpaired UTF-16 surrogates. `JSON.stringify` happily emits `"\ud800"`
 * for a lone surrogate, but a conforming implementation in a language with
 * enforced-valid strings (Rust) errors instead, so we must too.
 */
function assertNoLoneSurrogates(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(
        `cannot canonicalize string with unpaired low surrogate at index ${i}`,
      );
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // NaN when past the end
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(
          `cannot canonicalize string with unpaired high surrogate at index ${i}`,
        );
      }
      i++; // well-formed pair — skip the low surrogate
    }
  }
}

function serializeString(text: string): string {
  assertNoLoneSurrogates(text);
  return JSON.stringify(text);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw new TypeError("cannot canonicalize non-plain object");
  }
  const keys = Object.keys(value).sort(); // UTF-16 code unit order (RFC 8785 §3.2.3)
  const members: string[] = [];
  for (const key of keys) {
    const member = value[key];
    if (member === undefined) continue; // JSON.stringify drops undefined properties
    members.push(`${serializeString(key)}:${serialize(member)}`);
  }
  return `{${members.join(",")}}`;
}

/** Serialize a JSON-representable value to its RFC 8785 canonical form. */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

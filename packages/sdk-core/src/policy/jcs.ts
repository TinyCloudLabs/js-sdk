import { SignedObjectCanonicalizationError } from "./errors";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

type MutableJsonObject = { [key: string]: JsonValue };
const objectHasOwn: (object: object, propertyKey: PropertyKey) => boolean =
  (Object as ObjectConstructor & {
    hasOwn?: (object: object, propertyKey: PropertyKey) => boolean;
  }).hasOwn ??
  (Object.prototype.hasOwnProperty.call.bind(
    Object.prototype.hasOwnProperty,
  ) as (object: object, propertyKey: PropertyKey) => boolean);

/**
 * RFC 8785 JSON Canonicalization Scheme encoder for the signed-object profile.
 *
 * This local encoder is intentionally stricter than JSON.stringify:
 * it rejects non-plain JSON inputs, sparse arrays, undefined/functions/symbols,
 * non-finite numbers, BigInt, dangerous prototype keys, and lone surrogates.
 * Object keys are sorted by Unicode code point before serialization.
 */
export function jcsCanonicalize(input: unknown): string {
  return serialize(normalizeJson(input, "$"));
}

export function normalizeJson(input: unknown, path = "$"): JsonValue {
  if (input === null) {
    return null;
  }

  switch (typeof input) {
    case "boolean":
      return input;
    case "number":
      if (!Number.isFinite(input)) {
        throw new SignedObjectCanonicalizationError(
          `${path} must be a finite JSON number`,
        );
      }
      return input;
    case "string":
      assertUnicodeScalarString(input, path);
      return input;
    case "object":
      return normalizeJsonObjectOrArray(input, path);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
    default:
      throw new SignedObjectCanonicalizationError(
        `${path} is not a JSON value`,
      );
  }
}

export function serialize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new SignedObjectCanonicalizationError(
          "number could not be serialized as JSON",
        );
      }
      return encoded;
    }
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item)).join(",")}]`;
      }
      return serializeObject(value);
    default:
      throw new SignedObjectCanonicalizationError(
        `unsupported JSON value type ${typeof value}`,
      );
  }
}

function normalizeJsonObjectOrArray(input: object, path: string): JsonValue {
  assertNoSymbolKeys(input, path);

  if (Array.isArray(input)) {
    for (const key of Object.getOwnPropertyNames(input)) {
      if (key === "length") {
        continue;
      }
      if (!isArrayIndexKey(key, input.length)) {
        throw new SignedObjectCanonicalizationError(
          `${path}.${key} is not allowed on a JSON array`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor?.enumerable !== true) {
        throw new SignedObjectCanonicalizationError(
          `${path}[${key}] must be an enumerable JSON array item`,
        );
      }
      if (!("value" in descriptor)) {
        throw new SignedObjectCanonicalizationError(
          `${path}[${key}] must be a JSON data property`,
        );
      }
    }
    const output: JsonValue[] = [];
    for (let index = 0; index < input.length; index++) {
      if (!objectHasOwn(input, index)) {
        throw new SignedObjectCanonicalizationError(
          `${path}[${index}] must not be a sparse array hole`,
        );
      }
      output.push(normalizeJson(input[index], `${path}[${index}]`));
    }
    return output;
  }

  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new SignedObjectCanonicalizationError(
      `${path} must be a plain JSON object`,
    );
  }

  const output = Object.create(null) as MutableJsonObject;
  for (const key of Object.getOwnPropertyNames(input)) {
    assertUnicodeScalarString(key, `${path} key`);
    if (key === "__proto__" || key === "constructor") {
      throw new SignedObjectCanonicalizationError(
        `${path}.${key} is not allowed`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.enumerable !== true) {
      throw new SignedObjectCanonicalizationError(
        `${path}.${key} must be an enumerable JSON object property`,
      );
    }
    if (!("value" in descriptor)) {
      throw new SignedObjectCanonicalizationError(
        `${path}.${key} must be a JSON data property`,
      );
    }
    const value = descriptor.value;
    output[key] = normalizeJson(value, `${path}.${key}`);
  }
  return output;
}

function assertNoSymbolKeys(input: object, path: string): void {
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new SignedObjectCanonicalizationError(
      `${path} must not have symbol properties`,
    );
  }
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function serializeObject(value: { readonly [key: string]: JsonValue }): string {
  const keys = Object.keys(value).sort(compareCodePoints);
  const parts = keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`);
  return `{${parts.join(",")}}`;
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const max = Math.min(left.length, right.length);
  for (let index = 0; index < max; index++) {
    const leftPoint = left[index].codePointAt(0) ?? 0;
    const rightPoint = right[index].codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) {
      return leftPoint - rightPoint;
    }
  }
  return left.length - right.length;
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new SignedObjectCanonicalizationError(
          `${path} contains a lone high surrogate`,
        );
      }
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SignedObjectCanonicalizationError(
        `${path} contains a lone low surrogate`,
      );
    }
  }
}

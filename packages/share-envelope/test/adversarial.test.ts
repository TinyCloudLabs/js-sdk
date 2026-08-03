import { describe, expect, it } from "vitest";
import vectors from "./vectors/share-cli-adversarial.json";
import { isCanonicalResourcePath } from "../src/schema.js";
import { parseShareUrl } from "../src/link.js";

describe("shared Share CLI/viewer adversarial vectors", () => {
  it.each(vectors.linkCases)("rejects $id before accepting link material", ({ url, expected }) => {
    expect(() => parseShareUrl(url)).toThrow();
    expect(expected).toBe("invalid-link");
  });

  it.each(vectors.resourceCases)("classifies $id with the canonical resource grammar", ({ path, expected }) => {
    expect(isCanonicalResourcePath(path)).toBe(expected);
  });
});

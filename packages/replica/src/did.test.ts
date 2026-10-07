import { describe, expect, test } from "bun:test";
import { isPrincipalDid, principalOf } from "./did.js";

describe("isPrincipalDid", () => {
  const valid = [
    "did:pkh:eip155:1:0x28C4d9a58bd426ae64078EB44De372bC0c2AEefb",
    "did:key:z6MkfhoxdzVTa6fLWMgEJNiRJomE5grMqkWyHiRbU9Tt7mAq",
    "did:example:abc",
    "did:web:example.com%3A8080",
    // `:`-separated segments are allowed inside the method-specific-id; only
    // the final segment must be non-empty.
    "did:example:a:b:c",
    "did:example:a::b",
    "did:example:%20",
    "did:example:a%2Fb",
    "did:example:_x",
    "did:example:.x",
    "did:example:x-",
    "did:example:%2fX",    // %2f escape then a plain idchar
  ];
  const invalid = [
    "did:example:%QQ",      // bad percent-escape — passed the old regex
    "did:example::",        // empty final segment — passed the old regex
    "did:example:",         // empty method-specific-id
    "did::abc",             // empty method
    "did:Example:abc",      // method must be lowercase
    "did:example",          // no method-specific-id
    "did:example:abc#frag", // a DID-URL, not a DID
    "did:example:a~b",      // `~` is not an idchar
    "did:example:ab c",     // spaces are not idchars
    "did:example:%2",       // truncated escape
    "did:example:%f",       // one-hex escape
    "did:pkh:",
    "",
    "did:example:abc:",
  ];

  for (const did of valid) {
    test(`accepts ${did}`, () => expect(isPrincipalDid(did)).toBe(true));
  }
  for (const did of invalid) {
    test(`rejects ${did}`, () => expect(isPrincipalDid(did)).toBe(false));
  }

  test("rejects non-strings at runtime", () => {
    expect(isPrincipalDid(undefined as unknown as string)).toBe(false);
    expect(isPrincipalDid(null as unknown as string)).toBe(false);
    expect(isPrincipalDid(42 as unknown as string)).toBe(false);
  });
});

describe("principalOf", () => {
  test("strips the verification-method fragment", () => {
    expect(principalOf("did:key:z6Mkabc#z6Mkabc")).toBe("did:key:z6Mkabc");
    expect(principalOf("did:pkh:eip155:1:0x123")).toBe("did:pkh:eip155:1:0x123");
  });
});

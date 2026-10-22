import { describe, expect, test } from "bun:test";

import {
  DELEGABLE_KEY_ABILITIES,
  EncryptionResourceError,
  KEY_DELETE_ABILITY,
  encryptionResourceContains,
  formatKeyResource,
  formatPrefixResource,
  nodeSupportsNamedKeys,
  parseEncryptionResource,
  type ParsedEncryptionResource,
} from "./resource";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const KEY_OWNER = "did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi";
const NET = `urn:tinycloud:encryption:${OWNER}:default`;
const res = (path: string): string => `${NET}/${path}`;
const seg = (n: number): string => "a".repeat(n);

const validVectors: Array<[string, string, ParsedEncryptionResource]> = [
  ["network", NET, { kind: "network", ownerDid: OWNER, network: "default", networkId: NET }],
  [
    "key",
    res("secrets/software-factory"),
    { kind: "key", ownerDid: OWNER, network: "default", networkId: NET, path: "secrets/software-factory" },
  ],
  [
    "key with did:key owner",
    `urn:tinycloud:encryption:${KEY_OWNER}:default/apps/tinychat`,
    {
      kind: "key",
      ownerDid: KEY_OWNER,
      network: "default",
      networkId: `urn:tinycloud:encryption:${KEY_OWNER}:default`,
      path: "apps/tinychat",
    },
  ],
  [
    "prefix",
    res("apps/tinychat/"),
    { kind: "prefix", ownerDid: OWNER, network: "default", networkId: NET, prefix: "apps/tinychat" },
  ],
  [
    "8 segments, 255 bytes",
    res(Array(8).fill(seg(31)).join("/")),
    { kind: "key", ownerDid: OWNER, network: "default", networkId: NET, path: Array(8).fill(seg(31)).join("/") },
  ],
  [
    "dot, underscore, dash inside a segment",
    res("apps/v1.2_x-y"),
    { kind: "key", ownerDid: OWNER, network: "default", networkId: NET, path: "apps/v1.2_x-y" },
  ],
  [
    "node-rule network name when parsing a key",
    `urn:tinycloud:encryption:${OWNER}:My_Net/a`,
    {
      kind: "key",
      ownerDid: OWNER,
      network: "My_Net",
      networkId: `urn:tinycloud:encryption:${OWNER}:My_Net`,
      path: "a",
    },
  ],
];

const rejectVectors: Array<[string, string]> = [
  ["two trailing slashes", res("apps/x//")],
  ["empty segment", res("apps//x")],
  ["leading slash", res("/apps")],
  ["uppercase", res("Apps/x")],
  ["'..' segment", res("apps/../x")],
  ["'.' segment", res("apps/./x")],
  ["percent", res("apps/a%2Fb")],
  ["colon in path", res("apps/a:b")],
  ["space", res("apps/a b")],
  ["non-ASCII", res("apps/café")],
  ["9 segments", res("a/a/a/a/a/a/a/a/a")],
  ["segment of 65 bytes", res(seg(65))],
  ["total 256 bytes", res([...Array(7).fill(seg(31)), seg(32)].join("/"))],
  ["segment starting with '.'", res(".hidden")],
  ["segment starting with '-'", res("-x")],
  // Beyond the shared vectors.
  ["empty path after slash", `${NET}/`],
  ["prefix with a '..' segment", res("apps/../")],
  ["prefix with an empty segment", res("apps//x/")],
  ["lowercase pkh owner", `urn:tinycloud:encryption:${OWNER.toLowerCase().replace("0x", "0x")}:default/a`],
  ["lowercase pkh owner on a bare network", `urn:tinycloud:encryption:${OWNER.toLowerCase()}:default`],
  ["slash inside the owner part", `urn:tinycloud:encryption:did:web:a/b:default/c`],
  ["wrong URN prefix", `urn:tinycloud:other:${OWNER}:default/a`],
  ["bare network with uppercase name", `urn:tinycloud:encryption:${OWNER}:Default`],
  ["newline in path", res("a\nb")],
];

describe("parseEncryptionResource", () => {
  test.each(validVectors)("parses %s", (_name, uri, expected) => {
    expect(parseEncryptionResource(uri)).toEqual(expected);
  });

  test.each(rejectVectors)("rejects %s", (_name, uri) => {
    expect(() => parseEncryptionResource(uri)).toThrow(EncryptionResourceError);
  });

  test("a prefix result never carries a key path", () => {
    const parsed = parseEncryptionResource(res("apps/x/"));
    expect(parsed.kind).toBe("prefix");
    expect("path" in parsed).toBe(false);
  });

  test("lowercase pkh owner is rejected with a canonical-owner code", () => {
    const lower = `urn:tinycloud:encryption:${OWNER.toLowerCase()}:default/a`;
    expect(() => parseEncryptionResource(lower)).toThrow(
      expect.objectContaining({ code: "non_canonical_owner" }),
    );
  });
});

describe("formatKeyResource / formatPrefixResource", () => {
  test("return the exact canonical strings and round-trip through the parser", () => {
    expect(formatKeyResource(NET, "secrets/software-factory")).toBe(res("secrets/software-factory"));
    expect(formatPrefixResource(NET, "apps/tinychat")).toBe(res("apps/tinychat/"));
    expect(parseEncryptionResource(formatPrefixResource(NET, "apps/x")).kind).toBe("prefix");
  });

  test.each([
    ["key: uppercase", () => formatKeyResource(NET, "Apps")],
    ["key: trailing slash", () => formatKeyResource(NET, "apps/")],
    ["key: empty", () => formatKeyResource(NET, "")],
    ["key: 9 segments", () => formatKeyResource(NET, "a/a/a/a/a/a/a/a/a")],
    ["prefix: trailing slash supplied", () => formatPrefixResource(NET, "apps/")],
    ["prefix: '..' segment", () => formatPrefixResource(NET, "../a")],
    ["key: lowercase pkh owner", () => formatKeyResource(`urn:tinycloud:encryption:${OWNER.toLowerCase()}:default`, "a")],
    ["key: loose network name", () => formatKeyResource(`urn:tinycloud:encryption:${OWNER}:My_Net`, "a")],
    ["key: network id already a key", () => formatKeyResource(res("a"), "b")],
  ])("rejects %s", (_name, build) => {
    expect(build).toThrow(EncryptionResourceError);
  });
});

describe("encryptionResourceContains", () => {
  const other = `urn:tinycloud:encryption:${OWNER}:other`;
  const table: Array<[string, string, string, boolean]> = [
    ["exact == exact", res("a/b"), res("a/b"), true],
    ["exact vs different key", res("a/b"), res("a/c"), false],
    ["exact vs deeper key", res("a/b"), res("a/b/c"), false],
    ["prefix covers key below it", res("a/"), res("a/b"), true],
    ["prefix covers deep key", res("a/"), res("a/b/c/d"), true],
    ["prefix does not cover the key named like itself", res("a/"), res("a"), false],
    ["prefix does not cover sibling with same leading text", res("apps/foo/"), res("apps/foobar"), false],
    ["prefix does not cover sibling prefix with same leading text", res("apps/foo/"), res("apps/foobar/"), false],
    ["prefix covers itself", res("a/"), res("a/"), true],
    ["prefix covers narrower prefix", res("a/"), res("a/b/"), true],
    ["narrow prefix does not cover wider prefix", res("a/b/"), res("a/"), false],
    ["prefix a/ vs prefix a (key form) differ", res("a/"), res("a"), false],
    ["key does not cover prefix of itself", res("a/b"), res("a/b/"), false],
    ["key does not cover a prefix below it", res("a"), res("a/b/"), false],
    ["bare == bare", NET, NET, true],
    ["bare vs other network", NET, other, false],
    ["bare never covers key", NET, res("a"), false],
    ["bare never covers prefix", NET, res("a/"), false],
    ["key never covers bare", res("a"), NET, false],
    ["prefix never covers bare", res("a/"), NET, false],
    ["same path on other network", res("a/"), `${other}/a/b`, false],
    ["unparseable granted", `${NET}/A/`, res("a"), false],
    ["unparseable requested", res("a/"), `${NET}/a//b`, false],
  ];
  test.each(table)("%s", (_name, granted, requested, expected) => {
    expect(encryptionResourceContains(granted, requested)).toBe(expected);
  });
});

describe("abilities", () => {
  test("key.delete is not delegable", () => {
    expect(DELEGABLE_KEY_ABILITIES).not.toContain(KEY_DELETE_ABILITY);
    expect(DELEGABLE_KEY_ABILITIES).toHaveLength(3);
  });
});

describe("nodeSupportsNamedKeys", () => {
  test.each([
    ["feature present", { features: ["sql", "encryption-named-keys-v1"] }, true],
    ["feature absent", { features: ["sql", "encryption"] }, false],
    ["near-miss string", { features: ["encryption-named-keys-v2", "encryption-named-keys"] }, false],
    ["features missing", {}, false],
    ["features not an array", { features: "encryption-named-keys-v1" }, false],
    ["null info", null, false],
  ])("%s", (_name, info, expected) => {
    expect(nodeSupportsNamedKeys(info)).toBe(expected);
  });
});

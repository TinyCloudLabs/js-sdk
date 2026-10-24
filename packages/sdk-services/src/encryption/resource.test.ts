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

const LOWER_OWNER = OWNER.toLowerCase();
const key = (path: string, network = "default", ownerDid = OWNER): ParsedEncryptionResource => ({
  kind: "key",
  ownerDid,
  network,
  networkId: `urn:tinycloud:encryption:${ownerDid}:${network}`,
  path,
});
const prefixOf = (prefix: string): ParsedEncryptionResource => ({
  kind: "prefix",
  ownerDid: OWNER,
  network: "default",
  networkId: NET,
  prefix,
});
const seg255 = Array(8).fill(seg(31)).join("/");
const seg256 = [...Array(7).fill(seg(31)), seg(32)].join("/");

// Shared grammar vectors (numbered as in the contract vector list).
const validVectors: Array<[string, string, ParsedEncryptionResource]> = [
  ["#1 network", NET, { kind: "network", ownerDid: OWNER, network: "default", networkId: NET }],
  ["#2 key", res("secrets/software-factory"), key("secrets/software-factory")],
  [
    "#3 key with did:key owner",
    `urn:tinycloud:encryption:${KEY_OWNER}:default/apps/tinychat/session`,
    key("apps/tinychat/session", "default", KEY_OWNER),
  ],
  ["#4 prefix", res("apps/tinychat/"), prefixOf("apps/tinychat")],
  ["#5 8 segments, 255 bytes", res(seg255), key(seg255)],
  ["#6 dot, underscore, dash inside a segment", res("apps/v1.2_x-y/z"), key("apps/v1.2_x-y/z")],
  [
    "#24 bare network with lowercase pkh owner is normalized",
    `urn:tinycloud:encryption:${LOWER_OWNER}:default`,
    { kind: "network", ownerDid: OWNER, network: "default", networkId: NET },
  ],
  [
    "#31 did:web owner with colons",
    "urn:tinycloud:encryption:did:web:example.com:user:alice:default/apps/x/y",
    key("apps/x/y", "default", "did:web:example.com:user:alice"),
  ],
  ["#32 node-rule network name in a key", `urn:tinycloud:encryption:${OWNER}:Default/apps/x/y`, key("apps/x/y", "Default")],
  ["#33 prefix with a 255-byte path", res(`${seg255}/`), prefixOf(seg255)],
  ["#48 mixed-case network is a different network from 'default'", `urn:tinycloud:encryption:${OWNER}:DeFault/apps/x/y`, key("apps/x/y", "DeFault")],
  ["#44 network of exactly 64 characters", `urn:tinycloud:encryption:${OWNER}:${seg(64)}/apps/x/y`, key("apps/x/y", seg(64))],
  // #35 is a valid GRANT; the parser reports kind "prefix" so a caller can refuse it as an invocation target.
  ["#35 prefix parses as a prefix, never a key", res("apps/x/"), prefixOf("apps/x")],
];

const rejectVectors: Array<[string, string]> = [
  ["#7 two trailing slashes", res("apps/x//")],
  ["#8 empty segment", res("apps//x")],
  ["#9 leading slash", res("/apps")],
  ["#10 uppercase", res("Apps/x")],
  ["#11 '..' segment", res("apps/../x")],
  ["#12 '.' segment", res("apps/./x")],
  ["#13 percent", res("apps/a%2Fb")],
  ["#14 colon in path", res("apps/a:b")],
  ["#15 space", res("apps/a b")],
  ["#16 non-ASCII", res("apps/café")],
  ["#17 9 segments", res("a/a/a/a/a/a/a/a/a")],
  ["#18 segment of 65 bytes", res(seg(65))],
  ["#19 total 256 bytes", res(seg256)],
  ["#20 segment starting with '.'", res(".hidden")],
  ["#21 segment starting with '-'", res("-x")],
  ["#22 empty prefix", `${NET}/`],
  ["#23 key with lowercase pkh owner", `urn:tinycloud:encryption:${LOWER_OWNER}:default/apps/x`],
  ["#25 '#' in owner", `urn:tinycloud:encryption:${KEY_OWNER}#x:default/apps/x`],
  ["#26 '#' in network", `urn:tinycloud:encryption:${OWNER}:default#x/apps/x`],
  ["#27 '?' in network", `urn:tinycloud:encryption:${OWNER}:default?x/apps/x`],
  ["#28 '%' in owner", "urn:tinycloud:encryption:did:web:example.com%3A8443:default/apps/x"],
  ["#29 uppercase URN scheme", `URN:tinycloud:encryption:${OWNER}:default/apps/x`],
  ["#30 mixed-case URN namespace", `urn:TinyCloud:encryption:${OWNER}:default/apps/x`],
  ["#34 prefix path over 255 bytes", res(`${seg256}/`)],
  ["#36 bidi override in network of a key", `urn:tinycloud:encryption:${OWNER}:de\u202eault/apps/x`],
  ["#37 zero-width space in network", `urn:tinycloud:encryption:${OWNER}:de\u200bfault/apps/x`],
  ["#38 BOM in network", `urn:tinycloud:encryption:${OWNER}:\ufeffdefault/apps/x`],
  ["#39 control character in network", `urn:tinycloud:encryption:${OWNER}:de\x07fault/apps/x`],
  ["#40 non-ASCII letter in network", `urn:tinycloud:encryption:${OWNER}:d\xe9fault/apps/x`],
  ["#41 network starting with '-'", `urn:tinycloud:encryption:${OWNER}:-default/apps/x`],
  ["#42 network starting with '.'", `urn:tinycloud:encryption:${OWNER}:.a/apps/x`],
  ["#43 network of 65 characters", `urn:tinycloud:encryption:${OWNER}:${seg(65)}/apps/x`],
  ["#45 bidi network inside a prefix", `urn:tinycloud:encryption:${OWNER}:de\u202eault/apps/x/`],
  ["#46 newline in the network part of a key", `urn:tinycloud:encryption:${OWNER}:default\n/apps/x/y`],
  ["#47 trailing newline after the key path", `urn:tinycloud:encryption:${OWNER}:default/apps/x/y\n`],
  // Beyond the shared vectors.
  ["prefix with a '..' segment", res("apps/../")],
  ["prefix with an empty segment", res("apps//x/")],
  ["slash inside the owner part", "urn:tinycloud:encryption:did:web:a/b:default/c"],
  ["wrong URN prefix", `urn:tinycloud:other:${OWNER}:default/a`],
  ["bare network with uppercase name", `urn:tinycloud:encryption:${OWNER}:Default`],
  ["bare network with '#' in name", `urn:tinycloud:encryption:${OWNER}:de#fault`],
  ["newline in path", res("a\nb")],
  ["owner method with uppercase", "urn:tinycloud:encryption:did:Web:example.com:default/a"],
  ["network containing '%'", `urn:tinycloud:encryption:${OWNER}:de%66ault/a`],
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

const ADDR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const netOf = (ownerDid: string): string => `urn:tinycloud:encryption:${ownerDid}:default`;

describe("owner grammar", () => {
  test("generic owner with an empty colon component is accepted", () => {
    const uri = `${netOf("did:web:a::b")}/apps/x/y`;
    expect(parseEncryptionResource(uri)).toEqual(key("apps/x/y", "default", "did:web:a::b"));
  });

  test.each(["9007199254740992", "18446744073709551615"])("accepts did:pkh:eip155 chain id %s above 2^53 or at u64 max", (chain) => {
    const owner = `did:pkh:eip155:${chain}:${ADDR}`;
    expect(parseEncryptionResource(`${netOf(owner)}/apps/x/y`)).toEqual(key("apps/x/y", "default", owner));
  });

  test.each([
    ["chain id 0", `did:pkh:eip155:0:${ADDR}`],
    ["chain id above u64", `did:pkh:eip155:18446744073709551616:${ADDR}`],
    ["short address", "did:pkh:eip155:1:0x1234"],
    ["non-numeric chain id", `did:pkh:eip155:abc:${ADDR}`],
    ["extra component", `did:pkh:eip155:1:${ADDR}:extra`],
    ["missing address", "did:pkh:eip155:1"],
  ])("rejects malformed did:pkh:eip155 owner: %s", (_name, owner) => {
    expect(() => parseEncryptionResource(`${netOf(owner)}/apps/x`)).toThrow(EncryptionResourceError);
    expect(() => parseEncryptionResource(`${netOf(owner)}/apps/`)).toThrow(EncryptionResourceError);
    expect(() => parseEncryptionResource(netOf(owner))).toThrow(EncryptionResourceError);
    expect(
      encryptionResourceContains(`${netOf(owner)}/apps/`, `${netOf(owner)}/apps/x`),
    ).toBe(false);
  });
});

describe("builder output always parses", () => {
  test.each([
    ["uppercase method", "did:Web:example.com"],
    ["'#' in owner", "did:web:example.com#x"],
    ["'%' in owner", "did:web:example.com%3A8443"],
    ["empty colon component (parseNetworkId refuses it)", "did:web:a::b"],
  ])("throws for owner with %s", (_name, owner) => {
    expect(() => formatKeyResource(netOf(owner), "a")).toThrow(EncryptionResourceError);
    expect(() => formatPrefixResource(netOf(owner), "a")).toThrow(EncryptionResourceError);
  });

  test("throws for a bare network the key grammar would reject (65 characters)", () => {
    const longNet = `urn:tinycloud:encryption:${OWNER}:${seg(65)}`;
    expect(() => formatKeyResource(longNet, "a")).toThrow(EncryptionResourceError);
    expect(() => formatPrefixResource(longNet, "a")).toThrow(EncryptionResourceError);
  });

  test.each([
    ["large chain id", `did:pkh:eip155:9007199254740992:${ADDR}`],
  ])("output parses back to the same fields for owner with %s", (_name, owner) => {
    expect(parseEncryptionResource(formatKeyResource(netOf(owner), "a/b"))).toEqual(
      key("a/b", "default", owner),
    );
    expect(parseEncryptionResource(formatPrefixResource(netOf(owner), "a/b"))).toEqual({
      kind: "prefix",
      ownerDid: owner,
      network: "default",
      networkId: netOf(owner),
      prefix: "a/b",
    });
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
    ["a prefix does not cover the enclosing prefix", res("a/b/"), res("a/"), false],
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
    // Contract containment vectors.
    ["V1 apps/foo/ vs apps/foobar/x", res("apps/foo/"), res("apps/foobar/x"), false],
    ["V2 apps/foo/ vs apps/foo", res("apps/foo/"), res("apps/foo"), false],
    ["V3 apps/ is not a valid prefix and covers nothing", res("apps/"), res("apps/foo/"), false],
    ["V4 apps/foo/ covers apps/foo/a/b", res("apps/foo/"), res("apps/foo/a/b"), true],
    ["V5 bare vs key", NET, res("apps/x/y"), false],
    ["V6 key vs bare", res("apps/x/y"), NET, false],
    ["bare with lowercase owner equals the canonical bare network", `urn:tinycloud:encryption:${LOWER_OWNER}:default`, NET, true],
  ];
  test.each(table)("%s", (_name, granted, requested, expected) => {
    expect(encryptionResourceContains(granted, requested)).toBe(expected);
  });
});

describe("abilities", () => {
  test("key.delete is not delegable", () => {
    expect(DELEGABLE_KEY_ABILITIES).not.toContain(KEY_DELETE_ABILITY);
    for (const ability of [
      "tinycloud.encryption/key.create",
      "tinycloud.encryption/decrypt",
      "tinycloud.encryption/key.block",
      "tinycloud.encryption/key.unblock",
    ]) {
      expect(DELEGABLE_KEY_ABILITIES).toContain(ability);
    }
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

// Depth rule for the reserved `apps` segment (R1). The rows below are the
// groups `nodeKeyPathUnderApps`, `prefixValid` and `prefixCovers` copied
// exactly from ~/scratch/tc1777-node/APP-ID-VECTORS.json (sha256 prefix
// a5c46c1b7d02ccab), which is shared with the node and OpenKey.
describe("apps/ depth rule (shared vectors)", () => {
  const nodeKeyPathUnderApps: Array<[string, boolean]> = [
    ["apps/foo/x", true],
    ["apps/foo/x/y", true],
    ["apps/foo", false],
    ["apps", false],
    ["apps/Foo/x", false],
    ["apps/foo_bar/x", true],
    ["apps/foo/x/", false],
    ["secrets/x", true],
    ["appsx/y", true],
    ["apps.x/y", true],
  ];
  test.each(nodeKeyPathUnderApps)("key path %p accepted=%p", (keyPath, accepted) => {
    if (accepted) {
      expect(parseEncryptionResource(formatKeyResource(NET, keyPath))).toMatchObject({ kind: "key", path: keyPath });
    } else {
      expect(() => formatKeyResource(NET, keyPath)).toThrow(EncryptionResourceError);
    }
  });

  const prefixValid: Array<[string, boolean]> = [
    ["apps/", false],
    ["apps/foo/", true],
    ["apps/foo/x/", true],
    ["apps/Foo/", false],
    ["apps/foo//", false],
    ["appsx/", true],
    ["apps.x/", true],
    ["apps", false],
    ["apps/foo", false],
  ];
  test.each(prefixValid)("prefix %p valid=%p", (prefix, valid) => {
    if (valid) {
      expect(parseEncryptionResource(res(prefix)).kind).toBe("prefix");
    } else {
      expect(() => parseEncryptionResource(res(prefix))).toThrow(EncryptionResourceError);
    }
  });

  const prefixCovers: Array<[string, string, boolean]> = [
    ["apps/foo/", "apps/foo/x", true],
    ["apps/foo/", "apps/foo/x/y", true],
    ["apps/foo/", "apps/foo/x/y/z", true],
    ["apps/foo/", "apps/foo", false],
    ["apps/foo/", "apps/foobar/x", false],
    ["apps/foo/", "apps/foo.bar/x", false],
    ["apps/foo/", "apps/foo-bar/x", false],
    ["apps/foo/", "apps/fo/x", false],
    ["apps/foo/", "other/foo/x", false],
    ["apps/foo/", "secrets/apps/foo/x", false],
    ["apps/foo.bar/", "apps/foo.bar/x", true],
    ["apps/foo_bar/", "apps/foo.bar/x", false],
    ["apps/foo_bar/", "apps/foo-bar/x", false],
    ["apps/foo_bar/", "apps/fooxbar/x", false],
    ["apps/foo/x/", "apps/foo/x", false],
  ];
  test.each(prefixCovers)("prefix %p covers key %p = %p", (prefix, keyPath, covers) => {
    expect(encryptionResourceContains(res(prefix), res(keyPath))).toBe(covers);
  });

  test("apps and apps/<id> are not keys, apps/ is not a prefix, and the builders refuse them", () => {
    expect(() => parseEncryptionResource(res("apps"))).toThrow(EncryptionResourceError);
    expect(() => parseEncryptionResource(res("apps/tinychat"))).toThrow(EncryptionResourceError);
    expect(() => parseEncryptionResource(res("apps/"))).toThrow(EncryptionResourceError);
    expect(() => formatPrefixResource(NET, "apps")).toThrow(EncryptionResourceError);
    expect(() => formatKeyResource(NET, "apps/tinychat")).toThrow(EncryptionResourceError);
    expect(parseEncryptionResource(res("apps/tinychat/"))).toEqual(prefixOf("apps/tinychat"));
  });

  test("no grant covers every app's keys: the prefix apps/ grants nothing", () => {
    expect(encryptionResourceContains(res("apps/"), res("apps/foo/x"))).toBe(false);
    expect(encryptionResourceContains(res("apps/"), res("apps/foo/"))).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import {
  SECRET_MANAGER_ORIGIN,
  SecretRequestInputError,
  buildSecretManagerUrl,
  buildSecretRequestUrl,
  canonicalSecretRequestOwner,
  isSafeRequestAccessRecovery,
  missingSecretRecovery,
  resolveSecretsOwner,
  secretSetupFor,
  type SecretRequestInputErrorCode,
  type SecretRequestLinkInput,
} from "./secret-request.js";

const CHECKSUMMED = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const OWNER = `did:pkh:eip155:1:${CHECKSUMMED}`;
const LOWER_OWNER = `did:pkh:eip155:1:${CHECKSUMMED.toLowerCase()}`;
const FEED = "https://feed.tinycloud.xyz/";

function rejection(input: Partial<SecretRequestLinkInput>): SecretRequestInputErrorCode | undefined {
  try {
    buildSecretRequestUrl({ owner: OWNER, names: ["A"], ...input });
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretRequestInputError);
    return (error as SecretRequestInputError).code;
  }
}

function queryOf(url: string): URLSearchParams {
  expect(url.startsWith(`${SECRET_MANAGER_ORIGIN}/request?`)).toBe(true);
  return new URL(url).searchParams;
}

describe("owner rule", () => {
  test.each([
    [LOWER_OWNER, OWNER],
    [OWNER, OWNER],
    [`did:pkh:eip155:8453:${CHECKSUMMED}`, `did:pkh:eip155:8453:${CHECKSUMMED}`],
    [`did:pkh:eip155:${Number.MAX_SAFE_INTEGER}:${CHECKSUMMED}`, `did:pkh:eip155:${Number.MAX_SAFE_INTEGER}:${CHECKSUMMED}`],
  ])("accepts %s as %s", (input, canonical) => {
    expect(canonicalSecretRequestOwner(input)).toBe(canonical);
    expect(buildSecretRequestUrl({ owner: input, names: ["A"] }).owner).toBe(canonical);
  });

  test.each([
    `did:pkh:eip155:1:0xD559CCd9EB87c530A9a349262669386dE93cf412`,
    `did:pkh:eip155:1:${CHECKSUMMED.toUpperCase().replace("0X", "0x")}`,
    `did:pkh:eip155:1:0X${CHECKSUMMED.slice(2).toLowerCase()}`,
    `did:pkh:eip155:0:${CHECKSUMMED}`,
    `did:pkh:eip155:01:${CHECKSUMMED}`,
    `did:pkh:eip155:9007199254740992:${CHECKSUMMED}`,
    `did:pkh:eip155:1:${CHECKSUMMED.slice(0, -1)}`,
    `did:pkh:eip155:1:${CHECKSUMMED}0`,
    `did:pkh:solana:1:${CHECKSUMMED}`,
    `did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`,
    ` ${OWNER}`,
    "",
  ])("rejects %s", (owner) => {
    expect(() => canonicalSecretRequestOwner(owner)).toThrow(SecretRequestInputError);
    expect(rejection({ owner })).toBe("INVALID_OWNER");
  });
});

describe("name rule", () => {
  test("de-duplicates in order, then requires 1-10", () => {
    expect(buildSecretRequestUrl({ owner: OWNER, names: ["B", "A", "B"] }).names).toEqual(["B", "A"]);
    const ten = Array.from({ length: 10 }, (_, index) => `N${index}`);
    expect(buildSecretRequestUrl({ owner: OWNER, names: [...ten, "N0"] }).names).toEqual(ten);
    expect(rejection({ names: [...ten, "N10"] })).toBe("TOO_MANY_SECRET_NAMES");
    expect(rejection({ names: [] })).toBe("INVALID_SECRET_NAME");
  });

  test.each(["A", "A_1", "OPENAI_API_KEY", `A${"B".repeat(63)}`])("accepts %s", (name) => {
    expect(rejection({ names: [name] })).toBeUndefined();
  });

  test.each(["a", "1A", "_A", "A-B", " A", "A ", "", `A${"B".repeat(64)}`, "Ä"])("rejects %p", (name) => {
    expect(rejection({ names: [name] })).toBe("INVALID_SECRET_NAME");
  });
});

describe("scope rule", () => {
  test.each(["food-drinks", "a", "a1-b2", "x".repeat(64)])("accepts %s unchanged", (scope) => {
    expect(rejection({ scope })).toBeUndefined();
    expect(buildSecretRequestUrl({ owner: OWNER, names: ["A"], scope }).scope).toBe(scope);
  });

  test.each(["default", "global", "scoped", "Food", "food drinks", "-a", "a-", "a--b", "", "x".repeat(65)])(
    "rejects %p and never canonicalizes it",
    (scope) => {
      expect(rejection({ scope })).toBe("INVALID_SECRET_SCOPE");
    },
  );
});

describe("requester rule", () => {
  test.each(["agent@host", "a", "x".repeat(64), "Ünïcödé agent", "🤖 bot"])("accepts %p", (requester) => {
    expect(rejection({ requester })).toBeUndefined();
  });

  test.each(["", "x".repeat(65), "bell\u0007", "line\nbreak", "zero\u200bwidth", "rtl\u202e"])("rejects %p", (requester) => {
    expect(rejection({ requester })).toBe("INVALID_REQUESTER");
  });
});

describe("state rule", () => {
  test.each(["a", "A-z_0.9~", "s".repeat(128)])("accepts %p", (state) => {
    expect(rejection({ state })).toBeUndefined();
  });

  test.each(["", "s".repeat(129), "a b", "a/b", "é"])("rejects %p", (state) => {
    expect(rejection({ state })).toBe("INVALID_STATE");
  });
});

describe("returnTo rule", () => {
  const exactly2048 = `${FEED}${"a".repeat(2048 - FEED.length)}`;

  test.each([
    "https://feed.tinycloud.xyz/secret-returned",
    "https://pr-12.tinyfeed.pages.dev/x",
    "https://FEED.tinycloud.xyz/x",
    "https://feed.tinycloud.xyz:443/x",
    `${FEED}${"é".repeat(400)}`,
    exactly2048,
  ])("accepts %s and emits the raw value unchanged", (returnTo) => {
    const { url } = buildSecretRequestUrl({ owner: OWNER, names: ["A"], returnTo });
    expect(queryOf(url).get("return_to")).toBe(returnTo);
    expect(url).toContain(`&return_to=${encodeURIComponent(returnTo)}&`);
  });

  test("the 2048-character value is exactly at the limit", () => {
    expect(exactly2048).toHaveLength(2048);
  });

  test.each([
    "https://a.b.tinyfeed.pages.dev/x",
    "https://example.com/callback",
    "http://localhost:3000/callback",
    "http://127.0.0.1:3000/callback",
    "https://user:pass@feed.tinycloud.xyz/x",
    "https://user@feed.tinycloud.xyz/x",
    "https://feed.tinycloud.xyz:8443/x",
    "http://feed.tinycloud.xyz/x",
    "javascript:alert(1)",
    "/relative",
    `${FEED}${"a".repeat(2049 - FEED.length)}`,
  ])("rejects %s", (returnTo) => {
    expect(rejection({ returnTo })).toBe("INVALID_RETURN_TO");
  });

  test("a valid return address that encodes past 8192 is REQUEST_LINK_TOO_LONG", () => {
    const returnTo = `${FEED}${"𝄞".repeat(1000)}`;
    expect(returnTo.length).toBeLessThanOrEqual(2048);
    expect(rejection({ returnTo })).toBe("REQUEST_LINK_TOO_LONG");
  });
});

describe("serialization", () => {
  test("produces exactly one canonical link in the fixed parameter order", () => {
    const link = buildSecretRequestUrl({
      owner: LOWER_OWNER,
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      scope: "food-drinks",
      requester: "agent@host 1",
      returnTo: "https://feed.tinycloud.xyz/secret-returned?x=1&y=2",
      state: "st-1.2_3~",
    });
    expect(link).toEqual({
      url: "https://secrets.tinycloud.xyz/request?owner=did%3Apkh%3Aeip155%3A1%3A0xd559CCd9EB87c530A9a349262669386dE93cf412&name=OPENAI_API_KEY&name=ANTHROPIC_API_KEY&scope=food-drinks&requester=agent%40host%201&return_to=https%3A%2F%2Ffeed.tinycloud.xyz%2Fsecret-returned%3Fx%3D1%26y%3D2&state=st-1.2_3~&v=1",
      owner: OWNER,
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      scope: "food-drinks",
    });
    expect(secretSetupFor(link)).toEqual({
      url: link.url,
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      scope: "food-drinks",
      owner: OWNER,
      action: "add_secret",
    });
  });

  test("an unscoped minimal link has only owner, names and v", () => {
    const link = buildSecretRequestUrl({ owner: OWNER, names: ["A"] });
    expect(link.url).toBe(`https://secrets.tinycloud.xyz/request?owner=${encodeURIComponent(OWNER)}&name=A&v=1`);
    expect(link).not.toHaveProperty("scope");
    expect(secretSetupFor(link)).toEqual({ url: link.url, names: ["A"], owner: OWNER, action: "add_secret" });
  });
});

describe("buildSecretManagerUrl", () => {
  test("bare, one name, several names, and scope", () => {
    expect(buildSecretManagerUrl()).toBe("https://secrets.tinycloud.xyz/app");
    expect(buildSecretManagerUrl({ names: ["A"] })).toBe("https://secrets.tinycloud.xyz/app?secret=A");
    expect(buildSecretManagerUrl({ names: ["A", "B", "A"] })).toBe("https://secrets.tinycloud.xyz/app?secrets=A%2CB");
    expect(buildSecretManagerUrl({ names: ["A"], scope: "food-drinks" })).toBe("https://secrets.tinycloud.xyz/app?secret=A&scope=food-drinks");
    expect(buildSecretManagerUrl({ names: Array.from({ length: 12 }, (_, index) => `N${index}`) }))
      .toContain("secrets=N0%2CN1");
  });

  test("validates names and scope", () => {
    expect(() => buildSecretManagerUrl({ names: ["a"] })).toThrow(SecretRequestInputError);
    expect(() => buildSecretManagerUrl({ scope: "scoped" })).toThrow(SecretRequestInputError);
  });
});

describe("resolveSecretsOwner", () => {
  const delegateSpace = `tinycloud:pkh:eip155:1:${CHECKSUMMED.toLowerCase()}:default`;

  test("1. a local identity owns its own secrets", () => {
    expect(resolveSecretsOwner({ local: true, posture: "local-owner-key", principalDid: LOWER_OWNER, ownerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" }))
      .toEqual({ ok: true, owner: OWNER, local: true });
  });

  test("2. the recorded owner", () => {
    expect(resolveSecretsOwner({ local: false, posture: "delegate-session", ownerDid: OWNER, principalDid: "did:key:z6Mk", space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default" }))
      .toEqual({ ok: true, owner: OWNER, local: false });
  });

  test("3. a delegate session's space owner", () => {
    expect(resolveSecretsOwner({ local: false, posture: "delegate-session", principalDid: "did:key:z6Mk", space: delegateSpace }))
      .toEqual({ ok: true, owner: OWNER, local: false });
    // Only a delegate session takes its owner from its space.
    expect(resolveSecretsOwner({ local: false, posture: "owner-openkey", principalDid: "did:key:z6Mk", space: delegateSpace }))
      .toMatchObject({ ok: false, code: "OWNER_DID_UNKNOWN" });
  });

  test("4. a pkh principal", () => {
    expect(resolveSecretsOwner({ local: false, posture: "owner-openkey", principalDid: LOWER_OWNER }))
      .toEqual({ ok: true, owner: OWNER, local: false });
  });

  test("5. the requested owner", () => {
    expect(resolveSecretsOwner({ local: false, posture: "delegate-session", principalDid: "did:key:z6Mk" }, LOWER_OWNER))
      .toEqual({ ok: true, owner: OWNER, local: false });
  });

  test("6. otherwise OWNER_DID_UNKNOWN", () => {
    expect(resolveSecretsOwner({ local: false, posture: "delegate-session", principalDid: "did:key:z6Mk" }))
      .toMatchObject({ ok: false, code: "OWNER_DID_UNKNOWN" });
    expect(resolveSecretsOwner({ local: true, posture: "local-owner-key", principalDid: "did:key:z6Mk" }, OWNER))
      .toMatchObject({ ok: false, code: "OWNER_DID_UNKNOWN" });
  });

  test("a disagreeing requested owner is OWNER_MISMATCH; an equal one in another case is not", () => {
    expect(resolveSecretsOwner({ local: false, posture: "delegate-session", ownerDid: OWNER }, "did:pkh:eip155:1:0x1111111111111111111111111111111111111111"))
      .toMatchObject({ ok: false, code: "OWNER_MISMATCH" });
    expect(resolveSecretsOwner({ local: false, posture: "delegate-session", ownerDid: OWNER }, `did:pkh:eip155:8453:${CHECKSUMMED}`))
      .toMatchObject({ ok: false, code: "OWNER_MISMATCH" });
    expect(resolveSecretsOwner({ local: false, posture: "delegate-session", ownerDid: OWNER }, LOWER_OWNER))
      .toEqual({ ok: true, owner: OWNER, local: false });
  });
});

describe("missingSecretRecovery", () => {
  test("add_secret for a requestable owner", () => {
    expect(missingSecretRecovery({ owner: OWNER, local: false, names: ["A"], scope: "food-drinks" })).toEqual({
      kind: "add_secret",
      setup: {
        url: `https://secrets.tinycloud.xyz/request?owner=${encodeURIComponent(OWNER)}&name=A&scope=food-drinks&v=1`,
        names: ["A"],
        scope: "food-drinks",
        owner: OWNER,
        action: "add_secret",
      },
    });
  });

  test("put_locally for a local identity, with a --stdin hint", () => {
    expect(missingSecretRecovery({ owner: OWNER, local: true, names: ["A"], scope: "food-drinks" })).toEqual({
      kind: "put_locally",
      hint: "Store it with: tc secrets put A --scope food-drinks --stdin",
    });
  });

  test("not_requestable, never a throw, when no link can express the request", () => {
    for (const input of [
      { owner: undefined, local: false, names: ["A"] },
      { owner: "did:key:z6Mk", local: false, names: ["A"] },
      { owner: OWNER, local: false, names: ["A"], scope: "scoped" },
      { owner: OWNER, local: false, names: ["A"], scope: "x".repeat(65) },
      { owner: OWNER, local: false, names: [`A${"B".repeat(64)}`] },
    ]) {
      const recovery = missingSecretRecovery(input);
      expect(recovery.kind).toBe("not_requestable");
      expect(recovery).toMatchObject({ hint: expect.stringContaining("--stdin") });
    }
    expect(missingSecretRecovery({ owner: OWNER, local: false, names: [] }).kind).toBe("not_requestable");
  });
});

describe("isSafeRequestAccessRecovery", () => {
  const valid = { action: "request_access", names: ["B"], owner: OWNER };

  test("accepts only denied names, a canonical owner and a valid scope", () => {
    expect(isSafeRequestAccessRecovery(valid, ["B"])).toBe(true);
    expect(isSafeRequestAccessRecovery({ ...valid, scope: "food-drinks" }, ["B"])).toBe(true);
    for (const [value, denied] of [
      [{ ...valid, extra: "x" }, ["B"]],
      [{ ...valid, names: ["C"] }, ["B"]],
      [{ ...valid, names: ["b"] }, ["b"]],
      [{ ...valid, names: [] }, ["B"]],
      [{ ...valid, names: ["B", "B"] }, ["B"]],
      [{ ...valid, owner: LOWER_OWNER }, ["B"]],
      [{ ...valid, owner: OWNER.replace("d559", "D559") }, ["B"]],
      [{ ...valid, scope: "scoped" }, ["B"]],
      [{ ...valid, action: "sign_in" }, ["B"]],
      [valid, []],
      [null, ["B"]],
    ] as const) {
      expect(isSafeRequestAccessRecovery(value, denied)).toBe(false);
    }
  });
});

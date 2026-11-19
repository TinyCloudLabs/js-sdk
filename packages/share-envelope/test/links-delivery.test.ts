import { describe, expect, it } from "vitest";

import { DEFAULT_SHARE_ORIGINS, redactLink, shortShareLinkCid } from "../src/links/index.js";

const ORIGIN = "https://share.tinycloud.xyz";
const ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";
const KEY = "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo";
const CID = "bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u";
const SHORT = `${ORIGIN}/s/${ID}#v=4&k=${KEY}&c=${CID}`;

describe("the short share link of a delivery", () => {
  it("gives the c of a short share link, on the origin it is given", () => {
    expect(shortShareLinkCid(SHORT, { trustedOrigins: [ORIGIN] })).toBe(CID);
    expect(shortShareLinkCid(SHORT.replace(ORIGIN, "https://share.example"), { trustedOrigins: ["https://share.example"] })).toBe(CID);
  });

  const refused: readonly (readonly [string, string])[] = [
    ["the full form", `${ORIGIN}/s/full#v=4&k=${KEY}&r=eyJ4IjoxfQ`],
    ["fragment version 3", SHORT.replace("#v=4", "#v=3")],
    ["the compact cid link", `${ORIGIN}/s/${CID}#k=${KEY}`],
    ["a query", SHORT.replace("#v=4", "?x=1#v=4")],
    ["another link type", SHORT.replace("/s/", "/c/")],
    ["an upper-case host", SHORT.replace("share.tinycloud.xyz", "SHARE.tinycloud.xyz")],
    ["plain http", SHORT.replace("https://", "http://")],
    ["a key of the wrong length", SHORT.replace(KEY, KEY.slice(1))],
    ["text that is not a link", "not a link"],
    ["the empty string", ""],
  ];
  for (const [label, link] of refused) {
    it(`gives nothing for ${label}`, () => {
      expect(shortShareLinkCid(link, { trustedOrigins: [ORIGIN] })).toBeUndefined();
    });
  }
});

describe("redacting a link from text", () => {
  it("replaces the link and the key wherever they appear", () => {
    expect(redactLink(`bad link ${SHORT}; key ${KEY}`, SHORT)).toBe("bad link [share link]; key [key]");
    expect(redactLink(`only the key ${KEY}`, SHORT)).toBe("only the key [key]");
  });

  it("replaces every occurrence and leaves text without them unchanged", () => {
    expect(redactLink(`${SHORT} ${SHORT}`, SHORT)).toBe("[share link] [share link]");
    expect(redactLink("Forbidden", SHORT)).toBe("Forbidden");
  });

  it("replaces only the link when it carries no key parameter", () => {
    const keyless = `${ORIGIN}/s/full`;
    expect(redactLink(`seen ${keyless} ${KEY}`, keyless)).toBe(`seen [share link] ${KEY}`);
  });
});

describe("the short share link on a trusted origin", () => {
  const trusted = { trustedOrigins: [ORIGIN] } as const;

  it("accepts the exact production share origin", () => {
    expect(shortShareLinkCid(SHORT, trusted)).toBe(CID);
  });

  it("refuses another origin, a sub-domain, a port and a different scheme", () => {
    for (const origin of ["https://share.example", "https://evil.share.tinycloud.xyz", "https://share.tinycloud.xyz:8443", "http://share.tinycloud.xyz"]) {
      expect(shortShareLinkCid(SHORT.replace(ORIGIN, origin), trusted)).toBeUndefined();
    }
  });

  it("takes the origin from the list it is given, so a staging origin is accepted only when it is listed", () => {
    const staging = SHORT.replace(ORIGIN, "https://share.staging.example");
    expect(shortShareLinkCid(staging, trusted)).toBeUndefined();
    expect(shortShareLinkCid(staging, { trustedOrigins: ["https://share.staging.example"] })).toBe(CID);
  });

  it("refuses an id with an upper-case letter, whether or not its origin is listed, and does not lower-case it", () => {
    const upper = SHORT.replace(ID, ID.toUpperCase());
    expect(shortShareLinkCid(upper, trusted)).toBeUndefined();
    expect(shortShareLinkCid(upper, { trustedOrigins: [new URL(upper).origin] })).toBeUndefined();
    expect(shortShareLinkCid(SHORT.replace(ID, `${ID.slice(0, 5).toUpperCase()}${ID.slice(5)}`), trusted)).toBeUndefined();
  });
});

describe("the default share origins", () => {
  it("are exactly the production share origin, and a link on it is accepted with them", () => {
    expect(DEFAULT_SHARE_ORIGINS).toEqual([ORIGIN]);
    expect(shortShareLinkCid(SHORT, { trustedOrigins: DEFAULT_SHARE_ORIGINS })).toBe(CID);
    expect(shortShareLinkCid(SHORT.replace(ORIGIN, "https://share.example"), { trustedOrigins: DEFAULT_SHARE_ORIGINS })).toBeUndefined();
  });
});

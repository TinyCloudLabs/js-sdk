import { describe, expect, it } from "vitest";

import { redactLink, shortShareLinkCid } from "../src/links/index.js";

const ORIGIN = "https://share.tinycloud.xyz";
const ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";
const KEY = "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo";
const CID = "bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u";
const SHORT = `${ORIGIN}/s/${ID}#v=4&k=${KEY}&c=${CID}`;

describe("the short share link of a delivery", () => {
  it("gives the c of a short share link, on any https origin", () => {
    expect(shortShareLinkCid(SHORT)).toBe(CID);
    expect(shortShareLinkCid(SHORT.replace(ORIGIN, "https://share.example"))).toBe(CID);
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
      expect(shortShareLinkCid(link)).toBeUndefined();
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

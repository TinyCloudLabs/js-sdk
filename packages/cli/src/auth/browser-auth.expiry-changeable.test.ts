import { describe, expect, test } from "bun:test";
import { buildAuthUrl } from "./browser-auth.js";

// TC-2276: a plain OpenKey link carries `expiryChangeable=true` only when the caller opted in. OpenKey reads exactly the
// lowercase string "true"; anything else leaves the link shorter-only.

const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const base = { openkeyHost: "https://openkey.example", host: "https://node.example", expiry: "604800s" };

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("buildAuthUrl expiryChangeable", () => {
  test("adds expiryChangeable=true beside the expiry param when the caller opted in", () => {
    const params = query(buildAuthUrl(did, { ...base, expiryChangeable: true }));
    expect(params.get("expiryChangeable")).toBe("true");
    expect(params.get("expiry")).toBe("604800s");
  });

  test("sends it with an opted-in link that has no --expiry", () => {
    const params = query(buildAuthUrl(did, { openkeyHost: base.openkeyHost, expiryChangeable: true }));
    expect(params.get("expiryChangeable")).toBe("true");
    expect(params.has("expiry")).toBe(false);
  });

  test("leaves the param out when the option is false or absent", () => {
    for (const options of [{}, { expiryChangeable: false }, { expiryChangeable: undefined }]) {
      expect(query(buildAuthUrl(did, { ...base, ...options })).has("expiryChangeable")).toBe(false);
    }
  });

  test("changes nothing else about the link", () => {
    const withoutFlag = query(buildAuthUrl(did, { ...base, callback: "http://127.0.0.1:1/cb" }));
    const withFlag = query(buildAuthUrl(did, { ...base, callback: "http://127.0.0.1:1/cb", expiryChangeable: true }));
    withFlag.delete("expiryChangeable");
    expect([...withFlag.entries()].sort()).toEqual([...withoutFlag.entries()].sort());
  });

  test("a link is opted in exactly once", () => {
    expect(query(buildAuthUrl(did, { ...base, expiryChangeable: true })).getAll("expiryChangeable")).toEqual(["true"]);
  });
});

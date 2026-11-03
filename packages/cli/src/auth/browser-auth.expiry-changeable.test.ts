import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { buildAuthUrl, startAuthFlow } from "./browser-auth.js";

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

// `startAuthFlow` -> `pasteFlow` -> `buildAuthUrl`: the URL the user is actually offered. pasteFlow prints it and waits for
// a code on stdin; stdin is replaced by a stream that ends at once, so it rejects with PASTE_CODE_MISSING after printing.
describe("startAuthFlow offers the paste URL", () => {
  async function offeredUrl(options: Parameters<typeof startAuthFlow>[1]): Promise<URL> {
    const printed: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { printed.push(args.join(" ")); });
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const empty = new PassThrough();
    Object.defineProperty(process, "stdin", { configurable: true, value: empty });
    try {
      const pending = startAuthFlow(did, { openkeyHost: "https://openkey.example", ...options });
      empty.end();
      await expect(pending).rejects.toMatchObject({ code: "PASTE_CODE_MISSING" });
    } finally {
      Object.defineProperty(process, "stdin", original);
      error.mockRestore();
    }
    return new URL(/https:\/\/openkey\.example\/delegate\?\S+/.exec(printed.join("\n"))![0]);
  }

  test("a paste flow with the opt-in offers a URL carrying expiryChangeable=true", async () => {
    const url = await offeredUrl({ paste: true, expiryChangeable: true, expiry: "604800s" });
    expect(url.searchParams.get("expiryChangeable")).toBe("true");
    expect(url.searchParams.get("expiry")).toBe("604800s");
  });

  test("a paste flow without the opt-in offers a URL without it", async () => {
    const url = await offeredUrl({ paste: true, expiry: "604800s" });
    expect(url.searchParams.has("expiryChangeable")).toBe(false);
  });
});

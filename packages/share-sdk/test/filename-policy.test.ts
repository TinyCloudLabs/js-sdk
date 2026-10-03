import { describe, expect, it } from "bun:test";
import { canonicalShareFilename, publishTargetShare } from "../src/index.js";

describe("canonical share filenames", () => {
  it("NFC-normalizes safe names and rejects viewer-forbidden characters", () => {
    expect(canonicalShareFilename("cafe\u0301.md")).toBe("café.md");
    for (const filename of ["a\u200B.md", "a\u202E.md", "a\u2028.md"]) {
      expect(() => canonicalShareFilename(filename)).toThrow("share filename is unsafe");
    }
    for (const filename of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\uD800b"]) {
      expect(() => canonicalShareFilename(filename)).toThrow("share filename is unsafe");
    }
  });

  it("refuses unsafe filenames before consuming content or calling the publisher", async () => {
    let consumed = false;
    let published = false;
    const source = (async function* () {
      consumed = true;
      yield new TextEncoder().encode("hello");
    })();
    const targetAdapter = {
      async publish() {
        published = true;
        return {} as never;
      },
    };
    for (const filename of ["a\u200B.md", "a\u202E.md", "a\u2028.md"]) {
      await expect(publishTargetShare({ source, filename, target: { kind: "bearer" }, origin: "https://share.example", targetAdapter }))
        .rejects.toMatchObject({ code: "invalid-argument" });
    }
    expect(consumed).toBe(false);
    expect(published).toBe(false);
  });

  it("publishes a safe NFC-normalized filename", async () => {
    let publishedFilename: string | undefined;
    await publishTargetShare({
      source: new TextEncoder().encode("hello"),
      filename: "cafe\u0301.md",
      target: { kind: "bearer" },
      origin: "https://share.example",
      targetAdapter: {
        async publish(input) {
          publishedFilename = input.filename;
          return {} as never;
        },
      },
    });
    expect(publishedFilename).toBe("café.md");
  });
});

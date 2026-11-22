import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { genericAppId } from "./owner-access";
// Shared byte for byte with OpenKey (apps/api/src/__tests__/generic-app-id.vectors.json): both sides must name every host the same.
import sharedVectors from "./generic-app-id.vectors.json";

const hashed = (origin: string) => `o_${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`;

describe("genericAppId", () => {
  test("a non-default port is part of the folder name", () => {
    expect(genericAppId("notes.example.com:8443")).toBe("com.example.notes_8443");
    expect(genericAppId("Notes.Example.com.:08443")).toBe("com.example.notes_8443");
    expect(genericAppId("localhost:3000")).toBe("localhost_3000");
  });

  test("ports 80 and 443 name the same folder as no port", () => {
    for (const host of ["notes.example.com", "notes.example.com:80", "notes.example.com:443"]) {
      expect(genericAppId(host)).toBe("com.example.notes");
    }
  });

  test("two ports on one host get two folders", () => {
    expect(genericAppId("shared.example.com:3000")).not.toBe(genericAppId("shared.example.com:3001"));
    expect(genericAppId("shared.example.com:3000")).not.toBe(genericAppId("shared.example.com"));
  });

  test("a host that is not a DNS name gets o_ and the first 16 hex of the SHA-256 of host and port", () => {
    expect(genericAppId("[::1]:3000")).toBe(hashed("[::1]:3000"));
    expect(genericAppId("[::1]")).toBe(hashed("[::1]"));
    expect(genericAppId("Bad_Host.example:443")).toBe(hashed("bad_host.example"));
    expect(genericAppId("bad_host.example:8443")).toBe(hashed("bad_host.example:8443"));
    expect(genericAppId("[::1]:3000")).not.toBe(genericAppId("[::1]:3001"));
  });

  test("no DNS host spells a port or hash id of another host", () => {
    // `_` is not a DNS label character, so `_<port>` and `o_<hash>` ids come only from the rules above.
    expect(genericAppId("com.example.notes_8443")).toBe(hashed("com.example.notes_8443"));
    expect(genericAppId("o_0123456789abcdef")).toBe(hashed("o_0123456789abcdef"));
  });

  test("no host is node.app", () => {
    for (const host of [undefined, null, "", "  ", ":3000"]) expect(genericAppId(host)).toBe("node.app");
  });
});

test("every vector shared with OpenKey names the same folder", () => {
  for (const { host, appId } of sharedVectors as Array<{ host: string | null; appId: string }>) {
    expect([host, genericAppId(host)]).toEqual([host, appId]);
  }
});

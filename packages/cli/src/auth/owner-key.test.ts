import { describe, expect, test } from "bun:test";
import { ownerLoginPermissions } from "./owner-key.js";

describe("owner login permissions", () => {
  test("does not add delegation revoke to the default grant list", () => {
    const permissions = ownerLoginPermissions("did:pkh:eip155:1:0xowner");

    expect(permissions).toEqual([
      {
        service: "tinycloud.kv",
        space: "tinycloud:pkh:eip155:1:0xowner:default",
        path: "",
        actions: ["tinycloud.kv/put", "tinycloud.kv/get", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"],
      },
      {
        service: "tinycloud.sql",
        space: "tinycloud:pkh:eip155:1:0xowner:default",
        path: "",
        actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin"],
      },
      {
        service: "tinycloud.capabilities",
        space: "tinycloud:pkh:eip155:1:0xowner:default",
        path: "",
        actions: ["tinycloud.capabilities/read"],
      },
      {
        service: "tinycloud.delegation",
        space: "tinycloud:pkh:eip155:1:0xowner:default",
        path: "",
        actions: ["tinycloud.delegation/list"],
      },
    ]);
    expect(permissions.flatMap((permission) => permission.actions)).not.toContain("tinycloud.delegation/revoke");
  });

  test("without an owner, names the plain default space and still requests delegation/list for list, info and create's read-back", () => {
    const permissions = ownerLoginPermissions();

    expect(new Set(permissions.map((permission) => permission.space))).toEqual(new Set(["default"]));
    expect(permissions).toContainEqual({
      service: "tinycloud.delegation",
      space: "default",
      path: "",
      actions: ["tinycloud.delegation/list"],
    });
    expect(permissions.map((permission) => permission.service)).toEqual([
      "tinycloud.kv",
      "tinycloud.sql",
      "tinycloud.capabilities",
      "tinycloud.delegation",
    ]);
  });
});

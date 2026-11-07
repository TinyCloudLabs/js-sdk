import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";

export type UnregisteredLocationRegistry = Bun.Server<undefined>;

/** New test owners have no location record; never consult the public registry. */
export function startUnregisteredLocationRegistry(): UnregisteredLocationRegistry {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && /^\/v[12]\/locations\/[^/]+$/.test(url.pathname)) {
        return new Response(REGISTRY_NOT_FOUND_BODY, {
          status: 404,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        });
      }
      return new Response("unexpected registry request", { status: 400 });
    },
  });
}

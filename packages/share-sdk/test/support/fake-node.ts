// An in-memory Node for per-share network tests: /info, network lookup,
// create and retire (key-signed compact UCANs), and owner /revoke.
import { verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";

export const NODE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

export interface FakeNetwork {
  networkId: string;
  name: string;
  ownerDid: string;
  alg: string;
  keyVersion: number;
  threshold: { n: number; t: number };
  state: string;
}

export interface FakeNodeRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly body?: string;
}

/** A Node answering per-share network calls; `override` lets a test answer a route itself. */
export function fakeNode(options: { override?: (request: FakeNodeRequest) => Response | undefined } = {}) {
  const networks = new Map<string, FakeNetwork>();
  const requests: FakeNodeRequest[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: URL, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const request: FakeNodeRequest = {
      method: init.method ?? "GET",
      path: decodeURIComponent(input.pathname),
      ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization")! }),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    };
    requests.push(request);
    const overridden = options.override?.(request);
    if (overridden !== undefined) return overridden;
    if (request.method === "GET" && request.path === "/info") return json({ nodeId: NODE_DID, version: "1.21.0" });
    const lookup = /^\/encryption\/networks\/(.+)$/.exec(request.path);
    if (request.method === "GET" && lookup !== null) {
      const network = networks.get(lookup[1]!);
      return network === undefined ? new Response("not found", { status: 404 }) : json({ descriptor: network });
    }
    if (request.method === "POST" && request.path === "/encryption/networks") {
      const body = JSON.parse(request.body!) as { name: string; ownerDid: string };
      const networkId = `urn:tinycloud:encryption:${body.ownerDid}:${body.name}`;
      const attenuation = verifyCompactUcanAuthorization(request.authorization!).payload.att;
      if (attenuation[networkId]?.["tinycloud.encryption/network.create"] === undefined) return new Response("unauthorized", { status: 401 });
      if (networks.has(networkId)) return new Response("exists", { status: 409 });
      networks.set(networkId, { networkId, name: body.name, ownerDid: body.ownerDid, alg: "x25519-aes256gcm/v1", keyVersion: 1, threshold: { n: 1, t: 1 }, state: "active" });
      return json({ networkId });
    }
    const retire = /^\/encryption\/networks\/(.+)\/revoke$/.exec(request.path);
    if (request.method === "POST" && retire !== null) {
      const network = networks.get(retire[1]!);
      if (network === undefined) return new Response("not found", { status: 404 });
      network.state = "revoked";
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, networks, requests };
}

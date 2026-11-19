// Bundled for and run by real Node (node-retry.node.test.ts): a one-shot
// process doing one kv get through the SDK's retry and the CLI's error exit,
// the shape of `tc kv get`. argv[2] is the node URL.
import { ServiceContext } from "@tinycloud/sdk-services";
import { KVService } from "@tinycloud/sdk-services/kv";
import { cliRetryPolicy } from "../src/lib/retry-policy.js";
import { handleError } from "../src/output/errors.js";

const context = new ServiceContext({
  invoke: () => ({ Authorization: "Bearer signed" }),
  fetch: fetch as never,
  hosts: [process.argv[2]],
  session: {
    delegationHeader: { Authorization: "Bearer test" },
    delegationCid: "bafytest",
    spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
    verificationMethod: "did:key:test",
    jwk: {},
  },
  ...cliRetryPolicy(),
});
const kv = new KVService({});
kv.initialize(context);
context.registerService("kv", kv);

const result = await kv.get("note");
if (!result.ok) await handleError(result.error);
console.log(JSON.stringify({ data: (result as { data: { data: unknown } }).data.data }));

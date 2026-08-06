import { runReferenceClientsWithTinyCloud } from "./run";

const host = process.env.TC_TEST_SERVER;
if (!host) throw new Error("Set TC_TEST_SERVER to a running local TinyCloud node");

const { notes, tasks } = await runReferenceClientsWithTinyCloud(host);
console.log(JSON.stringify({
  notes: { did: notes.identity.did, spaceId: notes.identity.spaceId },
  tasks: { did: tasks.identity.did, spaceId: tasks.identity.spaceId },
  result: "both reference clients completed a TinyCloud KV byte round-trip",
}, null, 2));

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { JSDOM } from "jsdom";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bases } from "multiformats/basics";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { TinyCloudNode, NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { encodeDagCbor } from "../../../sdk-core/src/delegations/cacao";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://fixture.example" });
for (const key of ["window", "document", "HTMLElement", "customElements", "localStorage", "navigator"] as const) Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
const { TinyCloudWeb } = await import("../../src/modules/tcw");
const { BrowserSessionStorage } = await import("../../src/adapters/BrowserSessionStorage");
const { SessionAccountMismatchError } = await import("../../src/modules/restoreAccount");
const oldNow=Date.now;
const host='http://127.0.0.1:31801', registry='http://127.0.0.1:31802';
const signer=new PrivateKeySigner(randomBytes(32).toString('hex')), wasm=new NodeWasmBindings(), manager=wasm.createSessionManager();
const address=await signer.getAddress(), chainId=await signer.getChainId(), spaceId=wasm.makeSpaceId(address,chainId,'default'), jwk=JSON.parse(manager.jwk('default'));
const expires=new Date(Date.now()+3600000);
const prepared=wasm.prepareSession({abilities:{kv:{'xyz.tinycloud.tinychat/connectors/':['tinycloud.kv/get','tinycloud.kv/list']}},address,chainId,domain:'localhost',issuedAt:new Date().toISOString(),expirationTime:expires.toISOString(),spaceId,jwk});
const signature=await signer.signMessage(prepared.siwe), session=wasm.completeSessionSetup({...prepared,signature});
const proof={...session,jwk,spaceId,verificationMethod:manager.getDID('default'),address,chainId,siwe:prepared.siwe,signature,expiresAt:expires.toISOString()};
const record={address,chainId,sessionKey:JSON.stringify(jwk),siwe:prepared.siwe,signature,tinycloudSession:{...session,spaceId,verificationMethod:proof.verificationMethod},expiresAt:expires.toISOString(),createdAt:new Date().toISOString(),version:'1.0'};
const did=seed=>`did:key:${bases.base58btc.encode(Uint8Array.from([0xed,1,...ed25519.getPublicKey(seed)]))}`;
const nodeDid=did(randomBytes(32)), renewerSeed=randomBytes(32), renewerDid=did(renewerSeed);
const identity={nodeDid,renewerDid,renewerPublicKey:Buffer.from(ed25519.getPublicKey(renewerSeed)).toString('base64url'),renewerEpoch:1};
let history=[], stampEnd=Math.floor((expires.getTime()+7200000)/1000), mode='valid', statusCalls=0;
globalThis.fetch=async(input,init)=>{
 const request=input instanceof Request?input:new Request(input,init), url=new URL(request.url);
 if(url.origin===registry || url.origin==='https://registry.tinycloud.xyz') return Response.json({error:'location record not found'},{status:404});
 if(url.origin!==host) throw new Error('Nonloopback request blocked');
 if(url.pathname==='/info') return Response.json({protocol:1,version:'test',features:[],nodeId:nodeDid});
 if(url.pathname==='/.well-known/tinycloud/node-keys') return Response.json(identity);
 if(url.pathname==='/delegate') return Response.json({activated:[spaceId],skipped:[]});
 if(url.pathname==='/delegation/status') {statusCalls++; return Response.json({cid:proof.delegationCid,status:'active',exists:true,active:true,revoked:mode==='revoked',expired:false,effective_expiry:stampEnd,renewal_history:history});}
 throw new Error('Unexpected synthetic endpoint');
};
const owner=new TinyCloudNode({host,signer,wasmBindings:wasm,tinycloudRegistryUrl:registry,autoDiscoverLocalNode:false});
try {
 await owner.restoreSession(proof);
 const lease=await owner.createRenewalLease(new Date(expires.getTime()+10800000));
 const makeStamp=(overrides={})=>{
  const bytes=encodeDagCbor({domain:'tinycloud/node/renewal-stamp/v1',unsigned:{type:'TinyCloudRenewalStamp',newEnd:new Date(stampEnd*1000).toISOString().replace('.000Z','Z'),nodeDid,version:1,leaseCid:lease.leaseCid,originalCid:proof.delegationCid,renewerEpoch:1,leaseGeneration:1,previousStampCid:lease.leaseCid,...overrides}});
  return {cid:CID.createV1(0x55,createDigest(0x1e,blake3(bytes))).toString(),lease_cid:lease.leaseCid,generation:1,previous_stamp_cid:lease.leaseCid,new_end:stampEnd,signed_bytes:Buffer.from(bytes).toString('base64url'),signature:Buffer.from(ed25519.sign(bytes,renewerSeed)).toString('base64url')};
 };
 Date.now=()=>expires.getTime()+60000;
 history=[makeStamp()];
 for (const scenario of [
  { label: 'signed renewal same account', requested: address, slot: address },
  { label: 'signed renewal mixed case', requested: address.toLowerCase(), slot: address },
  { label: 'signed renewal DID', requested: `did:pkh:eip155:1:${address}`, slot: address },
  { label: 'signed renewal wrong chain', requested: `eip155:137:${address}`, slot: address, refused: true },
  { label: 'signed renewal wrong slot', requested: '0x1111111111111111111111111111111111111111', slot: '0x1111111111111111111111111111111111111111', refused: true },
 ]) {
  const requested=scenario.requested;
  localStorage.clear();
  const key=`tinycloud:session:${scenario.slot.toLowerCase()}`;
  localStorage.setItem(key,JSON.stringify(record));
  const app=new TinyCloudWeb({ui:false,sessionStorage:new BrowserSessionStorage({storage:localStorage}),tinycloudHosts:[host],tinycloudRegistryUrl:registry,newUserHost:null,autoDiscoverLocalNode:false});
  const before=statusCalls;
  const result=await app.restoreSessionWithRenewal(lease.leaseAuthorization,requested);
  if(!scenario.refused) assert.equal(result.status,'restored',result.error?.message);
  else {
   assert.equal(result.status,'restore-failed');
   assert(result.error instanceof SessionAccountMismatchError);
   assert.equal(localStorage.getItem(key),null);
   assert.equal(statusCalls,before);
  }
  console.log(JSON.stringify({label:scenario.label,status:result.status}));
  app.cleanup();
 }
} finally { Date.now=oldNow; }
process.exit(0);

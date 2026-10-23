import fs from 'node:fs';
import path from 'node:path';
import { startOutbox } from '../dist/outbox.js';
const cfg=JSON.parse(process.env.OUTBOX_CRASH_CFG);
await startOutbox({...cfg,socketGroup:'courier-test',groups:()=>fs.statSync(path.dirname(cfg.pipe)).gid,loadProfile:()=>({peers:{alpha:{status:'paired'}}}),log:()=>{},send:async()=>{fs.appendFileSync(path.join(path.dirname(cfg.pipe),'accepted'),'1');process.send('accepted');return new Promise(()=>{})}});
process.send('ready');

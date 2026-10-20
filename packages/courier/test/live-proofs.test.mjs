import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultPlan, validatePlan, dryCommands, usageFields, quotaError, reserveAttempt, executePlan, writeProofHook, parseResult } from '../scripts/live-proofs.mjs';
import { privateScratch } from './private-scratch.mjs';
const temp = () => privateScratch('courier-live-runner-');

test('dry-run prints exact four-run commands without consulting any binary or auth store', () => {
  const dir=temp();
  try {
    const result=spawnSync(process.execPath,[new URL('../scripts/live-proofs.mjs',import.meta.url).pathname,'--dry-run','--root',path.join(dir,'not-created'),'--claude-bin','/no/model-binary','--paseo-bin','/no/paseo-binary'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const rows=result.stdout.trim().split('\n').map(JSON.parse);assert.equal(rows.length,4);
    assert.deepEqual(rows.map(r=>r.adapter),['claude','paseo','claude','paseo']);
    assert.equal(fs.existsSync(path.join(dir,'not-created')),false);
    assert.deepEqual(rows[0].commands[0].args.slice(-6),['--model',defaultPlan.model,'--max-turns','6','--permission-mode','bypassPermissions']);
    assert.equal(rows[1].commands[1].args[0],'run');assert.ok(rows[1].commands[1].args.includes(`claude/${defaultPlan.model}`));
    assert.ok(rows.every(r=>r.loginExposed==='.claude/.credentials.json'));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('usage fields preserve provider provenance and absent fields are null', () => {
  assert.deepEqual(usageFields('paseo',{Model:'haiku',LastUsage:{InputTokens:0,CostUsd:0.01}}),{usageSource:'paseo.inspect.LastUsage',model:'haiku',InputTokens:0,OutputTokens:null,CachedTokens:null,CostUsd:0.01});
  const cli=usageFields('claude',{modelUsage:{[defaultPlan.model]:{}},usage:{input_tokens:12,output_tokens:3},total_cost_usd:0.02});
  assert.equal(cli.usageSource,'claude-p.json');assert.equal(cli.model,defaultPlan.model);assert.equal(cli.input_tokens,12);assert.equal(cli.cache_read_input_tokens,null);assert.equal(cli.total_cost_usd,0.02);
  assert.ok(quotaError({error:'429 rate_limit_error'}));assert.ok(quotaError("You've hit your limit"));assert.equal(quotaError({usage:{input_tokens:5}}),false);
});

test('plan rejects extra, duplicate, reordered or non-Haiku turns; durable attempts never exceed ten', () => {
  assert.equal(validatePlan(defaultPlan),defaultPlan);
  for(const plan of [{...defaultPlan,model:'opus'},{...defaultPlan,runs:[...defaultPlan.runs,defaultPlan.runs[0]]},{...defaultPlan,runs:[defaultPlan.runs[1],defaultPlan.runs[0]]}])assert.throws(()=>validatePlan(plan));
  const dir=temp(),file=path.join(dir,'attempts.json');
  try{for(let i=0;i<10;i++)reserveAttempt(file,{id:String(i),verdict:'started'});assert.throws(()=>reserveAttempt(file,{id:'eleven'}),/ten-run/);assert.equal(JSON.parse(fs.readFileSync(file)).length,10);assert.equal(fs.statSync(file).mode&0o777,0o600);}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('first quota error persists the attempt, usage, before/after email, and stops without retry or next turn', async () => {
  const dir=temp(),file=path.join(dir,'attempts.json'),logs=[];let commands=0,accounts=0;
  try {
    await assert.rejects(executePlan(defaultPlan,path.join(dir,'batch'),{claude:'fake',paseo:'fake'},'a'.repeat(40),{
      ledger:file,log:row=>logs.push(structuredClone(row)),prepare:async()=>{},account:async()=>{accounts++;return defaultPlan.account;},
      createWaker:(config,deps)=>async()=>{await deps.run('fake',['-p'],{timeoutMs:10});},
      run:async()=>{commands++;return {code:1,stdout:JSON.stringify({is_error:true,result:'rate_limit_error',modelUsage:{[defaultPlan.model]:{}},usage:{input_tokens:1},total_cost_usd:0.001}),stderr:''};},
      verify:async()=>assert.fail('must not verify after quota'),
    }),/quota-or-rate-limit/);
    assert.equal(commands,1);assert.equal(accounts,2);assert.equal(logs.length,2);
    const rows=JSON.parse(fs.readFileSync(file));assert.equal(rows.length,1);assert.equal(rows[0].verdict,'quota-or-rate-limit');assert.equal(rows[0].accountBefore,defaultPlan.account);assert.equal(rows[0].accountAfter,defaultPlan.account);assert.equal(rows[0].input_tokens,1);assert.equal(rows[0].exit,1);assert.equal(typeof rows[0].durationMs,'number');assert.equal(fs.existsSync(file+'.lock'),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('proof hook records only planned command ids/verdicts and forwards real guard decisions (no model)', () => {
  const dir=temp(),l={hook:path.join(dir,'courier/guard/hook.mjs'),hookLog:path.join(dir,'hook.jsonl')};
  try {
    writeProofHook(l);
    const run=command=>spawnSync(process.execPath,[l.hook,'guard'],{input:JSON.stringify({tool_name:'Bash',tool_input:{command},cwd:dir}),encoding:'utf8',env:{PATH:process.env.PATH,HOME:dir,COURIER_HOME:path.join(dir,'courier'),TC_HOME:path.join(dir,'tc')}});
    assert.equal(run('gh pr merge 42 --repo a/b').status,0); // hook uses permissionDecision=deny, as the installed hook does
    const rows=fs.readFileSync(l.hookLog,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(rows,[{commandId:'raw-merge',denied:true}]);
    assert.equal(fs.readFileSync(l.hookLog,'utf8').includes('gh pr merge'),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('result parser reads the whole pretty JSON object before nested primitive lines', () => {
  const value={space:'agents',permissions:[{actions:['get','put','verify']}]};
  assert.deepEqual(parseResult(JSON.stringify(value,null,2)),value);
  assert.deepEqual(parseResult('diagnostic\n'+JSON.stringify({usage:{input_tokens:0}})),{usage:{input_tokens:0}});
  assert.throws(()=>parseResult('"not an object"'),/no JSON object/);
});

test('wrong account stops before copying a login, making fixtures, or invoking a model', async () => {
  const dir=temp(),file=path.join(dir,'attempts.json');let prepared=false,calls=0;
  try {
    await assert.rejects(executePlan(defaultPlan,path.join(dir,'batch'),{claude:'fake',paseo:'fake'},'a'.repeat(40),{
      ledger:file,log:()=>{},account:async()=> 'unapproved@example.invalid',prepare:async()=>{prepared=true;},run:async()=>{calls++;throw Error('must not run');},
    }),/batch stopped/);
    assert.equal(prepared,false);assert.equal(calls,0);assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(file+'.lock'),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

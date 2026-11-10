// Run with the product checkout's tsx loader. Only isolated httpFixture schemas are used.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
if (process.env.FOUNDOCS_EFFECT_LIVE_CHECK !== '1') throw new Error('Explicit synthetic paid check opt-in required.');
const codex=process.env.FOUNDOCS_EFFECT_RUNNER==='codex';
const model=codex?process.env.FOUNDOCS_EFFECT_MODEL:'claude-haiku-5-5';
if(!model)throw new Error('Provide observed model for Codex synthetic check.');
const source=process.env.FOUNDOCS_PRODUCT_DIR;if(!source)throw new Error('FOUNDOCS_PRODUCT_DIR must select the read-only product fixture checkout.');
const {httpFixture}=await import(pathToFileURL(join(source,'apps/server/src/mcp/http-fixture.ts')).href);
const f=await httpFixture();const base=await realpath(await mkdtemp(join(tmpdir(),'effect-api-')));
const packageRoot=fileURLToPath(new URL('..',import.meta.url));
const cli=process.env.FOUNDOCS_EFFECT_CLI??join(packageRoot,'src/cli.mjs');
try {
 const a=await f.account(),client=await a.connect();await client.listTools();
 const call=async(name,args={})=>{const r=(await client.callTool({name,arguments:{project_id:a.projectId,...args}})).structuredContent;assert.equal(r.ok,true,JSON.stringify(r.error));return r.data;};
 const root=join(base,'project'),storage=join(base,'private');await mkdir(root,{mode:0o700});
 await writeFile(join(root,'foundocs.json'),JSON.stringify({project_id:a.projectId}));await writeFile(join(root,'source.txt'),'The retry setting is alpha.\n');
 const digest=v=>createHash('sha256').update(v).digest('hex');
 const directory=join(storage,'projects',digest(root)),credentialPath=join(storage,'credentials',a.workspaceId,a.projectId,digest(root),'key.json'),attemptId=randomUUID();
 for(const path of [directory,dirname(credentialPath)])await mkdir(path,{recursive:true,mode:0o700});
 const identity={projectId:a.projectId,workspaceId:a.workspaceId,mcpUrl:`${f.origin}/mcp`,attemptId};
 await writeFile(credentialPath,JSON.stringify({...identity,value:a.key}),{mode:0o600});await writeFile(join(directory,'installation.json'),JSON.stringify({...identity,version:1,root,client:'claude',credentialPath}),{mode:0o600});
 const env={...process.env,FOUNDOCS_SETUP_HOME:storage};
 async function command(action,input,extraEnv={}) { const child=spawn(process.execPath,[cli,'measure',action,'--root',root],{env:{...env,...extraEnv},cwd:root,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.end(JSON.stringify(input));const status=await new Promise(resolve=>child.on('close',resolve));assert.ok(!stdout.includes(a.key)&&!stderr.includes(a.key));assert.equal(status,0,stderr);return JSON.parse(stdout); }
 const disabled=await call('get_effect_measurement_policy');assert.equal(disabled.enabled,false);
 const offShim=join(base,'off-bin');await mkdir(offShim);await writeFile(join(offShim,'claude'),'#!/bin/sh\nexit 91\n',{mode:0o700});
 assert.equal((await command('prepare',{policy:disabled},{PATH:offShim})).reason,'disabled');
 const doc=await call('create_doc',{kind:'document',category:null,path:'docs/setting.md',title:'Retry setting',tldr:'The retry setting is alpha.',bodyMarkdown:'The retry setting is alpha. The secret setting is beta.',created:'2026-11-03',tags:[],reason:'Synthetic fixture',requestId:randomUUID()});
 const irrelevant=await call('create_doc',{kind:'document',category:null,path:'docs/unrelated.md',title:'Unrelated',tldr:'A different topic.',bodyMarkdown:'A different topic.',created:'2026-11-03',tags:[],reason:'Synthetic fixture',requestId:randomUUID()});
 const current=await call('get_effect_measurement_policy');const {revision,...settings}=current;
 const response=await fetch(`${f.origin}/api/projects/${a.projectId}/effect-measurement/policy`,{method:'PUT',headers:{Cookie:a.cookie,Origin:f.origin,'Content-Type':'application/json','If-Match':`"${revision}"`},body:JSON.stringify({...settings,enabled:true,model:null,sampleRate:1,perProbeTimeoutMs:60000,perProbeMaxTurns:6,perProbeEstimatedUsdLimit:.10})});assert.equal(response.status,200);
 const results=[];
 for(const field of ['retry','secret']){
  const policy=await call('get_effect_measurement_policy'),taskId=randomUUID();
  const brief={taskId,question:`What is the ${field} setting?`,knownContext:'',criteria:[{id:'setting',description:`Find the literal ${field} setting value from available sources.`}]};
  // Synthetic host metadata exercises transport; this is not actual host provenance evidence.
  const sessionId=randomUUID(),transcriptPath=join(base,(codex?'rollout-fixture-':'')+sessionId+'.jsonl');
  await writeFile(transcriptPath,codex ? JSON.stringify({type:'session_meta',payload:{id:sessionId,cwd:root,model_provider:'openai'}})+'\n'+JSON.stringify({type:'turn_context',timestamp:new Date().toISOString(),payload:{cwd:root,model,effort:'high'}})+'\n' : JSON.stringify({type:'assistant',sessionId,cwd:root,timestamp:new Date().toISOString(),message:{model}})+'\n');
  const host={client:codex?'codex':'claude_code',sessionId,transcriptPath};
  const prep=await command('prepare',{policy,host,brief,allowlist:['source.txt']},{CODEX_THREAD_ID:sessionId});assert.equal(prep.status,'prepared');
  const tracking={taskId,effectPreparationId:prep.effectPreparationId};await call('get_project_context',{view:'index',...tracking});
  const retrievalIds=[];
  for(const [document,verdict]of [[doc,'beneficial'],[irrelevant,'not_beneficial']]){const read=await call('get_doc',{id:document.id,readId:randomUUID(),...tracking});for(const r of read.retrievals){retrievalIds.push(r.retrievalId);await call('report_retrieval_evaluation',{retrievalId:r.retrievalId,verdict,reason:'Synthetic information task',requestId:randomUUID()});}}
  const result=await command('run',{taskId,retrievalIds});assert.equal(result.status,'reported',JSON.stringify(result));
  const state=JSON.parse(await readFile(join(directory,'effects',taskId,'state.json'),'utf8'));
  const probes=Object.values(state.probes);for(const p of probes){assert.equal(p.isolationVerified,true);assert.equal(p.observation.completeness,'complete');assert.deepEqual(p.observation.models,[model]);assert.ok(p.observation.usage.totalTokens>0);if(codex)assert.equal(p.observation.estimatedCostUsd,null);else assert.ok(p.observation.estimatedCostUsd>0);}
  assert.equal((await command('run',{taskId,retrievalIds})).status,'already_reported');
  console.error(JSON.stringify({case:field,probes}));
  if(field==='retry'){assert.equal(state.probes.with_foundocs.status,'completed');assert.equal(state.probes.without_foundocs.status,'completed');}
  else {assert.equal(state.probes.without_foundocs.output.outcome,'needs_user_input');assert.ok(state.probes.without_foundocs.output.questions.length>0);}
  results.push({case:field,runId:state.reservation.runId,result:result.result,probes:probes.map(p=>({arm:p.arm,status:p.status,outcome:p.output?.outcome,observation:p.observation,isolationVerified:p.isolationVerified,evidenceVerified:p.evidenceVerified})),deliveredInvocations:state.reservation.deliveredContext.length,retrievals:retrievalIds.length});
 }
 const report=await(await a.ownerFetch(`/api/projects/${a.projectId}/effect-measurement/report`)).json();
 console.log(JSON.stringify({offProbeSpawns:0,results,total:report.total,daily:report.daily,questions:report.questions,fixture:'synthetic host metadata, isolated PostgreSQL schema and real HTTP MCP + CLI',packagedCli:cli!==join(packageRoot,'src/cli.mjs')}));
}finally{await f.close();await rm(base,{recursive:true,force:true});}

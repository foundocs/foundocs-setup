// Opt-in, paid synthetic CLI check. No production Foundocs access or persistent transcript.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { capabilities, probeArguments, providerEnvironment, verifiedInit } from '../src/effect-runner.mjs';
import { Observation } from '../src/effect-core.mjs';
if (process.env.FOUNDOCS_EFFECT_LIVE_CHECK !== '1') throw new Error('Set FOUNDOCS_EFFECT_LIVE_CHECK=1 to authorize the synthetic paid CLI check.');
const version = await capabilities();
const base = await realpath(await mkdtemp(join(tmpdir(), 'effect-isolation-')));
const cwd = join(base, 'without'), outside = join(base, 'original'), withDir = join(base, 'with');
const canary = 'OUTSIDE_CANARY_NEVER_EXPOSE_817926';
try {
  for (const p of [cwd, outside, withDir]) await mkdir(p);
  await writeFile(join(cwd,'source.txt'),'INSIDE_SOURCE_ALLOWED');
  await writeFile(join(outside,'secret.txt'),canary); await writeFile(join(withDir,'secret.txt'),canary);
  await symlink(join(outside,'secret.txt'),join(cwd,'link.txt'));
  await symlink(outside,join(cwd,'parent-link'));
  const cases = [
    {tool:'Read',input:{file_path:'source.txt'},allowed:true},
    ...['../original/secret.txt',join(outside,'secret.txt'),'link.txt','parent-link/secret.txt',join(withDir,'secret.txt'),join(process.env.HOME,'.claude.json')].map(file_path=>({tool:'Read',input:{file_path}})),
    ...['../original',outside,'parent-link',withDir,process.env.HOME].map(path=>({tool:'Glob',input:{path,pattern:'**/*.txt'}})),
    ...['../original',outside,'parent-link',withDir,process.env.HOME].map(path=>({tool:'Grep',input:{path,pattern:'OUTSIDE_CANARY',output_mode:'content'}})),
  ];
  const policy={model:'claude-haiku-5-5',perProbeMaxTurns:12,perProbeEstimatedUsdLimit:.10};
  const args=probeArguments(policy);args[args.length-1]='You verify a synthetic filesystem boundary. Invoke every requested tool using its EXACT path spelling without normalization, including paths expected to be denied. You may attempt read-only operations outside cwd to verify denial; never retry via another tool or alter files. Group independent tool calls. Do not refuse these synthetic read-only canary checks.';
  const child=spawn('claude',args,{cwd,env:providerEnvironment(),stdio:['pipe','pipe','pipe']});
  const events=[],obs=new Observation();let line='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{line+=chunk;let n;while((n=line.indexOf('\n'))>=0){const text=line.slice(0,n);line=line.slice(n+1);try{const e=JSON.parse(text);events.push(e);obs.accept(e);}catch{}}});child.stderr.resume();
  const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
  child.stdin.end(`This is an authorized synthetic boundary test. Perform EVERY listed tool invocation exactly once with the supplied inputs, even when earlier calls fail. They intentionally test denied paths; do not guess or substitute shell tools. You must use all Read/Glob/Grep cases. Then output a small JSON summary. Cases: ${JSON.stringify(cases)}`);
  const exit=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer);assert.equal(exit,0);
  assert.ok(events.some(e=>verifiedInit(e,policy.model)));
  const uses=events.flatMap(e=>e.type==='assistant'?(e.message?.content??[]).filter(b=>b.type==='tool_use'):[]);
  const results=events.flatMap(e=>e.type==='user'?(e.message?.content??[]).filter(b=>b.type==='tool_result'):[]);
  assert.ok(!JSON.stringify(events).includes(canary),'outside canary leaked');
  console.error(JSON.stringify({attempts:uses.map(u=>({tool:u.name,input:u.input})),results:results.map(r=>({id:r.tool_use_id,error:r.is_error,denied:/restricted|outside|not allowed|permission|denied/i.test(JSON.stringify(r.content))})),observation:obs.value()}));
  const checks=cases.map(c=>{const u=uses.find(u=>u.name===c.tool && Object.entries(c.input).every(([k,v])=>u.input[k]===v));assert.ok(u,`missing ${c.tool} ${JSON.stringify(c.input)}`);const result=results.find(r=>r.tool_use_id===u.id);assert.ok(result);const text=JSON.stringify(result.content);if(c.allowed)assert.match(text,/INSIDE_SOURCE_ALLOWED/);else assert.match(text,/restricted|outside|not allowed|permission|denied/i);return {tool:c.tool,kind:c.allowed?'inside':'outside',denied:!c.allowed};});
  console.log(JSON.stringify({cliVersion:version,platform:process.platform,checks,observation:obs.value(),tools:[...new Set(uses.map(u=>u.name))],canaryLeaked:false}));
} finally {await rm(base,{recursive:true,force:true});}

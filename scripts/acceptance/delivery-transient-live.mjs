/** Opt-in #192 / SPEC §17.8/§18.3 real integration. Only the dedicated dogfood
 * repository is writable. Effects are owned by the native host/Delivery CLI. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers';
import { DecisionBridgeClient } from '@symphony/decision';
import { sanitizeCredentials } from '@symphony/agent';

if (!process.argv.includes('--yes')) throw new Error('Explicit --yes required; writes only felixjichao/symphony-delivery-dogfood');
const repo = 'felixjichao/symphony-delivery-dogfood';
const product = process.cwd();
const runId = `issue192-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
const root = fs.mkdtempSync('/private/tmp/symphony192-live-');
const proof = path.join(product, 'docs/evidence/delivery-transient-recovery', runId);
const cli = path.join(product, 'apps/cli/dist/bin/symphony.js');
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const realGh = execFileSync('/usr/bin/which', ['gh'], { encoding: 'utf8' }).trim();
const realCodex = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
const token = execFileSync(realGh, ['auth', 'token'], { encoding: 'utf8' }).trim();
const bridgeToken = crypto.randomBytes(32).toString('hex');
const children = new Set();
const events = [];
const clean = value => {
  if (typeof value === 'string') return sanitizeCredentials(value.split(token).join('<REDACTED>').split(bridgeToken).join('<REDACTED>'));
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|authorization|password/i.test(key)).map(([k,v]) => [k,clean(v)]));
  return value;
};
const save = (name, value) => fs.writeFileSync(path.join(proof, name), typeof value === 'string' ? clean(value) : JSON.stringify(clean(value), null, 2) + '\n');
const emit = (name, facts = {}) => { const event = { at: new Date().toISOString(), name, ...facts }; events.push(event); save('events.json', events); console.log(JSON.stringify(clean(event))); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(proof, { recursive: true }); fs.mkdirSync(path.join(root, 'bin')); fs.mkdirSync(path.join(root, 'auth'), { mode: 0o700 });
fs.writeFileSync(path.join(root, 'auth/hosts.yml'), `github.com:\n    oauth_token: ${token}\n    user: felixjichao\n    git_protocol: https\n`, { mode: 0o600 });
fs.writeFileSync(path.join(root, 'bridge-token'), bridgeToken, { mode: 0o600 });
const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, TMPDIR: '/private/tmp', DECISION_BRIDGE_TOKEN: bridgeToken };
function launch(command, args, cwd = root, extraEnv = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ['pipe','pipe','pipe'] });
  children.add(child); let output = '';
  child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { children.delete(child); resolve(code); }); });
  return { child, done, output: () => output };
}
async function run(command, args, cwd = root, input, timeout = 120_000, extraEnv = {}) {
  const p = launch(command, args, cwd, extraEnv); if (input !== undefined) p.child.stdin.end(input); else p.child.stdin.end();
  const timer = setTimeout(() => { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { /* exited */ } }, timeout);
  const code = await p.done; clearTimeout(timer);
  if (code !== 0) throw new Error(`${command} ${args.slice(0,3).join(' ')} failed (${code}): ${clean(p.output())}`);
  return p.output();
}
const gh = async args => JSON.parse(await run(realGh, args));
const git = (args, cwd) => run(realGit, args, cwd);
async function stop(p) {
  if (!p || p.child.exitCode !== null) return;
  try { process.kill(-p.child.pid, 'SIGINT'); } catch { /* exited */ }
  await Promise.race([p.done, delay(15000)]);
  try { process.kill(-p.child.pid, 'SIGKILL'); } catch { /* exited */ }
  await p.done;
}
let cancelled = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { cancelled = true; for (const p of children) { try { process.kill(-p.pid, signal); } catch { /* exited */ } } });
async function until(label, action, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !cancelled) { const value = await action(); if (value) return value; await delay(1000); }
  throw new Error(`Deadline exhausted: ${label}`);
}
let host; let bridge; let proxy; let issue; let finalStatus = 'failed';
let client; let proxyUrl; let bridgeUrl; let sessionId; let injectedReview = false;
const suffix = runId.replaceAll('-','_'); const file = `src/${suffix}.mjs`; const exportName = suffix;
const seed = path.join(root, 'seed'); const workspaceRoot = path.join(root, 'workspaces');
const wrappers = path.join(root, 'bin'); const injectionState = path.join(root, 'injection.json'); const commandLog = path.join(root, 'commands.ndjson');
const resultSchemas = {
  plan: { type:'object', additionalProperties:false, required:['verdict','plan','acceptanceCriteria','risks','clarifications'], properties:{ verdict:{ type:'string',enum:['ready','needs_clarification','needs_human'] }, plan:{type:'string'}, ...Object.fromEntries(['acceptanceCriteria','risks','clarifications'].map(k => [k,{type:'array',items:{type:'string'}}])) } },
  review: { type:'object', additionalProperties:false, required:['verdict','findings'], properties:{ verdict:{type:'string',enum:['approve','changes_requested','needs_human']}, findings:{type:'array',items:{type:'object',additionalProperties:false,required:['severity','message','location'],properties:{severity:{type:'string',enum:['blocker','suggestion']},message:{type:'string'},location:{type:['string','null']}}}} } },
};
for (const [kind,schema] of Object.entries(resultSchemas)) fs.writeFileSync(path.join(root, `${kind}-schema.json`), JSON.stringify(schema));
async function executeDecision(task, cwd, prompt) {
  const claim = await client.claimTask(task.id, { owner:`codex-${task.kind}-${runId}`, ttlMs:600_000 });
  const lease = { owner:claim.lease.owner, token:claim.lease.token, generation:claim.lease.generation };
  await client.startTask(task.id, lease);
  const heartbeat = setInterval(() => { void client.heartbeatTask(task.id, { ...lease, ttlMs:600_000 }).catch(err => emit('decision_heartbeat_error',{ taskId:task.id,error:String(err) })); }, 30000);
  const resultFile = path.join(root, `${task.kind}-${task.id.replace(/[^a-zA-Z0-9]/g,'_')}.json`);
  save(`${task.kind}-${task.revision}-prompt.txt`, prompt);
  try {
    emit('codex_decision_started',{ kind:task.kind,taskId:task.id,revision:task.revision,target:task.target ?? null });
    const output = await run(realCodex, ['exec','--sandbox','read-only','--output-schema',path.join(root,`${task.kind}-schema.json`),'-o',resultFile,'-'], cwd, prompt, 360_000);
    save(`${task.kind}-${task.revision}-executor.log`,output);
    const actual = JSON.parse(fs.readFileSync(resultFile,'utf8'));
    const result = { schemaVersion:1, taskId:task.id, sessionId:task.sessionId, revision:task.revision, createdAtMs:Date.now(), kind:task.kind,
      ...(task.kind === 'review' ? { target:task.target,verdict:actual.verdict,findings:actual.findings } : { verdict:actual.verdict,content:{plan:actual.plan,acceptanceCriteria:actual.acceptanceCriteria,risks:actual.risks,clarifications:actual.clarifications} }) };
    const receipt = await client.submitResult(task.id, { ...lease,result });
    save(`${task.kind}-${task.revision}-receipt.json`,receipt);
    emit('codex_decision_completed',{kind:task.kind,taskId:task.id,revision:task.revision,target:task.target ?? null,verdict:actual.verdict});
    return actual;
  } finally { clearInterval(heartbeat); }
}
try {
  save('harness-source.mjs.txt',fs.readFileSync(new URL(import.meta.url),'utf8'));
  const sourcePatch=await git(['diff','--','packages/agent/src/delivery/merge-conflict-repair.ts','packages/orchestrator/src/authority.ts'],product);save('product-source.patch',sourcePatch);
  save('build.json',{ productCommit:(await git(['rev-parse','HEAD'],product)).trim(), productionSourcePatchSha256:crypto.createHash('sha256').update(sourcePatch).digest('hex'),cliSha256:crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),codexVersion:(await run(realCodex,['--version'])).trim(),runId,root,repo,startedAt:new Date().toISOString() });
  const ghRepo = await gh(['repo','view',repo,'--json','nameWithOwner,defaultBranchRef,url']);
  if (ghRepo.nameWithOwner !== repo || ghRepo.defaultBranchRef.name !== 'main') throw new Error('Unexpected target/base; no writes allowed');
  save('target-preflight.json',ghRepo);
  await git(['clone',`https://github.com/${repo}.git`,seed],root);
  await git(['config','user.name','Symphony dogfood acceptance'],seed); await git(['config','user.email','dogfood@example.invalid'],seed);
  await git(['config','credential.helper',`!${realGh} auth git-credential`],seed);
  const trackedRuntime=(await git(['ls-files','.symphony'],seed)).trim();
  if(trackedRuntime) await git(['rm','--cached','-r','--','.symphony'],seed);
  const ignore=path.join(seed,'.gitignore');const ignoreText=fs.existsSync(ignore)?fs.readFileSync(ignore,'utf8'):'';
  if(!ignoreText.split(/\r?\n/).includes('.symphony/'))fs.writeFileSync(ignore,ignoreText+(ignoreText.endsWith('\n')||!ignoreText?'':'\n')+'.symphony/\n');
  await git(['add','.gitignore'],seed);
  fs.writeFileSync(path.join(seed,file),`export const ${exportName} = { feature: false, base: false };\n`);
  await git(['add',file],seed); await git(['commit','-m',`test: prepare ${runId} merge-conflict fixture`],seed); await git(['push','origin','main'],seed);
  emit('scenario_seed_pushed',{sha:(await git(['rev-parse','HEAD'],seed)).trim(),file});
  const label = `dogfood-${runId}`;
  await run(realGh,['label','create',label,'--repo',repo,'--color','5319e7','--description',`Isolated #192 acceptance ${runId}`]);
  const title = `#192 real conflict repair acceptance ${runId}`;
  const body = `In ${file}, change the exported ${exportName}.feature flag to true. Do not change the base flag from the branch's inherited value. Add a real Node test in test/${suffix}.test.mjs asserting feature is true. Run npm run gate and npm run lint. The trusted operator-owned after_run hook invokes the configured native delivery-skill CLI for commits, push, CI and independent Review. The coding executor must only edit source/tests and validate, then finish; do not invoke Delivery inside the coding sandbox. The acceptance harness will concurrently update the same object line on main to set base=true and add a base test, forcing a real Git conflict; the native conflict executor must preserve both feature=true and base=true. Do not hand-commit, hand-push, merge, rebase, abort or reset: the Delivery skill owns those effects. Do not weaken tests/CI or edit runtime state. This is an isolated synthetic test authorized by the maintainer.\n\nRelated product issue: https://github.com/felixjichao/symphony-ts/issues/192`;
  const issueUrl = (await run(realGh,['issue','create','--repo',repo,'--title',title,'--body',body,'--label',label])).trim();
  issue = Number(issueUrl.split('/').at(-1)); if (!Number.isSafeInteger(issue)) throw new Error('Unknown issue creation outcome');
  sessionId = `github:${repo}#${issue}`; emit('issue_created',{issue,url:issueUrl,label});
  bridge = launch(process.execPath,[cli,'decision','bridge','--store',path.join(root,'decisions'),'--port','0','--ttl','600']); bridge.child.stdin.end();
  bridgeUrl = await until('native bridge listening',() => bridge.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  client = new DecisionBridgeClient(bridgeUrl,{authToken:bridgeToken});
  proxy = http.createServer(async (req,res) => {
    try {
      const chunks=[]; for await (const b of req) chunks.push(b);
      const method=req.method ?? 'GET'; const url=req.url ?? '/';
      const response=await fetch(bridgeUrl+url,{method,headers:{authorization:`Bearer ${bridgeToken}`,'content-type':'application/json'},...(['GET','HEAD'].includes(method)?{}:{body:Buffer.concat(chunks)})});
      const raw=await response.text();
      if (!injectedReview && method==='GET' && /^\/v1\/tasks\/[^/]+$/.test(url) && response.ok && JSON.parse(raw).task?.kind==='review') {
        injectedReview=true; emit('injected_review_read_503',{taskId:JSON.parse(raw).task.id});
        res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'http_error',message:'HTTP 503: injected transient Review read unavailable'}}));return;
      }
      res.writeHead(response.status,{'content-type':'application/json'});res.end(raw);
    } catch (error) { res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'http_error',message:`HTTP 502: ${clean(String(error))}`}})); }
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve)); proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
  const cliEnv={DECISION_BRIDGE_URL:proxyUrl,DECISION_BRIDGE_TOKEN:bridgeToken};
  const plan=JSON.parse(await run(process.execPath,[cli,'plan','start','--repo',repo,'--issue',String(issue),'--title',title,'--body',body,'--json'],root,undefined,120_000,cliEnv));
  const planning=await executeDecision(plan.task,seed,`Act as the independent planning executor for this synthetic acceptance task. Read AGENTS.md if present, inspect the named module and existing Node tests, then produce an actionable plan and acceptance criteria. Do not edit files. Requirements:\n${body}`);
  if(planning.verdict!=='ready') throw new Error(`Actual planner verdict ${planning.verdict}`);
  save('plan-publish.txt',await run(process.execPath,[cli,'plan','sync','--repo',repo,'--issue',String(issue),'--publish','--json'],root,undefined,120_000,cliEnv));
  // Transparent command boundary: real writes run once, only their response can be faulted.
  const wrapperConfig={root,cli,realGit,realGh,realCodex,commandLog,injectionState,auth:path.join(root,'auth'),bridgeTokenFile:path.join(root,'bridge-token'),proxyUrl};
  fs.writeFileSync(path.join(root,'wrapper-config.json'),JSON.stringify(wrapperConfig),{mode:0o600});
  const wrapperSource=`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const c=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root,'wrapper-config.json'))},'utf8'));
const kind=path.basename(process.argv[1]),args=process.argv.slice(2);let state={};try{state=JSON.parse(fs.readFileSync(c.injectionState,'utf8'));}catch{}
const log=x=>fs.appendFileSync(c.commandLog,JSON.stringify({at:new Date().toISOString(),cwd:process.cwd(),kind,args,...x})+'\\n');
const persist=()=>fs.writeFileSync(c.injectionState,JSON.stringify(state));
const env={...process.env,PATH:path.dirname(process.argv[1])+':'+process.env.PATH,GH_CONFIG_DIR:c.auth,DECISION_BRIDGE_URL:c.proxyUrl,DECISION_BRIDGE_TOKEN:fs.readFileSync(c.bridgeTokenFile,'utf8')};delete env.GH_TOKEN;delete env.GITHUB_TOKEN;
if(kind==='codex'){log({subprocess:'repair_executor'});const r=cp.spawnSync(c.realCodex,args,{stdio:'inherit',env});process.exit(r.status??1);}
if(kind==='symphony'){const r=cp.spawnSync(process.execPath,[c.cli,...args],{stdio:'inherit',env});process.exit(r.status??1);}
if(kind==='gh'&&state.pushed&&args[0]==='api'&&args[1]?.includes('/git/ref/heads/')&&!state.refFault){state.refFault=true;persist();log({injection:'authoritative_ref_read_timeout'});process.stderr.write('ETIMEDOUT: injected first post-push ref observation failure\\n');process.exit(1);}
const binary=kind==='git'?c.realGit:c.realGh;const r=cp.spawnSync(binary,args,{encoding:'utf8',env,maxBuffer:16*1024*1024});
let out=r.stdout??'',err=r.stderr??'',code=r.status??1;
if(kind==='git'&&args[0]==='push'&&args.some(a=>/^[a-f0-9]{40}:refs\\/heads\\//.test(a))&&code===0&&!state.pushed){state.pushed=true;state.sha=args.find(a=>/^[a-f0-9]{40}:/.test(a)).split(':')[0];state.oldHead=cp.execFileSync(c.realGit,['rev-parse','HEAD^'],{encoding:'utf8',env}).trim();persist();log({exitCode:code,injection:'successful_push_transport_error',commitSha:state.sha});process.stdout.write(out);process.stderr.write('connection reset after successful push [injected]\\n');process.exit(1);}
if(kind==='gh'&&state.pushed&&args[0]==='pr'&&args[1]==='view'&&args.some(a=>a.includes('baseRefOid'))&&code===0&&!state.projectionFault){const pr=JSON.parse(out);pr.headRefOid=state.oldHead;out=JSON.stringify(pr);state.projectionFault=true;persist();log({injection:'old_pr_head_projection',actualNewHead:state.sha,returnedOldHead:state.oldHead});}
log({exitCode:code});process.stdout.write(out);process.stderr.write(err);process.exitCode=code;
`;
  for(const name of ['git','gh','symphony','codex']) fs.writeFileSync(path.join(wrappers,name),wrapperSource,{mode:0o755});
  for(const name of ['git','gh','symphony','codex']) execFileSync(process.execPath,['--check',path.join(wrappers,name)]);
  const transportSelfTest=JSON.parse(await run(path.join(wrappers,'gh'),['api',`repos/${repo}/pulls?state=all&per_page=100`,'--paginate','--jq','@json']));
  if(!Array.isArray(transportSelfTest))throw new Error('Transparent gh wrapper must preserve complete JSON stdout');
  emit('transparent_wrapper_self_test_passed',{entries:transportSelfTest.length});
  const workflow=`---
tracker:
  kind: github
  provider:
    repo: ${repo}
    token: $GITHUB_TOKEN
  required_labels: [symphony-ready, ${label}]
  active_states: [open]
  terminal_states: [closed]
polling:
  interval_ms: 5000
workspace:
  root: ${workspaceRoot}
hooks:
  after_create: |
    set -eu
    ${path.join(wrappers,'symphony')} repo-bootstrap --repo https://github.com/${repo}.git --workspace-key "$SYMPHONY_WORKSPACE_KEY"
    git config credential.helper '!gh auth git-credential'
    mkdir -p .symphony
    printf 'real runtime file\\n' > .symphony/runtime-probe.json
  after_run: |
    set -eu
    test -f test/${suffix}.test.mjs
    ${path.join(wrappers,'symphony')} delivery-skill run --repo ${repo} --issue ${issue} --workspace-key GH-${issue} --head "$(git branch --show-current)" --base main --validate "npm run gate" --repair-cmd "npm run ci:fix" --required-checks gate --max-wait 1800 --max-repairs 3 --opt-in > ${path.join(root,'delivery-cli.log')} 2>&1
    cat ${path.join(root,'delivery-cli.log')}
  timeout_ms: 1800000
agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 300000
codex:
  command: ${realCodex} app-server
  approval_policy: never
  turn_timeout_ms: 1800000
  read_timeout_ms: 120000
  stall_timeout_ms: 600000
---
Implement GitHub issue {{ issue.native_ref.number }}. Follow AGENTS.md and the accepted published plan.
{{ issue.description }}
After implementing source and tests, run npm run gate and npm run lint.
After implementation and validation, finish your coding turn. Do not invoke Delivery inside the coding sandbox and do not commit, push, merge, reset, rebase or edit runtime state. The trusted operator-owned after_run hook runs the native Delivery CLI outside the coding sandbox and owns all index/history and remote writes.
`;
  fs.writeFileSync(path.join(root,'WORKFLOW.md'),workflow);save('WORKFLOW.md',workflow);
  fs.mkdirSync(workspaceRoot);fs.writeFileSync(path.join(workspaceRoot,'.dogfood-sentinel'),'sentinel\n');
  await run(realGh,['issue','edit',String(issue),'--repo',repo,'--add-label','symphony-ready']);
  host=launch(process.execPath,[cli,path.join(root,'WORKFLOW.md'),'--decision-bridge-url',proxyUrl],root,{PATH:`${wrappers}:${process.env.PATH}`,DECISION_BRIDGE_URL:proxyUrl,DECISION_BRIDGE_TOKEN:bridgeToken});host.child.stdin.end();emit('native_host_started',{pid:host.child.pid,issue,bridgePort:proxy.address().port});
  const work=path.join(workspaceRoot,`GH-${issue}`);let workspaceObserved=false;let runtimeObserved=false;let injectedBase=false;let prNumber;let priorState='';const reviewed=new Set();
  const deadline=Date.now()+25*60*1000;
  while(Date.now()<deadline&&!cancelled){
    if(fs.existsSync(work)) workspaceObserved=true;
    if(!runtimeObserved&&fs.existsSync(path.join(work,'.symphony/runtime-probe.json'))){runtimeObserved=true;emit('ignored_runtime_observed',{path:'.symphony/runtime-probe.json',content:fs.readFileSync(path.join(work,'.symphony/runtime-probe.json'),'utf8')});}
    const stateFile=path.join(work,'.symphony/delivery-state.json');
    if(fs.existsSync(stateFile)){const raw=fs.readFileSync(stateFile,'utf8');if(raw!==priorState){priorState=raw;const state=JSON.parse(raw);save('delivery-last-state.json',state);fs.appendFileSync(path.join(proof,'delivery-states.ndjson'),JSON.stringify(clean({observedAt:new Date().toISOString(),state}))+'\n');}}
    save('host.log',host.output());
    if(fs.existsSync(path.join(root,'delivery-cli.log')))save('delivery-cli.log',fs.readFileSync(path.join(root,'delivery-cli.log'),'utf8'));
    const prs=await gh(['pr','list','--repo',repo,'--head',`symphony/GH-${issue}`,'--state','all','--json','number,state,url,headRefOid,headRefName']);
    if(prs.length>1) throw new Error('Multiple PRs for the run');
    const pr=prs[0];if(pr){prNumber=pr.number;save('pr-latest.json',pr);}
    if(pr&&!injectedBase){
      await git(['pull','--ff-only','origin','main'],seed);
      fs.writeFileSync(path.join(seed,file),`export const ${exportName} = { feature: false, base: true };\n`);
      fs.writeFileSync(path.join(seed,`test/${suffix}_base.test.mjs`),`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${exportName} } from '../${file}';\ntest('base implementation survives ${runId}', () => assert.equal(${exportName}.base, true));\n`);
      await git(['add',file,`test/${suffix}_base.test.mjs`],seed);await git(['commit','-m',`test: advance base to force ${runId} conflict`],seed);await git(['push','origin','main'],seed);
      injectedBase=true;emit('base_conflict_injected',{sha:(await git(['rev-parse','HEAD'],seed)).trim(),prNumber,originalHead:pr.headRefOid});
    }
    const tasks=(await client.getTasksForSession(sessionId)).tasks;save('decision-tasks.json',tasks);
    for(const task of tasks.filter(t=>t.kind==='review'&&t.status==='pending'&&!reviewed.has(t.id))){
      reviewed.add(task.id);const checkout=path.join(root,`review-${task.target.headSha.slice(0,12)}`);
      await git(['clone','--no-checkout',`https://github.com/${repo}.git`,checkout],root);await git(['fetch','origin',task.target.headSha],checkout);await git(['checkout','--detach',task.target.headSha],checkout);
      const context=await client.getTaskContext(task.id);save(`review-${task.revision}-context.json`,context);
      await executeDecision(task,checkout,`You are an independent code reviewer, not the coding/repair executor. Inspect this immutable checkout at exactly ${task.target.headSha} for ${repo} PR #${task.target.prNumber}. Read AGENTS.md, actual git diff against the merge base of origin/main, source and tests. Requirements:\n${body}\nThe harness intentionally introduces a base conflict handled by native Delivery AFTER initial approval. Review the feature implementation relative to its inherited base; do not treat the planned coordination conflict as a product-code finding. On the repaired merge commit, confirm both feature and base implementations/tests survive. Never fabricate approval: return changes_requested/needs_human with precise findings if appropriate. Do not edit files, commit, push or merge. Local validation and exact-SHA CI are performed by the native Delivery gate. Context:\n${JSON.stringify(context)}`);
    }
    const currentIssue=await gh(['issue','view',String(issue),'--repo',repo,'--json','number,url,state,labels']);save('issue-latest.json',currentIssue);
    if(currentIssue.state==='CLOSED'&&pr?.state==='MERGED'&&!fs.existsSync(work)&&host.output().split('\n').some(l=>l.includes('event="workspace_cleanup"')&&l.includes('outcome="completed"')&&l.includes(`issue_identifier="GH-${issue}"`))){
      if(!workspaceObserved||!fs.existsSync(path.join(workspaceRoot,'.dogfood-sentinel'))) throw new Error('Cleanup provenance failed');
      emit('native_terminal_cleanup_observed',{issue,prNumber,workspaceObserved,workspaceAbsent:true,sentinelAlive:true});finalStatus='passed';break;
    }
    if(currentIssue.state==='CLOSED'&&pr?.state==='MERGED'&&host.output().split('\n').some(l=>l.includes('event="workspace_cleanup"')&&l.includes('reason="cleanup_refused"')&&l.includes(`issue_identifier="GH-${issue}"`))){
      save('cleanup-refusal.json',{issue,prNumber,workspacePresent:fs.existsSync(work),sentinelAlive:fs.existsSync(path.join(workspaceRoot,'.dogfood-sentinel')),reason:'native_terminal_cleanup_refused'});
      save('pr-final.json',await gh(['pr','view',String(prNumber),'--repo',repo,'--json','number,url,state,headRefOid,baseRefOid,mergeCommit,mergedAt,statusCheckRollup']));
      save('ci-runs.json',await gh(['run','list','--repo',repo,'--branch',`symphony/GH-${issue}`,'--json','databaseId,url,headSha,status,conclusion,event']));
      throw new Error('native_terminal_cleanup_refused: delivery merged and issue closed, workspace retained; full profile failed');
    }
    if(priorState&&JSON.parse(priorState).isPaused) throw new Error('Native Delivery paused; no automatic replay');
    if(host.child.exitCode!==null) throw new Error(`Native host exited ${host.child.exitCode}`);
    await delay(2000);
  }
  if(finalStatus!=='passed')throw new Error(cancelled ? 'Live acceptance cancelled by operator' : 'Live acceptance deadline exhausted');
  save('pr-final.json',await gh(['pr','view',String(prNumber),'--repo',repo,'--json','number,url,state,headRefOid,baseRefOid,mergeCommit,mergedAt,commits,body,statusCheckRollup']));
  const runs=await gh(['run','list','--repo',repo,'--branch',`symphony/GH-${issue}`,'--json','databaseId,url,headSha,status,conclusion,event']);save('ci-runs.json',runs);
  save('issue-comments.json',await gh(['api',`repos/${repo}/issues/${issue}/comments`]));
  const state=JSON.parse(priorState);if(state.spentRepairs!==1||state.isPaused||!injectedReview)throw new Error('Recovery invariants failed');
  const faults=JSON.parse(fs.readFileSync(injectionState,'utf8'));if(!faults.pushed||!faults.refFault||!faults.projectionFault)throw new Error('Fault injections did not execute');
  if(!runtimeObserved||!runs.some(r=>r.headSha===state.mergeConflictRepair?.commitSha&&r.conclusion==='success'))throw new Error('Missing real runtime/current-SHA CI evidence');
  const commit=await gh(['api',`repos/${repo}/commits/${state.mergeConflictRepair.commitSha}`]);save('repair-commit.json',commit);
  if(commit.parents.length!==2||commit.parents[0].sha!==state.mergeConflictRepair.expectedHeadSha||commit.parents[1].sha!==state.mergeConflictRepair.baseSha||commit.files.some(f=>f.filename.startsWith('.symphony/')))throw new Error('Merge parent/runtime isolation evidence failed');
  const commands=fs.readFileSync(commandLog,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  if(commands.filter(c=>c.kind==='git'&&c.args[0]==='push'&&c.args.some(a=>/^[a-f0-9]{40}:refs\/heads\//.test(a))).length!==1||commands.filter(c=>c.subprocess==='repair_executor').length!==1)throw new Error('Duplicate repair executor/push');
  const reviewTasks=(await client.getTasksForSession(sessionId)).tasks.filter(t=>t.kind==='review');
  const reviewResults=await Promise.all(reviewTasks.map(async t=>({task:t,...await client.getTaskResult(t.id)})));save('review-results-final.json',reviewResults);
  if(!reviewResults.some(r=>r.result?.target?.headSha===state.mergeConflictRepair.commitSha&&r.result.verdict==='approve'))throw new Error('Missing actual independent exact-HEAD approval');
  save('injection-receipts.json',faults);emit('acceptance_passed',{issue,prNumber,repairCommit:state.mergeConflictRepair?.commitSha,spentRepairs:state.spentRepairs});
} catch(error){ finalStatus='failed';save('failure.txt',String(error));emit('acceptance_failed',{error:String(error),issue});process.exitCode=1;
} finally {
  await stop(host);await stop(bridge);
  if(fs.existsSync(path.join(root,'delivery-cli.log')))save('delivery-cli.log',fs.readFileSync(path.join(root,'delivery-cli.log'),'utf8'));
  if(host)save('host.log',host.output());if(bridge)save('bridge.log',bridge.output());
  if(proxy)await new Promise(resolve=>proxy.close(resolve));
  for(const child of children){try{process.kill(-child.pid,'SIGKILL');}catch{/* exited */}}
  if(fs.existsSync(commandLog))save('commands.ndjson',fs.readFileSync(commandLog,'utf8'));
  save('manifest.json',{runId,repo,issue,status:finalStatus,finishedAt:new Date().toISOString(),isolatedRoot:root,processesStopped:true,scope:'Native host + real Codex app-server/codex exec + native Decision bridge/CLI + real GitHub CI/merge/cleanup; explicit observation/ACK fault injection; no browser UI claim'});
  fs.rmSync(path.join(root,'auth'),{recursive:true,force:true});fs.rmSync(path.join(root,'bridge-token'),{force:true});
  console.log(`Evidence: ${proof}`);
}

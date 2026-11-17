import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const API=process.env.KESTREL_API_URL||'http://127.0.0.1:4000';
const TOKEN=process.env.KESTREL_WORKER_TOKEN||'dev-worker-token-change-me';
const WORKER_ID=process.env.KESTREL_WORKER_ID||`${os.hostname()}-${crypto.randomUUID().slice(0,5)}`;
const ROOT=path.resolve(process.env.KESTREL_WORKER_WORKDIR||process.env.KESTREL_WORKDIR||'.kestrel-worker');
const REPO_URL=process.env.KESTREL_REPOSITORY_URL;
const CONCURRENCY=Number(process.env.KESTREL_CONCURRENCY||1);
const ORG_ID=process.env.KESTREL_WORKER_ORGANIZATION_ID;
const DOCKER=process.env.KESTREL_DOCKER_BIN||'docker';
const JOB_IMAGE=process.env.KESTREL_JOB_IMAGE||'node:22-bookworm-slim';
const JOB_NETWORK=process.env.KESTREL_JOB_NETWORK||'none';
if(process.env.NODE_ENV==='production'&&!/@sha256:[a-f0-9]{64}$/i.test(JOB_IMAGE))throw new Error('Production workers require KESTREL_JOB_IMAGE pinned by immutable sha256 digest');
const headers={'content-type':'application/json',authorization:`Bearer ${TOKEN}`,'x-worker-id':WORKER_ID};
async function api(endpoint,body){const r=await fetch(`${API}${endpoint}`,{method:'POST',headers,body:JSON.stringify(body)});if(!r.ok)throw new Error(`${endpoint}: ${r.status} ${await r.text()}`);return r.json();}
async function run(command,cwd,onLine,job){return new Promise(resolve=>{const start=Date.now();const containerName=`kestrel-job-${String(job.id).replace(/[^a-zA-Z0-9_.-]/g,'')}`;const args=['run','--rm','--init','--name',containerName,'--network',JOB_NETWORK,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit',String(Number(process.env.KESTREL_JOB_PIDS_LIMIT||256)),'--memory',`${Math.min(8192,Math.max(256,Number(job.memoryLimitMb||process.env.KESTREL_JOB_DEFAULT_MEMORY_MB||2048)))}m`,'--memory-swap',`${Math.min(8192,Math.max(256,Number(job.memoryLimitMb||process.env.KESTREL_JOB_DEFAULT_MEMORY_MB||2048)))}m`,'--cpus',String(Math.min(8,Math.max(0.25,Number(job.cpuMillicores||2000)/1000))),'--user','1000:1000','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=512m','--mount',`type=bind,src=${cwd},dst=/workspace`,'--workdir','/workspace','--mount',`type=volume,src=kestrel-npm-${String(job.projectId||'shared').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,40)},dst=/home/node/.npm`,'--env','CI=true','--env','KESTREL=true',JOB_IMAGE,command];const child=spawn(DOCKER,args,{cwd, shell:false,env:process.env,stdio:['ignore','pipe','pipe']});let timedOut=false;const timeoutMs=Math.max(60000,Number(process.env.KESTREL_JOB_TIMEOUT_MS||1800000));const timeout=setTimeout(()=>{timedOut=true;const stop=spawn(DOCKER,['stop','--time','10',containerName],{stdio:'ignore'});stop.on('error',()=>{});},timeoutMs);let tail='';for(const [stream,pipe] of [['stdout',child.stdout],['stderr',child.stderr]]){pipe.on('data',buf=>{const lines=(tail+buf.toString()).split(/\r?\n/);tail=lines.pop()||'';for(const line of lines)if(line)onLine(stream,line);});pipe.on('end',()=>{if(tail){onLine(stream,tail);tail='';}});}child.on('close',code=>{clearTimeout(timeout);resolve({exitCode:timedOut?124:(code??1),durationMs:Date.now()-start});});child.on('error',e=>{clearTimeout(timeout);onLine('stderr',e.message);resolve({exitCode:1,durationMs:Date.now()-start});});});}
async function ensureJobImage(){await new Promise((resolve,reject)=>{const c=spawn(DOCKER,['image','inspect',JOB_IMAGE],{stdio:'ignore'});c.on('close',code=>{if(code===0)return resolve();const pull=spawn(DOCKER,['pull',JOB_IMAGE],{stdio:'inherit'});pull.on('close',n=>n===0?resolve():reject(new Error(`Unable to pull job image ${JOB_IMAGE}`)));pull.on('error',reject)});c.on('error',reject)})}
async function runGit(args,cwd,onLine){return new Promise(resolve=>{const start=Date.now();const child=spawn('git',args,{cwd,shell:false,env:{...process.env,CI:'true',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>child.kill('SIGKILL'),Number(process.env.KESTREL_GIT_TIMEOUT_MS||300000));for(const [stream,pipe] of [['stdout',child.stdout],['stderr',child.stderr]])pipe.on('data',buf=>{for(const line of buf.toString().split(/\r?\n/))if(line)onLine(stream,line);});child.on('close',code=>{clearTimeout(timer);resolve({exitCode:code??1,durationMs:Date.now()-start});});child.on('error',e=>{clearTimeout(timer);onLine('stderr',e.message);resolve({exitCode:1,durationMs:Date.now()-start});});});}
async function execute(job){const workspace=path.join(ROOT,job.runId,job.id);await fs.mkdir(workspace,{recursive:true});let repo=workspace;
 const logBuffer=[];let logFlushActive=false;let logBytes=0;let logTruncated=false;const flushLogs=async()=>{if(logFlushActive||!logBuffer.length)return;logFlushActive=true;const batch=logBuffer.splice(0,50);try{await api(`/api/workers/jobs/${job.id}/logs`,{leaseToken:job.leaseToken,entries:batch})}catch(e){logBuffer.unshift(...batch);console.error('log upload:',e.message)}finally{logFlushActive=false}};const logTimer=setInterval(()=>{flushLogs().catch(()=>{})},500);const leaseHeartbeat=setInterval(()=>api(`/api/workers/jobs/${job.id}/logs`,{leaseToken:job.leaseToken,entries:[]}).catch(e=>console.error('lease heartbeat:',e.message)),10000);
 try {
  const repository = (/^https:\/\//.test(job.repositoryUrl||'') ? job.repositoryUrl : REPO_URL || '');
  if(repository){const clone=await runGit(['clone','--depth','1','--branch',String(job.branch||'main'),'--',repository,'.'],workspace,(s,m)=>console.log(`[clone:${s}] ${m}`));if(clone.exitCode!==0)throw new Error('Repository clone failed; inspect worker output');}
  else {throw new Error('No valid Git repository URL. Set KESTREL_REPOSITORY_URL or configure the project repo as an https:// Git URL.');}
  if(job.commitSha){if(!/^[a-f0-9]{7,64}$/i.test(job.commitSha))throw new Error('Invalid commit SHA');const checkout=await runGit(['checkout','--detach',job.commitSha],repo,(s,m)=>console.log(`[checkout:${s}] ${m}`));if(checkout.exitCode!==0)throw new Error('Requested commit could not be checked out');}
  const result=await run(job.command,repo,(stream,message)=>{console.log(`[${job.name}:${stream}] ${message}`);if(logBytes<10*1024*1024){logBuffer.push({stream,message});logBytes+=Buffer.byteLength(message);}else if(!logTruncated){logTruncated=true;logBuffer.push({stream:'stderr',message:'[Kestrel] Log output truncated after 10 MiB.'});}if(logBuffer.length>=50)flushLogs().catch(()=>{});},job);
  while(logBuffer.length||logFlushActive){await flushLogs();if(logBuffer.length||logFlushActive)await new Promise(r=>setTimeout(r,50));}
  await api(`/api/workers/jobs/${job.id}/complete`,{leaseToken:job.leaseToken,...result});
 } finally {clearInterval(logTimer);clearInterval(leaseHeartbeat);await fs.rm(workspace,{recursive:true,force:true}).catch(e=>console.error('workspace cleanup:',e.message));}
}
if(!TOKEN||TOKEN.length<32)throw new Error('Set the one-time provisioned KESTREL_WORKER_TOKEN');
await ensureJobImage();
await api('/api/workers/register',{workerId:WORKER_ID,hostname:os.hostname(),arch:`linux/${os.arch()==='arm64'?'arm64':'amd64'}`,region:process.env.KESTREL_REGION||'local',maxConcurrency:CONCURRENCY});
console.log(`Kestrel worker ${WORKER_ID} connected to ${API}`);
setInterval(()=>api('/api/workers/heartbeat',{workerId:WORKER_ID,cpuPct:0,memoryUsedGb:0}).catch(e=>console.error('heartbeat:',e.message)),10000);
async function pollLoop(slot){while(true){try{const {job}=await api('/api/workers/claim',{workerId:WORKER_ID});if(!job){await new Promise(r=>setTimeout(r,500));continue;}console.log(`[slot ${slot}] Claimed ${job.name} (${job.id}) for run ${job.runId}`);try{await execute(job);}catch(e){console.error(e);await api(`/api/workers/jobs/${job.id}/complete`,{leaseToken:job.leaseToken,exitCode:1,durationMs:0}).catch(()=>{});}}catch(e){console.error('worker loop:',e.message);await new Promise(r=>setTimeout(r,3000));}}}
await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>pollLoop(i+1)));

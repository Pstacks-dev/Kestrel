import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function runProcess(command,args,{cwd,env,input,timeoutMs,onLine,signal,spawnImpl=spawn,maxCaptureBytes=256*1024,maxLineBytes=16*1024}={}) {
  const started=Date.now();
  const captureLimit=Math.max(0,Number.isFinite(maxCaptureBytes)?maxCaptureBytes:256*1024);
  const lineLimit=Math.max(256,Number.isFinite(maxLineBytes)?maxLineBytes:16*1024);
  return new Promise((resolve)=>{
    let settled=false, timedOut=false, killTimer=null;
    let stdout='',stderr='',tail={stdout:'',stderr:''},captured={stdout:0,stderr:0},truncated={stdout:false,stderr:false};
    const safeLine=(stream,line)=>{try{onLine?.(stream,line);}catch{/* Logging must not break build execution. */}};
    const capture=(stream,text)=>{
      const remaining=Math.max(0,captureLimit-captured[stream]);
      if(remaining>0){const kept=text.slice(0,remaining);if(stream==='stdout')stdout+=kept;else stderr+=kept;captured[stream]+=kept.length;}
      if(text.length>remaining)truncated[stream]=true;
    };
    let child;
    try{child=spawnImpl(command,args,{cwd,env,shell:false,stdio:['pipe','pipe','pipe']});}
    catch(error){return resolve({exitCode:1,stdout,stderr:String(error?.message||error).slice(0,lineLimit),durationMs:Date.now()-started});}
    const stop=()=>{
      if(settled)return;
      timedOut=true;
      try{child.kill('SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3000);
      killTimer.unref?.();
    };
    const timer=setTimeout(stop,Math.max(1,Number(timeoutMs)||1800000));
    const abort=()=>stop();
    if(signal?.aborted)stop();
    else signal?.addEventListener('abort',abort,{once:true});
    for(const [stream,pipe] of [['stdout',child.stdout],['stderr',child.stderr]])pipe?.on('data',(buf)=>{
      const text=buf.toString();capture(stream,text);
      const chunks=(tail[stream]+text).split(/\r?\n/);tail[stream]=chunks.pop()||'';
      for(const line of chunks)if(line)safeLine(stream,line);
      while(tail[stream].length>lineLimit){safeLine(stream,tail[stream].slice(0,lineLimit));tail[stream]=tail[stream].slice(lineLimit);}
    });
    child.on('close',(code)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      for(const stream of ['stdout','stderr']){
        if(tail[stream])safeLine(stream,tail[stream]);
        if(truncated[stream]){const marker='\n[output truncated; capture limit reached]';if(stream==='stdout')stdout+=marker;else stderr+=marker;}
      }
      resolve({exitCode:timedOut?124:code??1,stdout,stderr,durationMs:Date.now()-started});
    });
    child.on('error',(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      safeLine('stderr',error.message);capture('stderr',error.message);
      resolve({exitCode:1,stdout,stderr,durationMs:Date.now()-started});
    });
    if(input)child.stdin?.write(input);
    child.stdin?.end();
  });
}
function safePath(value,{allowDot=false}={}) {
  return typeof value==='string'&&value.length<=512&&(allowDot&&value==='.'||!value.startsWith('/')&&!value.includes('\\')&&! /^[A-Za-z]:/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'));
}

export async function buildAndPushContainerImage(config,{workspace,hostWorkspace,dockerBin='docker',username,password,timeoutSeconds=1800,onLine,signal,commandRunner=runProcess}={}) {
  if(!config||!['ghcr.io','docker.io'].includes(config.registryHost)||! /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(config.imageRepository||'')||String(config.imageRepository).includes('..')||! /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(config.imageTag||'')||!safePath(config.contextPath,{allowDot:true})||!safePath(config.dockerfilePath))return {exitCode:1,error:'Container build configuration is invalid'};
  if(!username||!password)return {exitCode:1,error:'Registry username or password secret is missing'};
  const context=path.resolve(workspace,config.contextPath==='.'?'':config.contextPath);
  if(context!==path.resolve(workspace)&&!context.startsWith(path.resolve(workspace)+path.sep))return {exitCode:1,error:'Build context escapes the checked-out workspace'};
  const dockerContext=path.resolve(context,config.dockerfilePath);
  if(dockerContext!==context&&!dockerContext.startsWith(context+path.sep))return {exitCode:1,error:'Dockerfile escapes the build context'};
  try {const [workspaceReal,contextReal,dockerfileReal,ctxStat,fileStat]=await Promise.all([fs.realpath(workspace),fs.realpath(context),fs.realpath(dockerContext),fs.stat(context),fs.stat(dockerContext)]);if(!ctxStat.isDirectory()||!fileStat.isFile()||!contextReal.startsWith(workspaceReal+path.sep)&&contextReal!==workspaceReal||!dockerfileReal.startsWith(contextReal+path.sep)&&dockerfileReal!==contextReal)return {exitCode:1,error:'Build context or Dockerfile escapes the workspace'};}catch{return {exitCode:1,error:'Build context or Dockerfile is missing'};}
  const imageName=config.registryHost+'/'+config.imageRepository,imageTag=imageName+':'+config.imageTag;
  const configDir=await fs.mkdtemp(path.join(os.tmpdir(),'kestrel-registry-auth-'));
  const env={...process.env,DOCKER_CONFIG:configDir};
  const timeoutMs=Math.max(60,Math.min(3600,Number(timeoutSeconds)||1800))*1000;
  let result;
  try {
    result=await commandRunner(dockerBin,['login',config.registryHost,'--username',username,'--password-stdin'],{env,input:password+'\n',timeoutMs:30000,onLine});
    if(result.exitCode!==0)return {exitCode:1,error:'Container registry login failed',durationMs:result.durationMs};
    result=await commandRunner(dockerBin,['build','--pull','--file',dockerContext,'--tag',imageTag,context],{env,timeoutMs,onLine,signal});
    if(result.exitCode!==0)return {exitCode:result.exitCode,error:'Container image build failed',durationMs:result.durationMs};
    result=await commandRunner(dockerBin,['push',imageTag],{env,timeoutMs,onLine,signal});
    if(result.exitCode!==0)return {exitCode:result.exitCode,error:'Container image push failed',durationMs:result.durationMs};
    result=await commandRunner(dockerBin,['image','inspect','--format','{{index .RepoDigests 0}}',imageTag],{env,timeoutMs:30000,onLine,signal});
    const imageRef=String(result.stdout||'').trim();
    const match=imageRef.match(/@sha256:([a-f0-9]{64})$/i);
    if(result.exitCode!==0||!match||!imageRef.startsWith(imageName+'@'))return {exitCode:1,error:'Registry did not return a verified immutable image digest'};
    return {exitCode:0,imageDigest:'sha256:'+match[1],imageRef,durationMs:result.durationMs};
  } catch(error) {
    return {exitCode:1,error:'Container image build or push failed',durationMs:result?.durationMs||0};
  } finally {
    await commandRunner(dockerBin,['logout',config.registryHost],{env,timeoutMs:15000,onLine,signal}).catch(()=>{});
    await commandRunner(dockerBin,['image','rm',imageTag],{env,timeoutMs:15000,onLine}).catch(()=>{});
    await fs.rm(configDir,{recursive:true,force:true}).catch(()=>{});
  }
}

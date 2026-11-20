import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function runProcess(command,args,{cwd,env,input,timeoutMs,onLine,signal,spawnImpl=spawn}={}) {
  const started=Date.now();
  return new Promise((resolve)=>{
    const child=spawnImpl(command,args,{cwd,env,shell:false,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',tail={stdout:'',stderr:''},timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),3000).unref?.();},timeoutMs||1800000);
    const abort=()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),3000).unref?.();};
    signal?.addEventListener('abort',abort,{once:true});
    for(const [stream,pipe] of [['stdout',child.stdout],['stderr',child.stderr]])pipe.on('data',(buf)=>{
      const text=buf.toString();if(stream==='stdout')stdout+=text;else stderr+=text;
      const chunks=(tail[stream]+text).split(/\r?\n/);tail[stream]=chunks.pop()||'';
      for(const line of chunks)if(line)onLine?.(stream,line);
    });
    child.on('close',(code)=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      for(const stream of ['stdout','stderr'])if(tail[stream])onLine?.(stream,tail[stream]);
      resolve({exitCode:timedOut?124:code??1,stdout,stderr,durationMs:Date.now()-started});
    });
    child.on('error',(error)=>{clearTimeout(timer);onLine?.('stderr',error.message);resolve({exitCode:1,stdout,stderr:stderr+error.message,durationMs:Date.now()-started});});
    if(input)child.stdin.write(input);
    child.stdin.end();
  });
}

function safePath(value,{allowDot=false}={}) {
  return typeof value==='string'&&value.length<=512&&(allowDot&&value==='.'||!value.startsWith('/')&&!value.includes('\\')&&! /^[A-Za-z]:/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'));
}

export async function buildAndPushContainerImage(config,{workspace,hostWorkspace,dockerBin='docker',username,password,timeoutSeconds=1800,onLine,signal,commandRunner=runProcess}={}) {
  if(!config||!['ghcr.io','docker.io'].includes(config.registryHost)||! /^[a-z0-9][a-z0-9._-]*(?:\\/[a-z0-9][a-z0-9._-]*)+$/.test(config.imageRepository||'')||String(config.imageRepository).includes('..')||! /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(config.imageTag||'')||!safePath(config.contextPath,{allowDot:true})||!safePath(config.dockerfilePath))return {exitCode:1,error:'Container build configuration is invalid'};
  if(!username||!password)return {exitCode:1,error:'Registry username or password secret is missing'};
  const context=path.resolve(workspace,config.contextPath==='.'?'':config.contextPath);
  if(context!==path.resolve(workspace)&&!context.startsWith(path.resolve(workspace)+path.sep))return {exitCode:1,error:'Build context escapes the checked-out workspace'};
  const hostContext=path.resolve(hostWorkspace,config.contextPath==='.'?'':config.contextPath);
  const dockerfile=path.resolve(context,config.dockerfilePath);
  if(dockerfile!==context&&!dockerfile.startsWith(context+path.sep))return {exitCode:1,error:'Dockerfile escapes the build context'};
  try {const [ctxStat,fileStat]=await Promise.all([fs.stat(hostContext),fs.stat(path.resolve(hostContext,config.dockerfilePath))]);if(!ctxStat.isDirectory()||!fileStat.isFile())return {exitCode:1,error:'Build context or Dockerfile is missing'};}catch{return {exitCode:1,error:'Build context or Dockerfile is missing'};}
  const imageName=config.registryHost+'/'+config.imageRepository,imageTag=imageName+':'+config.imageTag;
  const configDir=await fs.mkdtemp(path.join(os.tmpdir(),'kestrel-registry-auth-'));
  const env={...process.env,DOCKER_CONFIG:configDir};
  const timeoutMs=Math.max(60,Math.min(3600,Number(timeoutSeconds)||1800))*1000;
  let result;
  try {
    result=await commandRunner(dockerBin,['login',config.registryHost,'--username',username,'--password-stdin'],{env,input:password+'\n',timeoutMs:30000,onLine});
    if(result.exitCode!==0)return {exitCode:1,error:'Container registry login failed',durationMs:result.durationMs};
    result=await commandRunner(dockerBin,['build','--pull','--file',path.resolve(hostContext,config.dockerfilePath),'--tag',imageTag,hostContext],{env,timeoutMs,onLine,signal});
    if(result.exitCode!==0)return {exitCode:result.exitCode,error:'Container image build failed',durationMs:result.durationMs};
    result=await commandRunner(dockerBin,['push',imageTag],{env,timeoutMs,onLine});
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

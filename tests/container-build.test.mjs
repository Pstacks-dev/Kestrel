import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateContainerBuildRequest } from '../server/lib/container-build-validation.mjs';
import { buildAndPushContainerImage } from '../worker/container-build.mjs';

test('container build input validator restricts registries, paths and tags',()=>{
 const good=validateContainerBuildRequest({registryHost:'ghcr.io',imageRepository:'team/web',commitSha:'a'.repeat(40)});
 assert.equal(good.ok,true);
 assert.equal(good.config.imageTag,'sha-'+ 'a'.repeat(12));
 assert.equal(good.config.imageRef,'ghcr.io/team/web:sha-'+ 'a'.repeat(12));
 assert.equal(validateContainerBuildRequest({registryHost:'localhost:5000',imageRepository:'team/web',commitSha:'a'.repeat(40)}).ok,false);
 assert.equal(validateContainerBuildRequest({registryHost:'ghcr.io',imageRepository:'team/../web',commitSha:'a'.repeat(40)}).ok,false);
 assert.equal(validateContainerBuildRequest({registryHost:'ghcr.io',imageRepository:'team/web',commitSha:'a'.repeat(40),contextPath:'../outside'}).ok,false);
 assert.equal(validateContainerBuildRequest({registryHost:'ghcr.io',imageRepository:'team/web',commitSha:'a'.repeat(40),dockerfilePath:'/etc/passwd'}).ok,false);
});

test('container build runner logs in, builds, pushes and records an immutable digest',async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'kestrel-build-test-'));
 try{
  await mkdir(path.join(workspace,'app'),{recursive:true});await writeFile(path.join(workspace,'app','Dockerfile'),'FROM scratch');
  const commands=[];
  const digest='sha256:'+'d'.repeat(64);
  const result=await buildAndPushContainerImage({registryHost:'ghcr.io',imageRepository:'team/web',imageTag:'sha-test',dockerfilePath:'Dockerfile',contextPath:'app'},{workspace,hostWorkspace:workspace,username:'test-user',password:'secret-registry-password',commandRunner:async(command,args,options={})=>{
    commands.push({command,args,options});
    if(args[0]==='image'&&args[1]==='inspect')return {exitCode:0,stdout:'ghcr.io/team/web@'+digest,durationMs:10};
    return {exitCode:0,stdout:'',durationMs:10};
  }});
  assert.equal(result.exitCode,0);assert.equal(result.imageDigest,digest);assert.equal(result.imageRef,'ghcr.io/team/web@'+digest);
  assert.deepEqual(commands.map(c=>c.args[0]),['login','build','push','image','logout','image']);
  assert.equal(commands[0].options.input,'secret-registry-password\n');
  assert.ok(commands[1].args.includes(path.join(workspace,'app')));
  assert.ok(!commands[1].args.join(' ').includes('secret-registry-password'));
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('container build runner does not push after build failure and cleans auth config',async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'kestrel-build-fail-'));
 try{
  await writeFile(path.join(workspace,'Dockerfile'),'FROM scratch');
  const commands=[];
  const result=await buildAndPushContainerImage({registryHost:'docker.io',imageRepository:'user/app',imageTag:'sha-fail',dockerfilePath:'Dockerfile',contextPath:'.'},{workspace,hostWorkspace:workspace,username:'user',password:'secret',commandRunner:async(command,args,options={})=>{
    commands.push(args[0]);if(args[0]==='build')return {exitCode:1,stdout:'',durationMs:1};return {exitCode:0,stdout:'',durationMs:1};
  }});
  assert.equal(result.exitCode,1);assert.equal(result.error,'Container image build failed');assert.deepEqual(commands,['login','build','logout','image']);
 }finally{await rm(workspace,{recursive:true,force:true});}
});


test('container build route, worker claim and completion are wired to image build metadata',async()=>{
 const fs=await import('node:fs/promises');
 const route=await fs.readFile(new URL('../server/routes/container-builds.mjs',import.meta.url),'utf8');
 const control=await fs.readFile(new URL('../server/control-plane.mjs',import.meta.url),'utf8');
 const migration=await fs.readFile(new URL('../db/migrations/026_container_image_builds.sql',import.meta.url),'utf8');
 assert.match(route,/successful pipeline run/);
 assert.match(route,/project_secrets/);
 assert.match(route,/container_build_config/);
 assert.match(control,/j\.job_type = 'container_build'/);
 assert.match(control,/containerImageDigest/);
 assert.match(control,/container_builds set status/);
 assert.match(migration,/container_build/);
 assert.match(migration,/container_image_digest/);
});

test('registry login auth config is temporary and removed after push',async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'kestrel-auth-cleanup-'));
 try{
  await writeFile(path.join(workspace,'Dockerfile'),'FROM scratch');
  let configDir;
  const result=await buildAndPushContainerImage({registryHost:'ghcr.io',imageRepository:'org/repo',imageTag:'sha-clean',dockerfilePath:'Dockerfile',contextPath:'.'},{workspace,hostWorkspace:workspace,username:'u',password:'p',commandRunner:async(cmd,args,opts)=>{
   configDir=opts.env.DOCKER_CONFIG;
   if(args[0]==='image'&&args[1]==='inspect')return {exitCode:0,stdout:'ghcr.io/org/repo@sha256:'+'e'.repeat(64),durationMs:1};
   return {exitCode:0,stdout:'',durationMs:1};
  }});
  assert.equal(result.exitCode,0);
  await assert.rejects(()=>stat(configDir));
 }finally{await rm(workspace,{recursive:true,force:true});}
});

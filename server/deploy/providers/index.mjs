import crypto from 'node:crypto';

const API={
 render:'https://api.render.com/v1',railway:'https://backboard.railway.app/graphql/v2',
 fly:'https://api.machines.dev',flyGraph:'https://api.fly.io/graphql',
 cloud:'https://run.googleapis.com',aws:'https://apprunner.amazonaws.com',
 azure:'https://management.azure.com',do:'https://api.digitalocean.com/v2',
 heroku:'https://api.heroku.com',vercel:'https://api.vercel.com',netlify:'https://api.netlify.com/api/v1'
};
function parseCred(value){
 if(value&&typeof value==='object'&&!Array.isArray(value))return value;
 if(typeof value!=='string')throw new Error('Provider credential required');
 try{const j=JSON.parse(value);if(j&&typeof j==='object'&&!Array.isArray(j))return j;}catch{}
 return {token:value};
}
function token(c){return c.accessToken||c.token||c.apiToken||c.apiKey;}
function required(o,k){if(!o||!o[k])throw new Error('Required configuration field: '+k);return o[k];}
function safeErr(e){return e?.provider?'Provider API returned HTTP '+e.status:e?.message||'Provider request failed';}
async function api(fetcher,url,opts={}){
 const headers={Accept:'application/json',...(opts.token?{Authorization:'Bearer '+opts.token}:{}),...(opts.headers||{}),...(opts.body!==undefined?{'Content-Type':'application/json'}:{})};
 const response=await fetcher(url,{method:opts.method||'GET',headers,...(opts.body!==undefined?{body:JSON.stringify(opts.body)}:{}),signal:AbortSignal.timeout(opts.timeout||15000)});
 const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null;}catch{data=raw;}
 if(!response.ok){const e=new Error(String(data?.message||data?.error?.message||data?.error||data?.detail||response.statusText).slice(0,350));e.status=response.status;e.provider=true;throw e;}
 return data;
}
async function awsApi(c,path,body,fetcher,method='POST'){
 const region=required(c,'region'),access=required(c,'accessKeyId'),secret=required(c,'secretAccessKey'),host='apprunner.'+region+'.amazonaws.com';
 const target=body.__target,payloadBody={...body};delete payloadBody.__target;const payload=JSON.stringify(payloadBody);
 const now=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=now.slice(0,8);
 const headers={host,'content-type':'application/x-amz-json-1.1','x-amz-date':now,'x-amz-target':'AmazonAppRunner.'+target};
 if(c.sessionToken)headers['x-amz-security-token']=c.sessionToken;
 const keys=Object.keys(headers).map(k=>k.toLowerCase()).sort(),canonicalHeaders=keys.map(k=>k+':'+headers[k].trim()+'\n').join(''),signed=keys.join(';');
 const digest=crypto.createHash('sha256').update(payload).digest('hex'),canonical=[method,path,'',canonicalHeaders+signed,digest].join('\n'),scope=day+'/'+region+'/apprunner/aws4_request';
 const stringToSign=['AWS4-HMAC-SHA256',now,scope,crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
 const hmac=(key,val)=>crypto.createHmac('sha256',key).update(val).digest();
 const signKey=hmac(hmac(hmac(hmac('AWS4'+secret,day),region),'apprunner'),'aws4_request');
 headers.authorization='AWS4-HMAC-SHA256 Credential='+access+'/'+scope+', SignedHeaders='+signed+', Signature='+hmac(signKey,stringToSign).toString('hex');
 const response=await fetcher('https://'+host+path,{method,headers,body:method==='GET'?undefined:payload,signal:AbortSignal.timeout(20000)});
 const raw=await response.text();let data;try{data=raw?JSON.parse(raw):{};}catch{data=raw;}
 if(!response.ok){const e=new Error(String(data?.message||data?.Message||response.statusText));e.status=response.status;e.provider=true;throw e;}return data;
}
export async function verifyHostingProvider(providerId,credential,{fetchImpl=fetch}={}){
 const c=parseCred(credential),t=token(c);
 try{
  switch(providerId){
   case 'render':{const d=await api(fetchImpl,API.render+'/services?limit=1',{token:t});return {ok:true,providerId,accountLabel:'Render',sampleCount:Array.isArray(d)?d.length:undefined};}
   case 'railway':{const d=await api(fetchImpl,API.railway,{method:'POST',token:t,body:{query:'query { projects { edges { node { id name } } } }'}});if(d?.errors?.length)throw new Error('Railway GraphQL rejected the token');return {ok:true,providerId,accountLabel:'Railway'};}
   case 'flyio':{const d=await api(fetchImpl,API.fly+'/v1/apps'+(c.orgSlug?'?org_slug='+encodeURIComponent(c.orgSlug):''),{token:t});return {ok:true,providerId,accountLabel:'Fly.io',sampleCount:d?.apps?.length};}
   case 'cloud-run':{const access=required(c,'accessToken'),project=required(c,'projectId');await api(fetchImpl,'https://cloudresourcemanager.googleapis.com/v1/projects/'+encodeURIComponent(project),{token:access});return {ok:true,providerId,accountLabel:'Google Cloud '+project};}
   case 'aws-apprunner':{const d=await awsApi(c,'/',{__target:'ListServices',MaxResults:1},fetchImpl);return {ok:true,providerId,accountLabel:'AWS',sampleCount:d?.ServiceSummaryList?.length};}
   case 'azure-container-apps':{const access=required(c,'accessToken'),sub=required(c,'subscriptionId');const d=await api(fetchImpl,API.azure+'/subscriptions/'+sub+'/resourceGroups?api-version=2021-04-01',{token:access});return {ok:true,providerId,accountLabel:'Azure',sampleCount:d?.value?.length};}
   case 'digitalocean':{const d=await api(fetchImpl,API.do+'/apps?per_page=1',{token:t});return {ok:true,providerId,accountLabel:'DigitalOcean',sampleCount:d?.apps?.length};}
   case 'heroku':{const d=await api(fetchImpl,API.heroku+'/apps?limit=1',{token:t,headers:{Accept:'application/vnd.heroku+json; version=3'}});return {ok:true,providerId,accountLabel:'Heroku',sampleCount:Array.isArray(d)?d.length:undefined};}
   case 'vercel':{const d=await api(fetchImpl,API.vercel+'/v9/projects?limit=1'+(c.teamId?'&teamId='+encodeURIComponent(c.teamId):''),{token:t});return {ok:true,providerId,accountLabel:'Vercel',sampleCount:d?.projects?.length};}
   case 'netlify':{const d=await api(fetchImpl,API.netlify+'/sites?per_page=1',{token:t});return {ok:true,providerId,accountLabel:'Netlify',sampleCount:Array.isArray(d)?d.length:undefined};}
   default:return {ok:false,providerId,error:'Unknown provider'};
  }
 }catch(e){return {ok:false,providerId,error:safeErr(e)};}
}
function validate(providerId,r){
 const image=r.image||r.containerImage;
 if(image&&!/@sha256:[a-fA-F0-9]{64}$/.test(image))throw new Error('Container image must be pinned to SHA-256 digest');
 if(!image&&!r.repoUrl&&!r.sourceTarball&&!r.gitSource&&!r.deployFiles)throw new Error('Validated source repository required');
 if(['render','flyio','cloud-run','aws-apprunner','azure-container-apps','digitalocean'].includes(providerId)&&!image)throw new Error(providerId+' requires immutable image');
 if(providerId==='heroku'&&!r.sourceTarball)throw new Error('Heroku requires source archive');
 if(providerId==='vercel'&&!r.gitSource)throw new Error('Vercel requires Git source');
 if(providerId==='netlify'&&(!r.deployFiles||typeof r.deployFiles!=='object'||Array.isArray(r.deployFiles)||!Object.keys(r.deployFiles).length))throw new Error('Netlify requires built artifact files');
 const slug=String(r.projectSlug||'').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
 if(slug.length<2||slug.length>63)throw new Error('Project slug must be 2-63 characters');
 return {image,slug};
}
export async function deployToHostingProvider(providerId,credential,r,{fetchImpl=fetch}={}){
 const c=parseCred(credential);
 try{
  const {image,slug}=validate(providerId,r),t=token(c),repoUrl=r.repoUrl,branch=r.branch||'main',port=Number(r.port||3000),env=r.env||{};
  let data,id,url,metadata={};
  switch(providerId){
   case 'render':{
    const ownerId=required(c,'ownerId');
    data=await api(fetchImpl,API.render+'/services',{method:'POST',token:t,body:{type:'web_service',name:slug,ownerId,autoDeployTrigger:'off',image:{url:image},envVars:Object.entries(env).map(([key,value])=>({key,value:String(value)}))}});
    id=data?.service?.id||data?.id;url=data?.service?.serviceDetails?.url||data?.service?.url||data?.url;break;
   }
   case 'railway':{
    const projectId=required(c,'projectId'),environmentId=required(c,'environmentId');
    const create='mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }';
    const created=await api(fetchImpl,API.railway,{method:'POST',token:t,body:{query:create,variables:{input:{projectId,name:slug,source:repoUrl?{repo:repoUrl}:{image},variables:env}}}});
    if(created?.errors?.length)throw new Error('Railway service creation failed');const service=created?.data?.serviceCreate;if(!service?.id)throw new Error('Railway missing service id');
    const deploy='mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';
    const deployed=await api(fetchImpl,API.railway,{method:'POST',token:t,body:{query:deploy,variables:{serviceId:service.id,environmentId,commitSha:r.commitSha}}});
    if(deployed?.errors?.length)throw new Error('Railway deployment trigger failed');id=deployed?.data?.serviceInstanceDeployV2||service.id;metadata={serviceId:service.id};data={service,deploymentId:id};
    const domainMutation='mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }';
    const domain=await api(fetchImpl,API.railway,{method:'POST',token:t,body:{query:domainMutation,variables:{input:{serviceId:service.id,environmentId,targetPort:port}}}});
    if(domain?.errors?.length)throw new Error('Railway public domain creation failed');url=domain?.data?.serviceDomainCreate?.domain?'https://'+domain.data.serviceDomainCreate.domain:null;metadata.serviceDomainId=domain?.data?.serviceDomainCreate?.id;break;
   }
   case 'flyio':{
    const org=required(c,'orgSlug');const app=await api(fetchImpl,API.fly+'/v1/apps',{method:'POST',token:t,body:{app_name:slug,org_slug:org}});metadata={appName:slug};id=app?.id||slug;
    const allocate='mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { sharedIpAddress } } }';
    const ip4=await api(fetchImpl,API.flyGraph,{method:'POST',token:t,body:{query:allocate,variables:{input:{appId:slug,type:'shared_v4',region:''}}}});if(ip4?.errors?.length)throw new Error('Fly shared IPv4 allocation failed');
    const allocate6='mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address type region createdAt } } }';
    const ip6=await api(fetchImpl,API.flyGraph,{method:'POST',token:t,body:{query:allocate6,variables:{input:{appId:slug,type:'v6',region:''}}}});if(ip6?.errors?.length)throw new Error('Fly IPv6 allocation failed');
    const machine=await api(fetchImpl,API.fly+'/v1/apps/'+slug+'/machines',{method:'POST',token:t,body:{config:{image,env,services:[{ports:[{port:80,handlers:['http']},{port:443,handlers:['tls','http']}],protocol:'tcp',internal_port:port}]}}});
    id=machine?.id||app?.id||slug;metadata={appName:slug};url='https://'+slug+'.fly.dev';data={app,machine};break;
   }
   case 'cloud-run':{
    const project=required(c,'projectId'),region=c.region||'us-central1',access=required(c,'accessToken');
    const body={template:{containers:[{image,ports:[{containerPort:port}],env:Object.entries(env).map(([name,value])=>({name,value:String(value)}))}]},ingress:'INGRESS_TRAFFIC_ALL'};
    data=await api(fetchImpl,API.cloud+'/v2/projects/'+project+'/locations/'+region+'/services?serviceId='+slug,{method:'POST',token:access,body});
    id=data?.name;metadata={serviceName:slug};url=data?.uri;break;
   }
   case 'aws-apprunner':{
    const role=required(c,'accessRoleArn');
    data=await awsApi(c,'/',{__target:'CreateService',ServiceName:slug,SourceConfiguration:{ImageRepository:{ImageIdentifier:image,ImageRepositoryType:'ECR',ImageConfiguration:{Port:String(port),RuntimeEnvironmentVariables:env},AutoDeploymentsEnabled:false},AuthenticationConfiguration:{AccessRoleArn:role}},HealthCheckConfiguration:{Protocol:'HTTP',Path:r.healthPath||'/',Interval:10,Timeout:5,HealthyThreshold:1,UnhealthyThreshold:5}},fetchImpl);
    id=data?.Service?.ServiceId;metadata={serviceArn:data?.Service?.ServiceArn};url=data?.Service?.ServiceUrl?'https://'+data.Service.ServiceUrl:null;break;
   }
   case 'azure-container-apps':{
    const sub=required(c,'subscriptionId'),group=required(c,'resourceGroup'),location=required(c,'location'),environment=required(c,'containerAppEnvironmentId'),access=required(c,'accessToken');
    const resource='/subscriptions/'+sub+'/resourceGroups/'+group+'/providers/Microsoft.App/containerApps/'+slug;
    const body={location,properties:{managedEnvironmentId:environment,configuration:{ingress:{external:true,targetPort:port,transport:'auto'}},template:{containers:[{name:slug,image,env:Object.entries(env).map(([name,value])=>({name,value:String(value)}))}],scale:{minReplicas:0,maxReplicas:1}}}};
    data=await api(fetchImpl,API.azure+resource+'?api-version=2024-03-01',{method:'PUT',token:access,body});
    id=data?.id;metadata={resourceId:data?.id||resource};url=data?.properties?.configuration?.ingress?.fqdn?'https://'+data.properties.configuration.ingress.fqdn:null;break;
   }
   case 'digitalocean':{
    const imageRepository=required(r,'imageRepository'),imageTag=required(r,'imageTag'),region=c.region||'nyc',registryType=r.registryType||'DOCR';
    if(r.commitSha&&imageTag!==r.commitSha&&imageTag!=='sha-'+r.commitSha)throw new Error('DigitalOcean image tag must match validated commit SHA');
    data=await api(fetchImpl,API.do+'/apps',{method:'POST',token:t,body:{spec:{name:slug,region,services:[{name:slug,image:{registry_type:registryType,repository:imageRepository,tag:imageTag},http_port:port,instance_count:1,instance_size_slug:r.instanceSize||'basic-xxs',envs:Object.entries(env).map(([key,value])=>({key,value:String(value),type:'GENERAL'}))}]}}});
    id=data?.app?.id;metadata={appId:id};url=data?.app?.default_ingress?'https://'+data.app.default_ingress:null;break;
   }
   case 'heroku':{
    let archive;try{archive=new URL(r.sourceTarball);}catch{}if(!archive||archive.protocol!=='https:'||!archive.pathname.includes(r.commitSha))throw new Error('Heroku archive must be HTTPS and include validated commit SHA');
    const app=await api(fetchImpl,API.heroku+'/apps',{method:'POST',token:t,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{name:slug,region:c.region||'us'}});metadata={appId:app?.id,webUrl:app?.web_url};
    const build=await api(fetchImpl,API.heroku+'/apps/'+app.id+'/builds',{method:'POST',token:t,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{source:{url:r.sourceTarball,version:r.commitSha},buildpacks:r.buildpacks}});
    id=build?.id;metadata={appId:app?.id,webUrl:app?.web_url};url=app?.web_url;data={app,build};break;
   }
   case 'vercel':{
    const project=required(c,'projectId'),git=r.gitSource;if(!git?.org||!git?.repo||!git?.ref)throw new Error('Vercel requires linked GitHub org, repo and ref');
    data=await api(fetchImpl,API.vercel+'/v13/deployments',{method:'POST',token:t,body:{name:slug,project,target:r.target||'production',gitSource:{type:'github',org:git.org,repo:git.repo,ref:git.ref,...(git.sha?{sha:git.sha}:{})},...(r.buildCommand?{buildCommand:r.buildCommand}:{}),...(r.outputDirectory?{outputDirectory:r.outputDirectory}:{})}});
    id=data?.id;metadata={teamId:c.teamId};url=data?.url?'https://'+data.url:null;break;
   }
   case 'netlify':{
    const site=c.siteId||(await api(fetchImpl,API.netlify+'/sites',{method:'POST',token:t,body:{name:slug}}))?.id;if(!site)throw new Error('Netlify site create failed');metadata={siteId:site};
    const files={},uploadContents={};for(const [path,content] of Object.entries(r.deployFiles)){if(typeof content!=='string'||!path.startsWith('/')||path.includes('..'))throw new Error('Unsafe Netlify file path or content');const bytes=content.startsWith('base64:')?Buffer.from(content.slice(7),'base64'):Buffer.from(content,'utf8');if(content.startsWith('base64:')&&bytes.toString('base64')!==content.slice(7))throw new Error('Invalid base64 deploy file');files[path]=crypto.createHash('sha256').update(bytes).digest('hex');uploadContents[path]=bytes;}
    data=await api(fetchImpl,API.netlify+'/sites/'+site+'/deploys',{method:'POST',token:t,body:{files}});id=data?.id;metadata={siteId:site,siteCreated:!c.siteId};url=data?.deploy_url||data?.url;
    for(const [path,bytes] of Object.entries(uploadContents)){const upload=await fetchImpl(API.netlify+'/deploys/'+id+'/files/'+encodeURIComponent(path),{method:'PUT',headers:{Authorization:'Bearer '+t,'Content-Type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(15000)});if(!upload.ok)throw new Error('Netlify file upload failed HTTP '+upload.status);}
    break;
   }
   default:throw new Error('Unsupported provider');
  }
  return {ok:true,providerId,providerDeploymentId:id||null,providerStatus:data?.status||data?.state||'provisioning',url,hostname:url?new URL(url).hostname:null,metadata};
 }catch(e){return {ok:false,providerId,error:safeErr(e)};}
}
export function hostingProviderApiBase(providerId){return API[providerId]||null;}
export async function refreshHostingDeployment(providerId,credential,deployment,{fetchImpl=fetch}={}){
 const c=parseCred(credential),t=token(c),id=deployment.providerResourceId,m=deployment.metadata||{};
 try{
  let data,status='unknown',url=deployment.liveUrl||null;
  switch(providerId){
   case 'render':data=await api(fetchImpl,API.render+'/services/'+id,{token:t});status=/live/i.test(data?.service?.status||data?.status||'')?'live':/failed|suspended/i.test(data?.service?.status||data?.status||'')?'failed':'deploying';url=data?.service?.url||data?.url||url;break;
   case 'railway':{const q='query deployment($id: String!) { deployment(id: $id) { id status url staticUrl } }';data=await api(fetchImpl,API.railway,{method:'POST',token:t,body:{query:q,variables:{id}}});const d=data?.data?.deployment;status=['SUCCESS','SUCCEEDED','SUCCESSFUL'].includes(String(d?.status||'').toUpperCase())?'live':String(d?.status||'').toUpperCase()==='FAILED'?'failed':'deploying';url=d?.url||d?.staticUrl||url;break;}
   case 'flyio':data=await api(fetchImpl,API.fly+'/v1/apps/'+m.appName+'/machines/'+id,{token:t});status=data?.state==='started'?'live':data?.state==='stopped'?'failed':'deploying';url=m.appName?'https://'+m.appName+'.fly.dev':url;break;
   case 'cloud-run':data=await api(fetchImpl,API.cloud+'/'+id,{token:required(c,'accessToken')});status=data?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')?'live':data?.conditions?.some(x=>x.type==='Ready'&&x.status==='False')?'failed':'deploying';url=data?.uri||url;break;
   case 'aws-apprunner':data=await awsApi(c,'/',{__target:'DescribeService',ServiceArn:m.serviceArn},fetchImpl);status=data?.Service?.Status==='RUNNING'?'live':/FAILED/.test(data?.Service?.Status||'')?'failed':'deploying';url=data?.Service?.ServiceUrl?'https://'+data.Service.ServiceUrl:url;break;
   case 'azure-container-apps':data=await api(fetchImpl,API.azure+m.resourceId+'?api-version=2024-03-01',{token:required(c,'accessToken')});status=data?.properties?.provisioningState==='Succeeded'?'live':data?.properties?.provisioningState==='Failed'?'failed':'deploying';url=data?.properties?.configuration?.ingress?.fqdn?'https://'+data.properties.configuration.ingress.fqdn:url;break;
   case 'digitalocean':data=await api(fetchImpl,API.do+'/apps/'+id,{token:t});status=data?.app?.active_deployment?.phase==='ACTIVE'?'live':data?.app?.active_deployment?.phase==='ERROR'?'failed':'deploying';url=data?.app?.default_ingress?'https://'+data.app.default_ingress:url;break;
   case 'heroku':data=await api(fetchImpl,API.heroku+'/apps/'+m.appId+'/builds/'+id,{token:t,headers:{Accept:'application/vnd.heroku+json; version=3'}});status=data?.status==='succeeded'?'live':data?.status==='failed'?'failed':'deploying';url=m.webUrl||url;break;
   case 'vercel':data=await api(fetchImpl,API.vercel+'/v13/deployments/'+id+(c.teamId?'?teamId='+encodeURIComponent(c.teamId):''),{token:t});status=data?.readyState==='READY'?'live':data?.readyState==='ERROR'?'failed':'deploying';url=data?.url?'https://'+data.url:url;break;
   case 'netlify':data=await api(fetchImpl,API.netlify+'/deploys/'+id,{token:t});status=data?.state==='ready'?'live':data?.state==='error'?'failed':'deploying';url=data?.deploy_url||data?.url||url;break;
   default:return {ok:false,error:'Unknown provider'};
  }
  return {ok:true,providerId,status,url,providerStatus:data?.status||data?.state||data?.readyState||data?.Service?.Status||null};
 }catch(e){return {ok:false,providerId,error:safeErr(e)};}
}


// Retrieve provider-side logs where the provider exposes a documented deployment-log API.
export async function getHostingDeploymentLogs(providerId, credential, deployment, { fetchImpl = fetch } = {}) {
 const c=parseCred(credential),t=token(c),id=deployment.providerResourceId,m=deployment.metadata||{};
 try {
  let data;
  switch(providerId){
   case 'heroku': data=await api(fetchImpl,API.heroku+'/apps/'+required(m,'appId')+'/builds/'+required({id},'id')+'/output',{token:t,headers:{Accept:'application/vnd.heroku+json; version=3'}});break;
   case 'vercel': data=await api(fetchImpl,API.vercel+'/v2/deployments/'+required({id},'id')+'/events'+(c.teamId?'?teamId='+encodeURIComponent(c.teamId):''),{token:t});break;
   case 'netlify': {const response=await fetchImpl(API.netlify+'/deploys/'+required({id},'id')+'/log',{headers:{Authorization:'Bearer '+t,Accept:'text/plain'},signal:AbortSignal.timeout(15000)});const text=await response.text();if(!response.ok)throw Object.assign(new Error('Provider API returned HTTP '+response.status),{provider:true,status:response.status});return {ok:true,logs:text.slice(-50000)};}
   case 'railway': {const q='query deploymentLogs($deploymentId: String!) { deploymentLogs(deploymentId: $deploymentId) }';data=await api(fetchImpl,API.railway,{method:'POST',token:t,body:{query:q,variables:{deploymentId:id}}});if(data?.errors?.length)throw new Error('Provider deployment logs unavailable');break;}
   default:return {ok:false,error:'Provider log retrieval is not supported by this adapter yet'};
  }
  return {ok:true,logs:JSON.stringify(data).slice(-50000)};
 }catch(e){return {ok:false,error:safeErr(e)};}
}

// Explicit cleanup is only invoked by a user action after the control plane verifies a failed deployment.
// Some providers delete the entire service/app rather than only the individual deployment.
export async function cleanupHostingDeployment(providerId, credential, deployment, { fetchImpl = fetch } = {}) {
 const c=parseCred(credential),t=token(c),id=deployment.providerResourceId,m=deployment.metadata||{};
 try {
  if(!id && !m.serviceId && !m.appId && !m.serviceName && !m.resourceId && !m.serviceArn && !m.appName && !m.siteId) return {ok:false,error:'No provider resource identifier was saved; automatic cleanup cannot safely identify the resource'};
  switch(providerId){
   case 'render': await api(fetchImpl,API.render+'/services/'+required({id},'id'),{method:'DELETE',token:t});break;
   case 'railway': {const q='mutation serviceDelete($id: String!) { serviceDelete(id: $id) }';const d=await api(fetchImpl,API.railway,{method:'POST',token:t,body:{query:q,variables:{id:required(m,'serviceId')}}});if(d?.errors?.length)throw new Error('Provider service deletion failed');break;}
   case 'flyio': await api(fetchImpl,API.fly+'/v1/apps/'+required(m,'appName'),{method:'DELETE',token:t});break;
   case 'cloud-run': await api(fetchImpl,API.cloud+'/'+required({id},'id'),{method:'DELETE',token:required(c,'accessToken')});break;
   case 'aws-apprunner': await awsApi(c,'/',{__target:'DeleteService',ServiceArn:required(m,'serviceArn')},fetchImpl);break;
   case 'azure-container-apps': await api(fetchImpl,API.azure+required(m,'resourceId')+'?api-version=2024-03-01',{method:'DELETE',token:required(c,'accessToken')});break;
   case 'digitalocean': await api(fetchImpl,API.do+'/apps/'+required(m,'appId'),{method:'DELETE',token:t});break;
   case 'heroku': await api(fetchImpl,API.heroku+'/apps/'+required(m,'appId'),{method:'DELETE',token:t,headers:{Accept:'application/vnd.heroku+json; version=3'}});break;
   case 'vercel': await api(fetchImpl,API.vercel+'/v13/deployments/'+required({id},'id')+(c.teamId?'?teamId='+encodeURIComponent(c.teamId):''),{method:'DELETE',token:t});break;
   case 'netlify': if(id) await api(fetchImpl,API.netlify+'/deploys/'+id,{method:'DELETE',token:t}); else if(m.siteCreated) await api(fetchImpl,API.netlify+'/sites/'+required(m,'siteId'),{method:'DELETE',token:t}); else throw new Error('Netlify site is an existing connected site; cleanup will not delete it');break;
   default:return {ok:false,error:'Provider cleanup is not supported'};
  }
  return {ok:true,providerId,deletedResourceId:id||m.appId||m.serviceId||m.serviceArn||m.resourceId||m.serviceName};
 }catch(e){return {ok:false,providerId,error:safeErr(e)};}
}

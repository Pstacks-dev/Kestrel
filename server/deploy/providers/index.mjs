import crypto from 'node:crypto';

const BASE={
 render:'https://api.render.com/v1', railway:'https://backboard.railway.app/graphql/v2',
 flyio:'https://api.fly.io', cloudRun:'https://run.googleapis.com',
 aws:'https://apprunner.amazonaws.com', azure:'https://management.azure.com',
 digitalocean:'https://api.digitalocean.com/v2', heroku:'https://api.heroku.com',
 vercel:'https://api.vercel.com', netlify:'https://api.netlify.com/api/v1'
};
const KEY={
 render:'render',railway:'railway',flyio:'flyio','cloud-run':'cloudRun',
 'aws-apprunner':'aws','azure-container-apps':'azure',digitalocean:'digitalocean',
 heroku:'heroku',vercel:'vercel',netlify:'netlify'
};
function credentials(value){
 if(value&&typeof value==='object'&&!Array.isArray(value))return value;
 if(typeof value!=='string')throw new Error('Provider credential is required');
 try{const p=JSON.parse(value);if(p&&typeof p==='object'&&!Array.isArray(p))return p;}catch{}
 return {token:value};
}
function bearer(c){return c.accessToken||c.token||c.apiToken||c.apiKey;}
function required(obj,key){if(!obj||!obj[key])throw new Error('Required configuration field: '+key);return obj[key];}
function safeError(e){return e?.provider?'Provider API returned HTTP '+e.status:e?.message||'Provider request failed';}
async function request(fetcher,url,opts={}){
 const init={method:opts.method||'GET',headers:{Accept:'application/json',...(opts.token?{Authorization:'Bearer '+opts.token}:{}),...(opts.headers||{}),...(opts.body!==undefined?{'Content-Type':'application/json'}:{})},...(opts.body!==undefined?{body:JSON.stringify(opts.body)}:{}),signal:AbortSignal.timeout(opts.timeout||15000)};
 const response=await fetcher(url,init);const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null;}catch{data=raw;}
 if(!response.ok){const error=new Error(String(data?.message||data?.error?.message||data?.error||data?.detail||response.statusText).slice(0,400));error.status=response.status;error.provider=true;throw error;}
 return data;
}
async function awsRequest(c,path,body,fetcher,method='POST'){
 const region=required(c,'region'),key=required(c,'accessKeyId'),secret=required(c,'secretAccessKey'),host='apprunner.'+region+'.amazonaws.com';
 const target=body?.__target,clean={...body};delete clean.__target;const payload=JSON.stringify(clean);
 const now=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),date=now.slice(0,8);
 const headers={host,'content-type':'application/x-amz-json-1.1','x-amz-date':now,...(target?{'x-amz-target':'AmazonAppRunner.'+target}:{})};
 if(c.sessionToken)headers['x-amz-security-token']=c.sessionToken;
 const sorted=Object.keys(headers).sort(),canonicalHeaders=sorted.map(k=>k.toLowerCase()+':'+headers[k].trim()+'\n').join(''),signed=sorted.join(';');
 const hash=crypto.createHash('sha256').update(payload).digest('hex'),canonical=[method,path,'',canonicalHeaders,signed,hash].join('\n'),scope=date+'/'+region+'/apprunner/aws4_request';
 const stringToSign=['AWS4-HMAC-SHA256',now,scope,crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
 const hmac=(k,v)=>crypto.createHmac('sha256',k).update(v).digest();
 const signing=hmac(hmac(hmac(hmac('AWS4'+secret,date),region),'apprunner'),'aws4_request');
 headers.authorization='AWS4-HMAC-SHA256 Credential='+key+'/'+scope+', SignedHeaders='+signed+', Signature='+hmac(signing,stringToSign).toString('hex');
 const res=await fetcher('https://'+host+path,{method,headers,body:method==='GET'?undefined:payload,signal:AbortSignal.timeout(20000)});
 const raw=await res.text();let data;try{data=raw?JSON.parse(raw):{};}catch{data=raw;}
 if(!res.ok){const error=new Error(String(data?.message||data?.Message||res.statusText));error.status=res.status;error.provider=true;throw error;}return data;
}

export async function verifyHostingProvider(providerId,credential,{fetchImpl=fetch}={}){
 const c=credentials(credential),token=bearer(c);
 try{
  switch(providerId){
   case 'render':{const d=await request(fetchImpl,BASE.render+'/services?limit=1',{token});return {ok:true,providerId,accountLabel:'Render account',sampleCount:Array.isArray(d)?d.length:undefined};}
   case 'railway':{const d=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:'query { projects { edges { node { id name } } } }'}});if(d?.errors?.length)throw new Error('Railway GraphQL token/query rejected');return {ok:true,providerId,accountLabel:'Railway account'};}
   case 'flyio':{const d=await request(fetchImpl,BASE.flyio+'/v1/apps'+(c.orgSlug?'?org_slug='+encodeURIComponent(c.orgSlug):''),{token});return {ok:true,providerId,accountLabel:'Fly.io account',sampleCount:d?.apps?.length??(Array.isArray(d)?d.length:undefined)};}
   case 'cloud-run':{const access=required(c,'accessToken'),project=required(c,'projectId');await request(fetchImpl,'https://cloudresourcemanager.googleapis.com/v1/projects/'+encodeURIComponent(project),{token:access});return {ok:true,providerId,accountLabel:'Google Cloud project '+project};}
   case 'aws-apprunner':{const d=await awsRequest(c,'/',{__target:'ListServices',MaxResults:1},fetchImpl);return {ok:true,providerId,accountLabel:'AWS account',sampleCount:d?.ServiceSummaryList?.length};}
   case 'azure-container-apps':{const access=required(c,'accessToken'),sub=required(c,'subscriptionId');const d=await request(fetchImpl,BASE.azure+'/subscriptions/'+sub+'/resourceGroups?api-version=2021-04-01',{token:access});return {ok:true,providerId,accountLabel:'Azure subscription',sampleCount:d?.value?.length};}
   case 'digitalocean':{const d=await request(fetchImpl,BASE.digitalocean+'/apps?per_page=1',{token});return {ok:true,providerId,accountLabel:'DigitalOcean account',sampleCount:d?.apps?.length};}
   case 'heroku':{const d=await request(fetchImpl,BASE.heroku+'/apps?limit=1',{token,headers:{Accept:'application/vnd.heroku+json; version=3'}});return {ok:true,providerId,accountLabel:'Heroku account',sampleCount:Array.isArray(d)?d.length:undefined};}
   case 'vercel':{const d=await request(fetchImpl,BASE.vercel+'/v9/projects?limit=1'+(c.teamId?'&teamId='+encodeURIComponent(c.teamId):''),{token});return {ok:true,providerId,accountLabel:'Vercel account',sampleCount:d?.projects?.length};}
   case 'netlify':{const d=await request(fetchImpl,BASE.netlify+'/sites?per_page=1',{token});return {ok:true,providerId,accountLabel:'Netlify account',sampleCount:Array.isArray(d)?d.length:undefined};}
   default:return {ok:false,providerId,error:'Unknown provider'};
  }
 }catch(e){return {ok:false,providerId,error:safeError(e)};}
}

function validateDeployment(providerId,r){
 const image=r.image||r.containerImage;
 if(image&&!/@sha256:[a-fA-F0-9]{64}$/.test(image))throw new Error('Container image must use an immutable SHA-256 digest');
 if(!image&&!r.repoUrl&&!r.sourceTarball&&!r.gitSource)throw new Error('Validated source repository URL is required');
 if(['render','flyio','cloud-run','aws-apprunner','azure-container-apps','digitalocean'].includes(providerId)&&!image)throw new Error(providerId+' requires a pinned container image');
 if(providerId==='heroku'&&!r.sourceTarball)throw new Error('Heroku requires a commit-pinned source archive URL');
 if(providerId==='vercel'&&!r.gitSource)throw new Error('Vercel requires a linked Git source');
 if(providerId==='netlify'&&(!r.deployFiles||typeof r.deployFiles!=='object'||Array.isArray(r.deployFiles)||!Object.keys(r.deployFiles).length))throw new Error('Netlify direct deployment requires built artifact files');
 const slug=String(r.projectSlug||'').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
 if(slug.length<2||slug.length>63)throw new Error('Project slug must be 2-63 characters');
 return {image,slug};
}
export async function deployToHostingProvider(providerId,credential,r,{fetchImpl=fetch}={}){
 const c=credentials(credential);
 try{
  const {image,slug}=validateDeployment(providerId,r),token=bearer(c),repoUrl=r.repoUrl,branch=r.branch||'main',port=Number(r.port||3000),env=r.env||{};
  let data,id,url,metadata={};
  switch(providerId){
   case 'render':{
    const ownerId=required(c,'ownerId');
    data=await request(fetchImpl,BASE.render+'/services',{method:'POST',token,body:{type:'web_service',name:slug,ownerId,autoDeployTrigger:'off',image:{url:image},envVars:Object.entries(env).map(([key,value])=>({key,value:String(value)}))}});
    id=data?.service?.id||data?.id;url=data?.service?.serviceDetails?.url||data?.service?.url||data?.url;break;
   }
   case 'railway':{
    const projectId=required(c,'projectId'),environmentId=required(c,'environmentId');
    const createQuery='mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }';
    const created=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:createQuery,variables:{input:{projectId,name:slug,source:repoUrl?{repo:repoUrl}:{image},variables:env}}}});
    if(created?.errors?.length)throw new Error('Railway service creation failed');
    const service=created?.data?.serviceCreate;if(!service?.id)throw new Error('Railway returned no service id');
    const deployQuery='mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';
    const deployed=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:deployQuery,variables:{serviceId:service.id,environmentId,commitSha:r.commitSha}}});
    if(deployed?.errors?.length)throw new Error('Railway deployment trigger failed');
    id=deployed?.data?.serviceInstanceDeployV2||service.id;metadata={serviceId:service.id};data={service,deploymentId:id};
    const domainQuery='mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }';
    const domain=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:domainQuery,variables:{input:{serviceId:service.id,environmentId,targetPort:port}}}});
    if(domain?.errors?.length)throw new Error('Railway public domain creation failed');
    url=domain?.data?.serviceDomainCreate?.domain?'https://'+domain.data.serviceDomainCreate.domain:null;metadata.serviceDomainId=domain?.data?.serviceDomainCreate?.id;break;
   }
   case 'cloud-run':{
    const projectId=required(c,'projectId'),region=c.region||'us-central1',access=required(c,'accessToken');
    const body={template:{containers:[{image,ports:[{containerPort:port}],env:Object.entries(env).map(([name,value])=>({name,value:String(value)}))}]},ingress:'INGRESS_TRAFFIC_ALL'};
    data=await request(fetchImpl,BASE.cloudRun+'/v2/projects/'+projectId+'/locations/'+region+'/services?serviceId='+slug,{method:'POST',token:access,body});
    id=data?.name;metadata={serviceName:slug};url=data?.uri;break;
   }
   case 'aws-apprunner':{
    const role=required(c,'accessRoleArn');
    data=await awsRequest(c,'/',{__target:'CreateService',ServiceName:slug,SourceConfiguration:{ImageRepository:{ImageIdentifier:image,ImageRepositoryType:'ECR',ImageConfiguration:{Port:String(port),RuntimeEnvironmentVariables:env},AutoDeploymentsEnabled:false},AuthenticationConfiguration:{AccessRoleArn:role}},HealthCheckConfiguration:{Protocol:'HTTP',Path:r.healthPath||'/',Interval:10,Timeout:5,HealthyThreshold:1,UnhealthyThreshold:5}},fetchImpl);
    id=data?.Service?.ServiceId;metadata={serviceArn:data?.Service?.ServiceArn};url=data?.Service?.ServiceUrl?'https://'+data.Service.ServiceUrl:null;break;
   }
   case 'azure-container-apps':{
    const sub=required(c,'subscriptionId'),group=required(c,'resourceGroup'),location=required(c,'location'),environmentId=required(c,'containerAppEnvironmentId'),access=required(c,'accessToken');
    const resource='/subscriptions/'+sub+'/resourceGroups/'+group+'/providers/Microsoft.App/containerApps/'+slug;
    const body={location,properties:{managedEnvironmentId:environmentId,configuration:{ingress:{external:true,targetPort:port,transport:'auto'}},template:{containers:[{name:slug,image,env:Object.entries(env).map(([name,value])=>({name,value:String(value)}))}],scale:{minReplicas:0,maxReplicas:1}}}};
    data=await request(fetchImpl,BASE.azure+resource+'?api-version=2024-03-01',{method:'PUT',token:access,body});
    id=data?.id;metadata={resourceId:data?.id||resource};url=data?.properties?.configuration?.ingress?.fqdn?'https://'+data.properties.configuration.ingress.fqdn:null;break;
   }
   case 'digitalocean':{
    const imageRepository=required(r,'imageRepository'),imageTag=required(r,'imageTag'),region=c.region||'nyc',registryType=r.registryType||'DOCR';
    if(r.commitSha&&imageTag!==r.commitSha&&imageTag!=='sha-'+r.commitSha)throw new Error('DigitalOcean image tag must match the validated commit SHA');
    data=await request(fetchImpl,BASE.digitalocean+'/apps',{method:'POST',token,body:{spec:{name:slug,region,services:[{name:slug,image:{registry_type:registryType,repository:imageRepository,tag:imageTag},http_port:port,instance_count:1,instance_size_slug:r.instanceSize||'basic-xxs',envs:Object.entries(env).map(([key,value])=>({key,value:String(value),type:'GENERAL'}))}]}}});
    id=data?.app?.id;metadata={appId:id};url=data?.app?.default_ingress?'https://'+data.app.default_ingress:null;break;
   }
   case 'heroku':{
    let archive;try{archive=new URL(r.sourceTarball);}catch{}
    if(!archive||archive.protocol!=='https:'||!archive.pathname.includes(r.commitSha))throw new Error('Heroku archive URL must be HTTPS and pinned to the validated commit SHA');
    const app=await request(fetchImpl,BASE.heroku+'/apps',{method:'POST',token,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{name:slug,region:c.region||'us'}});
    const build=await request(fetchImpl,BASE.heroku+'/apps/'+app.id+'/builds',{method:'POST',token,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{source:{url:r.sourceTarball,version:r.commitSha},buildpacks:r.buildpacks}});
    id=build?.id;metadata={appId:app?.id,webUrl:app?.web_url};url=app?.web_url;data={app,build};break;
   }
   case 'vercel':{
    const projectId=required(c,'projectId'),git=r.gitSource;
    if(!git?.org||!git?.repo||!git?.ref)throw new Error('Vercel requires connected GitHub org, repo and ref');
    data=await request(fetchImpl,BASE.vercel+'/v13/deployments',{method:'POST',token,body:{name:slug,project:projectId,target:r.target||'production',gitSource:{type:'github',org:git.org,repo:git.repo,ref:git.ref,...(git.sha?{sha:git.sha}:{})},...(r.buildCommand?{buildCommand:r.buildCommand}:{}),...(r.outputDirectory?{outputDirectory:r.outputDirectory}:{})}});
    id=data?.id;metadata={teamId:c.teamId};url=data?.url?'https://'+data.url:null;break;
   }
   case 'netlify':{
    const siteId=c.siteId|| (await request(fetchImpl,BASE.netlify+'/sites',{method:'POST',token,body:{name:slug}}))?.id;
    if(!siteId)throw new Error('Netlify did not return a site id');
    const hashes={};
    for(const [path,content] of Object.entries(r.deployFiles)){if(typeof content!=='string'||!path.startsWith('/')||path.includes('..'))throw new Error('Unsafe deploy file path or content type');hashes[path]=crypto.createHash('sha256').update(content).digest('hex');}
    data=await request(fetchImpl,BASE.netlify+'/sites/'+siteId+'/deploys',{method:'POST',token,body:{files:hashes}});
    id=data?.id;metadata={siteId};url=data?.deploy_url||data?.url;
    for(const [path,content] of Object.entries(r.deployFiles)){
     const upload=await fetchImpl(BASE.netlify+'/deploys/'+id+'/files/'+encodeURIComponent(path),{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:content,signal:AbortSignal.timeout(15000)});
     if(!upload.ok)throw new Error('Netlify file upload failed HTTP '+upload.status);
    }
    break;
   }
   default:throw new Error('Unsupported hosting provider');
  }
  return {ok:true,providerId,providerDeploymentId:id||null,providerStatus:data?.status||data?.state||'provisioning',url,hostname:url?new URL(url).hostname:null,metadata};
 }catch(e){return {ok:false,providerId,error:safeError(e)};}
}
export function hostingProviderApiBase(providerId){const k=KEY[providerId];return k?BASE[k]:null;}

export async function refreshHostingDeployment(providerId,credential,deployment,{fetchImpl=fetch}={}){
 const c=credentials(credential),token=bearer(c),id=deployment.providerResourceId,meta=deployment.metadata||{};
 try{
  let data,status='unknown',url=deployment.liveUrl||null;
  switch(providerId){
   case 'render':data=await request(fetchImpl,BASE.render+'/services/'+id,{token});status=/live/i.test(data?.service?.status||data?.status||'')?'live':/failed|suspended/i.test(data?.service?.status||data?.status||'')?'failed':'deploying';url=data?.service?.url||data?.url||url;break;
   case 'railway':{const q='query deployment($id: String!) { deployment(id: $id) { id status url staticUrl } }';data=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:q,variables:{id}}});const d=data?.data?.deployment;status=['SUCCESS','SUCCEEDED','SUCCESSFUL'].includes(String(d?.status||'').toUpperCase())?'live':String(d?.status||'').toUpperCase()==='FAILED'?'failed':'deploying';url=d?.url||d?.staticUrl||url;break;}
   case 'flyio':data=await request(fetchImpl,BASE.flyio+'/v1/apps/'+meta.appName+'/machines/'+id,{token});status=data?.state==='started'?'live':data?.state==='stopped'?'failed':'deploying';url=meta.appName?'https://'+meta.appName+'.fly.dev':url;break;
   case 'cloud-run':data=await request(fetchImpl,BASE.cloudRun+'/'+id,{token:required(c,'accessToken')});status=data?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')?'live':data?.conditions?.some(x=>x.type==='Ready'&&x.status==='False')?'failed':'deploying';url=data?.uri||url;break;
   case 'aws-apprunner':data=await awsRequest(c,'/',{__target:'DescribeService',ServiceArn:meta.serviceArn},fetchImpl);status=data?.Service?.Status==='RUNNING'?'live':/FAILED/.test(data?.Service?.Status||'')?'failed':'deploying';url=data?.Service?.ServiceUrl?'https://'+data.Service.ServiceUrl:url;break;
   case 'azure-container-apps':data=await request(fetchImpl,BASE.azure+meta.resourceId+'?api-version=2024-03-01',{token:required(c,'accessToken')});status=data?.properties?.provisioningState==='Succeeded'?'live':data?.properties?.provisioningState==='Failed'?'failed':'deploying';url=data?.properties?.configuration?.ingress?.fqdn?'https://'+data.properties.configuration.ingress.fqdn:url;break;
   case 'digitalocean':data=await request(fetchImpl,BASE.digitalocean+'/apps/'+id,{token});status=data?.app?.active_deployment?.phase==='ACTIVE'?'live':data?.app?.active_deployment?.phase==='ERROR'?'failed':'deploying';url=data?.app?.default_ingress?'https://'+data.app.default_ingress:url;break;
   case 'heroku':data=await request(fetchImpl,BASE.heroku+'/apps/'+meta.appId+'/builds/'+id,{token,headers:{Accept:'application/vnd.heroku+json; version=3'}});status=data?.status==='succeeded'?'live':data?.status==='failed'?'failed':'deploying';url=meta.webUrl||url;break;
   case 'vercel':data=await request(fetchImpl,BASE.vercel+'/v13/deployments/'+id+(c.teamId?'?teamId='+encodeURIComponent(c.teamId):''),{token});status=data?.readyState==='READY'?'live':data?.readyState==='ERROR'?'failed':'deploying';url=data?.url?'https://'+data.url:url;break;
   case 'netlify':data=await request(fetchImpl,BASE.netlify+'/deploys/'+id,{token});status=data?.state==='ready'?'live':data?.state==='error'?'failed':'deploying';url=data?.deploy_url||data?.url||url;break;
   default:return {ok:false,error:'Unknown provider'};
  }
  return {ok:true,providerId,status,url,providerStatus:data?.status||data?.state||data?.readyState||data?.Service?.Status||null};
 }catch(e){return {ok:false,providerId,error:safeError(e)};}
}   case 'flyio':{
    const orgSlug=required(c,'orgSlug');
    const app=await request(fetchImpl,BASE.flyio+'/v1/apps',{method:'POST',token,body:{app_name:slug,org_slug:orgSlug}});
    const ipQuery='mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { app { sharedIpAddress } } }';
    const ipv4=await request(fetchImpl,'https://api.fly.io/graphql',{method:'POST',token,body:{query:ipQuery,variables:{input:{appId:slug,type:'shared_v4',region:''}}}});
    if(ipv4?.errors?.length)throw new Error('Fly.io public IPv4 allocation failed');
    const ipv6Query='mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address type region createdAt } } }';
    const ipv6=await request(fetchImpl,'https://api.fly.io/graphql',{method:'POST',token,body:{query:ipv6Query,variables:{input:{appId:slug,type:'v6',region:''}}}});
    if(ipv6?.errors?.length)throw new Error('Fly.io public IPv6 allocation failed');
    const machine=await request(fetchImpl,BASE.flyio+'/v1/apps/'+slug+'/machines',{method:'POST',token,body:{config:{image,env,services:[{ports:[{port:80,handlers:['http']},{port:443,handlers:['tls','http']}],protocol:'tcp',internal_port:port}]}}});
    id=machine?.id||app?.id||slug;metadata={appName:slug};url='https://'+slug+'.fly.dev';data={app,machine};break;
   }
   case 'cloud-run':{const access=required(c,'accessToken'),project=required(c,'projectId');await request(fetchImpl,'https://cloudresourcemanager.googleapis.com/v1/projects/'+encodeURIComponent(project),{token:access});return {ok:true,providerId,accountLabel:'Google Cloud project '+project};}
   case 'aws-apprunner':{const d=await awsRequest(c,'/',{__target:'ListServices',MaxResults:1},fetchImpl);return {ok:true,providerId,accountLabel:'AWS account',sampleCount:d?.ServiceSummaryList?.length};}
   case 'azure-container-apps':{const access=required(c,'accessToken'),sub=required(c,'subscriptionId');const d=await request(fetchImpl,BASE.azure+'/subscriptions/'+sub+'/resourceGroups?api-version=2021-04-01',{token:access});return {ok:true,providerId,accountLabel:'Azure subscription',sampleCount:d?.value?.length};}
   case 'digitalocean':{const d=await request(fetchImpl,BASE.digitalocean+'/apps?per_page=1',{token});return {ok:true,providerId,accountLabel:'DigitalOcean account',sampleCount:d?.apps?.length};}
   case 'heroku':{const d=await request(fetchImpl,BASE.heroku+'/apps?limit=1',{token,headers:{Accept:'application/vnd.heroku+json; version=3'}});return {ok:true,providerId,accountLabel:'Heroku account',sampleCount:Array.isArray(d)?d.length:undefined};}
   case 'vercel':{const d=await request(fetchImpl,BASE.vercel+'/v9/projects?limit=1'+(c.teamId?'&teamId='+encodeURIComponent(c.teamId):''),{token});return {ok:true,providerId,accountLabel:'Vercel account',sampleCount:d?.projects?.length};}
   case 'netlify':{const d=await request(fetchImpl,BASE.netlify+'/sites?per_page=1',{token});return {ok:true,providerId,accountLabel:'Netlify account',sampleCount:Array.isArray(d)?d.length:undefined};}
   default:return {ok:false,providerId,error:'Unknown provider'};
  }
 }catch(e){return {ok:false,providerId,error:safeError(e)};}
}

function validateDeployment(providerId,r){
 const image=r.image||r.containerImage;
 if(image&&!/@sha256:[a-fA-F0-9]{64}$/.test(image))throw new Error('Container image must use an immutable SHA-256 digest');
 if(!image&&!r.repoUrl&&!r.sourceTarball&&!r.gitSource)throw new Error('Validated source repository URL is required');
 if(['render','flyio','cloud-run','aws-apprunner','azure-container-apps','digitalocean'].includes(providerId)&&!image)throw new Error(providerId+' requires a pinned container image');
 if(providerId==='heroku'&&!r.sourceTarball)throw new Error('Heroku requires a commit-pinned source archive URL');
 if(providerId==='vercel'&&!r.gitSource)throw new Error('Vercel requires a linked Git source');
 if(providerId==='netlify'&&(!r.deployFiles||typeof r.deployFiles!=='object'||Array.isArray(r.deployFiles)||!Object.keys(r.deployFiles).length))throw new Error('Netlify direct deployment requires built artifact files');
 const slug=String(r.projectSlug||'').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
 if(slug.length<2||slug.length>63)throw new Error('Project slug must be 2-63 characters');
 return {image,slug};
}
export async function deployToHostingProvider(providerId,credential,r,{fetchImpl=fetch}={}){
 const c=credentials(credential);
 try{
  const {image,slug}=validateDeployment(providerId,r),token=bearer(c),repoUrl=r.repoUrl,branch=r.branch||'main',port=Number(r.port||3000),env=r.env||{};
  let data,id,url,metadata={};
  switch(providerId){
   case 'render':{
    const ownerId=required(c,'ownerId');
    data=await request(fetchImpl,BASE.render+'/services',{method:'POST',token,body:{type:'web_service',name:slug,ownerId,autoDeployTrigger:'off',image:{url:image},envVars:Object.entries(env).map(([key,value])=>({key,value:String(value)}))}});
    id=data?.service?.id||data?.id;url=data?.service?.serviceDetails?.url||data?.service?.url||data?.url;break;
   }
   case 'railway':{
    const projectId=required(c,'projectId'),environmentId=required(c,'environmentId');
    const createQuery='mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }';
    const created=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:createQuery,variables:{input:{projectId,name:slug,source:repoUrl?{repo:repoUrl}:{image},variables:env}}}});
    if(created?.errors?.length)throw new Error('Railway service creation failed');
    const service=created?.data?.serviceCreate;if(!service?.id)throw new Error('Railway returned no service id');
    const deployQuery='mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }';
    const deployed=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:deployQuery,variables:{serviceId:service.id,environmentId,commitSha:r.commitSha}}});
    if(deployed?.errors?.length)throw new Error('Railway deployment trigger failed');
    id=deployed?.data?.serviceInstanceDeployV2||service.id;metadata={serviceId:service.id};data={service,deploymentId:id};
    const domainQuery='mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }';
    const domain=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:domainQuery,variables:{input:{serviceId:service.id,environmentId,targetPort:port}}}});
    if(domain?.errors?.length)throw new Error('Railway public domain creation failed');
    url=domain?.data?.serviceDomainCreate?.domain?'https://'+domain.data.serviceDomainCreate.domain:null;metadata.serviceDomainId=domain?.data?.serviceDomainCreate?.id;break;
   }
   case 'cloud-run':{
    const projectId=required(c,'projectId'),region=c.region||'us-central1',access=required(c,'accessToken');
    const body={template:{containers:[{image,ports:[{containerPort:port}],env:Object.entries(env).map(([name,value])=>({name,value:String(value)}))}]},ingress:'INGRESS_TRAFFIC_ALL'};
    data=await request(fetchImpl,BASE.cloudRun+'/v2/projects/'+projectId+'/locations/'+region+'/services?serviceId='+slug,{method:'POST',token:access,body});
    id=data?.name;metadata={serviceName:slug};url=data?.uri;break;
   }
   case 'aws-apprunner':{
    const role=required(c,'accessRoleArn');
    data=await awsRequest(c,'/',{__target:'CreateService',ServiceName:slug,SourceConfiguration:{ImageRepository:{ImageIdentifier:image,ImageRepositoryType:'ECR',ImageConfiguration:{Port:String(port),RuntimeEnvironmentVariables:env},AutoDeploymentsEnabled:false},AuthenticationConfiguration:{AccessRoleArn:role}},HealthCheckConfiguration:{Protocol:'HTTP',Path:r.healthPath||'/',Interval:10,Timeout:5,HealthyThreshold:1,UnhealthyThreshold:5}},fetchImpl);
    id=data?.Service?.ServiceId;metadata={serviceArn:data?.Service?.ServiceArn};url=data?.Service?.ServiceUrl?'https://'+data.Service.ServiceUrl:null;break;
   }
   case 'azure-container-apps':{
    const sub=required(c,'subscriptionId'),group=required(c,'resourceGroup'),location=required(c,'location'),environmentId=required(c,'containerAppEnvironmentId'),access=required(c,'accessToken');
    const resource='/subscriptions/'+sub+'/resourceGroups/'+group+'/providers/Microsoft.App/containerApps/'+slug;
    data=await request(fetchImpl,BASE.azure+resource+'?api-version=2024-03-01',{method:'PUT',token:access,body:{location,properties:{managedEnvironmentId:environmentId,configuration:{ingress:{external:true,targetPort:port,transport:'auto'}},template:{containers:[{name:slug,image,env:Object.entries(env).map(([name,value])=>({name,value:String(value)}))}],scale:{minReplicas:0,maxReplicas:1}}}});
    id=data?.id;metadata={resourceId:data?.id||resource};url=data?.properties?.configuration?.ingress?.fqdn?'https://'+data.properties.configuration.ingress.fqdn:null;break;
   }
   case 'digitalocean':{
    const imageRepository=required(r,'imageRepository'),imageTag=required(r,'imageTag'),region=c.region||'nyc',registryType=r.registryType||'DOCR';
    if(r.commitSha&&imageTag!==r.commitSha&&imageTag!=='sha-'+r.commitSha)throw new Error('DigitalOcean image tag must match the validated commit SHA');
    data=await request(fetchImpl,BASE.digitalocean+'/apps',{method:'POST',token,body:{spec:{name:slug,region,services:[{name:slug,image:{registry_type:registryType,repository:imageRepository,tag:imageTag},http_port:port,instance_count:1,instance_size_slug:r.instanceSize||'basic-xxs',envs:Object.entries(env).map(([key,value])=>({key,value:String(value),type:'GENERAL'}))}]}}});
    id=data?.app?.id;metadata={appId:id};url=data?.app?.default_ingress?'https://'+data.app.default_ingress:null;break;
   }
   case 'heroku':{
    let archive;try{archive=new URL(r.sourceTarball);}catch{}
    if(!archive||archive.protocol!=='https:'||!archive.pathname.includes(r.commitSha))throw new Error('Heroku archive URL must be HTTPS and pinned to the validated commit SHA');
    const app=await request(fetchImpl,BASE.heroku+'/apps',{method:'POST',token,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{name:slug,region:c.region||'us'}});
    const build=await request(fetchImpl,BASE.heroku+'/apps/'+app.id+'/builds',{method:'POST',token,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{source:{url:r.sourceTarball,version:r.commitSha},buildpacks:r.buildpacks}});
    id=build?.id;metadata={appId:app?.id,webUrl:app?.web_url};url=app?.web_url;data={app,build};break;
   }
   case 'vercel':{
    const projectId=required(c,'projectId'),git=r.gitSource;
    if(!git?.org||!git?.repo||!git?.ref)throw new Error('Vercel requires connected GitHub org, repo and ref');
    data=await request(fetchImpl,BASE.vercel+'/v13/deployments',{method:'POST',token,body:{name:slug,project:projectId,target:r.target||'production',gitSource:{type:'github',org:git.org,repo:git.repo,ref:git.ref,...(git.sha?{sha:git.sha}:{})},...(r.buildCommand?{buildCommand:r.buildCommand}:{}),...(r.outputDirectory?{outputDirectory:r.outputDirectory}:{})}});
    id=data?.id;metadata={teamId:c.teamId};url=data?.url?'https://'+data.url:null;break;
   }
   case 'netlify':{
    const siteId=c.siteId|| (await request(fetchImpl,BASE.netlify+'/sites',{method:'POST',token,body:{name:slug}}))?.id;
    if(!siteId)throw new Error('Netlify did not return a site id');
    const hashes={};
    for(const [path,content] of Object.entries(r.deployFiles)){if(typeof content!=='string'||!path.startsWith('/')||path.includes('..'))throw new Error('Unsafe deploy file path or content type');hashes[path]=crypto.createHash('sha256').update(content).digest('hex');}
    data=await request(fetchImpl,BASE.netlify+'/sites/'+siteId+'/deploys',{method:'POST',token,body:{files:hashes}});
    id=data?.id;metadata={siteId};url=data?.deploy_url||data?.url;
    for(const [path,content] of Object.entries(r.deployFiles)){
     const upload=await fetchImpl(BASE.netlify+'/deploys/'+id+'/files/'+encodeURIComponent(path),{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:content,signal:AbortSignal.timeout(15000)});
     if(!upload.ok)throw new Error('Netlify file upload failed HTTP '+upload.status);
    }
    break;
   }
   default:throw new Error('Unsupported hosting provider');
  }
  return {ok:true,providerId,providerDeploymentId:id||null,providerStatus:data?.status||data?.state||'provisioning',url,hostname:url?new URL(url).hostname:null,metadata};
 }catch(e){return {ok:false,providerId,error:safeError(e)};}
}
export function hostingProviderApiBase(providerId){const k=KEY[providerId];return k?BASE[k]:null;}

export async function refreshHostingDeployment(providerId,credential,deployment,{fetchImpl=fetch}={}){
 const c=credentials(credential),token=bearer(c),id=deployment.providerResourceId,meta=deployment.metadata||{};
 try{
  let data,status='unknown',url=deployment.liveUrl||null;
  switch(providerId){
   case 'render':data=await request(fetchImpl,BASE.render+'/services/'+id,{token});status=/live/i.test(data?.service?.status||data?.status||'')?'live':/failed|suspended/i.test(data?.service?.status||data?.status||'')?'failed':'deploying';url=data?.service?.url||data?.url||url;break;
   case 'railway':{const q='query deployment($id: String!) { deployment(id: $id) { id status url staticUrl } }';data=await request(fetchImpl,BASE.railway,{method:'POST',token,body:{query:q,variables:{id}}});const d=data?.data?.deployment;status=['SUCCESS','SUCCEEDED','SUCCESSFUL'].includes(String(d?.status||'').toUpperCase())?'live':String(d?.status||'').toUpperCase()==='FAILED'?'failed':'deploying';url=d?.url||d?.staticUrl||url;break;}
   case 'flyio':data=await request(fetchImpl,BASE.flyio+'/v1/apps/'+meta.appName+'/machines/'+id,{token});status=data?.state==='started'?'live':data?.state==='stopped'?'failed':'deploying';url=meta.appName?'https://'+meta.appName+'.fly.dev':url;break;
   case 'cloud-run':data=await request(fetchImpl,BASE.cloudRun+'/'+id,{token:required(c,'accessToken')});status=data?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')?'live':data?.conditions?.some(x=>x.type==='Ready'&&x.status==='False')?'failed':'deploying';url=data?.uri||url;break;
   case 'aws-apprunner':data=await awsRequest(c,'/',{__target:'DescribeService',ServiceArn:meta.serviceArn},fetchImpl);status=data?.Service?.Status==='RUNNING'?'live':/FAILED/.test(data?.Service?.Status||'')?'failed':'deploying';url=data?.Service?.ServiceUrl?'https://'+data.Service.ServiceUrl:url;break;
   case 'azure-container-apps':data=await request(fetchImpl,BASE.azure+meta.resourceId+'?api-version=2024-03-01',{token:required(c,'accessToken')});status=data?.properties?.provisioningState==='Succeeded'?'live':data?.properties?.provisioningState==='Failed'?'failed':'deploying';url=data?.properties?.configuration?.ingress?.fqdn?'https://'+data.properties.configuration.ingress.fqdn:url;break;
   case 'digitalocean':data=await request(fetchImpl,BASE.digitalocean+'/apps/'+id,{token});status=data?.app?.active_deployment?.phase==='ACTIVE'?'live':data?.app?.active_deployment?.phase==='ERROR'?'failed':'deploying';url=data?.app?.default_ingress?'https://'+data.app.default_ingress:url;break;
   case 'heroku':data=await request(fetchImpl,BASE.heroku+'/apps/'+meta.appId+'/builds/'+id,{token,headers:{Accept:'application/vnd.heroku+json; version=3'}});status=data?.status==='succeeded'?'live':data?.status==='failed'?'failed':'deploying';url=meta.webUrl||url;break;
   case 'vercel':data=await request(fetchImpl,BASE.vercel+'/v13/deployments/'+id+(c.teamId?'?teamId='+encodeURIComponent(c.teamId):''),{token});status=data?.readyState==='READY'?'live':data?.readyState==='ERROR'?'failed':'deploying';url=data?.url?'https://'+data.url:url;break;
   case 'netlify':data=await request(fetchImpl,BASE.netlify+'/deploys/'+id,{token});status=data?.state==='ready'?'live':data?.state==='error'?'failed':'deploying';url=data?.deploy_url||data?.url||url;break;
   default:return {ok:false,error:'Unknown provider'};
  }
  return {ok:true,providerId,status,url,providerStatus:data?.status||data?.state||data?.readyState||data?.Service?.Status||null};
 }catch(e){return {ok:false,providerId,error:safeError(e)};}
}

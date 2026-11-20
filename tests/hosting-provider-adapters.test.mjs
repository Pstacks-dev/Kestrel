import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyHostingProvider, deployToHostingProvider, refreshHostingDeployment } from '../server/deploy/providers/index.mjs';

const ids=['render','railway','flyio','cloud-run','aws-apprunner','azure-container-apps','digitalocean','heroku','vercel','netlify'];
const response=(payload,status=200)=>new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
const mockFetch=handler=>async(url,init={})=>handler(String(url),init);
const credentials={render:{token:'r-token',ownerId:'workspace'},railway:{token:'rw-token',projectId:'proj',environmentId:'env'},flyio:{token:'fly-token',orgSlug:'personal'},'cloud-run':{accessToken:'gcp-token',projectId:'test-project'},'aws-apprunner':{accessKeyId:'AKID',secretAccessKey:'secret',region:'us-east-1',accessRoleArn:'arn:aws:iam::123456789012:role/AppRunnerECRAccess'},'azure-container-apps':{accessToken:'azure-token',subscriptionId:'sub',resourceGroup:'rg',location:'westus',containerAppEnvironmentId:'/env'},digitalocean:{token:'do-token',region:'nyc'},heroku:{token:'hk-token',region:'us'},vercel:{token:'vc-token',projectId:'proj'},netlify:{token:'nt-token'}};

test('credential verification API adapters for all ten providers pass mocked success contracts',async()=>{
 const mocks={render:()=>response([]),railway:()=>response({data:{projects:{edges:[]}}}),flyio:()=>response({apps:[]}),'cloud-run':()=>response({projectId:'test-project'}),'aws-apprunner':()=>response({ServiceSummaryList:[]}), 'azure-container-apps':()=>response({value:[]}),digitalocean:()=>response({apps:[]}),heroku:()=>response([]),vercel:()=>response({projects:[]}),netlify:()=>response([])};
 for(const providerId of ids){let hit=false;const result=await verifyHostingProvider(providerId,credentials[providerId],{fetchImpl:mockFetch((url,init)=>{hit=true;assert.ok(url.startsWith('https://'));if(providerId!=='aws-apprunner')assert.ok(init.headers.Authorization);return mocks[providerId]();})});assert.equal(result.ok,true,providerId+': '+result.error);assert.equal(hit,true,providerId+' API was not called');}
});

test('credential verification safely reports rejected credentials',async()=>{
 for(const providerId of ['render','railway','flyio','digitalocean','heroku','vercel','netlify']){const result=await verifyHostingProvider(providerId,'bad-token',{fetchImpl:async()=>response({message:'unauthorized'},401)});assert.equal(result.ok,false);assert.match(result.error,/HTTP 401/);assert.doesNotMatch(result.error,/unauthorized/i);}
});

test('deployment request rejects mutable image tags and malformed slug before API call',async()=>{
 const fetchImpl=async()=>{throw new Error('should not call network');};
 const mutable=await deployToHostingProvider('flyio','token',{projectSlug:'sample',image:'registry/app:latest'},{fetchImpl});assert.equal(mutable.ok,false);assert.match(mutable.error,/SHA-256 digest/);
 const badSlug=await deployToHostingProvider('render','token',{projectSlug:'x',image:'registry/app@sha256:'+'b'.repeat(64)},{fetchImpl});assert.equal(badSlug.ok,false);assert.match(badSlug.error,/2-63 characters/);
});

test('mocked provision API contract runs for all ten hosting providers',async()=>{
 const digest='sha256:'+'a'.repeat(64), image='registry.example/app@'+digest;
 const deployInputs={
 render:{projectSlug:'demo',image,appType:'docker'},
 railway:{projectSlug:'demo',image,commitSha:'abc123'},
 flyio:{projectSlug:'demo',image},
 'cloud-run':{projectSlug:'demo',image,port:8080},
 'aws-apprunner':{projectSlug:'demo',image,port:8080},
 'azure-container-apps':{projectSlug:'demo',image,port:8080},
 digitalocean:{projectSlug:'demo',image,imageRepository:'repo',imageTag:'sha-abc123',registryType:'DOCR',commitSha:'abc123'},
 heroku:{projectSlug:'demo',repoUrl:'https://github.com/org/repo',sourceTarball:'https://example.test/abc-source.tgz',commitSha:'abc'},
 vercel:{projectSlug:'demo',gitSource:{org:'org',repo:'repo',ref:'main',sha:'abc'}},
 netlify:{projectSlug:'demo',repoUrl:'https://github.com/org/repo',deployFiles:{'/index.html':'<html>hello</html>'}},
 };
 const urlResponses={
 render:{service:{id:'render-svc',url:'https://demo.onrender.com'}},
 railway:{data:{serviceCreate:{id:'rail-service'},serviceInstanceDeployV2:'rail-deploy'}},
 flyio:{id:'fly-machine',app_name:'demo'},
 'cloud-run':{name:'projects/p/locations/r/services/demo',uri:'https://demo.run.app'},
 'aws-apprunner':{Service:{ServiceId:'aws-svc',ServiceUrl:'demo.awsapprunner.com'}},
 'azure-container-apps':{id:'aca',properties:{configuration:{ingress:{fqdn:'demo.azurecontainerapps.io'}}}},
 digitalocean:{app:{id:'do-app',default_ingress:'demo.ondigitalocean.app'}},
 heroku:{id:'build-id',app:{id:'heroku-app',web_url:'https://demo.herokuapp.com'}},
 vercel:{id:'vercel-deploy',url:'demo.vercel.app'},
 netlify:{id:'netlify-deploy',deploy_url:'https://deploy-preview.netlify.app'},
 };
 for(const providerId of ids){let calls=0;const result=await deployToHostingProvider(providerId,credentials[providerId],deployInputs[providerId],{fetchImpl:mockFetch((url,init)=>{calls++;assert.ok(url.startsWith('https://'),providerId);if(providerId==='aws-apprunner')assert.match(init.headers.authorization,/AWS4-HMAC-SHA256/);if(providerId==='netlify'&&calls===1)return response({id:'site-id'});if(providerId==='railway'&&calls===1)return response({data:{serviceCreate:{id:'rail-service'}}});if(providerId==='railway'&&calls===2)return response({data:{serviceInstanceDeployV2:'rail-deploy'}});if(providerId==='railway'&&calls===3)return response({data:{serviceDomainCreate:{id:'domain',domain:'demo.up.railway.app'}}});if(providerId==='flyio'&&calls===1)return response({app_name:'demo'});if(providerId==='flyio'&&calls<=3)return response({data:{allocateIpAddress:{ipAddress:{address:'1.2.3.4'}}}});return response(urlResponses[providerId]);})});assert.equal(result.ok,true,providerId+': '+result.error);assert.ok(calls>=1,providerId+' made no request');assert.ok(result.providerDeploymentId,providerId+' returned no resource ID');if(providerId==='railway')assert.equal(result.url,'https://demo.up.railway.app');if(providerId==='flyio')assert.equal(result.url,'https://demo.fly.dev');}
});

test('status refresh API adapters cover all ten providers with mocked live responses',async()=>{
 const cases=[
  {id:'render',cred:'token',deployment:{providerResourceId:'service',metadata:{}},url:'/services/service',payload:{status:'live',url:'https://live.onrender.com'}},
  {id:'railway',cred:'token',deployment:{providerResourceId:'deploy',metadata:{}},payload:{data:{deployment:{status:'SUCCESS',url:'https://live.up.railway.app'}}}},
  {id:'flyio',cred:{token:'token'},deployment:{providerResourceId:'machine',metadata:{appName:'demo'}},payload:{state:'started'}},
  {id:'cloud-run',cred:{accessToken:'token'},deployment:{providerResourceId:'projects/p/locations/r/services/s',metadata:{}},payload:{uri:'https://run.app',conditions:[{type:'Ready',status:'True'}]}},
  {id:'aws-apprunner',cred:{accessKeyId:'AKID',secretAccessKey:'secret',region:'us-east-1'},deployment:{providerResourceId:'id',metadata:{serviceArn:'arn:aws:apprunner:us-east-1:123:service/x'}},payload:{Service:{Status:'RUNNING',ServiceUrl:'service.awsapprunner.com'}}},
  {id:'azure-container-apps',cred:{accessToken:'token'},deployment:{providerResourceId:'id',metadata:{resourceId:'/resource'}},payload:{properties:{provisioningState:'Succeeded',configuration:{ingress:{fqdn:'live.azurecontainerapps.io'}}}}},
  {id:'digitalocean',cred:'token',deployment:{providerResourceId:'app',metadata:{}},payload:{app:{active_deployment:{phase:'ACTIVE'},default_ingress:'live.ondigitalocean.app'}}},
  {id:'heroku',cred:'token',deployment:{providerResourceId:'build',metadata:{appId:'app',webUrl:'https://live.herokuapp.com'}},payload:{status:'succeeded'}},
  {id:'vercel',cred:'token',deployment:{providerResourceId:'deploy',metadata:{}},payload:{readyState:'READY',url:'live.vercel.app'}},
  {id:'netlify',cred:'token',deployment:{providerResourceId:'deploy',metadata:{}},payload:{state:'ready',deploy_url:'https://live.netlify.app'}}
 ];
 for(const item of cases){const result=await refreshHostingDeployment(item.id,item.cred,item.deployment,{fetchImpl:mockFetch((url,init)=>{assert.ok(url.startsWith('https://'),item.id);if(item.id==='railway')return response(item.payload);return response(item.payload);})});assert.equal(result.ok,true,item.id+': '+result.error);assert.equal(result.status,'live',item.id);assert.ok(result.url,item.id+' should return a deployment URL');}
});

test('AWS App Runner SigV4 signature matches independently calculated canonical request',async()=>{
 let captured;
 const result=await verifyHostingProvider('aws-apprunner',credentials['aws-apprunner'],{fetchImpl:async(url,init)=>{captured={url:String(url),init};return response({ServiceSummaryList:[]});}});
 assert.equal(result.ok,true,result.error);
 assert.equal(captured.url,'https://apprunner.us-east-1.amazonaws.com/');
 assert.equal(captured.init.headers['x-amz-target'],'AmazonAppRunner.ListServices');
 const auth=captured.init.headers.authorization;
 const signedHeaders='content-type;host;x-amz-date;x-amz-target';
 assert.ok(auth.includes('SignedHeaders='+signedHeaders));
 const headers=captured.init.headers,date=headers['x-amz-date'],day=date.slice(0,8),region='us-east-1';
 const canonicalHeaders=signedHeaders.split(';').map(name=>name+':'+headers[name].trim()+'\n').join('');
 const payloadHash=crypto.createHash('sha256').update(captured.init.body).digest('hex');
 const canonicalRequest=['POST','/','',canonicalHeaders+signedHeaders,payloadHash].join('\n');
 const scope=day+'/'+region+'/apprunner/aws4_request';
 const stringToSign=['AWS4-HMAC-SHA256',date,scope,crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
 const hmac=(key,value)=>crypto.createHmac('sha256',key).update(value).digest();
 const signingKey=hmac(hmac(hmac(hmac('AWS4'+credentials['aws-apprunner'].secretAccessKey,day),region),'apprunner'),'aws4_request');
 const expected=hmac(signingKey,stringToSign).toString('hex');
 assert.equal(auth.match(/Signature=([a-f0-9]{64})$/)?.[1],expected,'signature must use the canonical AWS request');
});


test('provider failures classify retry safety conservatively', async () => {
 const digest='sha256:'+'b'.repeat(64), input={projectSlug:'retry-app',image:'registry.example/app@'+digest,appType:'docker'};
 const rateLimited=await deployToHostingProvider('render',{token:'r-token',ownerId:'owner'},input,{fetchImpl:async()=>response({message:'rate limited'},429)});
 assert.equal(rateLimited.ok,false); assert.equal(rateLimited.retryable,true); assert.equal(rateLimited.ambiguous,false);
 const serverError=await deployToHostingProvider('render',{token:'r-token',ownerId:'owner'},input,{fetchImpl:async()=>response({message:'internal error'},500)});
 assert.equal(serverError.ok,false); assert.equal(serverError.retryable,false); assert.equal(serverError.ambiguous,true);
 const networkFailure=await deployToHostingProvider('render',{token:'r-token',ownerId:'owner'},input,{fetchImpl:async()=>{throw new Error('socket timeout');}});
 assert.equal(networkFailure.ok,false); assert.equal(networkFailure.retryable,false); assert.equal(networkFailure.ambiguous,true);
});

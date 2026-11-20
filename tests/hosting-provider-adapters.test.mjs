import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyHostingProvider, deployToHostingProvider } from '../server/deploy/providers/index.mjs';

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
 const badSlug=await deployToHostingProvider('render','token',{projectSlug:'x',repoUrl:'https://github.com/org/repo'},{fetchImpl});assert.equal(badSlug.ok,false);assert.match(badSlug.error,/2-63 characters/);
});

test('mocked provision API contract runs for all ten hosting providers',async()=>{
 const digest='sha256:'+'a'.repeat(64), image='registry.example/app@'+digest;
 const deployInputs={
 render:{projectSlug:'demo',image,appType:'docker'},
 railway:{projectSlug:'demo',image},
 flyio:{projectSlug:'demo',image},
 'cloud-run':{projectSlug:'demo',image,port:8080},
 'aws-apprunner':{projectSlug:'demo',image,port:8080},
 'azure-container-apps':{projectSlug:'demo',image,port:8080},
 digitalocean:{projectSlug:'demo',image,imageRepository:'repo',imageTag:'sha-a',registryType:'DOCR'},
 heroku:{projectSlug:'demo',repoUrl:'https://github.com/org/repo',sourceTarball:'https://example.test/source.tgz',commitSha:'abc'},
 vercel:{projectSlug:'demo',gitSource:{org:'org',repo:'repo',ref:'main',sha:'abc'}},
 netlify:{projectSlug:'demo',repoUrl:'https://github.com/org/repo',deployFiles:{'/index.html':'sha'}},
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
 for(const providerId of ids){let calls=0;const result=await deployToHostingProvider(providerId,credentials[providerId],deployInputs[providerId],{fetchImpl:mockFetch((url,init)=>{calls++;assert.ok(url.startsWith('https://'),providerId);if(providerId==='aws-apprunner')assert.match(init.headers.authorization,/AWS4-HMAC-SHA256/);if(providerId==='netlify'&&calls===1)return response({id:'site-id'});if(providerId==='railway'&&calls===1)return response({data:{serviceCreate:{id:'rail-service'}}});if(providerId==='railway')return response({data:{serviceInstanceDeployV2:'rail-deploy'}});if(providerId==='flyio'&&calls===1)return response({app_name:'demo'});return response(urlResponses[providerId]);})});assert.equal(result.ok,true,providerId+': '+result.error);assert.ok(calls>=1,providerId+' made no request');assert.ok(result.providerDeploymentId,providerId+' returned no resource ID');}
});

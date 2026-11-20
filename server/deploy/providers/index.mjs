import crypto from 'node:crypto';

const PROVIDER_URLS = {
  render: 'https://api.render.com/v1', railway: 'https://backboard.railway.app/graphql/v2',
  flyio: 'https://api.fly.io', cloudRun: 'https://run.googleapis.com',
  aws: 'https://apprunner.amazonaws.com', azure: 'https://management.azure.com',
  digitalocean: 'https://api.digitalocean.com/v2', heroku: 'https://api.heroku.com',
  vercel: 'https://api.vercel.com', netlify: 'https://api.netlify.com/api/v1',
};
const PROVIDER_KEYS = {
  render: 'render', railway: 'railway', flyio: 'flyio', 'cloud-run': 'cloudRun',
  'aws-apprunner': 'aws', 'azure-container-apps': 'azure', digitalocean: 'digitalocean',
  heroku: 'heroku', vercel: 'vercel', netlify: 'netlify',
};
function parseCredential(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') throw new Error('Provider credential is required');
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch {}
  return { token: value };
}
function tokenOf(c) { return c.accessToken || c.token || c.apiToken || c.apiKey; }
async function call(fetchImpl, url, { method = 'GET', token, headers = {}, body, timeoutMs = 15000 } = {}) {
  const response = await fetchImpl(url, { method, headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) { const msg = typeof data === 'object' ? data?.message || data?.error?.message || data?.error || data?.detail : data; const error = new Error(`${response.status}: ${String(msg || response.statusText).slice(0, 400)}`); error.status = response.status; error.provider = true; throw error; }
  return data;
}
function requireValue(c, name) { if (!c[name]) throw new Error(`Credential/configuration field "${name}" is required`); return c[name]; }
function safeError(error) { return error?.provider ? `Provider API returned HTTP ${error.status}` : error?.message || 'Provider API request failed'; }

async function awsRequest(c, path, body, fetchImpl, method = 'POST') {
  const region = requireValue(c, 'region'), accessKeyId = requireValue(c, 'accessKeyId'), secretAccessKey = requireValue(c, 'secretAccessKey');
  const host = `apprunner.${region}.amazonaws.com`, url = `https://${host}${path}`;
  const now = new Date().toISOString().replace(/[:-]|\\.\\d{3}/g, ''), date = now.slice(0, 8);
  const target = body?.__target, payloadBody = { ...body }; delete payloadBody.__target;
  const payload = JSON.stringify(payloadBody), headers = { host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-date': now, ...(target ? { 'x-amz-target': `AmazonAppRunner.${target}` } : {}) };
  if (c.sessionToken) headers['x-amz-security-token'] = c.sessionToken;
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k].trim()}\\n`).join('');
  const signedHeaders = Object.keys(headers).sort().join(';'), hash = crypto.createHash('sha256').update(payload).digest('hex');
  const canonical = [method, path, '', canonicalHeaders, signedHeaders, hash].join('\\n'), scope = `${date}/${region}/apprunner/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', now, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\\n');
  const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), 'apprunner'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign).toString('hex')}`;
  const response = await fetchImpl(url, { method, headers, body: method === 'GET' ? undefined : payload, signal: AbortSignal.timeout(20000) });
  const text = await response.text(); let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!response.ok) { const error = new Error(`${response.status}: ${data?.message || data?.Message || response.statusText}`); error.status = response.status; error.provider = true; throw error; }
  return data;
}

export async function verifyHostingProvider(providerId, credential, { fetchImpl = fetch } = {}) {
  const c = parseCredential(credential), token = tokenOf(c);
  try {
    switch (providerId) {
      case 'render': {
        const data = await call(fetchImpl, `${PROVIDER_URLS.render}/services?limit=1`, { token });
        return { ok: true, providerId, accountLabel: 'Render account', sampleCount: Array.isArray(data) ? data.length : undefined };
      }
      case 'railway': {
        const data = await call(fetchImpl, PROVIDER_URLS.railway, { method: 'POST', token, body: { query: 'query { projects { edges { node { id name } } } }' } });
        if (data?.errors?.length) throw new Error('Railway rejected the token or GraphQL query');
        return { ok: true, providerId, accountLabel: 'Railway account' };
      }
      case 'flyio': {
        const data = await call(fetchImpl, `${PROVIDER_URLS.flyio}/v1/apps${c.orgSlug ? `?org_slug=${encodeURIComponent(c.orgSlug)}` : ''}`, { token });
        return { ok: true, providerId, accountLabel: 'Fly.io account', sampleCount: data?.apps?.length ?? (Array.isArray(data) ? data.length : undefined) };
      }
      case 'cloud-run': {
        const access = requireValue(c, 'accessToken'), project = requireValue(c, 'projectId');
        await call(fetchImpl, `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}`, { token: access });
        return { ok: true, providerId, accountLabel: `Google Cloud project ${project}` };
      }
      case 'aws-apprunner': {
        const data = await awsRequest(c, '/', { __target: 'ListServices', MaxResults: 1 }, fetchImpl);
        return { ok: true, providerId, accountLabel: 'AWS account', sampleCount: data?.ServiceSummaryList?.length };
      }
      case 'azure-container-apps': {
        const access = requireValue(c, 'accessToken'), subscription = requireValue(c, 'subscriptionId');
        const data = await call(fetchImpl, `${PROVIDER_URLS.azure}/subscriptions/${subscription}/resourceGroups?api-version=2021-04-01`, { token: access });
        return { ok: true, providerId, accountLabel: 'Azure subscription', sampleCount: data?.value?.length };
      }
      case 'digitalocean': {
        const data = await call(fetchImpl, `${PROVIDER_URLS.digitalocean}/apps?per_page=1`, { token });
        return { ok: true, providerId, accountLabel: 'DigitalOcean account', sampleCount: data?.apps?.length };
      }
      case 'heroku': {
        const data = await call(fetchImpl, `${PROVIDER_URLS.heroku}/apps?limit=1`, { token, headers: { Accept: 'application/vnd.heroku+json; version=3' } });
        return { ok: true, providerId, accountLabel: 'Heroku account', sampleCount: Array.isArray(data) ? data.length : undefined };
      }
      case 'vercel': {
        const data = await call(fetchImpl, `${PROVIDER_URLS.vercel}/v9/projects?limit=1`, { token });
        return { ok: true, providerId, accountLabel: 'Vercel account', sampleCount: data?.projects?.length };
      }
      case 'netlify': {
        if (!request.deployFiles || typeof request.deployFiles !== 'object' || Array.isArray(request.deployFiles) || !Object.keys(request.deployFiles).length) throw new Error('Netlify direct deploy requires build artifact files from the validated pipeline');
        let siteId=c.siteId;
        if (!siteId) { const site=await call(fetchImpl,PROVIDER_URLS.netlify+'/sites',{method:'POST',token,body:{name:slug}}); siteId=site?.id; }
        if (!siteId) throw new Error('Netlify did not return a site ID');
        const fileHashes={};
        for (const [path,content] of Object.entries(request.deployFiles)) { if (typeof content !== 'string' || !path.startsWith('/') || path.includes('..')) throw new Error('Deploy file map must contain safe absolute paths and text contents'); fileHashes[path]=crypto.createHash('sha256').update(content).digest('hex'); }
        data=await call(fetchImpl,PROVIDER_URLS.netlify+'/sites/'+siteId+'/deploys',{method:'POST',token,body:{files:fileHashes}});
        id=data?.id; metadata={siteId}; url=data?.deploy_url||data?.url;
        for (const [path,content] of Object.entries(request.deployFiles)) { const upload=await fetchImpl(PROVIDER_URLS.netlify+'/deploys/'+id+'/files/'+encodeURIComponent(path),{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:content,signal:AbortSignal.timeout(15000)}); if(!upload.ok)throw new Error('Netlify file upload failed (HTTP '+upload.status+')'); }
        break;
      }      default: throw new Error('Unsupported provider');
    }
    return { ok:true, providerId, providerDeploymentId:id||null, providerStatus:data?.status||data?.state||'provisioning', url, hostname:url?new URL(url).hostname:null, metadata, response:data };
  } catch (error) { return { ok:false, providerId, error:safeError(error) }; }
}
export function hostingProviderApiBase(providerId) { const key=PROVIDER_KEYS[providerId]; return key ? PROVIDER_URLS[key] : null; }

export async function refreshHostingDeployment(providerId, credential, deployment, { fetchImpl = fetch } = {}) {
  const c=parseCredential(credential),token=tokenOf(c),id=deployment.providerResourceId,metadata=deployment.metadata||{};
  try { let data,status='unknown',url=deployment.liveUrl||null;
    switch(providerId){
      case 'render': data=await call(fetchImpl,PROVIDER_URLS.render+'/services/'+id,{token});status=/live/i.test(data?.service?.status||data?.status||'')?'live':/failed|suspended/i.test(data?.service?.status||data?.status||'')?'failed':'deploying';url=data?.service?.url||data?.url||url;break;
      case 'railway': {const q='query deployment($id: String!) { deployment(id: $id) { id status url staticUrl } }';data=await call(fetchImpl,PROVIDER_URLS.railway,{method:'POST',token,body:{query:q,variables:{id}}});const d=data?.data?.deployment;status=String(d?.status||'').toUpperCase()==='SUCCESS'?'live':String(d?.status||'').toUpperCase()==='FAILED'?'failed':'deploying';url=d?.url||d?.staticUrl||url;break;}
      case 'flyio': data=await call(fetchImpl,PROVIDER_URLS.flyio+'/v1/apps/'+metadata.appName+'/machines/'+id,{token});status=data?.state==='started'?'live':data?.state==='stopped'?'failed':'deploying';url=metadata.appName?'https://'+metadata.appName+'.fly.dev':url;break;
      case 'cloud-run': data=await call(fetchImpl,PROVIDER_URLS.cloudRun+'/'+id,{token:requireValue(c,'accessToken')});status=data?.conditions?.some(x=>x.type==='Ready'&&x.status==='True')?'live':data?.conditions?.some(x=>x.type==='Ready'&&x.status==='False')?'failed':'deploying';url=data?.uri||url;break;
      case 'aws-apprunner': data=await awsRequest(c,'/',{__target:'DescribeService',ServiceArn:metadata.serviceArn},fetchImpl);status=data?.Service?.Status==='RUNNING'?'live':/FAILED/.test(data?.Service?.Status||'')?'failed':'deploying';url=data?.Service?.ServiceUrl?'https://'+data.Service.ServiceUrl:url;break;
      case 'azure-container-apps': data=await call(fetchImpl,PROVIDER_URLS.azure+metadata.resourceId+'?api-version=2024-03-01',{token:requireValue(c,'accessToken')});status=data?.properties?.provisioningState==='Succeeded'?'live':data?.properties?.provisioningState==='Failed'?'failed':'deploying';url=data?.properties?.configuration?.ingress?.fqdn?'https://'+data.properties.configuration.ingress.fqdn:url;break;
      case 'digitalocean': data=await call(fetchImpl,PROVIDER_URLS.digitalocean+'/apps/'+id,{token});status=data?.app?.active_deployment?.phase==='ACTIVE'?'live':data?.app?.active_deployment?.phase==='ERROR'?'failed':'deploying';url=data?.app?.default_ingress?'https://'+data.app.default_ingress:url;break;
      case 'heroku': data=await call(fetchImpl,PROVIDER_URLS.heroku+'/apps/'+metadata.appId+'/builds/'+id,{token,headers:{Accept:'application/vnd.heroku+json; version=3'}});status=data?.status==='succeeded'?'live':data?.status==='failed'?'failed':'deploying';url=metadata.webUrl||url;break;
      case 'vercel': data=await call(fetchImpl,PROVIDER_URLS.vercel+'/v13/deployments/'+id+(c.teamId?'?teamId='+encodeURIComponent(c.teamId):''),{token});status=data?.readyState==='READY'?'live':data?.readyState==='ERROR'?'failed':'deploying';url=data?.url?'https://'+data.url:url;break;
      case 'netlify': data=await call(fetchImpl,PROVIDER_URLS.netlify+'/deploys/'+id,{token});status=data?.state==='ready'?'live':data?.state==='error'?'failed':'deploying';url=data?.deploy_url||data?.url||url;break;
      default:return {ok:false,error:'Unknown hosting provider'};
    }
    return {ok:true,providerId,status,url,providerStatus:data?.status||data?.state||data?.readyState||data?.Service?.Status||null};
  }catch(error){return {ok:false,providerId,error:safeError(error)};}
}
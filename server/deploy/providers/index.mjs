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
        const data = await call(fetchImpl, `${PROVIDER_URLS.netlify}/sites?per_page=1`, { token });
        return { ok: true, providerId, accountLabel: 'Netlify account', sampleCount: Array.isArray(data) ? data.length : undefined };
      }
      default: return { ok: false, providerId, error: 'Unknown provider' };
    }
  } catch (error) { return { ok: false, providerId, error: safeError(error) }; }
}

function validateRequest(request) {
  const image = request.image || request.containerImage;
  if (image && !/@sha256:[a-fA-F0-9]{64}$/.test(image)) throw new Error('Container image must use an immutable SHA-256 digest');
  if (!image && !request.repoUrl && !request.sourceTarball && !request.gitSource) throw new Error('Validated project source repository URL is required');
  if (['flyio','cloud-run','aws-apprunner','azure-container-apps','digitalocean'].includes(providerId) && !image) throw new Error(`${providerId} requires a pinned container image`);
  if (providerId === 'heroku' && !request.sourceTarball) throw new Error('Heroku deployment requires a source archive URL');
  if (providerId === 'vercel' && !request.gitSource) throw new Error('Vercel deployment requires a connected Git source');
  const slug = String(request.projectSlug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (slug.length < 2 || slug.length > 63) throw new Error('Project slug must be 2-63 characters');
  return { image, slug };
}

/** Provision a hosting resource. This API is only called after Kestrel confirms the source pipeline succeeded. */
export async function deployToHostingProvider(providerId, credential, request, { fetchImpl = fetch } = {}) {
  const c = parseCredential(credential);
  try {
    const { image, slug } = validateRequest(request), token = tokenOf(c), repoUrl = request.repoUrl, branch = request.branch || 'main';
    const port = Number(request.port || 3000), env = request.env || {}; let data, id, url;
    switch (providerId) {
      case 'render': {
        const ownerId = requireValue(c, 'ownerId');
        data = await call(fetchImpl, `${PROVIDER_URLS.render}/services`, { method: 'POST', token, body: { type: request.appType === 'static' ? 'static_site' : 'web_service', name: slug, ownerId, autoDeployTrigger: 'off', ...(repoUrl ? { repo: repoUrl, branch, buildCommand: request.buildCommand, startCommand: request.startCommand } : {}), ...(image ? { image: { url: image } } : {}), envVars: Object.entries(env).map(([key,value])=>({key,value:String(value)})) } });
        id = data?.service?.id || data?.id; url = data?.service?.serviceDetails?.url || data?.service?.url || data?.url; break;
      }
      case 'railway': {
        const projectId = requireValue(c, 'projectId'), environmentId = requireValue(c, 'environmentId');
        const query = 'mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }';
        const created = await call(fetchImpl, PROVIDER_URLS.railway, { method:'POST', token, body:{ query, variables:{input:{projectId,name:slug,source:repoUrl ? {repo:repoUrl} : {image},variables:env}} } });
        if (created?.errors?.length) throw new Error('Railway service creation failed');
        const service = created?.data?.serviceCreate; if (!service?.id) throw new Error('Railway did not return a service ID');
        const deployQuery = 'mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }';
        const deployed = await call(fetchImpl, PROVIDER_URLS.railway, { method:'POST', token, body:{query:deployQuery,variables:{serviceId:service.id,environmentId}} });
        id = deployed?.data?.serviceInstanceDeployV2 || service.id; data = { service, deploymentId:id }; break;
      }
      case 'flyio': {
        const orgSlug = requireValue(c, 'orgSlug');
        const app = await call(fetchImpl, `${PROVIDER_URLS.flyio}/v1/apps`, { method:'POST',token,body:{app_name:slug,org_slug:orgSlug} });
        const machine = await call(fetchImpl, `${PROVIDER_URLS.flyio}/v1/apps/${slug}/machines`, { method:'POST',token,body:{config:{image,env,services:[{ports:[{port:80,handlers:['http']},{port:443,handlers:['tls','http']}],protocol:'tcp',internal_port:port}]}} });
        id = machine?.id || app?.id || slug; url = `https://${slug}.fly.dev`; data = { app, machine }; break;
      }
      case 'cloud-run': {
        const projectId=requireValue(c,'projectId'), region=c.region||'us-central1', access=requireValue(c,'accessToken');
        const serviceBody = {
          template: { containers: [{ image, ports: [{ containerPort: port }], env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })) }] },
          ingress: 'INGRESS_TRAFFIC_ALL',
        };
        data = await call(fetchImpl, `${PROVIDER_URLS.cloudRun}/v2/projects/${projectId}/locations/${region}/services?serviceId=${slug}`, { method: 'POST', token: access, body: serviceBody });
        id=data?.name; url=data?.uri; break;
      }
      case 'aws-apprunner': {
        const roleArn=requireValue(c,'accessRoleArn');
        data=await awsRequest(c,'/',{__target:'CreateService',ServiceName:slug,SourceConfiguration:{ImageRepository:{ImageIdentifier:image,ImageRepositoryType:'ECR',ImageConfiguration:{Port:String(port),RuntimeEnvironmentVariables:env},AutoDeploymentsEnabled:false},AuthenticationConfiguration:{AccessRoleArn:roleArn}},HealthCheckConfiguration:{Protocol:'HTTP',Path:request.healthPath||'/',Interval:10,Timeout:5,HealthyThreshold:1,UnhealthyThreshold:5}},fetchImpl);
        id=data?.Service?.ServiceId; url=data?.Service?.ServiceUrl ? `https://${data.Service.ServiceUrl}` : null; break;
      }
      case 'azure-container-apps': {
        const subscription=requireValue(c,'subscriptionId'), group=requireValue(c,'resourceGroup'), location=requireValue(c,'location'), environmentId=requireValue(c,'containerAppEnvironmentId'), access=requireValue(c,'accessToken');
        const arm=`${PROVIDER_URLS.azure}/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.App/containerApps/${slug}?api-version=2024-03-01`;
        const body = { location, properties: { managedEnvironmentId: environmentId, configuration: { ingress: { external: true, targetPort: port, transport: 'auto' } }, template: { containers: [{ name: slug, image, env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })) }], scale: { minReplicas: 0, maxReplicas: 1 } } } };
        data = await call(fetchImpl, arm, { method: 'PUT', token: access, body });
        id=data?.id; url=data?.properties?.configuration?.ingress?.fqdn ? `https://${data.properties.configuration.ingress.fqdn}` : null; break;
      }
      case 'digitalocean': {
        const region=c.region||'nyc', registryType=request.registryType||'DOCR';
        const imageRepository=requireValue(request,'imageRepository'), imageTag=requireValue(request,'imageTag');
        data=await call(fetchImpl,`${PROVIDER_URLS.digitalocean}/apps`,{method:'POST',token,body:{spec:{name:slug,region,services:[{name:slug,image:{registry_type:registryType,repository:imageRepository,tag:imageTag},http_port:port,instance_count:1,instance_size_slug:request.instanceSize||'basic-xxs',envs:Object.entries(env).map(([key,value])=>({key,value:String(value),type:'GENERAL'}))}]}}});
        id=data?.app?.id; url=data?.app?.default_ingress ? `https://${data.app.default_ingress}` : null; break;
      }
      case 'heroku': {
        if (!request.sourceTarball) throw new Error('Heroku deployments require a public source archive URL; container-image releases are not implemented in this adapter');
        const app=await call(fetchImpl,`${PROVIDER_URLS.heroku}/apps`,{method:'POST',token,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{name:slug,region:c.region||'us'}});
        const build=await call(fetchImpl,`${PROVIDER_URLS.heroku}/apps/${app.id}/builds`,{method:'POST',token,headers:{Accept:'application/vnd.heroku+json; version=3'},body:{source:{url:request.sourceTarball,version:request.commitSha},buildpacks:request.buildpacks}});
        id=build?.id; url=app?.web_url; data={app,build}; break;
      }
      case 'vercel': {
        const projectId=requireValue(c,'projectId'), git=request.gitSource;
        if (!git || !git.org || !git.repo || !git.ref) throw new Error('Vercel deployment requires a linked Git repository (gitSource.org, repo, ref)');
        data=await call(fetchImpl,`${PROVIDER_URLS.vercel}/v13/deployments`,{method:'POST',token,body:{name:slug,project:projectId,target:request.target||'production',gitSource:{type:'github',org:git.org,repo:git.repo,ref:git.ref,...(git.sha?{sha:git.sha}:{})},...(request.buildCommand?{buildCommand:request.buildCommand}:{}),...(request.outputDirectory?{outputDirectory:request.outputDirectory}:{})}});
        id=data?.id; url=data?.url ? `https://${data.url}` : null; break;
      }
      case 'netlify': {
        let siteId=c.siteId;
        if (!siteId) { const site=await call(fetchImpl,`${PROVIDER_URLS.netlify}/sites`,{method:'POST',token,body:{name:slug,...(repoUrl?{repo:{provider:'github',repo_path:repoUrl,repo_branch:branch,deploy_key_id:c.deployKeyId}}:{})}}); siteId=site?.id; }
        if (!siteId) throw new Error('Netlify did not return a site ID');
        data=await call(fetchImpl,`${PROVIDER_URLS.netlify}/sites/${siteId}/deploys`,{method:'POST',token,body:{...(request.deployFiles?{files:request.deployFiles}:{}),...(request.buildCommand?{build_command:request.buildCommand}:{}),...(request.publishDirectory?{dir:request.publishDirectory}:{})}});
        id=data?.id; url=data?.deploy_url||data?.url; break;
      }
      default: throw new Error('Unsupported provider');
    }
    return { ok:true, providerId, providerDeploymentId:id||null, providerStatus:data?.status||data?.state||'provisioning', url, hostname:url?new URL(url).hostname:null, response:data };
  } catch (error) { return { ok:false, providerId, error:safeError(error) }; }
}
export function hostingProviderApiBase(providerId) { const key=PROVIDER_KEYS[providerId]; return key ? PROVIDER_URLS[key] : null; }

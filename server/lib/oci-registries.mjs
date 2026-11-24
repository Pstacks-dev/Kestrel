import crypto from 'node:crypto';

function slug(value, max = 48) {
  const result = String(value || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max);
  return result || 'app';
}

function imageTag(commitSha) {
  if (!/^[a-f0-9]{40}$/i.test(commitSha || '')) throw new Error('A full Git commit SHA is required for an immutable image tag');
  return `sha-${commitSha.toLowerCase()}`;
}

async function flyRequest(token, path, { method = 'GET', body, fetchImpl }) {
  const response = await fetchImpl(`https://api.machines.dev/v1${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Fly.io registry provisioning failed (${response.status})`);
  return payload;
}

async function provisionFly(credentials, projectName, commitSha, fetchImpl) {
  if (!credentials.token || !credentials.orgSlug) throw new Error('Verified Fly.io token and organization slug are required');
  const appName = slug(`kestrel-${projectName}`, 60);
  const existing = await flyRequest(credentials.token, `/apps/${encodeURIComponent(appName)}`, { fetchImpl });
  if (!existing) {
    await flyRequest(credentials.token, '/apps', { method: 'POST', body: { app_name: appName, org_slug: credentials.orgSlug }, fetchImpl });
  } else if (existing.organization?.slug && existing.organization.slug !== credentials.orgSlug) {
    throw new Error('Fly.io app name belongs to a different organization');
  }
  const registryHost = 'registry.fly.io';
  return {
    provider: 'flyio', registry: registryHost, image: `${registryHost}/${appName}:${imageTag(commitSha)}`,
    username: 'x', password: credentials.token, projectName: appName,
  };
}

function googleEncode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

async function googleAccessToken(serviceAccountJson, fetchImpl) {
  const account = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  if (account.type !== 'service_account' || !account.client_email || !account.private_key) throw new Error('A valid Google service account is required');
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${googleEncode({ alg: 'RS256', typ: 'JWT' })}.${googleEncode({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: issuedAt, exp: issuedAt + 3600,
  })}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned); signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key, 'base64url')}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error('Google OAuth token exchange failed during Artifact Registry provisioning');
  return { token: payload.access_token, account };
}

async function googleRequest(token, url, options, fetchImpl) {
  const response = await fetchImpl(url, {
    ...options, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409 && response.status !== 404) {
    throw new Error(`Google Artifact Registry provisioning failed (${response.status})`);
  }
  return { status: response.status, payload };
}

async function provisionGoogle(credentials, projectName, commitSha, fetchImpl) {
  const projectId = credentials.projectId;
  const location = credentials.region || 'us-central1';
  if (!projectId || !/^[a-z0-9-]+$/.test(location)) throw new Error('Google Cloud project and valid Artifact Registry region are required');
  const { token, account } = await googleAccessToken(credentials.serviceAccountJson, fetchImpl);
  const repository = 'kestrel-images';
  const base = `https://artifactregistry.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/repositories`;
  const current = await googleRequest(token, `${base}/${repository}`, {}, fetchImpl);
  if (current.status === 404) {
    const created = await googleRequest(token, `${base}?repositoryId=${repository}`, {
      method: 'POST', body: JSON.stringify({ format: 'DOCKER', description: 'Kestrel managed deployment images' }),
    }, fetchImpl);
    if (![200, 201, 409].includes(created.status)) throw new Error('Artifact Registry repository could not be created');
  }
  const host = `${location}-docker.pkg.dev`;
  const imageName = slug(projectName, 50);
  return {
    provider: 'google-cloud-run', registry: host,
    image: `${host}/${projectId}/${repository}/${imageName}:${imageTag(commitSha)}`,
    username: '_json_key', password: typeof credentials.serviceAccountJson === 'string' ? credentials.serviceAccountJson : JSON.stringify(account),
    projectName: imageName, location,
  };
}

function awsSigningKey(secret, date, region, service) {
  const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

async function ecrRequest(credentials, action, payload, fetchImpl) {
  const region = credentials.region;
  const host = `api.ecr.${region}.amazonaws.com`;
  const body = JSON.stringify(payload || {});
  const amzDate = new Date().toISOString().replace(/[:-]|\\.\\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers = {
    'content-type': 'application/x-amz-json-1.1', host, 'x-amz-date': amzDate,
    'x-amz-target': `AmazonEC2ContainerRegistry_V20150921.${action}`,
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\\n`).join('');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, crypto.createHash('sha256').update(body).digest('hex')].join('\\n');
  const scope = `${date}/${region}/ecr/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\\n');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${crypto.createHmac('sha256', awsSigningKey(credentials.secretAccessKey, date, region, 'ecr')).update(stringToSign).digest('hex')}`;
  const response = await fetchImpl(`https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.message || result.Message || '';
    if (action === 'CreateRepository' && /RepositoryAlreadyExistsException/i.test(message)) return {};
    throw new Error(`AWS ECR ${action} failed (${response.status})`);
  }
  return result;
}

async function provisionEcr(credentials, projectName, commitSha, fetchImpl) {
  if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.region) throw new Error('Verified AWS ECR credentials are required');
  const repositoryName = `kestrel/${slug(projectName, 220)}`;
  let repository;
  try {
    repository = await ecrRequest(credentials, 'CreateRepository', {
      repositoryName, imageTagMutability: 'IMMUTABLE', imageScanningConfiguration: { scanOnPush: true },
    }, fetchImpl);
  } catch (error) {
    if (!/RepositoryAlreadyExistsException/i.test(error.message)) throw error;
  }
  const described = repository?.repository || (await ecrRequest(credentials, 'DescribeRepositories', { repositoryNames: [repositoryName] }, fetchImpl)).repositories?.[0];
  if (!described?.repositoryUri) throw new Error('AWS ECR did not return a repository URI');
  const auth = await ecrRequest(credentials, 'GetAuthorizationToken', {}, fetchImpl);
  const entry = auth.authorizationData?.[0];
  if (!entry?.authorizationToken || !entry.proxyEndpoint) throw new Error('AWS ECR did not return registry credentials');
  const decoded = Buffer.from(entry.authorizationToken, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1) throw new Error('AWS ECR returned malformed registry credentials');
  return {
    provider: 'aws-ecs-express', registry: new URL(entry.proxyEndpoint).host,
    image: `${described.repositoryUri}:${imageTag(commitSha)}`,
    username: decoded.slice(0, separator), password: decoded.slice(separator + 1),
    projectName: repositoryName,
  };
}

export async function provisionProviderImageRegistry(provider, credentials, projectName, commitSha, { fetchImpl = fetch } = {}) {
  if (provider === 'flyio') return provisionFly(credentials, projectName, commitSha, fetchImpl);
  if (provider === 'google-cloud-run') return provisionGoogle(credentials, projectName, commitSha, fetchImpl);
  if (provider === 'aws-ecs-express') return provisionEcr(credentials, projectName, commitSha, fetchImpl);
  throw new Error('OCI registry provisioning is not supported for this provider');
}

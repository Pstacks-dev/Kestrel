import crypto from 'node:crypto';

const TIMEOUT_MS = 10000;
const GCP_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function timeoutSignal() { return AbortSignal.timeout(TIMEOUT_MS); }
async function responseError(response) {
  const body = await response.text().catch(() => '');
  return new Error(`Provider returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
}
async function requireOk(response) {
  if (!response.ok) throw await responseError(response);
  return response;
}

function awsSigningKey(secret, date, region, service) {
  const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

async function verifyAws(credentials, fetchImpl, now) {
  const host = 'sts.amazonaws.com';
  const region = credentials.region;
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const amzDate = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonicalHeaders = `content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/sts/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signature = crypto.createHmac('sha256', awsSigningKey(credentials.secretAccessKey, date, region, 'sts')).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetchImpl(`https://${host}/`, {
    method: 'POST', signal: timeoutSignal(), body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'x-amz-date': amzDate, Authorization: authorization,
    },
  });
  await requireOk(response);
  return { account: 'AWS account authenticated' };
}

async function verifyGoogle(credentials, fetchImpl, now) {
  const account = JSON.parse(credentials.serviceAccountJson);
  const issuedAt = Math.floor(now / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.client_email, scope: GCP_SCOPE,
    aud: 'https://oauth2.googleapis.com/token', iat: issuedAt, exp: issuedAt + 3600,
  })}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key, 'base64url')}`;
  const tokenResponse = await requireOk(await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: timeoutSignal(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  }));
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error('Google did not issue an access token');
  const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(credentials.projectId)}/locations/-/services?pageSize=1`;
  await requireOk(await fetchImpl(url, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: timeoutSignal() }));
  return { account: credentials.projectId };
}

export async function verifyHostingProvider(providerId, credentials, { fetchImpl = fetch, now = Date.now() } = {}) {
  let response;
  switch (providerId) {
    case 'render':
      response = await fetchImpl('https://api.render.com/v1/services?limit=1', {
        headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/json' }, signal: timeoutSignal(),
      });
      await requireOk(response);
      return { verified: true, account: 'Render API authenticated' };
    case 'railway':
      response = await fetchImpl('https://backboard.railway.com/graphql/v2', {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { me { id name } }' }), signal: timeoutSignal(),
      });
      await requireOk(response);
      const railway = await response.json();
      if (railway.errors?.length || !railway.data?.me?.id) throw new Error('Railway rejected the credential');
      return { verified: true, account: railway.data.me.name || railway.data.me.id };
    case 'flyio':
      response = await fetchImpl('https://api.machines.dev/v1/apps', {
        headers: { Authorization: `Bearer ${credentials.token}` }, signal: timeoutSignal(),
      });
      await requireOk(response);
      return { verified: true, account: 'Fly.io Machines API authenticated' };
    case 'google-cloud-run':
      return { verified: true, ...(await verifyGoogle(credentials, fetchImpl, now)) };
    case 'aws-app-runner':
      return { verified: true, ...(await verifyAws(credentials, fetchImpl, now)) };
    case 'digitalocean-app-platform':
      response = await fetchImpl('https://api.digitalocean.com/v2/account', {
        headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: 'application/json' }, signal: timeoutSignal(),
      });
      await requireOk(response);
      const digitalocean = await response.json();
      return { verified: true, account: digitalocean.account?.email || 'DigitalOcean API authenticated' };
    case 'heroku':
      response = await fetchImpl('https://api.heroku.com/account', {
        headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: 'application/vnd.heroku+json; version=3' }, signal: timeoutSignal(),
      });
      await requireOk(response);
      const heroku = await response.json();
      return { verified: true, account: heroku.email || 'Heroku API authenticated' };
    default:
      throw Object.assign(new Error('Credential verification is not implemented for this provider'), { code: 'NOT_IMPLEMENTED' });
  }
}

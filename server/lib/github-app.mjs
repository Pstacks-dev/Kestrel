import crypto from 'node:crypto';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) throw new Error(`GitHub App configuration is missing ${name}`);
  return String(value).trim();
}

export function createGitHubAppJwt({ appId, privateKey, now = Date.now() }) {
  if (!appId || !privateKey) throw new Error('GitHub App ID and private key are required');
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: String(appId) })).toString('base64url');
  const unsigned = header + '.' + payload;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return unsigned + '.' + signer.sign(privateKey).toString('base64url');
}

export function getGitHubAppConfig(env = process.env) {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const appSlug = env.GITHUB_APP_SLUG;
  if (!appId || !privateKey || !appSlug) return null;
  return { appId, privateKey, appSlug };
}

export async function createGitHubInstallationToken(installationId, {
  repository, permissions, fetchImpl = fetch, config = getGitHubAppConfig(),
} = {}) {
  if (!config) throw new Error('GitHub App is not configured');
  if (!/^\d+$/.test(String(installationId))) throw new Error('Invalid GitHub installation ID');
  const jwt = createGitHubAppJwt(config);
  const body = {};
  if (repository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository name');
    body.repository = repository.split('/')[1];
    body.repositories = [body.repository];
  }
  if (permissions) body.permissions = permissions;
  const response = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'Kestrel-Control-Plane',
    },
    ...(Object.keys(body).length ? { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'Kestrel-Control-Plane', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error(`GitHub App installation token request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (!result.token || !result.expires_at) throw new Error('GitHub returned an incomplete installation token response');
  return { token: result.token, expiresAt: result.expires_at, permissions: result.permissions || {} };
}

export async function getGitHubInstallation(installationId, { fetchImpl = fetch, config = getGitHubAppConfig() } = {}) {
  if (!config) throw new Error('GitHub App is not configured');
  const jwt = createGitHubAppJwt(config);
  const response = await fetchImpl(`${API}/app/installations/${installationId}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'Kestrel-Control-Plane' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error(`GitHub App installation lookup failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

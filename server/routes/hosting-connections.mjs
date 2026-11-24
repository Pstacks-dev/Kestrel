import { encryptSecret, decryptSecret } from '../lib/security.mjs';
import { verifyHostingProvider } from '../lib/hosting-adapters.mjs';
import { listHostingProviders } from '../lib/hosting-providers.mjs';

const WRITE_ROLES = ['owner', 'admin', 'developer'];

const VERIFIED_PROVIDERS = new Set(['render', 'railway', 'flyio', 'google-cloud-run', 'aws-ecs-express', 'digitalocean-app-platform', 'heroku', 'vercel']);

const CREDENTIAL_FIELDS = {
  render: ['apiKey', 'ownerId'],
  railway: ['token'],
  flyio: ['token', 'orgSlug'],
  'google-cloud-run': ['projectId', 'serviceAccountJson'],
  'aws-ecs-express': ['accessKeyId', 'secretAccessKey', 'region', 'executionRoleArn', 'infrastructureRoleArn'],
  'digitalocean-app-platform': ['accessToken'],
  heroku: ['apiKey'],
  vercel: ['token'],
  netlify: ['authToken'],
  'cloudflare-pages': ['apiToken', 'accountId'],
};

export function validateProviderCredentials(providerId, credentials) {
  const required = CREDENTIAL_FIELDS[providerId];
  if (!required || !credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return false;
  for (const field of required) {
    if (typeof credentials[field] !== 'string' || !credentials[field].trim() || credentials[field].length > 20000) return false;
  }
  if (providerId === 'aws-ecs-express') {
    const roleArn = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;
    if (!roleArn.test(credentials.executionRoleArn) || !roleArn.test(credentials.infrastructureRoleArn)) return false;
  }
  if (providerId === 'google-cloud-run' && credentials.region !== undefined && !/^[a-z]+-[a-z]+[0-9]$/.test(credentials.region)) return false;
  if (providerId === 'google-cloud-run') {
    try {
      const account = JSON.parse(credentials.serviceAccountJson);
      if (account.type !== 'service_account' || !account.client_email || !account.private_key) return false;
    } catch { return false; }
  }
  const allowed = new Set([...required, 'accountLabel', ...(providerId === 'railway' ? ['workspaceId'] : []), ...(providerId === 'digitalocean-app-platform' ? ['region'] : []), ...(providerId === 'vercel' ? ['teamId'] : []), ...(providerId === 'google-cloud-run' ? ['region'] : [])]);
  if (credentials.workspaceId !== undefined && (typeof credentials.workspaceId !== 'string' || credentials.workspaceId.length > 200)) return false;
  if (providerId === 'digitalocean-app-platform' && credentials.region !== undefined && !/^[a-z]{3}$/.test(credentials.region)) return false;
  if (providerId === 'render' && !/^[A-Za-z0-9_-]{3,100}$/.test(credentials.ownerId)) return false;
  if (providerId === 'vercel' && credentials.teamId !== undefined && (typeof credentials.teamId !== 'string' || credentials.teamId.length > 200)) return false;
  return Object.keys(credentials).every((field) => allowed.has(field));
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

export function registerHostingConnectionRoutes(app, { userAuth, query, transaction }) {
  async function workspaceRole(req, res, write = false) {
    const result = await query(
      'select role from public.organization_members where organization_id = $1 and user_id = $2',
      [req.params.orgId, req.user.id],
    );
    if (!result.rowCount) { fail(res, 404, 'Workspace not found'); return null; }
    if (write && !WRITE_ROLES.includes(result.rows[0].role)) { fail(res, 403, 'Workspace administrator or developer access is required'); return null; }
    return result.rows[0].role;
  }

  app.get('/api/workspaces/:orgId/hosting/providers', userAuth, async (req, res) => {
    try {
      if (!await workspaceRole(req, res)) return;
      const connections = await query(
        `select provider_id as "providerId", account_label as "accountLabel", status,
                created_at as "configuredAt", updated_at as "updatedAt", last_verified_at as "lastVerifiedAt", last_error as "lastError"
         from public.hosting_provider_connections where organization_id = $1`,
        [req.params.orgId],
      );
      const byProvider = new Map(connections.rows.map((row) => [row.providerId, row]));
      res.json({
        providers: listHostingProviders().map((provider) => ({
          id: provider.id, name: provider.name, category: provider.category,
          connected: byProvider.has(provider.id),
          connection: byProvider.get(provider.id) || null,
        })),
      });
    } catch (error) {
      console.error('Hosting provider connection lookup failed:', error.message);
      fail(res, 500, 'Could not load hosting provider connections');
    }
  });

  app.put('/api/workspaces/:orgId/hosting/providers/:providerId', userAuth, async (req, res) => {
    try {
      if (!await workspaceRole(req, res, true)) return;
      const { providerId } = req.params;
      if (!CREDENTIAL_FIELDS[providerId]) return fail(res, 404, 'Unsupported hosting provider');
      if (!process.env.KESTREL_ENCRYPTION_KEY || process.env.KESTREL_ENCRYPTION_KEY.length < 32) {
        return fail(res, 503, 'Secure provider credential storage is not configured');
      }
      const credentials = req.body?.credentials;
      if (!validateProviderCredentials(providerId, credentials)) {
        return fail(res, 400, 'Required provider credentials are missing or invalid');
      }
      const encrypted = encryptSecret(JSON.stringify(credentials));
      const label = typeof credentials.accountLabel === 'string' ? credentials.accountLabel.trim().slice(0, 120) : null;
      const saved = await transaction(async (client) => {
        const row = await client.query(
          `insert into public.hosting_provider_connections
             (organization_id, provider_id, credentials_ciphertext, credentials_iv, credentials_auth_tag,
              account_label, status, connected_by)
           values($1,$2,$3,$4,$5,$6,'configured',$7)
           on conflict (organization_id, provider_id) do update set
             credentials_ciphertext = excluded.credentials_ciphertext,
             credentials_iv = excluded.credentials_iv,
             credentials_auth_tag = excluded.credentials_auth_tag,
             account_label = excluded.account_label,
             status = 'configured', connected_by = excluded.connected_by, last_error = null, updated_at = now()
           returning provider_id as "providerId", account_label as "accountLabel", status,
                     created_at as "configuredAt", updated_at as "updatedAt"`,
          [req.params.orgId, providerId, encrypted.encryptedValue, encrypted.iv, encrypted.authTag, label, req.user.id],
        );
        await client.query(
          `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
           values($1,$2,'hosting.provider.configured','hosting_provider',$3,$4::jsonb)`,
          [req.params.orgId, req.user.id, providerId, JSON.stringify({ providerId })],
        );
        return row.rows[0];
      });
      res.status(200).json({ connection: saved, verified: false, message: 'Credentials stored securely. Provider access has not yet been verified.' });
    } catch (error) {
      console.error('Hosting provider credential save failed:', { code: error.code, message: error.message });
      fail(res, 500, 'Could not save provider credentials');
    }
  });

  app.post('/api/workspaces/:orgId/hosting/providers/:providerId/verify', userAuth, async (req, res) => {
    try {
      if (!await workspaceRole(req, res, true)) return;
      const { providerId } = req.params;
      if (!CREDENTIAL_FIELDS[providerId]) return fail(res, 404, 'Unsupported hosting provider');
      if (!VERIFIED_PROVIDERS.has(providerId)) return fail(res, 501, 'Credential verification is not yet available for this provider');
      const result = await query(
        `select credentials_ciphertext, credentials_iv, credentials_auth_tag
         from public.hosting_provider_connections where organization_id = $1 and provider_id = $2`,
        [req.params.orgId, providerId],
      );
      if (!result.rowCount) return fail(res, 404, 'Provider credentials have not been configured');
      let credentials;
      try {
        const row = result.rows[0];
        credentials = JSON.parse(decryptSecret(row.credentials_ciphertext, row.credentials_iv, row.credentials_auth_tag));
      } catch {
        return fail(res, 503, 'Stored credentials could not be decrypted. Check the Kestrel encryption key.');
      }
      try {
        const verification = await verifyHostingProvider(providerId, credentials);
        await query(
          `update public.hosting_provider_connections
           set status = 'verified', last_verified_at = now(), last_error = null, updated_at = now()
           where organization_id = $1 and provider_id = $2`,
          [req.params.orgId, providerId],
        );
        return res.json({ providerId, verified: true, account: verification.account || null });
      } catch {
        await query(
          `update public.hosting_provider_connections
           set status = 'error', last_error = 'Provider credential verification failed', updated_at = now()
           where organization_id = $1 and provider_id = $2`,
          [req.params.orgId, providerId],
        );
        return fail(res, 422, 'Provider rejected the credentials or could not be reached');
      }
    } catch {
      fail(res, 500, 'Could not verify provider credentials');
    }
  });

  app.delete('/api/workspaces/:orgId/hosting/providers/:providerId', userAuth, async (req, res) => {
    try {
      if (!await workspaceRole(req, res, true)) return;
      if (!CREDENTIAL_FIELDS[req.params.providerId]) return fail(res, 404, 'Unsupported hosting provider');
      const removed = await transaction(async (client) => {
        const result = await client.query(
          'delete from public.hosting_provider_connections where organization_id = $1 and provider_id = $2 returning provider_id',
          [req.params.orgId, req.params.providerId],
        );
        if (result.rowCount) {
          await client.query(
            `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
             values($1,$2,'hosting.provider.disconnected','hosting_provider',$3,$4::jsonb)`,
            [req.params.orgId, req.user.id, req.params.providerId, JSON.stringify({ providerId: req.params.providerId })],
          );
        }
        return result.rowCount > 0;
      });
      if (!removed) return fail(res, 404, 'Provider connection not found');
      res.json({ ok: true, disconnected: true, providerId: req.params.providerId });
    } catch (error) {
      console.error('Hosting provider disconnect failed:', { code: error.code, message: error.message });
      fail(res, 500, 'Could not disconnect hosting provider');
    }
  });
}

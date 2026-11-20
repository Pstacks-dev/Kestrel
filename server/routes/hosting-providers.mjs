import crypto from 'node:crypto';
import { encryptSecret } from '../lib/security.mjs';
import { HOSTING_PROVIDERS, getHostingProvider } from '../deploy/providers/catalog.mjs';

const roles = ['owner', 'admin'];
const validName = (value) => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 100;
const safeError = (error) => ({ error: error?.status ? error.message : 'Provider connection request failed' });

export function registerHostingProviderRoutes(app, { userAuth, query, transaction }) {
  app.get('/api/hosting/providers', userAuth, (_req, res) => {
    res.json({ providers: HOSTING_PROVIDERS.map(({ id, name, domains, appTypes, supportsContainers, supportsPersistentServices, adapterStatus }) => ({ id, name, domains, appTypes, supportsContainers, supportsPersistentServices, adapterStatus })) });
  });

  app.get('/api/organizations/:organizationId/hosting-connections', userAuth, async (req, res) => {
    try {
      const result = await query(
        `select c.id, c.provider_id as "providerId", c.display_name as "displayName",
                c.status, c.last_verified_at as "lastVerifiedAt", c.last_error as "lastError",
                c.created_at as "createdAt", c.updated_at as "updatedAt"
         from public.hosting_provider_connections c
         join public.organization_members m on m.organization_id = c.organization_id
         where c.organization_id = $1 and m.user_id = $2 order by c.provider_id`,
        [req.params.organizationId, req.user.id]
      );
      res.json({ connections: result.rows });
    } catch { res.status(500).json({ error: 'Could not load hosting connections' }); }
  });

  app.post('/api/organizations/:organizationId/hosting-connections', userAuth, async (req, res) => {
    const { providerId, displayName, credential } = req.body || {};
    if (!getHostingProvider(providerId)) return res.status(400).json({ error: 'Unsupported hosting provider' });
    if (!validName(displayName)) return res.status(400).json({ error: 'Connection name must be 1-100 characters' });
    if (typeof credential !== 'string' || credential.trim().length < 8 || credential.length > 8192) {
      return res.status(400).json({ error: 'A valid provider access token or API key is required' });
    }
    if (!process.env.KESTREL_ENCRYPTION_KEY || process.env.KESTREL_ENCRYPTION_KEY.length < 32) {
      return res.status(503).json({ error: 'Provider credential encryption is not configured securely' });
    }
    try {
      const membership = await query(
        'select role from public.organization_members where organization_id = $1 and user_id = $2',
        [req.params.organizationId, req.user.id]
      );
      if (!membership.rowCount) return res.status(404).json({ error: 'Workspace not found' });
      if (!roles.includes(membership.rows[0].role)) return res.status(403).json({ error: 'Workspace owner or admin permission required' });
      const secret = encryptSecret(credential.trim());
      const result = await query(
        `insert into public.hosting_provider_connections
         (organization_id, provider_id, display_name, encrypted_credentials, credentials_iv, credentials_auth_tag, created_by)
         values($1,$2,$3,$4,$5,$6,$7)
         on conflict (organization_id, provider_id) do update set
           display_name = excluded.display_name,
           encrypted_credentials = excluded.encrypted_credentials,
           credentials_iv = excluded.credentials_iv,
           credentials_auth_tag = excluded.credentials_auth_tag,
           status = 'unverified', last_verified_at = null, last_error = null,
           updated_at = now()
         returning id, provider_id as "providerId", display_name as "displayName", status, created_at as "createdAt"`,
        [req.params.organizationId, providerId, displayName.trim(), secret.encryptedValue, secret.iv, secret.authTag, req.user.id]
      );
      res.status(201).json({ connection: result.rows[0], note: 'Credential encrypted and stored. Provider verification is not yet implemented; this connection remains unverified.' });
    } catch (error) {
      res.status(error.status || 500).json(safeError(error));
    }
  });

  app.delete('/api/organizations/:organizationId/hosting-connections/:connectionId', userAuth, async (req, res) => {
    try {
      const result = await query(
        `delete from public.hosting_provider_connections c
         using public.organization_members m
         where c.id = $1 and c.organization_id = $2 and m.organization_id = c.organization_id
           and m.user_id = $3 and m.role = any($4) returning c.id`,
        [req.params.connectionId, req.params.organizationId, req.user.id, roles]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Connection not found or permission denied' });
      res.json({ deleted: true });
    } catch { res.status(500).json({ error: 'Could not remove provider connection' }); }
  });
}

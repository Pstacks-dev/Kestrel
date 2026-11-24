import { createGitHubInstallationToken, getGitHubInstallation, getGitHubAppConfig } from '../lib/github-app.mjs';

const WRITE_ROLES = ['owner', 'admin', 'developer'];

export function registerGitHubAppRoutes(app, { userAuth, query, transaction, signJwt, verifyJwt }) {
  app.post('/api/git/app/install', userAuth, async (req, res) => {
    const organizationId = String(req.body?.organizationId || '');
    if (!organizationId) return res.status(400).json({ error: 'Workspace is required' });
    if (!getGitHubAppConfig()) return res.status(503).json({ error: 'GitHub App integration is not configured' });
    try {
      const member = await query(
        'select role from public.organization_members where organization_id = $1 and user_id = $2',
        [organizationId, req.user.id],
      );
      if (!member.rowCount || !WRITE_ROLES.includes(member.rows[0].role)) {
        return res.status(403).json({ error: 'Developer access to this workspace is required' });
      }
      const state = signJwt({ purpose: 'github_app_install', organizationId, userId: req.user.id }, 10 * 60);
      const slug = getGitHubAppConfig().appSlug;
      return res.json({ installUrl: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}` });
    } catch {
      return res.status(500).json({ error: 'Could not start GitHub App installation' });
    }
  });

  // GitHub redirects here after an installation. Signed state binds the callback to
  // the initiating workspace and user; membership is rechecked before persisting.
  app.get('/api/git/app/callback', async (req, res) => {
    const state = verifyJwt(String(req.query.state || ''));
    const installationId = String(req.query.installation_id || '');
    if (!state || state.purpose !== 'github_app_install' || !state.organizationId || !state.userId ||
        !/^\d+$/.test(installationId)) {
      return res.status(400).json({ error: 'GitHub installation callback is invalid or expired. Start again from Kestrel.' });
    }
    try {
      const member = await query(
        'select role from public.organization_members where organization_id = $1 and user_id = $2',
        [state.organizationId, state.userId],
      );
      if (!member.rowCount || !WRITE_ROLES.includes(member.rows[0].role)) {
        return res.status(403).json({ error: 'Workspace access changed before installation completed' });
      }
      const installation = await getGitHubInstallation(installationId);
      if (installation.suspended_at || !installation.account?.login ||
          !['User', 'Organization'].includes(installation.account.type)) {
        return res.status(409).json({ error: 'This GitHub App installation is suspended or invalid' });
      }
      await transaction(async (client) => {
        await client.query(
          `insert into public.github_app_installations
             (organization_id, installation_id, account_login, account_type, installed_by, suspended_at, updated_at)
           values ($1,$2,$3,$4,$5,null,now())
           on conflict (installation_id) do update set
             organization_id = excluded.organization_id, account_login = excluded.account_login,
             account_type = excluded.account_type, installed_by = excluded.installed_by,
             suspended_at = null, updated_at = now()`,
          [state.organizationId, installation.id, installation.account.login, installation.account.type, state.userId],
        );
        await client.query(
          `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
           values($1,$2,'github_app.installation_linked','github_app_installation',$3,$4::jsonb)`,
          [state.organizationId, state.userId, String(installation.id), JSON.stringify({ account: installation.account.login, accountType: installation.account.type })],
        );
      });
      return res.status(200).json({
        connected: true,
        account: installation.account.login,
        accountType: installation.account.type,
        message: 'GitHub App installation linked. You can return to Kestrel.',
      });
    } catch (error) {
      console.error('GitHub App callback failed:', error.message);
      return res.status(error.status === 404 ? 404 : 502).json({ error: 'Could not verify this GitHub App installation' });
    }
  });

  app.get('/api/workspaces/:orgId/github/installations', userAuth, async (req, res) => {
    try {
      const result = await query(
        `select i.installation_id as "installationId", i.account_login as "accountLogin",
                i.account_type as "accountType", i.suspended_at as "suspendedAt", i.created_at as "createdAt"
         from public.github_app_installations i
         join public.organization_members m on m.organization_id = i.organization_id
         where i.organization_id = $1 and m.user_id = $2
         order by i.created_at desc`,
        [req.params.orgId, req.user.id],
      );
      return res.json({ installations: result.rows });
    } catch {
      return res.status(500).json({ error: 'Could not load GitHub App installations' });
    }
  });
}

export async function fetchGitHubRepositoryWithInstallation(installationId, repository, { fetchImpl = fetch, config } = {}) {
  const token = await createGitHubInstallationToken(installationId, { repository, fetchImpl, config });
  const response = await fetchImpl(`https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Kestrel-Project-Importer',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? 'Repository is not accessible to this GitHub App installation' : 'GitHub repository lookup failed');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

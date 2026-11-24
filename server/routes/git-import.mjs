import crypto from 'node:crypto';

const WRITE_ROLES = ['owner', 'admin', 'developer'];

export function parseGitHubRepository(input) {
  if (typeof input !== 'string' || input.length > 512) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' ||
        url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part)) ||
        parts[0] === '.' || parts[1] === '.' || parts[0] === '..' || parts[1] === '..') return null;
    return { owner: parts[0], repo: parts[1] };
  } catch { return null; }
}

export function registerGitImportRoutes(app, { userAuth, query, transaction, fetchImpl = fetch }) {
  app.post('/api/git/import', userAuth, async (req, res) => {
    const organizationId = String(req.body?.organizationId || '');
    const name = String(req.body?.name || '').trim();
    const repository = parseGitHubRepository(req.body?.repositoryUrl);
    if (!organizationId) return res.status(400).json({ error: 'Workspace is required' });
    if (!repository) return res.status(400).json({ error: 'Enter a valid public GitHub repository URL' });
    if (name.length > 120) return res.status(400).json({ error: 'Project name must be 120 characters or fewer' });

    try {
      const membership = await query(
        'select role from public.organization_members where organization_id = $1 and user_id = $2',
        [organizationId, req.user.id],
      );
      if (!membership.rowCount || !WRITE_ROLES.includes(membership.rows[0].role)) {
        return res.status(403).json({ error: 'Developer access to this workspace is required' });
      }

      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
        { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Kestrel-Project-Importer' }, signal: AbortSignal.timeout(8000) },
      );
      if (response.status === 404) return res.status(404).json({ error: 'Repository was not found or is private. Public repositories are supported by this import flow.' });
      if (!response.ok) return res.status(502).json({ error: 'GitHub could not verify this repository. Try again shortly.' });
      const remote = await response.json();
      if (remote.private || remote.disabled || remote.archived) {
        return res.status(409).json({ error: 'This repository is private, disabled, or archived and cannot be imported by the public-repository flow.' });
      }
      const projectName = name || remote.name;
      if (projectName.length < 2 || projectName.length > 120) return res.status(400).json({ error: 'Project name must be between 2 and 120 characters' });
      const repoUrl = `https://github.com/${repository.owner}/${repository.repo}`;
      const project = await transaction(async (client) => {
        const created = await client.query(
          `insert into public.projects(organization_id, name, repository_url, default_branch, created_by, source_type)
           values($1, $2, $3, $4, $5, 'git')
           returning id, organization_id as "organizationId", name, repository_url as "repositoryUrl",
                     default_branch as "defaultBranch", source_type as "sourceType", created_at as "createdAt"`,
          [organizationId, projectName, repoUrl, remote.default_branch || 'main', req.user.id],
        );
        const secret = cryptoRandomSecret();
        const webhook = await client.query(
          'insert into public.github_webhooks(project_id, webhook_secret) values($1, $2) returning id',
          [created.rows[0].id, secret],
        );
        await client.query(
          `insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata)
           values($1, $2, 'project.imported', 'project', $3, $4::jsonb)`,
          [organizationId, req.user.id, created.rows[0].id, JSON.stringify({ provider: 'github', repository: remote.full_name, defaultBranch: remote.default_branch || 'main' })],
        );
        return { ...created.rows[0], webhookId: webhook.rows[0].id };
      });
      return res.status(201).json({
        project,
        repository: { fullName: remote.full_name, description: remote.description, defaultBranch: remote.default_branch || 'main', private: false },
        webhook: { endpoint: '/api/webhooks/github', setupRequired: true },
      });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A project with this name already exists in this workspace' });
      console.error('GitHub project import failed:', error.message);
      return res.status(500).json({ error: 'Could not import this repository' });
    }
  });
}

function cryptoRandomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

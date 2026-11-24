import { listHostingProviders, rankHostingProviders, detectProjectProfile } from '../lib/hosting-providers.mjs';
import { parseGitHubRepository } from './git-import.mjs';

export function registerHostingRoutes(app, { userAuth, query, fetchImpl = fetch }) {
  app.get('/api/hosting/providers', userAuth, (_req, res) => {
    res.json({ providers: listHostingProviders() });
  });

  app.post('/api/hosting/recommend', userAuth, (req, res) => {
    const profile = req.body?.profile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return res.status(400).json({ error: 'A project deployment profile is required' });
    }
    const providers = rankHostingProviders(profile);
    if (!providers.length) {
      return res.status(422).json({ error: 'No provider supports these deployment requirements', providers: [] });
    }
    res.json({
      profile,
      selectedProvider: providers.find((provider) => provider.configured)?.id || providers[0].id,
      selectionRequiresCredentials: !providers.some((provider) => provider.configured),
      providers,
    });
  });

  app.get('/api/projects/:projectId/hosting/recommendation', userAuth, async (req, res) => {
    try {
      const projectResult = await query(
        `select p.id, p.repository_url, p.source_type
         from public.projects p
         join public.organization_members m on m.organization_id = p.organization_id
         where p.id = $1 and m.user_id = $2`,
        [req.params.projectId, req.user.id],
      );
      if (!projectResult.rowCount) return res.status(404).json({ error: 'Project not found' });
      const project = projectResult.rows[0];
      const repository = parseGitHubRepository(project.repository_url);
      if (project.source_type !== 'git' || !repository) {
        return res.status(422).json({ error: 'Automatic profile detection currently supports public GitHub repositories' });
      }
      const apiHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Kestrel-Hosting-Detector' };
      const rootResponse = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/`, {
        headers: apiHeaders, signal: AbortSignal.timeout(8000),
      });
      if (!rootResponse.ok) return res.status(rootResponse.status === 404 ? 404 : 502).json({ error: 'Could not inspect the public GitHub repository' });
      const root = await rootResponse.json();
      if (!Array.isArray(root)) return res.status(422).json({ error: 'Repository root could not be inspected' });
      const files = root.filter((entry) => entry.type === 'file').map((entry) => entry.name);
      let packageJson = null;
      if (files.some((name) => name.toLowerCase() === 'package.json')) {
        const packageResponse = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/package.json`, {
          headers: apiHeaders, signal: AbortSignal.timeout(8000),
        });
        if (packageResponse.ok) {
          const body = await packageResponse.json();
          try { packageJson = JSON.parse(Buffer.from(body.content || '', 'base64').toString('utf8')); } catch { return res.status(422).json({ error: 'The repository package.json is invalid JSON' }); }
        }
      }
      const profile = detectProjectProfile({ files, packageJson });
      const providers = rankHostingProviders(profile);
      return res.json({
        projectId: project.id,
        profile,
        selectedProvider: providers.find((provider) => provider.configured)?.id || providers[0]?.id || null,
        selectionRequiresCredentials: !providers.some((provider) => provider.configured),
        providers,
      });
    } catch (error) {
      console.error('Hosting recommendation failed:', error.message);
      return res.status(502).json({ error: 'Could not inspect the project for hosting compatibility' });
    }
  });
}

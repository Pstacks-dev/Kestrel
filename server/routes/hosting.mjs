import { listHostingProviders, rankHostingProviders } from '../lib/hosting-providers.mjs';

export function registerHostingRoutes(app, { userAuth }) {
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
      return res.status(422).json({ error: 'No configured provider supports these deployment requirements', providers: [] });
    }
    res.json({
      profile,
      selectedProvider: providers.find((provider) => provider.configured)?.id || providers[0].id,
      selectionRequiresCredentials: !providers.some((provider) => provider.configured),
      providers,
    });
  });
}

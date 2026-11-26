import React, { useCallback, useEffect, useMemo, useState } from 'react';

type ProviderField = { key: string; label: string; optional?: boolean; multiline?: boolean };
type ProviderConnection = { providerId: string; accountLabel?: string | null; status: string; lastError?: string | null };
type Provider = { id: string; name: string; category: string; connected: boolean; connection?: ProviderConnection | null };
type HerokuPricing = { catalogVersion: string; plans: Record<string, { label: string; monthlyUsd: number }> };
type Deployment = {
  id: string; provider: string; status: string; branch: string; commitSha: string;
  providerUrl?: string | null; createdAt?: string;
  herokuDynoSize?: string | null; herokuDynoQuantity?: number | null; estimatedMonthlyCostUsd?: number | null;
};

const fields: Record<string, ProviderField[]> = {
  render: [{ key: 'apiKey', label: 'Render API key' }, { key: 'ownerId', label: 'Owner ID' }],
  railway: [{ key: 'token', label: 'Railway API token' }, { key: 'workspaceId', label: 'Workspace ID', optional: true }],
  flyio: [{ key: 'token', label: 'Fly API token' }, { key: 'orgSlug', label: 'Organization slug' }],
  'google-cloud-run': [
    { key: 'projectId', label: 'Google Cloud project ID' },
    { key: 'serviceAccountJson', label: 'Service account JSON', multiline: true },
    { key: 'region', label: 'Default region', optional: true },
  ],
  'aws-ecs-express': [
    { key: 'accessKeyId', label: 'AWS access key ID' },
    { key: 'secretAccessKey', label: 'AWS secret access key' },
    { key: 'sessionToken', label: 'AWS session token', optional: true },
    { key: 'region', label: 'AWS region' },
    { key: 'executionRoleArn', label: 'ECS task execution role ARN' },
    { key: 'infrastructureRoleArn', label: 'ECS infrastructure role ARN' },
  ],
  'digitalocean-app-platform': [{ key: 'accessToken', label: 'DigitalOcean access token' }, { key: 'region', label: 'Default region', optional: true }],
  heroku: [{ key: 'apiKey', label: 'Heroku API key' }],
  vercel: [{ key: 'token', label: 'Vercel access token' }, { key: 'teamId', label: 'Team ID', optional: true }],
  netlify: [{ key: 'authToken', label: 'Netlify personal access token' }],
  'cloudflare-pages': [{ key: 'apiToken', label: 'Cloudflare API token' }, { key: 'accountId', label: 'Cloudflare account ID' }],
};

const activationNotes: Record<string, string> = {
  flyio: 'Requires Kestrel OCI image building and registry publishing before it can be selected.',
  'google-cloud-run': 'Requires a published OCI image accessible to your Google Cloud project.',
  'aws-ecs-express': 'Requires a published OCI image and provisions billable Fargate and ingress resources.',
  heroku: 'Automatic selection is gated until you explicitly approve paid web dyno size and quantity.',
  netlify: 'Deploys artifacts from the latest successful Kestrel build for the exact commit.',
  'cloudflare-pages': 'Requires this repository to be authorized in Cloudflare Pages GitHub integration.',
};

function labelForStatus(status?: string) {
  if (status === 'verified') return 'Verified';
  if (status === 'configured') return 'Needs verification';
  if (status === 'failed') return 'Verification failed';
  return 'Not connected';
}

export default function ManagedHostingPanel({
  apiBase, accessToken, organizationId, projectId, defaultBranch = 'main',
}: {
  apiBase: string; accessToken: string; organizationId: string; projectId: string; defaultBranch?: string;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState('auto');
  const [herokuPricing, setHerokuPricing] = useState<HerokuPricing | null>(null);
  const [herokuDynoSize, setHerokuDynoSize] = useState('basic');
  const [herokuDynoQuantity, setHerokuDynoQuantity] = useState(1);
  const [herokuCostApproved, setHerokuCostApproved] = useState(false);

  const canDeploy = providers.some((provider) => provider.connection?.status === 'verified' && ['render', 'railway', 'digitalocean-app-platform', 'heroku', 'vercel', 'netlify', 'cloudflare-pages'].includes(provider.id));

  const headers = useMemo(() => ({
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }), [accessToken]);

  const refresh = useCallback(async () => {
    if (!organizationId || !accessToken) return;
    const response = await fetch(`${apiBase}/workspaces/${organizationId}/hosting/providers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const data = await response.json();
      setProviders(data.providers || []);
      try {
        const pricing = await fetch(`${apiBase}/heroku/dyno-pricing`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (pricing.ok) setHerokuPricing(await pricing.json());
      } catch { setHerokuPricing(null); }
    }
  }, [apiBase, accessToken, organizationId]);

  const refreshDeployments = useCallback(async () => {
    if (!projectId || !accessToken) return;
    const response = await fetch(`${apiBase}/projects/${projectId}/managed-deployments`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const data = await response.json();
      const current: Deployment[] = data.deployments || [];
      const pending = current.filter((deployment) => ['queued', 'deploying', 'building'].includes(deployment.status)).slice(0, 10);
      const updates = await Promise.all(pending.map(async (deployment) => {
        try {
          const detail = await fetch(`${apiBase}/managed-deployments/${deployment.id}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!detail.ok) return null;
          const body = await detail.json();
          return body.deployment as Deployment;
        } catch { return null; }
      }));
      const byId = new Map(updates.filter(Boolean).map((deployment: any) => [deployment.id, deployment]));
      setDeployments(current.map((deployment) => ({ ...deployment, ...(byId.get(deployment.id) || {}) })));
    }
  }, [apiBase, accessToken, projectId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { refreshDeployments(); }, [refreshDeployments]);
  useEffect(() => {
    const interval = window.setInterval(() => { refreshDeployments(); }, 10000);
    return () => window.clearInterval(interval);
  }, [refreshDeployments]);

  async function saveConnection(providerId: string) {
    const definitions = fields[providerId] || [];
    const values = credentials;
    const missing = definitions.filter((field) => !field.optional && !String(values[field.key] || '').trim());
    if (missing.length) {
      setMessage(`Enter ${missing.map((field) => field.label).join(', ')}.`);
      return;
    }
    const payload = Object.fromEntries(definitions
      .filter((field) => String(values[field.key] || '').trim())
      .map((field) => [field.key, values[field.key]]));
    setBusy(true);
    setMessage('');
    try {
      const saved = await fetch(`${apiBase}/workspaces/${organizationId}/hosting/providers/${providerId}`, {
        method: 'PUT', headers, body: JSON.stringify({ credentials: payload }),
      });
      const savedBody = await saved.json().catch(() => ({}));
      if (!saved.ok) throw new Error(savedBody.error || 'Could not save provider credentials');
      const verified = await fetch(`${apiBase}/workspaces/${organizationId}/hosting/providers/${providerId}/verify`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      const verifyBody = await verified.json().catch(() => ({}));
      if (!verified.ok) throw new Error(verifyBody.error || 'Provider verification failed');
      setMessage(`${providerId} connection verified.`);
      setEditingProvider(null);
      setCredentials({});
      await refresh();
    } catch (error: any) {
      setMessage(error.message || 'Could not connect provider');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function startDeployment() {
    if (!projectId) return;
    setDeploying(true);
    setMessage('');
    try {
      const body: Record<string, any> = {
        branch: defaultBranch,
        ...(selectedProviderId !== 'auto' ? { providerId: selectedProviderId } : {}),
      };
      if (selectedProviderId === 'heroku') {
        if (!herokuCostApproved || !herokuPricing) throw new Error('Approve the current Heroku cost estimate before deploying.');
        const plan = herokuPricing.plans[herokuDynoSize];
        if (!plan) throw new Error('Select a valid Heroku dyno plan.');
        body.herokuCostApproval = {
          approved: true, dynoSize: herokuDynoSize, dynoQuantity: herokuDynoQuantity,
          monthlyCostUsd: Number((plan.monthlyUsd * herokuDynoQuantity).toFixed(2)),
          pricingCatalogVersion: herokuPricing.catalogVersion,
        };
      }
      const response = await fetch(`${apiBase}/projects/${projectId}/managed-deployments`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not start managed deployment');
      setMessage(`Kestrel selected ${data.selectedProvider} for this project.`);
      await refreshDeployments();
    } catch (error: any) {
      setMessage(error.message || 'Managed deployment failed');
    } finally {
      setDeploying(false);
    }
  }

  async function rollback(deploymentId: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${apiBase}/managed-deployments/${deploymentId}/rollback`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Rollback failed');
      setMessage('Rollback requested.');
      await refreshDeployments();
    } catch (error: any) {
      setMessage(error.message || 'Rollback failed');
    } finally {
      setBusy(false);
    }
  }

  async function showLogs(deploymentId: string) {
    setLogs('Loading deployment logs…');
    try {
      const response = await fetch(`${apiBase}/managed-deployments/${deploymentId}/logs`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not load logs');
      const entries = [...(data.logs?.build || []), ...(data.logs?.runtime || [])];
      setLogs(entries.map((entry: any) => entry.message || JSON.stringify(entry)).join('\n') || data.logs?.message || 'No provider logs are available for this deployment.');
    } catch (error: any) {
      setLogs(error.message || 'Could not load deployment logs');
    }
  }

  return (
    <section className="panel mt-5">
      <div className="panel-head flex-wrap justify-between gap-3">
        <div>
          <h3>Managed hosting providers</h3>
          <p>Connect your provider accounts once. Kestrel selects a compatible host and manages deployment history.</p>
        </div>
        <div className="flex flex-col gap-2 min-w-64">
          <label className="text-xs font-medium">Hosting provider
            <select className="mt-1 w-full rounded border p-2" value={selectedProviderId} onChange={(e) => { setSelectedProviderId(e.target.value); setHerokuCostApproved(false); }}>
              <option value="auto">Automatic — best compatible verified provider</option>
              {providers.filter((provider) => provider.connection?.status === 'verified').map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          {selectedProviderId === 'heroku' && (
            <div className="rounded border p-3 text-xs space-y-2">
              <label>Heroku dyno plan
                <select className="mt-1 w-full rounded border p-2" value={herokuDynoSize} onChange={(e) => { setHerokuDynoSize(e.target.value); if (e.target.value === 'basic') setHerokuDynoQuantity(1); setHerokuCostApproved(false); }}>
                  {Object.entries(herokuPricing?.plans || {}).map(([size, plan]) => <option key={size} value={size}>{plan.label} — ${plan.monthlyUsd.toFixed(2)}/month</option>)}
                </select>
              </label>
              <label>Web dyno quantity
                <input className="mt-1 w-full rounded border p-2" type="number" min={1} max={herokuDynoSize === 'basic' ? 1 : 10} value={herokuDynoQuantity} onChange={(e) => { setHerokuDynoQuantity(herokuDynoSize === 'basic' ? 1 : Math.max(1, Math.min(10, Number(e.target.value) || 1))); setHerokuCostApproved(false); }} />
              </label>
              <p>Estimated maximum: <b>${((herokuPricing?.plans[herokuDynoSize]?.monthlyUsd || 0) * herokuDynoQuantity).toFixed(2)} USD/month</b>, assuming 24/7 use. Add-ons and taxes are excluded.</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={herokuCostApproved} onChange={(e) => setHerokuCostApproved(e.target.checked)} />
                <span>I approve this plan, quantity and recurring cost for this workspace. Only an owner/admin can submit the approval.</span>
              </label>
              <small>Catalog {herokuPricing?.catalogVersion || 'loading'}; Kestrel verifies the estimate server-side.</small>
            </div>
          )}
          <button className="btn btn-dark" onClick={startDeployment} disabled={!projectId || !canDeploy || deploying || (selectedProviderId === 'heroku' && (!herokuCostApproved || !herokuPricing))}>
            {deploying ? 'Starting deployment…' : selectedProviderId === 'auto' ? 'Deploy with best compatible provider' : `Deploy with ${providers.find((p) => p.id === selectedProviderId)?.name || selectedProviderId}`}
          </button>
        </div>
      </div>

      {message && <div className="notice mb-4" role="status">{message}</div>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {providers.map((provider) => {
          const status = provider.connection?.status;
          const providerFields = fields[provider.id] || [];
          return (
            <div key={provider.id} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex items-center justify-between gap-2">
                <b>{provider.name}</b>
                <span className={status === 'verified' ? 'pill pill-green' : 'pill pill-muted'}>
                  {labelForStatus(status)}
                </span>
              </div>
              {provider.connection?.lastError && <p className="mt-2 text-xs text-red-700">{provider.connection.lastError}</p>}
              {activationNotes[provider.id] && <p className="mt-2 text-xs text-neutral-500">{activationNotes[provider.id]}</p>}
              {provider.id === 'railway' || provider.id === 'vercel' ? (
                <p className="mt-2 text-xs text-neutral-500">Git-connected deployments may also be triggered by the provider's native Git integration.</p>
              ) : null}
              <div className="mt-3">
                <button className="btn btn-light text-xs" onClick={() => {
                  setEditingProvider(editingProvider === provider.id ? null : provider.id);
                  setCredentials({});
                }}>
                  {provider.connected ? 'Update credentials' : 'Connect provider'}
                </button>
              </div>
              {editingProvider === provider.id && (
                <div className="mt-4 space-y-3 border-t pt-3">
                  {providerFields.map((field) => (
                    <label key={field.key} className="block text-xs font-medium">
                      {field.label}{field.optional ? ' (optional)' : ''}
                      {field.multiline ? (
                        <textarea
                          className="mt-1 w-full rounded border p-2 font-mono text-xs"
                          rows={5}
                          value={credentials[field.key] || ''}
                          onChange={(event) => setCredentials((previous) => ({ ...previous, [field.key]: event.target.value }))}
                          placeholder="Paste JSON"
                        />
                      ) : (
                        <input
                          className="mt-1 w-full rounded border p-2 text-xs"
                          type="password"
                          autoComplete="off"
                          value={credentials[field.key] || ''}
                          onChange={(event) => setCredentials((previous) => ({ ...previous, [field.key]: event.target.value }))}
                        />
                      )}
                    </label>
                  ))}
                  <button className="btn btn-dark w-full" disabled={busy} onClick={() => saveConnection(provider.id)}>
                    {busy ? 'Saving and verifying…' : 'Save and verify'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 border-t pt-5">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="font-semibold">Managed deployment history</h4>
          <button className="btn btn-light text-xs" onClick={refreshDeployments}>Refresh</button>
        </div>
        {deployments.length ? (
          <div className="space-y-2">
            {deployments.slice(0, 10).map((deployment) => (
              <div key={deployment.id} className="flex flex-wrap items-center justify-between gap-3 rounded border p-3 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <b>{deployment.provider}</b>
                    <span className="pill pill-muted">{deployment.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">{deployment.branch} · {deployment.commitSha?.slice(0, 10)}</p>
                  {deployment.provider === 'heroku' && deployment.estimatedMonthlyCostUsd != null && <p className="mt-1 text-xs text-neutral-600">Approved: {deployment.herokuDynoQuantity} × {deployment.herokuDynoSize} · up to ${deployment.estimatedMonthlyCostUsd.toFixed(2)}/month</p>}
                  {deployment.providerUrl && <a className="text-xs text-blue-700 underline" href={deployment.providerUrl} target="_blank" rel="noreferrer">{deployment.providerUrl}</a>}
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-light text-xs" onClick={() => showLogs(deployment.id)}>Logs</button>
                  <button className="btn btn-light text-xs" disabled={busy || deployment.status !== 'live'} onClick={() => rollback(deployment.id)}>Rollback</button>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-neutral-500">No managed provider deployments yet.</p>}
        {logs !== null && (
          <pre className="mt-4 max-h-72 overflow-auto rounded bg-neutral-950 p-3 text-xs text-neutral-100">{logs}</pre>
        )}
      </div>
    </section>
  );
}

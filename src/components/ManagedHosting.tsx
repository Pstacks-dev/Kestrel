import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, CircleAlert, Cloud, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';

type Provider = {
  id: string; name: string; category: string; connected: boolean;
  connection?: { status: string; accountLabel?: string | null; lastVerifiedAt?: string | null; lastError?: string | null } | null;
};
type Deployment = {
  id: string; provider: string; status: string; branch: string; commitSha: string;
  providerUrl?: string | null; createdAt?: string; providerStatus?: string;
};
type Field = { key: string; label: string; placeholder?: string; multiline?: boolean; optional?: boolean };

const PROVIDERS: Record<string, Field[]> = {
  render: [{ key: 'apiKey', label: 'Render API key' }, { key: 'ownerId', label: 'Workspace owner ID' }],
  railway: [{ key: 'token', label: 'Railway API token' }],
  flyio: [{ key: 'token', label: 'Fly.io API token' }, { key: 'orgSlug', label: 'Organization slug' }],
  'google-cloud-run': [{ key: 'projectId', label: 'Google Cloud project ID' }, { key: 'serviceAccountJson', label: 'Service account JSON', multiline: true }, { key: 'region', label: 'Region', optional: true, placeholder: 'us-central1' }],
  'aws-ecs-express': [{ key: 'accessKeyId', label: 'AWS access key ID' }, { key: 'secretAccessKey', label: 'AWS secret access key' }, { key: 'region', label: 'AWS region', placeholder: 'us-east-1' }, { key: 'executionRoleArn', label: 'ECS task execution role ARN' }, { key: 'infrastructureRoleArn', label: 'ECS infrastructure role ARN' }, { key: 'sessionToken', label: 'Temporary session token', optional: true }],
  'digitalocean-app-platform': [{ key: 'accessToken', label: 'DigitalOcean personal access token' }],
  heroku: [{ key: 'apiKey', label: 'Heroku API key' }],
  vercel: [{ key: 'token', label: 'Vercel access token' }, { key: 'teamId', label: 'Team ID', optional: true }],
  netlify: [{ key: 'authToken', label: 'Netlify personal access token' }],
  'cloudflare-pages': [{ key: 'apiToken', label: 'Cloudflare API token' }, { key: 'accountId', label: 'Cloudflare account ID' }],
};

const labelStatus = (status?: string) => status === 'verified' ? 'Verified' : status === 'configured' ? 'Needs verification' : status === 'error' ? 'Verification failed' : 'Not connected';

export function ManagedHosting({ apiBase, accessToken, organizationId, projectId }: {
  apiBase: string; accessToken: string; organizationId: string; projectId: string;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [loadingLogs, setLoadingLogs] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [artifactIds, setArtifactIds] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const headers = useMemo(() => ({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }), [accessToken]);

  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(`${apiBase}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function refresh() {
    if (!organizationId) return;
    setLoading(true);
    setError('');
    try {
      const result = await request(`/workspaces/${organizationId}/hosting/providers`);
      setProviders(result.providers || []);
    } catch (e: any) { setError(e.message || 'Could not load hosting providers'); }
    finally { setLoading(false); }
  }

  async function refreshDeployments() {
    if (!projectId) { setDeployments([]); return; }
    try {
      const result = await request(`/projects/${projectId}/managed-deployments`);
      const items: Deployment[] = result.deployments || [];
      const pending = items.filter((item) => ['queued', 'deploying', 'rolling_back', 'unknown'].includes(item.status)).slice(0, 12);
      const refreshed = await Promise.all(items.map(async (item) => {
        if (!pending.some((candidate) => candidate.id === item.id)) return item;
        try {
          const current = await request(`/managed-deployments/${item.id}`);
          return current.deployment || item;
        } catch { return item; }
      }));
      setDeployments(refreshed);
    } catch (e: any) { setError(e.message || 'Could not load deployment history'); }
  }

  useEffect(() => { refresh(); }, [organizationId, accessToken]);
  useEffect(() => { refreshDeployments(); }, [projectId, accessToken]);

  async function save(providerId: string) {
    setSaving(true); setError(''); setMessage('');
    try {
      const fields = PROVIDERS[providerId] || [];
      const value = Object.fromEntries(fields.filter((field) => credentials[field.key]?.trim()).map((field) => [field.key, credentials[field.key].trim()]));
      await request(`/workspaces/${organizationId}/hosting/providers/${providerId}`, {
        method: 'PUT', body: JSON.stringify({ credentials: value }),
      });
      setMessage('Credentials encrypted and saved. Verify access before deploying.');
      setEditing(null); setCredentials({});
      await refresh();
    } catch (e: any) { setError(e.message || 'Could not save provider credentials'); }
    finally { setSaving(false); }
  }

  async function verify(providerId: string) {
    setVerifying(providerId); setError(''); setMessage('');
    try {
      const result = await request(`/workspaces/${organizationId}/hosting/providers/${providerId}/verify`, { method: 'POST', body: '{}' });
      setMessage(`${providers.find((p) => p.id === providerId)?.name || providerId} verified${result.account ? ` · ${result.account}` : ''}.`);
      await refresh();
    } catch (e: any) { setError(e.message || 'Provider verification failed'); await refresh(); }
    finally { setVerifying(null); }
  }

  async function disconnect(providerId: string) {
    if (!window.confirm('Disconnect this provider? Kestrel will delete its encrypted credentials. Existing provider deployments will not be deleted.')) return;
    setError(''); setMessage('');
    try {
      await request(`/workspaces/${organizationId}/hosting/providers/${providerId}`, { method: 'DELETE' });
      setMessage('Provider disconnected. Existing hosted applications are unchanged.');
      await refresh();
    } catch (e: any) { setError(e.message || 'Could not disconnect provider'); }
  }

  async function loadLogs(deploymentId: string) {
    setLoadingLogs(deploymentId); setError('');
    try {
      const result = await request(`/managed-deployments/${deploymentId}/logs`);
      const entries = [...(result.build || []).map((item: any) => `[build] ${item.message || ''}`), ...(result.runtime || []).map((item: any) => `[runtime] ${item.message || ''}`)];
      setLogs((old) => ({ ...old, [deploymentId]: entries.join('\\n') || result.message || 'No logs are available for this deployment yet.' }));
    } catch (e: any) { setError(e.message || 'Could not load deployment logs'); }
    finally { setLoadingLogs(null); }
  }

  async function rollback(deploymentId: string) {
    if (!window.confirm('Roll back this provider deployment? Kestrel will ask the hosting provider to restore the previous release.')) return;
    setRollingBack(deploymentId); setError(''); setMessage('');
    try {
      await request(`/managed-deployments/${deploymentId}/rollback`, { method: 'POST', body: '{}' });
      setMessage('Rollback requested. The provider is starting the previous release.');
      await refreshDeployments();
    } catch (e: any) { setError(e.message || 'Could not roll back deployment'); }
    finally { setRollingBack(null); }
  }

  async function deploy() {
    if (!projectId) { setError('Select a project before deploying.'); return; }
    setDeploying(true); setError(''); setMessage('');
    try {
      const ids = artifactIds.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
      const result = await request(`/projects/${projectId}/managed-deployments`, {
        method: 'POST', body: JSON.stringify({ ...(ids.length ? { artifactIds: ids } : {}) }),
      });
      setMessage(`Deployment started with ${result.selectedProvider || result.deployment?.provider || 'the selected provider'}.`);
      await refreshDeployments();
    } catch (e: any) { setError(e.message || 'Could not start deployment'); }
    finally { setDeploying(false); }
  }

  return <section className="managed-hosting">
    <div className="managed-hosting-heading">
      <div><div className="eyebrow">MANAGED HOSTING</div><h3>Connect a hosting account</h3><p>Connect a provider once. Kestrel stores credentials encrypted and selects a compatible verified provider when you deploy.</p></div>
      <button className="btn btn-light" onClick={() => { refresh(); refreshDeployments(); }} disabled={loading}><RefreshCw size={14}/> Refresh</button>
    </div>
    {message && <div className="managed-hosting-notice success"><Check size={15}/>{message}</div>}
    {error && <div className="managed-hosting-notice error"><CircleAlert size={15}/>{error}</div>}
    <div className="managed-provider-grid">
      {providers.map((provider) => <article className="managed-provider-card" key={provider.id}>
        <div className="managed-provider-top"><span className="managed-provider-icon"><Cloud size={17}/></span><span className={provider.connection?.status === 'verified' ? 'pill pill-green' : 'pill pill-muted'}>{labelStatus(provider.connection?.status)}</span></div>
        <h4>{provider.name}</h4><p>{provider.category.replaceAll('-', ' ')}</p>
        {provider.connection?.lastError && <small className="managed-provider-error">{provider.connection.lastError}</small>}
        {editing === provider.id ? <div className="managed-provider-form">
          {(PROVIDERS[provider.id] || []).map((field) => <label key={field.key}>{field.label}{field.optional && ' (optional)'}
            {field.multiline ? <textarea rows={4} value={credentials[field.key] || ''} onChange={(e) => setCredentials((old) => ({ ...old, [field.key]: e.target.value }))} placeholder="Paste service-account JSON" /> :
              <input type={field.key.toLowerCase().includes('secret') || field.key.toLowerCase().includes('token') || field.key === 'apiKey' ? 'password' : 'text'} value={credentials[field.key] || ''} onChange={(e) => setCredentials((old) => ({ ...old, [field.key]: e.target.value }))} placeholder={field.placeholder || field.label} />}
          </label>)}
          <div className="managed-provider-actions"><button className="btn btn-dark" disabled={saving} onClick={() => save(provider.id)}>{saving ? 'Saving…' : 'Save credentials'}</button><button className="btn btn-light" onClick={() => { setEditing(null); setCredentials({}); }}>Cancel</button></div>
        </div> : <div className="managed-provider-actions">
          <button className="btn btn-light" onClick={() => { setEditing(provider.id); setCredentials({}); }}><Plus size={14}/>{provider.connected ? 'Update credentials' : 'Connect'}</button>
          {provider.connected && <><button className="btn btn-light" disabled={verifying === provider.id} onClick={() => verify(provider.id)}>{verifying === provider.id ? <Loader2 className="spin" size={14}/> : <ShieldCheck size={14}/>}Verify</button><button className="btn btn-quiet" title="Disconnect" onClick={() => disconnect(provider.id)}><Trash2 size={14}/></button></>}
        </div>}
      </article>)}
    </div>
    <div className="panel managed-deploy-panel">
      <div className="panel-head"><div><h3>Deploy this project</h3><p>Kestrel ranks connected providers by project compatibility. It does not require a Kestrel-owned hosting server.</p></div></div>
      <label className="managed-artifact-field">Netlify build artifact IDs <span>(optional; required when Netlify is selected)</span>
        <textarea rows={2} value={artifactIds} onChange={(e) => setArtifactIds(e.target.value)} placeholder="Paste artifact IDs separated by commas or new lines" />
      </label>
      <button className="btn btn-dark" onClick={deploy} disabled={deploying || !projectId}>{deploying ? 'Starting deployment…' : 'Deploy with best compatible provider'} <Cloud size={15}/></button>
    </div>
    <div className="panel managed-deployment-history">
      <div className="panel-head"><div><h3>Managed deployment history</h3><p>Provider status and public URL for each deployment.</p></div></div>
      {!deployments.length ? <p className="deployment-muted">No managed deployments yet.</p> : <div className="managed-deployment-list">
        {deployments.map((item) => <div className="managed-deployment-row" key={item.id}>
          <div><b>{item.provider}</b><small>{item.branch} · {item.commitSha?.slice(0, 8)}</small></div>
          <span className={item.status === 'live' ? 'pill pill-green' : 'pill pill-muted'}>{item.status}</span>
          {item.providerUrl ? <a href={item.providerUrl} target="_blank" rel="noreferrer">Open app ↗</a> : <small>URL pending</small>}
          <div className="managed-deployment-actions">
            <button className="btn btn-light" onClick={() => loadLogs(item.id)} disabled={loadingLogs === item.id}>{loadingLogs === item.id ? 'Loading logs…' : 'View logs'}</button>
            {item.status === 'live' && <button className="btn btn-light" onClick={() => rollback(item.id)} disabled={rollingBack === item.id}>{rollingBack === item.id ? 'Rolling back…' : 'Roll back'}</button>}
          </div>
          {logs[item.id] !== undefined && <pre className="managed-deployment-logs">{logs[item.id]}</pre>}
        </div>)}
      </div>}
    </div>
  </section>;
}

import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock3, Radio, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';

type Props = {
  api: string;
  accessToken: string;
  selectedProject: string;
  setSelectedProject: (id: string) => void;
  projects: any[];
  runs: any[];
  setMessage: (message: string) => void;
  message: string;
};

export default function ReleaseCenter({ api, accessToken, selectedProject, setSelectedProject, projects, runs, setMessage, message }: Props) {
  const [targets, setTargets] = useState<any[]>([]);
  const [deployments, setDeployments] = useState<any[]>([]);
  const [provider, setProvider] = useState('vercel');
  const [name, setName] = useState('Production');
  const [siteId, setSiteId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [token, setToken] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [approval, setApproval] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!selectedProject || !accessToken) return;
    const headers = { Authorization: 'Bearer ' + accessToken };
    const [targetResponse, deploymentResponse] = await Promise.all([
      fetch(api + '/projects/' + selectedProject + '/deployment-targets', { headers }),
      fetch(api + '/deployments?projectId=' + encodeURIComponent(selectedProject), { headers }),
    ]);
    if (targetResponse.ok) setTargets(await targetResponse.json());
    if (deploymentResponse.ok) setDeployments(await deploymentResponse.json());
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message || 'Could not load deployments'));
  }, [selectedProject, accessToken, api]);

  const latestRun = useMemo(() => runs
    .filter((run) => run.projectId === selectedProject && run.status === 'succeeded' && /^[a-f0-9]{40}$/i.test(run.commitSha || ''))
    .sort((a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime())[0], [runs, selectedProject]);

  async function connectProvider(event: any) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(api + '/projects/' + selectedProject + '/deployment-targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({
          provider, name, providerSiteId: siteId, providerTeamId: teamId || null,
          token, environment, approvalRequired: approval,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not connect provider');
      setToken('');
      setSiteId('');
      setTeamId('');
      setMessage('Provider connected. Its access token is encrypted and will not be displayed again.');
      await refresh();
    } catch (error: any) {
      setMessage(error.message || 'Could not connect provider');
    } finally {
      setBusy(false);
    }
  }

  async function requestDeployment(targetId: string) {
    if (!latestRun) return setMessage('A successful run with a full commit SHA is required before deployment.');
    setBusy(true);
    try {
      const response = await fetch(api + '/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({ targetId, runId: latestRun.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Deployment request failed');
      setMessage(data.status === 'pending_approval' ? 'Deployment is waiting for owner/admin approval.' : 'Deployment submitted to provider.');
      await refresh();
    } catch (error: any) {
      setMessage(error.message || 'Deployment request failed');
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, actionName: 'approve' | 'reject' | 'rollback' | 'refresh') {
    setBusy(true);
    try {
      const response = await fetch(api + '/deployments/' + id + '/' + actionName, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not ' + actionName + ' deployment');
      setMessage(actionName === 'approve' ? 'Release approved and submitted.' : actionName === 'reject' ? 'Release rejected.' : actionName === 'rollback' ? 'Rollback submitted.' : 'Provider status refreshed.');
      await refresh();
    } catch (error: any) {
      setMessage(error.message || 'Deployment action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DELIVERY / DEPLOYMENTS</div>
          <h1>Deployment targets</h1>
          <p>Connect Vercel or Netlify, approve production releases, and restore an earlier successful deployment.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div><h3>Project</h3><p>Each target belongs to one registered repository.</p></div></div>
        <select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)} className="w-full max-w-md border rounded-lg p-2 text-sm">
          <option value="">Select project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <p className="text-xs text-neutral-500 mt-3">{latestRun ? 'Latest successful run: #' + latestRun.runNumber + ' · ' + latestRun.commitSha.slice(0, 8) : 'No successful run with a full commit SHA is available yet.'}</p>
      </div>

      {selectedProject && <>
        <div className="panel mt-5">
          <div className="panel-head"><div><h3>Connect provider</h3><p>Provider credentials are encrypted before they are stored. Never paste a publishable or browser-exposed key here.</p></div></div>
          <form onSubmit={connectProvider} className="project-form">
            <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="vercel">Vercel</option><option value="netlify">Netlify</option></select></label>
            <label>Target name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
            <label>{provider === 'vercel' ? 'Vercel Project ID' : 'Netlify Site ID'}<input value={siteId} onChange={(event) => setSiteId(event.target.value)} required /></label>
            {provider === 'vercel' && <label>Vercel Team ID (optional)<input value={teamId} onChange={(event) => setTeamId(event.target.value)} placeholder="team_…" /></label>}
            <label>Provider access token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" required /></label>
            <label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="production">Production</option><option value="preview">Preview</option></select></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={approval} onChange={(event) => setApproval(event.target.checked)} /> Require owner/admin approval before deployment</label>
            <button className="btn btn-dark" type="submit" disabled={busy}>Connect provider <ArrowUpRight size={14} /></button>
          </form>
        </div>

        <div className="panel mt-5">
          <div className="panel-head"><div><h3>Connected targets</h3><p>Deploys are created from the commit attached to the successful pipeline run.</p></div><button className="btn btn-light" onClick={() => refresh()}><Activity size={14} /> Refresh</button></div>
          {targets.length ? targets.map((target) => <div className="table-row" key={target.id}>
            <Radio size={18} />
            <div className="flex-1"><b>{target.name} · {target.provider}</b><small>{target.environment} · {target.approvalRequired ? 'Approval required' : 'Automatic deployment'} · {target.active ? 'Active' : 'Disabled'}</small></div>
            <button className="btn btn-light" disabled={busy || !target.active || !latestRun} onClick={() => requestDeployment(target.id)}>Deploy latest successful run <ArrowUpRight size={14} /></button>
          </div>) : <div className="empty-state"><Radio size={22} /><b>No deployment targets</b><p>Connect a Vercel or Netlify project to start deploying from Kestrel.</p></div>}
        </div>

        <div className="panel mt-5">
          <div className="panel-head"><div><h3>Release history</h3><p>Pending approvals, provider status, and rollback history.</p></div><button className="btn btn-light" onClick={() => refresh()}><Activity size={14} /> Refresh</button></div>
          {deployments.length ? deployments.map((deployment) => <div className="table-row flex-wrap" key={deployment.id}>
            <span className={'pill ' + (deployment.status === 'ready' ? 'pill-green' : 'pill-muted')}>{deployment.status.replace('_', ' ')}</span>
            <div className="flex-1 min-w-[190px]"><b>{deployment.targetName} · {deployment.provider}</b><small>{deployment.branch} · {String(deployment.commitSha).slice(0, 8)} · {new Date(deployment.createdAt).toLocaleString()}</small>{deployment.errorMessage && <small className="text-red-600">{deployment.errorMessage}</small>}{deployment.deploymentUrl && <a className="text-xs underline" href={deployment.deploymentUrl} target="_blank" rel="noreferrer">Open deployment</a>}</div>
            <div className="flex gap-2 flex-wrap">
              {deployment.status === 'pending_approval' && <><button className="btn btn-light" disabled={busy} onClick={() => action(deployment.id, 'approve')}><CheckCircle2 size={14} /> Approve</button><button className="btn btn-light" disabled={busy} onClick={() => action(deployment.id, 'reject')}><XCircle size={14} /> Reject</button></>}
              {deployment.status === 'deploying' && <button className="btn btn-light" disabled={busy} onClick={() => action(deployment.id, 'refresh')}><Clock3 size={14} /> Check status</button>}
              {deployment.status === 'ready' && <button className="btn btn-light" disabled={busy} onClick={() => action(deployment.id, 'rollback')}><RotateCcw size={14} /> Rollback</button>}
            </div>
          </div>) : <div className="empty-state"><ShieldCheck size={22} /><b>No releases yet</b><p>Deploy a successful run to create the first release record.</p></div>}
        </div>
      </>}
      {message && <div className="action-message mt-4">{message}</div>}
    </div>
  );
}

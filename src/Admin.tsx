import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity, ArrowRight, Boxes, Cpu, LogOut, RefreshCw, Server, ShieldCheck, Workflow } from 'lucide-react';
import { requireSupabase } from './lib-supabase';
import './admin.css';
type Overview={generatedAt:string;totals:{projects:number;runs:number;workers:number;jobs:number};workers:any[];jobStatuses:Record<string,number>};
type Org={id:string;name:string;slug:string;members:number;projects:number};
export default function Admin(){
  const [checking,setChecking]=useState(true);
  const [allowed,setAllowed]=useState(false);
  const [needsLogin,setNeedsLogin]=useState(false);
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [data,setData]=useState<Overview|null>(null);
  const [health,setHealth]=useState<any>(null);
  const [orgs,setOrgs]=useState<Org[]>([]);
  const [organizationId,setOrganizationId]=useState('');
  const [workerName,setWorkerName]=useState('builder-node');
  const [workerToken,setWorkerToken]=useState('');
  const [workerId,setWorkerId]=useState('');
  const [computeNodes,setComputeNodes]=useState<any[]>([]);
  const [computeNodeId,setComputeNodeId]=useState('incus-ibadan-01');
  const [computeProvider,setComputeProvider]=useState('incus');
  const [computeHostname,setComputeHostname]=useState('incus-ibadan-01');
  const [computeRegion,setComputeRegion]=useState('ng-ibadan');
  const [computeVcpu,setComputeVcpu]=useState('16');
  const [computeMemory,setComputeMemory]=useState('32768');
  const [computeDisk,setComputeDisk]=useState('1000');
  const [computeMaxInstances,setComputeMaxInstances]=useState('40');
  const [computeNodeToken,setComputeNodeToken]=useState('');
  const [quotaInstances,setQuotaInstances]=useState('3');
  const [quotaVcpu,setQuotaVcpu]=useState('8');
  const [quotaMemory,setQuotaMemory]=useState('16384');
  const [quotaDisk,setQuotaDisk]=useState('200');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  async function load(){
    setBusy(true);setError('');
    try{
      const sb=requireSupabase();
      const {data:{session}}=await sb.auth.getSession();
      if(!session){setAllowed(false);setNeedsLogin(true);return}
      const r=await fetch('/api/admin/overview',{headers:{Authorization:`Bearer ${session.access_token}`}});
      if(r.status===404||r.status===403){setAllowed(false);setNeedsLogin(false);setError('This account is not provisioned as a platform administrator.');return}
      if(!r.ok)throw new Error('Unable to load admin data');
      setData(await r.json());
      const h=await fetch('/api/admin/health',{headers:{Authorization:`Bearer ${session.access_token}`}});
      if(h.ok)setHealth(await h.json());
      const o=await fetch('/api/admin/organizations',{headers:{Authorization:`Bearer ${session.access_token}`}});
      if(o.ok){const list=await o.json();setOrgs(list);if(list.length&&!organizationId)setOrganizationId(list[0].id)}
      const cn=await fetch('/api/admin/compute/nodes',{headers:{Authorization:`Bearer ${session.access_token}`}});
      if(cn.ok){const body=await cn.json();setComputeNodes(body.nodes||[])}
      setNeedsLogin(false);setAllowed(true);
    }catch(e:any){setError(e.message||'Request failed')}
    finally{setBusy(false);setChecking(false)}
  }
  useEffect(()=>{load()},[]);

  async function signIn(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');
    try{
      const {error}=await requireSupabase().auth.signInWithPassword({email,password});
      if(error)throw error;
      setPassword('');
      await load();
    }catch(e:any){setError(e.message||'Unable to sign in')}
    finally{setBusy(false);setChecking(false)}
  }
  async function provisionWorker(e:FormEvent){
    e.preventDefault();setError('');setWorkerToken('');setBusy(true);
    try{
      const sb=requireSupabase();const {data:{session}}=await sb.auth.getSession();
      if(!session)throw new Error('Sign in again');
      const r=await fetch('/api/admin/workers',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({organizationId,name:workerName,maxConcurrency:2})});
      const j=await r.json();if(!r.ok)throw new Error(j.error||'Worker provisioning failed');
      setWorkerId(j.workerId);setWorkerToken(j.token);await load();
    }catch(e:any){setError(e.message||'Provisioning failed')}
    finally{setBusy(false)}
  }
  async function provisionComputeNode(e:FormEvent){
    e.preventDefault();setError('');setComputeNodeToken('');setBusy(true);
    try{
      const {data:{session}}=await requireSupabase().auth.getSession();
      if(!session)throw new Error('Sign in again');
      const r=await fetch('/api/admin/compute/nodes',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({
        id:computeNodeId,provider:computeProvider,hostname:computeHostname,region:computeRegion,
        totalVcpu:Number(computeVcpu),totalMemoryMib:Number(computeMemory),totalDiskGib:Number(computeDisk),maxInstances:Number(computeMaxInstances)
      })});
      const j=await r.json();if(!r.ok)throw new Error(j.error||'Compute node provisioning failed');
      setComputeNodeToken(j.agentToken);await load();
    }catch(e:any){setError(e.message||'Compute node provisioning failed')}
    finally{setBusy(false)}
  }
  async function saveComputeQuota(e:FormEvent){
    e.preventDefault();setError('');setBusy(true);
    try{
      const {data:{session}}=await requireSupabase().auth.getSession();
      if(!session)throw new Error('Sign in again');
      const r=await fetch(`/api/admin/compute/quotas/${encodeURIComponent(organizationId)}`,{
        method:'PUT',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},
        body:JSON.stringify({maxInstances:Number(quotaInstances),maxVcpu:Number(quotaVcpu),maxMemoryMiB:Number(quotaMemory),maxDiskGiB:Number(quotaDisk)})
      });
      const j=await r.json();if(!r.ok)throw new Error(j.error||'Quota update failed');
      setError('');
    }catch(e:any){setError(e.message||'Quota update failed')}
    finally{setBusy(false)}
  }
  async function setComputeNodeState(id:string,desiredState:'online'|'draining'|'offline'){
    setError('');setBusy(true);
    try{
      const {data:{session}}=await requireSupabase().auth.getSession();
      if(!session)throw new Error('Sign in again');
      const r=await fetch(`/api/admin/compute/nodes/${encodeURIComponent(id)}/state`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({desiredState})});
      const j=await r.json();if(!r.ok)throw new Error(j.error||'Compute node state update failed');
      await load();
    }catch(e:any){setError(e.message||'Compute node state update failed')}
    finally{setBusy(false)}
  }
  async function rotateComputeNodeToken(id:string){
    setError('');setComputeNodeToken('');setBusy(true);
    try{
      const {data:{session}}=await requireSupabase().auth.getSession();
      if(!session)throw new Error('Sign in again');
      const r=await fetch(`/api/admin/compute/nodes/${encodeURIComponent(id)}/rotate-token`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`}});
      const j=await r.json();if(!r.ok)throw new Error(j.error||'Credential rotation failed');
      setComputeNodeToken(j.agentToken);await load();
    }catch(e:any){setError(e.message||'Credential rotation failed')}
    finally{setBusy(false)}
  }
  async function setWorkerState(id:string,state:'online'|'draining'|'offline'){
    setError('');setBusy(true);
    try{
      const sb=requireSupabase();const {data:{session}}=await sb.auth.getSession();
      if(!session)throw new Error('Sign in again');
      const r=await fetch(`/api/admin/workers/${encodeURIComponent(id)}/state`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({state})});
      const j=await r.json();if(!r.ok)throw new Error(j.error||'Worker state update failed');
      await load();
    }catch(e:any){setError(e.message||'Worker state update failed')}
    finally{setBusy(false)}
  }
  async function logout(){await requireSupabase().auth.signOut();setAllowed(false);setNeedsLogin(true);window.location.assign('/admin')}

  if(checking)return <div className="admin-screen"><div className="admin-card">Verifying administrator permissions…</div></div>;
  if(needsLogin)return <div className="admin-screen"><main className="admin-login">
    <div className="admin-brand"><ShieldCheck/> KESTREL <span>/ ADMIN SIGN IN</span></div>
    <div className="admin-kicker">RESTRICTED CONTROL PLANE</div>
    <h1>Administrator sign in</h1>
    <p>Sign in with your Kestrel account. Access is granted only to provisioned platform administrators.</p>
    <form onSubmit={signIn}>
      <label>Work email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="admin@company.com" autoComplete="username" required/></label>
      <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" required/></label>
      {error&&<p className="admin-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy?'Signing in…':'Sign in to admin'} <ArrowRight size={15}/></button>
    </form>
    <small>This is a dedicated sign-in screen, not a separate account system. Your platform-admin role is checked securely by the server after authentication.</small>
    <button className="admin-plain" style={{marginTop:18}} onClick={()=>window.location.assign('/login')}>Return to regular sign in</button>
  </main></div>;
  if(!allowed)return <div className="admin-screen"><div className="admin-login"><div className="admin-brand"><ShieldCheck/> KESTREL <span>/ RESTRICTED</span></div><h1>Access denied</h1><p>{error||'This area is restricted to platform administrators.'}</p><button onClick={()=>window.location.assign('/overview')}>Return to workspace</button></div></div>;

  const metrics=[['Projects',data?.totals.projects,Boxes],['Pipeline runs',data?.totals.runs,Workflow],['Workers',data?.totals.workers,Server],['Compute nodes',computeNodes.length,Cpu],['Jobs',data?.totals.jobs,Activity]] as const;
  return <div className="admin-screen"><header className="admin-top"><div className="admin-brand"><ShieldCheck/> KESTREL <span>/ PRIVATE OPERATIONS</span></div><div><button className="admin-plain" onClick={load} disabled={busy}><RefreshCw size={14}/> Refresh</button><button className="admin-plain" onClick={logout}><LogOut size={14}/> Sign out</button></div></header><main className="admin-main"><div className="admin-heading"><div><div className="admin-kicker">PLATFORM ADMINISTRATION</div><h1>System overview</h1><p>Restricted operational visibility. Authorization is verified by the API on every request.</p></div><span className="admin-private"><ShieldCheck size={14}/> ADMIN ONLY</span></div><section className="admin-metrics">{metrics.map(([label,value,Icon])=><article key={label}><Icon/><span>{label}</span><strong>{value??'—'}</strong></article>)}</section>{error&&<p className="admin-error" role="alert">{error}</p>}<section className="admin-panel admin-recent"><div className="admin-panel-head"><div><h2>Provision a worker</h2><p>Create a scoped one-time credential for a dedicated worker host.</p></div><Server/></div><form onSubmit={provisionWorker} className="admin-worker-form"><label>Workspace<select value={organizationId} onChange={e=>setOrganizationId(e.target.value)} required>{orgs.map(o=><option key={o.id} value={o.id}>{o.name} · {o.id}</option>)}</select></label><label>Worker name<input value={workerName} onChange={e=>setWorkerName(e.target.value)} required/></label><button disabled={busy||!orgs.length}>{busy?'Provisioning…':'Generate worker credential'}</button></form>{workerToken&&<div className="admin-worker-token"><b>Copy this token now — it is shown only once.</b><code>{workerToken}</code><small>Worker ID: {workerId}</small><p>Set KESTREL_WORKER_ID and KESTREL_WORKER_TOKEN on the dedicated worker host.</p></div>}</section><section className="admin-panel admin-recent"><div className="admin-panel-head"><div><h2>Provision a compute node</h2><p>Register a dedicated Incus, Firecracker or KubeVirt provider host. The agent token is shown once.</p></div><Cpu/></div><form onSubmit={provisionComputeNode} className="admin-worker-form"><label>Node ID<input value={computeNodeId} onChange={e=>setComputeNodeId(e.target.value)} pattern="[a-z0-9][a-z0-9-]{0,61}[a-z0-9]" required/></label><label>Provider<select value={computeProvider} onChange={e=>setComputeProvider(e.target.value)}><option value="incus">Incus</option><option value="firecracker">Firecracker</option><option value="kubevirt">KubeVirt</option></select></label><label>Hostname<input value={computeHostname} onChange={e=>setComputeHostname(e.target.value)} required/></label><label>Region<input value={computeRegion} onChange={e=>setComputeRegion(e.target.value)} required/></label><label>Total vCPU<input type="number" min="1" max="4096" value={computeVcpu} onChange={e=>setComputeVcpu(e.target.value)} required/></label><label>Total memory (MiB)<input type="number" min="512" max="4194304" value={computeMemory} onChange={e=>setComputeMemory(e.target.value)} required/></label><label>Total disk (GiB)<input type="number" min="5" max="1048576" value={computeDisk} onChange={e=>setComputeDisk(e.target.value)} required/></label><label>Maximum VMs<input type="number" min="1" max="10000" value={computeMaxInstances} onChange={e=>setComputeMaxInstances(e.target.value)} required/></label><button disabled={busy}>{busy?'Provisioning…':'Register compute node'}</button></form>{computeNodeToken&&<div className="admin-worker-token"><b>Copy this agent token now — it is shown only once.</b><code>{computeNodeToken}</code><p>Put it in /etc/kestrel/compute-agent.env as KESTREL_COMPUTE_NODE_TOKEN on the matching Linux host.</p></div>}</section><section className="admin-panel"><div className="admin-panel-head"><div><h2>Workspace compute quotas</h2><p>Set the maximum VM, CPU, memory and storage allocation for a workspace.</p></div><Cpu/></div><form onSubmit={saveComputeQuota} className="admin-worker-form"><label>Workspace<select value={organizationId} onChange={e=>setOrganizationId(e.target.value)} required>{orgs.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label><label>Maximum VMs<input type="number" min="0" max="10000" value={quotaInstances} onChange={e=>setQuotaInstances(e.target.value)} required/></label><label>Maximum vCPU<input type="number" min="0" max="4096" value={quotaVcpu} onChange={e=>setQuotaVcpu(e.target.value)} required/></label><label>Maximum memory (MiB)<input type="number" min="0" max="4194304" value={quotaMemory} onChange={e=>setQuotaMemory(e.target.value)} required/></label><label>Maximum disk (GiB)<input type="number" min="0" max="1048576" value={quotaDisk} onChange={e=>setQuotaDisk(e.target.value)} required/></label><button disabled={busy||!organizationId}>{busy?'Saving…':'Save compute quota'}</button></form></section><section className="admin-panel"><div className="admin-panel-head"><div><h2>Compute provider fleet</h2><p>Provider host health, capacity reservations and agent credentials.</p></div><Cpu/></div>{computeNodes.length?computeNodes.map(node=><div className="admin-row" key={node.id}><div><b>{node.hostname}</b><small>{node.id} · {node.provider} · {node.region} · {node.allocatedVcpu}/{node.totalVcpu} vCPU · {node.activeInstances} VMs</small><small>{node.allocatedMemoryMib}/{node.totalMemoryMib} MiB · {node.allocatedDiskGib}/{node.totalDiskGib} GiB · Last heartbeat {node.lastSeenAt?new Date(node.lastSeenAt).toLocaleString():'never'}</small></div><span className={`admin-state ${node.state==='online'?'online':''}`}>{node.state}</span><div className="admin-worker-actions">{node.desiredState==='draining'?<button disabled={busy} onClick={()=>setComputeNodeState(node.id,'online')}>Resume</button>:node.desiredState==='offline'?<button disabled={busy} onClick={()=>setComputeNodeState(node.id,'online')}>Enable</button>:<button disabled={busy} onClick={()=>setComputeNodeState(node.id,'draining')}>Drain</button>}<button disabled={busy} onClick={()=>setComputeNodeState(node.id,'offline')}>Disable</button><button disabled={busy} onClick={()=>rotateComputeNodeToken(node.id)}>Rotate token</button></div></div>):<p className="admin-footer">No compute provider nodes have been registered.</p>}</section><section className="admin-panel"><div className="admin-panel-head"><div><h2>Platform health</h2><p>Live operational signals from the control plane.</p></div><Activity/></div><div className="admin-health-grid"><div><small>Database</small><b className={health?.database==='connected'?'online':''}>{health?.database||'Unknown'}</b></div><div><small>Artifact storage</small><b>{health?.artifactStorage||'Unknown'}</b></div><div><small>Scheduler</small><b>{health?.scheduler||'Unknown'}</b></div><div><small>Online workers</small><b>{health?.workers?.online??'—'}</b></div><div><small>Stale workers</small><b>{health?.workers?.stale??'—'}</b></div><div><small>Queued jobs</small><b>{health?.queue?.queued??'—'}</b></div><div><small>Running jobs</small><b>{health?.queue?.running??'—'}</b></div><div><small>Failed jobs</small><b>{health?.queue?.failed??'—'}</b></div></div><div className="admin-footer">Health checked {health?.checkedAt?new Date(health.checkedAt).toLocaleString():'—'}</div></section><section className="admin-columns"><article className="admin-panel"><div className="admin-panel-head"><div><h2>Worker fleet</h2><p>Registered execution nodes.</p></div><Server/></div>{data?.workers.map(w=><div className="admin-row" key={w.id}><div><b>{w.hostname}</b><small>{w.id} · {w.architecture} · {w.region}</small></div><span className={`admin-state ${w.state==='online'||w.state==='busy'?'online':''}`}>{w.state}</span><div className="admin-worker-actions">{w.state==='draining'?<button disabled={busy} onClick={()=>setWorkerState(w.id,'online')}>Resume</button>:w.state==='offline'?<button disabled={busy} onClick={()=>setWorkerState(w.id,'online')}>Enable</button>:<button disabled={busy} onClick={()=>setWorkerState(w.id,'draining')}>Drain</button>}<button disabled={busy||w.state==='offline'} onClick={()=>setWorkerState(w.id,'offline')}>Disable</button></div></div>)}</article><article className="admin-panel"><div className="admin-panel-head"><div><h2>Job status</h2><p>Current execution totals.</p></div><Activity/></div>{Object.entries(data?.jobStatuses||{}).map(([status,count])=><div className="admin-row" key={status}><b>{status}</b><strong>{count}</strong></div>)}</article></section><footer className="admin-footer">Private administrator console · {data?.generatedAt?new Date(data.generatedAt).toLocaleString():'—'}</footer></main></div>
}
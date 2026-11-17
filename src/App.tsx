import Admin from './Admin';
import { requireSupabase } from './lib-supabase';
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Command,
  Cpu,
  GitBranch,
  Github,
  KeyRound,
  Layers3,
  LockKeyhole,
  Menu,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Server,
  ShieldCheck,
  Square,
  TerminalSquare,
  Trash2,
  Webhook,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { LogViewer } from './components/LogViewer';
import { StatusIndicator, formatDuration } from './components/StatusIndicator';
import { JobStep, LogEntry, JobStatus } from './types/pipeline';

type Page =
  | 'home'
  | 'login'
  | 'signup'
  | 'docs'
  | 'pricing'
  | 'admin'
  | 'overview'
  | 'pipelines'
  | 'runs'
  | 'workers'
  | 'projects'
  | 'artifacts'
  | 'settings';

const nav: { id: Page; label: string; icon: any; group: string }[] = [
  { id: 'overview', label: 'Overview', icon: Activity, group: 'WORKSPACE' },
  { id: 'pipelines', label: 'Pipelines', icon: Workflow, group: 'WORKSPACE' },
  { id: 'runs', label: 'Run history', icon: Clock3, group: 'WORKSPACE' },
  { id: 'workers', label: 'Workers', icon: Server, group: 'INFRASTRUCTURE' },
  { id: 'projects', label: 'Projects', icon: Layers3, group: 'INFRASTRUCTURE' },
  { id: 'artifacts', label: 'Artifacts', icon: Boxes, group: 'INFRASTRUCTURE' },
  { id: 'settings', label: 'Settings', icon: Command, group: 'MANAGE' },
];

function go(p: Page) {
  history.pushState({}, '', p === 'home' ? '/' : `/${p}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <button className={`brand ${light ? 'brand-light' : ''}`} onClick={() => go('home')}>
      <span className="brand-mark">
        <span />
      </span>
      <span>
        kestrel<span className="brand-dot">.</span>
      </span>
    </button>
  );
}

function Button({ children, onClick, kind = 'dark', disabled = false, type = 'button' }: any) {
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`btn btn-${kind}`}>
      {children}
    </button>
  );
}

function Landing() {
  return (
    <div className="marketing">
      <header className="marketing-nav wrap">
        <Brand />
        <nav>
          <a href="#platform">Platform</a>
          <a href="#workflow">How it works</a>
          <button onClick={() => go('docs')}>Documentation</button>
          <button onClick={() => go('pricing')}>Pricing</button>
        </nav>
        <div className="nav-actions">
          <button className="login-link" onClick={() => go('login')}>
            Log in
          </button>
          <Button onClick={() => go('signup')}>
            Start building <ArrowUpRight size={15} />
          </Button>
        </div>
      </header>

      <section className="hero wrap">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="live-dot" /> DISTRIBUTED DELIVERY INFRASTRUCTURE
          </div>
          <h1>
            Ship with confidence.
            <br />
            <span>Scale without limits.</span>
          </h1>
          <p className="hero-lead">
            A distributed CI/CD platform that turns every commit into a coordinated build, test and deployment
            pipeline — across the machines you control.
          </p>
          <div className="hero-ctas">
            <Button onClick={() => go('signup')}>
              Get started free <ArrowRight size={16} />
            </Button>
            <button className="text-cta" onClick={() => go('docs')}>
              Read the documentation <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="hero-proof">
            <div className="proof-avatars">
              <i>K</i>
              <i>CI</i>
              <i>+</i>
            </div>
            <span>Built for teams that ship software</span>
            <span className="proof-sep">·</span>
            <span>Self-hosted workers</span>
          </div>
        </div>

        <div className="hero-visual">
          <div className="visual-top">
            <span>
              <i className="live-dot" /> LIVE PIPELINE
            </span>
            <span>run_8f21c6</span>
          </div>
          <div className="visual-title">
            <div>
              <small>storefront / production</small>
              <h3>Deploy pipeline</h3>
            </div>
            <span className="pill pill-green">● Running</span>
          </div>
          <div className="pipeline-track">
            <div className="track-line" />
            <div className="stage done">
              <span>
                <Check />
              </span>
              <b>Checkout</b>
              <small>0.8s</small>
            </div>
            <div className="stage done">
              <span>
                <Check />
              </span>
              <b>Install</b>
              <small>12.4s</small>
            </div>
            <div className="stage active">
              <span>
                <Radio />
              </span>
              <b>Test suite</b>
              <small>Worker 02</small>
            </div>
            <div className="stage waiting">
              <span>4</span>
              <b>Deploy</b>
              <small>Waiting</small>
            </div>
          </div>
          <div className="visual-divider" />
          <div className="worker-strip">
            <div>
              <Server />
              <span>
                <b>worker-eu-02</b>
                <small>Linux · 4 vCPU</small>
              </span>
            </div>
            <div className="worker-state">
              <i className="live-dot" /> EXECUTING
            </div>
          </div>
          <div className="log-lines">
            <p>
              <time>14:32:08</time>
              <span className="log-ok">✓</span> Dependencies installed
            </p>
            <p>
              <time>14:32:11</time>
              <span className="log-ok">✓</span> Type check passed
            </p>
            <p>
              <time>14:32:14</time>
              <span className="log-run">↻</span> Running integration tests...
            </p>
          </div>
          <div className="visual-foot">
            <span>
              CONTROL PLANE <b>CONNECTED</b>
            </span>
            <span>3 WORKERS ONLINE</span>
          </div>
        </div>
      </section>

      <div className="ticker">
        <div className="wrap ticker-inner">
          <span>ONE CONTROL PLANE</span>
          <span>·</span>
          <span>MANY EXECUTION NODES</span>
          <span>·</span>
          <span>YOUR INFRASTRUCTURE</span>
          <span>·</span>
          <span>YOUR DELIVERY PIPELINE</span>
        </div>
      </div>

      <section className="section wrap" id="platform">
        <div className="section-head">
          <div>
            <div className="eyebrow">THE KESTREL PLATFORM</div>
            <h2>
              Everything in the pipeline.
              <br />
              <span>Nothing behind the curtain.</span>
            </h2>
          </div>
          <p>
            One place to orchestrate work. Independent workers to execute it. Full visibility from the first checkout to
            the final deployment.
          </p>
        </div>
        <div className="feature-grid">
          <article className="feature feature-large">
            <div className="feature-icon">
              <Workflow />
            </div>
            <div className="mini-graph">
              <div>
                build <b>✓</b>
              </div>
              <div>
                test <b>↻</b>
              </div>
              <div>
                package <b>·</b>
              </div>
              <div>
                deploy <b>·</b>
              </div>
            </div>
            <h3>Pipeline orchestration</h3>
            <p>Define jobs, dependencies and stages. Kestrel schedules work when its prerequisites are met, not a moment before.</p>
          </article>
          <article className="feature">
            <div className="feature-icon">
              <Server />
            </div>
            <h3>Distributed workers</h3>
            <p>Connect independent execution nodes across machines and environments. Scale capacity without scaling the control plane.</p>
            <div className="feature-metric">
              <b>03</b>
              <span>workers connected</span>
            </div>
          </article>
          <article className="feature">
            <div className="feature-icon">
              <TerminalSquare />
            </div>
            <h3>Live execution logs</h3>
            <p>Follow stdout, stderr, job status and exit codes as work happens on the worker.</p>
            <div className="terminal-mini">
              <span>$ npm run test</span>
              <b>✓ 42 passed</b>
            </div>
          </article>
          <article className="feature">
            <div className="feature-icon">
              <ShieldCheck />
            </div>
            <h3>Operational control</h3>
            <p>Monitor worker health, concurrency and job leases. Keep execution capacity visible and accountable.</p>
          </article>
          <article className="feature">
            <div className="feature-icon">
              <Boxes />
            </div>
            <h3>Build artifacts</h3>
            <p>Keep outputs traceable to the pipeline run that produced them. Build once, promote with confidence.</p>
          </article>
        </div>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="wrap workflow-inner">
          <div>
            <div className="eyebrow">HOW KESTREL WORKS</div>
            <h2>
              One commit.
              <br />
              A coordinated system.
            </h2>
            <p>
              Your control plane coordinates the work. Workers claim eligible jobs, execute commands and report results.
              Dependencies decide what runs next.
            </p>
            <Button onClick={() => go('docs')}>
              Explore the architecture <ArrowRight size={16} />
            </Button>
          </div>
          <div className="flow-steps">
            <div>
              <span>01</span>
              <GitBranch />
              <section>
                <b>Connect a repository</b>
                <small>Register a project and define its pipeline.</small>
              </section>
            </div>
            <div>
              <span>02</span>
              <Workflow />
              <section>
                <b>Schedule the work</b>
                <small>Jobs enter the queue when dependencies allow.</small>
              </section>
            </div>
            <div>
              <span>03</span>
              <Cpu />
              <section>
                <b>Execute across workers</b>
                <small>Available workers claim jobs and stream results.</small>
              </section>
            </div>
            <div>
              <span>04</span>
              <Check />
              <section>
                <b>Review and deploy</b>
                <small>Inspect logs, artifacts and final status.</small>
              </section>
            </div>
          </div>
        </div>
      </section>

      <section className="bottom-cta wrap">
        <div>
          <div className="eyebrow">READY WHEN YOU ARE</div>
          <h2>Your next release starts here.</h2>
          <p>Bring your repository. Connect your workers. Let Kestrel coordinate the rest.</p>
        </div>
        <Button onClick={() => go('signup')}>
          Create your workspace <ArrowUpRight size={16} />
        </Button>
      </section>
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer wrap">
      <Brand />
      <span>© 2026 Kestrel Systems</span>
      <div>
        <button onClick={() => go('docs')}>Documentation</button>
        <button onClick={() => go('pricing')}>Pricing</button>
        <button onClick={() => go('login')}>Sign in</button>
      </div>
    </footer>
  );
}

function Auth({ mode }: { mode: 'login' | 'signup' }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function submit(e: any) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const sb = requireSupabase();
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name } } });
        if (error) throw error;
        if (!data.session) {
          setMessage('Check your email to confirm your account, then sign in.');
          return;
        }
        go('overview');
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        go('overview');
      }
    } catch (e: any) {
      setError(e.message || 'Authentication failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <Brand light />
        <div className="auth-aside-copy">
          <div className="eyebrow">DISTRIBUTED CI/CD, UNDER YOUR CONTROL</div>
          <h1>
            Build systems
            <br />
            that <span>move work<br />forward.</span>
          </h1>
          <p>Coordinate pipelines across independent workers. Keep every build visible, every execution traceable.</p>
        </div>
        <div className="auth-aside-bottom">
          <div className="auth-grid-art">
            <span>CONTROL PLANE</span>
            <ArrowDownRight />
            <span>WORKER NODES</span>
            <div className="art-nodes">
              <i />
              <i />
              <i />
            </div>
          </div>
          <small>KESTREL · DELIVERY INFRASTRUCTURE</small>
        </div>
      </aside>
      <main className="auth-main">
        <button className="back-home" onClick={() => go('home')}>
          ← Back to home
        </button>
        <div className="auth-form-wrap">
          <div className="auth-kicker">{mode === 'login' ? 'WELCOME BACK' : 'GET STARTED'}</div>
          <h2>{mode === 'login' ? 'Sign in to Kestrel' : 'Create your workspace'}</h2>
          <p>{mode === 'login' ? 'Continue to your delivery workspace.' : 'Start orchestrating builds across your infrastructure.'}</p>
          <form onSubmit={submit}>
            {mode === 'signup' && (
              <label>
                Full name
                <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Your name" autoComplete="name" />
              </label>
            )}
            <label>
              Work email
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="you@company.com" autoComplete="email" />
            </label>
            <label>
              Password
              <div className="password-input">
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type={show ? 'text' : 'password'}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                <button type="button" onClick={() => setShow(!show)}>
                  {show ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
            {mode === 'signup' && (
              <label className="checkline">
                <input type="checkbox" required /> I agree to the terms and privacy policy.
              </label>
            )}
            {error && <div className="notice text-red-600">{error}</div>}
            {message && <div className="notice text-green-600">{message}</div>}
            <button disabled={busy} className="btn btn-dark auth-submit">
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={16} />
            </button>
          </form>
          <div className="auth-switch">
            {mode === 'login' ? (
              <>
                New to Kestrel? <button onClick={() => go('signup')}>Create an account</button>
              </>
            ) : (
              <>
                Already have an account? <button onClick={() => go('login')}>Sign in</button>
              </>
            )}
          </div>
          <div className="auth-security">
            <LockKeyhole size={14} /> Authentication powered by Supabase Auth
          </div>
        </div>
        <div className="auth-copyright">
          © 2026 Kestrel Systems <span>·</span> <button onClick={() => go('docs')}>Help centre</button>
        </div>
      </main>
    </div>
  );
}

function AppShell({ page }: { page: Page }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const api = (import.meta.env.VITE_API_BASE_URL as string) || '/api';
  const [accessToken, setAccessToken] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [health, setHealth] = useState('Checking...');
  const [snapshot, setSnapshot] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Project registration state
  const [projectName, setProjectName] = useState('');
  const [projectRepo, setProjectRepo] = useState('');
  const [projectBranch, setProjectBranch] = useState('main');
  const [actionMessage, setActionMessage] = useState('');

  // Run creation state
  const [selectedProject, setSelectedProject] = useState('');
  const [branch, setBranch] = useState('main');
  const [commitMessage, setCommitMessage] = useState('Manual pipeline run');

  // Inspection states
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobStep | undefined>(undefined);
  const [selectedProjectForSecrets, setSelectedProjectForSecrets] = useState<string | null>(null);
  const [projectSecrets, setProjectSecrets] = useState<{ id: string; name: string; createdAt: string }[]>([]);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [webhookConfig, setWebhookConfig] = useState<{ webhookSecret: string; events: string[] } | null>(null);

  const active = nav.find((n) => n.id === page) || nav[0];

  async function connect() {
    setLoading(true);
    try {
      const sb = requireSupabase();
      const {
        data: { session },
      } = await sb.auth.getSession();
      if (!session) {
        go('login');
        throw new Error('Please sign in first');
      }
      setAccessToken(session.access_token);

      let ws = await fetch(`${api}/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!ws.ok) throw new Error('Could not load workspaces');
      let list = await ws.json();

      if (!list.length) {
        const created = await fetch(`${api}/workspaces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ name: 'Personal Workspace' }),
        });
        if (!created.ok) throw new Error('Could not create your workspace');
        const item = await created.json();
        list = [item];
      }

      const org = list[0].id;
      setOrganizationId(org);

      const s = await fetch(`${api}/snapshot?organizationId=${org}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!s.ok) throw new Error('Could not load workspace data');
      const snapData = await s.json();
      setSnapshot(snapData);
      setHealth('Connected');

      // Update selected project default
      if (snapData.projects?.length && !selectedProject) {
        setSelectedProject(snapData.projects[0].id);
      }
    } catch (e: any) {
      setHealth(e.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    connect();
  }, []);

  // Periodic polling for active runs
  useEffect(() => {
    if (!accessToken || !organizationId) return;
    const interval = setInterval(async () => {
      try {
        const s = await fetch(`${api}/snapshot?organizationId=${organizationId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (s.ok) {
          const snapData = await s.json();
          setSnapshot(snapData);
        }
      } catch {}
    }, 4000);
    return () => clearInterval(interval);
  }, [accessToken, organizationId, api]);

  // Fetch job logs whenever a job is selected
  useEffect(() => {
    if (!selectedJob?.id || !accessToken) return;

    let isSubscribed = true;
    const fetchLogs = async () => {
      try {
        const res = await fetch(`${api}/jobs/${selectedJob.id}/logs`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok && isSubscribed) {
          const data = await res.json();
          setSelectedJob((prev) => (prev ? { ...prev, logs: data.logs || [] } : undefined));
        }
      } catch {}
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 1500);
    return () => {
      isSubscribed = false;
      clearInterval(interval);
    };
  }, [selectedJob?.id, accessToken, api]);

  // Fetch Project Secrets & Webhook
  async function openProjectSettings(projectId: string) {
    setSelectedProjectForSecrets(projectId);
    try {
      const [secRes, hookRes] = await Promise.all([
        fetch(`${api}/projects/${projectId}/secrets`, { headers: { Authorization: `Bearer ${accessToken}` } }),
        fetch(`${api}/projects/${projectId}/webhook-config`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      ]);
      if (secRes.ok) setProjectSecrets(await secRes.json());
      if (hookRes.ok) setWebhookConfig(await hookRes.json());
    } catch {}
  }

  async function saveSecret(e: any) {
    e.preventDefault();
    if (!selectedProjectForSecrets || !newSecretName || !newSecretValue) return;
    try {
      const res = await fetch(`${api}/projects/${selectedProjectForSecrets}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: newSecretName, value: newSecretValue }),
      });
      if (res.ok) {
        setNewSecretName('');
        setNewSecretValue('');
        openProjectSettings(selectedProjectForSecrets);
      }
    } catch {}
  }

  async function deleteSecret(name: string) {
    if (!selectedProjectForSecrets) return;
    try {
      await fetch(`${api}/projects/${selectedProjectForSecrets}/secrets/${name}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      openProjectSettings(selectedProjectForSecrets);
    } catch {}
  }

  async function registerProject(e: any) {
    e.preventDefault();
    setActionMessage('');
    try {
      const res = await fetch(`${api}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          organizationId,
          name: projectName,
          repo: projectRepo,
          defaultBranch: projectBranch,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not register project');
      setProjectName('');
      setProjectRepo('');
      setActionMessage('Project registered successfully.');
      await connect();
    } catch (err: any) {
      setActionMessage(err.message || 'Project registration failed');
    }
  }

  async function triggerRun(e: any) {
    e.preventDefault();
    setActionMessage('');
    try {
      const pId = selectedProject || snapshot?.projects?.[0]?.id;
      if (!pId) throw new Error('No project selected');

      const res = await fetch(`${api}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          projectId: pId,
          branch,
          commitMessage,
          jobs: [
            { id: 'install', name: 'Install dependencies', stage: 'build', command: 'npm ci' },
            { id: 'test', name: 'Run test suite', stage: 'test', command: 'npm test', needs: ['install'] },
            { id: 'build', name: 'Build production bundle', stage: 'package', command: 'npm run build', needs: ['test'] },
          ],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not trigger run');
      setActionMessage(`Pipeline run #${data.run_number} queued successfully.`);
      setInspectedRunId(data.id);
      await connect();
    } catch (err: any) {
      setActionMessage(err.message || 'Pipeline trigger failed');
    }
  }

  async function triggerDemoRun() {
    setActionMessage('');
    try {
      let pId = snapshot?.projects?.[0]?.id;
      if (!pId) {
        const createdProj = await fetch(`${api}/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            organizationId,
            name: 'kestrel-demo',
            repo: 'https://github.com/peterakinwale326-code/Kestrel.git',
            defaultBranch: 'main',
          }),
        });
        const projData = await createdProj.json();
        pId = projData.id;
      }

      const res = await fetch(`${api}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          projectId: pId,
          branch: 'main',
          commitMessage: 'Demo execution: standalone verification',
          jobs: [
            { id: 'check-runtime', name: 'Verify Environment', stage: 'checks', command: 'node -v && echo "Kestrel execution engine online."' },
            { id: 'run-tests', name: 'Test Execution', stage: 'test', command: 'node -e "console.log(\'Running unit tests... All 22 tests passed.\')"', needs: ['check-runtime'] },
            { id: 'package-bundle', name: 'Build Distribution', stage: 'package', command: 'node -e "console.log(\'Compiling output artifacts into dist/... Done!\')"', needs: ['run-tests'] },
          ],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to queue demo run');
      setActionMessage(`Demo run #${data.run_number} queued! Selected for live inspection.`);
      setInspectedRunId(data.id);
      await connect();
    } catch (e: any) {
      setActionMessage(e.message || 'Demo trigger failed');
    }
  }

  async function cancelRun(runId: string) {
    try {
      await fetch(`${api}/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      connect();
    } catch {}
  }

  async function retryRun(runId: string) {
    try {
      await fetch(`${api}/runs/${runId}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      connect();
    } catch {}
  }

  const counts = useMemo(
    () => ({
      projects: snapshot?.projects?.length ?? 0,
      runs: snapshot?.runs?.length ?? 0,
      workers: snapshot?.workers?.length ?? 0,
      artifacts: snapshot?.artifacts?.length ?? 0,
    }),
    [snapshot]
  );

  const inspectedRun = useMemo(() => {
    if (!inspectedRunId || !snapshot?.runs) return null;
    return snapshot.runs.find((r: any) => r.id === inspectedRunId) || null;
  }, [inspectedRunId, snapshot]);

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className={`app-sidebar ${collapsed ? 'collapsed' : ''} ${mobile ? 'mobile-open' : ''}`}>
        <div className="app-brand-row">
          <Brand />
          <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)}>
            <Menu size={16} />
          </button>
        </div>
        <div className="workspace-switch">
          <div className="workspace-avatar">K</div>
          <span>
            <b>Workspace</b>
            <small>Kestrel CI</small>
          </span>
          <ChevronDown size={14} />
        </div>
        {['WORKSPACE', 'INFRASTRUCTURE', 'MANAGE'].map((group) => (
          <div className="nav-group" key={group}>
            <small>{group}</small>
            {nav
              .filter((n) => n.group === group)
              .map((n) => (
                <button
                  key={n.id}
                  className={`side-link ${page === n.id ? 'selected' : ''}`}
                  onClick={() => {
                    setInspectedRunId(null);
                    go(n.id);
                  }}
                >
                  <n.icon size={17} />
                  <span>{n.label}</span>
                </button>
              ))}
          </div>
        ))}
        <div className="sidebar-bottom">
          <div className="plan-card">
            <Zap size={15} />
            <b>Build capacity</b>
            <p>Connect workers to increase parallel execution.</p>
            <button onClick={() => go('pricing')}>
              View plans <ArrowRight size={13} />
            </button>
          </div>
          <div className="profile-row">
            <div className="profile-avatar">P</div>
            <span>
              <b>Workspace Owner</b>
              <small>Administrator</small>
            </span>
            <ChevronDown size={14} />
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="app-main">
        <header className="app-topbar">
          <button className="mobile-menu" onClick={() => setMobile(!mobile)}>
            <Menu />
          </button>
          <div className="breadcrumbs">
            Workspace <span>/</span> <b>{active.label}</b>
          </div>
          <div className="top-actions">
            <span className={`connection ${health === 'Connected' ? 'connected' : ''}`}>
              <i /> {health}
            </span>
            <button className="icon-btn" title="Help" onClick={() => go('docs')}>
              <CircleHelp size={17} />
            </button>
            <div className="profile-avatar small">P</div>
          </div>
        </header>

        {/* OVERVIEW */}
        {page === 'overview' && !inspectedRun && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">WORKSPACE / OVERVIEW</div>
                <h1>Delivery overview</h1>
                <p>Your distributed build system at a glance.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={triggerDemoRun} kind="light">
                  <Zap size={14} /> Quick Demo Run
                </Button>
                <Button onClick={() => go('pipelines')}>
                  <Play size={14} /> Trigger pipeline
                </Button>
              </div>
            </div>
            <div className="metric-grid">
              {[
                { label: 'Projects', value: counts.projects, icon: Layers3, sub: 'Connected repos' },
                { label: 'Pipeline runs', value: counts.runs, icon: Workflow, sub: 'Recorded runs' },
                { label: 'Active workers', value: counts.workers, icon: Server, sub: 'Execution nodes' },
                { label: 'Artifacts', value: counts.artifacts, icon: Boxes, sub: 'Build outputs' },
              ].map((m) => (
                <div className="metric-card" key={m.label}>
                  <div>
                    <span>{m.label}</span>
                    <m.icon size={17} />
                  </div>
                  <strong>{m.value.toString().padStart(2, '0')}</strong>
                  <small>{m.sub}</small>
                </div>
              ))}
            </div>
            <div className="dashboard-grid">
              <section className="panel recent-panel">
                <div className="panel-head">
                  <div>
                    <h3>Recent pipeline runs</h3>
                    <p>Click any execution to inspect job logs</p>
                  </div>
                  <button onClick={() => go('runs')}>
                    View all history <ArrowUpRight size={14} />
                  </button>
                </div>
                {snapshot?.runs?.length ? (
                  snapshot.runs.slice(0, 6).map((r: any) => (
                    <div
                      className="table-row cursor-pointer hover:bg-neutral-50 transition"
                      key={r.id}
                      onClick={() => setInspectedRunId(r.id)}
                    >
                      <StatusIndicator status={r.status as JobStatus} />
                      <div className="flex-1">
                        <b>{r.commitMessage || r.id}</b>
                        <small>
                          {r.branch} · {r.id.slice(0, 8)}
                        </small>
                      </div>
                      <span className="row-meta">{r.jobs?.length || 0} jobs</span>
                      <span className="text-xs text-neutral-500 font-mono">
                        {new Date(r.triggeredAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon={Workflow}
                    title="No pipeline runs yet"
                    desc="Connect a project and trigger your first distributed pipeline."
                    action="Go to pipelines"
                    onClick={() => go('pipelines')}
                  />
                )}
              </section>

              <section className="panel system-panel">
                <div className="panel-head">
                  <div>
                    <h3>System health</h3>
                    <p>Control plane status</p>
                  </div>
                  <span className={`pill ${health === 'Connected' ? 'pill-green' : 'pill-muted'}`}>{health}</span>
                </div>
                <div className="system-status">
                  <div>
                    <span>API endpoint</span>
                    <b>{api}</b>
                  </div>
                  <div>
                    <span>Workers</span>
                    <b>{counts.workers} registered</b>
                  </div>
                  <div>
                    <span>Isolation</span>
                    <b>Linux containers / Non-root</b>
                  </div>
                </div>
                <button className="outline-wide" onClick={connect}>
                  {loading ? 'Refreshing…' : 'Refresh workspace'} <ArrowRight size={14} />
                </button>
              </section>
            </div>
          </>
        )}

        {/* PIPELINES */}
        {page === 'pipelines' && !inspectedRun && (
          <div className="page-content">
            <div className="page-heading">
              <div>
                <div className="eyebrow">WORKSPACE / PIPELINES</div>
                <h1>Pipeline trigger</h1>
                <p>Submit jobs with dependency relationships to execution nodes.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={triggerDemoRun} kind="light">
                  <Zap size={14} /> Quick Demo Run
                </Button>
                <Button onClick={() => go('projects')}>
                  <Plus size={15} /> Add repository
                </Button>
              </div>
            </div>
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>Queue pipeline execution</h3>
                  <p>Jobs will be claimed atomically by provisioned workers.</p>
                </div>
                <span className="pill pill-muted">{counts.projects} projects</span>
              </div>
              {snapshot?.projects?.length ? (
                <form className="pipeline-form" onSubmit={triggerRun}>
                  <label>
                    Project
                    <select
                      required
                      value={selectedProject || snapshot.projects[0].id}
                      onChange={(e) => setSelectedProject(e.target.value)}
                    >
                      {snapshot.projects.map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.defaultBranch})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Branch
                    <input value={branch} onChange={(e) => setBranch(e.target.value)} required />
                  </label>
                  <label>
                    Commit message / description
                    <input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} required />
                  </label>
                  <div className="job-preview">
                    <b>DAG Pipeline Stages:</b>
                    <span>01 · npm ci (Install)</span>
                    <span>02 · npm test (Test suite, depends on Install)</span>
                    <span>03 · npm run build (Bundle & Artifacts, depends on Test)</span>
                  </div>
                  <Button type="submit">
                    Queue pipeline run <Play size={14} />
                  </Button>
                </form>
              ) : (
                <Empty
                  icon={Workflow}
                  title="No projects registered"
                  desc="Register a repository first to make it available for execution."
                  action="Manage projects"
                  onClick={() => go('projects')}
                />
              )}
            </div>
            {actionMessage && <div className="action-message mt-4">{actionMessage}</div>}
          </div>
        )}

        {/* RUN HISTORY & RUN INSPECTION */}
        {(page === 'runs' || inspectedRun) && (
          <div className="page-content">
            {inspectedRun ? (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <button
                      className="text-xs text-neutral-500 hover:text-neutral-900 mb-2 inline-flex items-center gap-1 font-medium"
                      onClick={() => {
                        setInspectedRunId(null);
                        setSelectedJob(undefined);
                      }}
                    >
                      ← Back to runs list
                    </button>
                    <h1 className="text-xl font-bold flex items-center gap-3">
                      Run #{inspectedRun.runNumber} · {inspectedRun.commitMessage}
                      <StatusIndicator status={inspectedRun.status as JobStatus} />
                    </h1>
                    <p className="text-xs text-neutral-500 mt-1">
                      Branch: <span className="font-mono">{inspectedRun.branch}</span> · Triggered:{' '}
                      {new Date(inspectedRun.triggeredAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {inspectedRun.status === 'running' || inspectedRun.status === 'queued' ? (
                      <Button kind="light" onClick={() => cancelRun(inspectedRun.id)}>
                        <Square size={13} className="text-red-600" /> Cancel run
                      </Button>
                    ) : (
                      <Button kind="light" onClick={() => retryRun(inspectedRun.id)}>
                        <RotateCcw size={13} /> Retry run
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Job List */}
                  <div className="panel col-span-1">
                    <div className="panel-head border-b pb-3 mb-3">
                      <h3>Pipeline Jobs ({inspectedRun.jobs?.length || 0})</h3>
                      <small>Select job for live logs</small>
                    </div>
                    <div className="space-y-2">
                      {inspectedRun.jobs?.map((j: any) => {
                        const isSelected = selectedJob?.id === (j.internalId || j.id);
                        return (
                          <div
                            key={j.id}
                            onClick={() =>
                              setSelectedJob({
                                id: j.internalId || j.id,
                                name: j.name,
                                stage: j.stage,
                                command: j.command || '',
                                needs: j.needs || [],
                                status: j.status,
                                durationMs: j.durationMs || 0,
                                workerId: j.workerId || 'Pending',
                                arch: 'linux/amd64',
                                cacheDigest: '',
                                cacheHit: false,
                                exitCode: j.exitCode,
                                memoryLimitMb: 2048,
                                cpuMillicores: 1000,
                                logs: [],
                              })
                            }
                            className={`p-3 rounded-lg border cursor-pointer transition flex items-center justify-between ${
                              isSelected
                                ? 'border-neutral-900 bg-neutral-50 font-semibold'
                                : 'border-neutral-200 hover:border-neutral-400'
                            }`}
                          >
                            <div>
                              <div className="text-xs font-mono">{j.name}</div>
                              <div className="text-[10px] text-neutral-500 uppercase tracking-wide">
                                Stage: {j.stage}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-neutral-400 font-mono">
                                {formatDuration(j.durationMs)}
                              </span>
                              <StatusIndicator status={j.status as JobStatus} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Log Viewer Panel */}
                  <div className="col-span-2 min-h-[500px]">
                    <LogViewer
                      job={selectedJob}
                      onCancelJob={(jobId) => {
                        fetch(`${api}/jobs/${jobId}/cancel`, {
                          method: 'POST',
                          headers: { Authorization: `Bearer ${accessToken}` },
                        }).then(() => connect());
                      }}
                      onRerunJob={() => retryRun(inspectedRun.id)}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <PageHeading
                  eyebrow="WORKSPACE / RUN HISTORY"
                  title="Run history"
                  desc="Traceable records of pipeline executions, statuses and step outputs."
                />
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h3>Recorded Executions</h3>
                      <p>Select any run to inspect sandboxed execution and live logs.</p>
                    </div>
                    <Button kind="light" onClick={connect}>
                      Refresh <Activity size={14} />
                    </Button>
                  </div>
                  {snapshot?.runs?.length ? (
                    snapshot.runs.map((r: any) => (
                      <div
                        className="table-row cursor-pointer hover:bg-neutral-50 transition"
                        key={r.id}
                        onClick={() => setInspectedRunId(r.id)}
                      >
                        <StatusIndicator status={r.status as JobStatus} />
                        <div className="flex-1">
                          <b>
                            #{r.runNumber} · {r.commitMessage || 'Manual run'}
                          </b>
                          <small>
                            {r.branch} {r.commitSha ? `(${r.commitSha.slice(0, 7)})` : ''} · {r.id.slice(0, 8)}
                          </small>
                        </div>
                        <span className="row-meta">{r.jobs?.length || 0} jobs</span>
                        <span className="text-xs text-neutral-500 font-mono">
                          {new Date(r.triggeredAt).toLocaleString()}
                        </span>
                      </div>
                    ))
                  ) : (
                    <Empty
                      icon={Clock3}
                      title="No runs recorded"
                      desc="Pipeline runs will appear here after a project is registered and triggered."
                      action="Go to pipelines"
                      onClick={() => go('pipelines')}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* PROJECTS */}
        {page === 'projects' && !inspectedRun && (
          <div className="page-content">
            <PageHeading
              eyebrow="INFRASTRUCTURE / PROJECTS"
              title="Projects & Repositories"
              desc="Manage registered Git repositories, encrypted secrets, and GitHub webhooks."
            />
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>Register a repository</h3>
                  <p>Add a credential-free HTTPS Git URL on an approved host.</p>
                </div>
              </div>
              <form className="project-form" onSubmit={registerProject}>
                <label>
                  Project name
                  <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="kestrel-app"
                    required
                  />
                </label>
                <label>
                  Repository URL
                  <input
                    value={projectRepo}
                    onChange={(e) => setProjectRepo(e.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    required
                  />
                </label>
                <label>
                  Default branch
                  <input
                    value={projectBranch}
                    onChange={(e) => setProjectBranch(e.target.value)}
                    placeholder="main"
                    required
                  />
                </label>
                <Button type="submit">
                  Register project <Plus size={14} />
                </Button>
              </form>
            </div>
            {actionMessage && <div className="action-message mt-4">{actionMessage}</div>}

            <div className="panel mt-6">
              <div className="panel-head">
                <div>
                  <h3>Connected Projects</h3>
                  <p>Click "Settings & Secrets" to manage encrypted environment variables and webhooks.</p>
                </div>
              </div>
              {snapshot?.projects?.length ? (
                snapshot.projects.map((p: any) => (
                  <div className="table-row justify-between" key={p.id}>
                    <div className="flex items-center gap-3">
                      <Github size={18} />
                      <div>
                        <b>{p.name}</b>
                        <small>
                          {p.repo} · {p.defaultBranch}
                        </small>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button kind="light" onClick={() => openProjectSettings(p.id)}>
                        <KeyRound size={13} /> Secrets & Webhook
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <Empty
                  icon={Github}
                  title="No projects registered"
                  desc="Register a repository above to enable pipeline triggers."
                />
              )}
            </div>

            {/* Project Secrets & Webhook Modal */}
            {selectedProjectForSecrets && (
              <div className="panel mt-6 border-2 border-neutral-900">
                <div className="panel-head justify-between">
                  <div>
                    <h3>Project Security & Webhooks</h3>
                    <p>AES-256-GCM encrypted secrets are injected into worker sandboxes at runtime.</p>
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      setSelectedProjectForSecrets(null);
                      setWebhookConfig(null);
                    }}
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* GitHub Webhook Info */}
                {webhookConfig && (
                  <div className="bg-neutral-50 p-4 rounded-lg mb-6 border">
                    <div className="flex items-center gap-2 font-semibold text-xs mb-1">
                      <Webhook size={14} /> GitHub Webhook Configuration
                    </div>
                    <p className="text-xs text-neutral-600 mb-2">
                      In your GitHub repository settings &gt; Webhooks, add this endpoint to trigger runs on push:
                    </p>
                    <div className="text-xs font-mono bg-white p-2 border rounded select-all mb-2">
                      Payload URL: {window.location.origin}/api/webhooks/github
                    </div>
                    <div className="text-xs font-mono bg-white p-2 border rounded select-all">
                      Secret: {webhookConfig.webhookSecret}
                    </div>
                  </div>
                )}

                {/* Secrets list */}
                <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-500 mb-2">
                  Configured Secrets ({projectSecrets.length})
                </h4>
                {projectSecrets.length ? (
                  <div className="space-y-2 mb-6">
                    {projectSecrets.map((s) => (
                      <div key={s.id} className="flex items-center justify-between p-2 bg-neutral-50 border rounded text-xs font-mono">
                        <span className="font-bold">{s.name}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-neutral-400">••••••••••••••••</span>
                          <button
                            onClick={() => deleteSecret(s.name)}
                            className="text-red-600 hover:text-red-800"
                            title="Delete secret"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-neutral-500 mb-4">No secrets defined yet.</p>
                )}

                {/* Add secret form */}
                <form onSubmit={saveSecret} className="flex flex-wrap gap-2 items-end">
                  <label className="text-xs">
                    Secret Name
                    <input
                      placeholder="NPM_TOKEN"
                      value={newSecretName}
                      onChange={(e) => setNewSecretName(e.target.value.toUpperCase())}
                      className="text-xs font-mono"
                      required
                    />
                  </label>
                  <label className="text-xs flex-1">
                    Secret Value
                    <input
                      type="password"
                      placeholder="Secret token or key"
                      value={newSecretValue}
                      onChange={(e) => setNewSecretValue(e.target.value)}
                      className="text-xs"
                      required
                    />
                  </label>
                  <Button type="submit">Add Secret</Button>
                </form>
              </div>
            )}
          </div>
        )}

        {/* WORKERS */}
        {page === 'workers' && !inspectedRun && (
          <div className="page-content">
            <PageHeading
              eyebrow="INFRASTRUCTURE / WORKERS"
              title="Execution Fleet"
              desc="Provisioned worker hosts running Docker sandboxes."
            />
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>Worker Nodes</h3>
                  <p>Heartbeats, concurrency caps, and live status.</p>
                </div>
                <Button kind="light" onClick={connect}>
                  Refresh <Activity size={14} />
                </Button>
              </div>
              {snapshot?.workers?.length ? (
                snapshot.workers.map((w: any) => (
                  <div className="table-row" key={w.id}>
                    <Server size={18} />
                    <div className="flex-1">
                      <b>{w.hostname}</b>
                      <small>
                        ID: {w.id} · Arch: {w.arch} · Region: {w.region}
                      </small>
                    </div>
                    <span className="row-meta font-mono text-xs">{w.maxConcurrency} slots</span>
                    <span
                      className={`pill ${
                        w.state === 'online' || w.state === 'busy' ? 'pill-green' : 'pill-muted'
                      }`}
                    >
                      {w.state}
                    </span>
                  </div>
                ))
              ) : (
                <Empty
                  icon={Server}
                  title="No workers connected"
                  desc="Start a Kestrel worker agent on a dedicated Linux machine with Docker installed."
                  action="Read worker setup"
                  onClick={() => go('docs')}
                />
              )}
            </div>
            <div className="panel info-panel mt-6">
              <b>Worker Agent Start Command</b>
              <code>node worker/agent.mjs</code>
              <small>
                Set KESTREL_API_URL, KESTREL_WORKER_ID, and KESTREL_WORKER_TOKEN in your worker environment.
              </small>
            </div>
          </div>
        )}

        {/* ARTIFACTS */}
        {page === 'artifacts' && !inspectedRun && (
          <div className="page-content">
            <PageHeading
              eyebrow="INFRASTRUCTURE / ARTIFACTS"
              title="Build Artifacts"
              desc="Compiled binaries, packages and reports collected from completed jobs."
            />
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>Stored Build Outputs</h3>
                  <p>Artifacts are tied directly to the pipeline run that generated them.</p>
                </div>
              </div>
              {snapshot?.artifacts?.length ? (
                snapshot.artifacts.map((a: any) => (
                  <div className="table-row" key={a.id}>
                    <Boxes size={18} />
                    <div className="flex-1">
                      <b>{a.name || a.id}</b>
                      <small>
                        Key: {a.objectKey} · Size: {(a.sizeBytes / 1024).toFixed(1)} KB · Content:{' '}
                        {a.contentType || 'application/octet-stream'}
                      </small>
                    </div>
                    <span className="text-xs text-neutral-400 font-mono">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))
              ) : (
                <Empty
                  icon={Boxes}
                  title="No artifacts collected"
                  desc="Artifacts produced in dist/ or build/ directories will appear here when completed."
                />
              )}
            </div>
          </div>
        )}

        {/* SETTINGS */}
        {page === 'settings' && !inspectedRun && (
          <div className="page-content">
            <PageHeading
              eyebrow="MANAGE / SETTINGS"
              title="Workspace Settings"
              desc="Connection parameters and platform authentication details."
            />
            <div className="panel settings-panel">
              <h3>Connection Status</h3>
              <p>Authentication is handled via Supabase Auth tokens; worker communication is signed.</p>
              <div className="system-status">
                <div>
                  <span>Control Plane API</span>
                  <b>{api}</b>
                </div>
                <div>
                  <span>Active Workspace UUID</span>
                  <b>{organizationId || 'Not connected'}</b>
                </div>
                <div>
                  <span>Tenant Isolation</span>
                  <b>Enforced via Postgres RLS &amp; JWT</b>
                </div>
              </div>
              <Button onClick={connect}>
                {loading ? 'Reconnecting…' : 'Verify connection'} <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function PageHeading({ eyebrow, title, desc }: any) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{desc}</p>
      </div>
    </div>
  );
}

function Empty({ icon: Icon, title, desc, action, onClick }: any) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={21} />
      </div>
      <b>{title}</b>
      <p>{desc}</p>
      {action && (
        <button onClick={onClick}>
          {action} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

function InfoPage({ page }: { page: 'docs' | 'pricing' }) {
  return (
    <div className="marketing">
      <header className="marketing-nav wrap">
        <Brand />
        <nav>
          <button onClick={() => go('home')}>Platform</button>
          <button onClick={() => go('docs')}>Documentation</button>
          <button onClick={() => go('pricing')}>Pricing</button>
        </nav>
        <div className="nav-actions">
          <button className="login-link" onClick={() => go('login')}>
            Log in
          </button>
          <Button onClick={() => go('signup')}>
            Get started <ArrowRight size={15} />
          </Button>
        </div>
      </header>
      <section className="info-hero wrap">
        <div className="eyebrow">KESTREL / {page.toUpperCase()}</div>
        <h1>{page === 'docs' ? 'Understand the system.' : 'Start small. Scale your workers.'}</h1>
        <p>
          {page === 'docs'
            ? 'A complete guide to connecting repositories, configuring the control plane, running isolated workers, and setting up webhooks.'
            : 'Build with your own control plane and add execution capacity across your own machines as workloads grow.'}
        </p>
      </section>
      <section className="info-cards wrap">
        {(page === 'docs'
          ? [
              ['01', 'Control plane', 'Deploy the Express API to Vercel or Node.js with Supabase PostgreSQL.'],
              ['02', 'Connect workers', 'Run worker/agent.mjs on Linux with Docker socket access and worker token.'],
              ['03', 'Register projects', 'Add Git repo, configure AES-256 secrets, and enable signed GitHub webhooks.'],
              ['04', 'Pipeline execution', 'Define DAG job dependencies and watch streaming logs in real time.'],
            ]
          : [
              ['COMMUNITY', 'Local development', 'Run Kestrel locally and evaluate the containerized workflow.'],
              ['SELF-HOSTED', 'Your infrastructure', 'Run the control plane and workers on machines you manage.'],
              ['ENTERPRISE', 'Scale execution', 'Add worker fleets horizontally with zero lock-in.'],
            ]
        ).map((x) => (
          <article className="info-card" key={x[0]}>
            <small>{x[0]}</small>
            <h3>{x[1]}</h3>
            <p>{x[2]}</p>
          </article>
        ))}
      </section>
      <Footer />
    </div>
  );
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const f = () => setPath(window.location.pathname);
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, []);

  const page = (path.replace(/^\//, '') || 'home') as Page;
  if (page === 'admin') return <Admin />;
  if (page === 'home') return <Landing />;
  if (page === 'login' || page === 'signup') return <Auth mode={page} />;
  if (page === 'docs' || page === 'pricing') return <InfoPage page={page} />;
  if (nav.some((n) => n.id === page)) return <AppShell page={page} />;
  return <Landing />;
}

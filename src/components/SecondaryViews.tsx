import { Trash2 } from 'lucide-react';
import {
  CacheArtifact,
  PipelineProject,
  PipelineRun,
  WorkerNode,
} from '../types/pipeline';
import { formatDuration, StatusIndicator } from './StatusIndicator';

interface RunHistoryViewProps {
  runs: PipelineRun[];
  projects: PipelineProject[];
  onInspectRun: (runId: string, projectId: string) => void;
}

export function RunHistoryView({
  runs,
  projects,
  onInspectRun,
}: RunHistoryViewProps) {
  const projectMap = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <section className="border border-[#E5E5E0] bg-white rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E5E5E0] flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#141413]">
            Pipeline Run History
          </h2>
          <p className="text-xs text-[#6B6B66] mt-0.5">
            Select any execution to inspect step statuses and sandboxed logs.
          </p>
        </div>
        <span className="text-xs text-[#6B6B66] font-mono tabular-nums whitespace-nowrap shrink-0">
          {runs.length} runs recorded
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#E5E5E0] bg-[#FAFAFA] text-[11px] font-medium text-[#6B6B66]">
              <th className="py-2.5 px-4">Run</th>
              <th className="py-2.5 px-4">Repository</th>
              <th className="py-2.5 px-4">Branch &amp; Commit</th>
              <th className="py-2.5 px-4">Status</th>
              <th className="py-2.5 px-4 text-right">Duration</th>
              <th className="py-2.5 px-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0] text-sm">
            {runs.map((run) => {
              const hasFailure = run.jobs.some((j) => j.status === 'failed');
              const hasRunning = run.jobs.some((j) => j.status === 'running');
              const overallStatus = hasFailure
                ? 'failed'
                : hasRunning
                ? 'running'
                : 'succeeded';
              const totalMs = run.jobs.reduce((acc, j) => acc + j.durationMs, 0);

              return (
                <tr
                  key={run.id}
                  className="hover:bg-[#FAFAFA] transition-colors"
                >
                  <td className="py-3 px-4 font-mono text-xs font-semibold text-[#141413] tabular-nums whitespace-nowrap">
                    #{run.runNumber}
                  </td>
                  <td className="py-3 px-4 text-xs font-medium text-[#141413] whitespace-nowrap">
                    {projectMap.get(run.projectId) ?? run.projectId}
                  </td>
                  <td className="py-3 px-4 min-w-[220px]">
                    <div className="text-xs text-[#141413] truncate max-w-md">
                      {run.commitMessage}
                    </div>
                    <div className="text-[11px] text-[#6B6B66] mt-0.5">
                      <span className="font-mono">{run.branch}</span>
                      <span aria-hidden="true"> · </span>
                      <span className="font-mono">{run.commitSha}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{run.author}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <StatusIndicator status={overallStatus} />
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-xs text-[#52524D] tabular-nums whitespace-nowrap">
                    {formatDuration(totalMs)}
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onInspectRun(run.id, run.projectId)}
                      className="px-3 py-1.5 text-xs font-medium text-[#141413] bg-white border border-[#E5E5E0] rounded-md hover:bg-[#F6F6F4] transition-colors whitespace-nowrap shrink-0"
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface ArtifactCacheViewProps {
  artifacts: CacheArtifact[];
  onEvictArtifact: (digest: string) => void;
}

export function ArtifactCacheView({
  artifacts,
  onEvictArtifact,
}: ArtifactCacheViewProps) {
  const totalSizeMb = artifacts.reduce((acc, a) => acc + a.sizeMb, 0);

  return (
    <section className="border border-[#E5E5E0] bg-white rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E5E5E0] flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#141413]">
            Content-Addressable Artifact Cache
          </h2>
          <p className="text-xs text-[#6B6B66] mt-0.5">
            Deterministic SHA-256 build outputs shared across distributed worker nodes.
          </p>
        </div>
        <span className="text-xs text-[#52524D] font-mono tabular-nums whitespace-nowrap shrink-0">
          {artifacts.length} blobs · {totalSizeMb.toFixed(1)} MB stored
        </span>
      </div>

      {artifacts.length === 0 ? (
        <div className="py-12 px-6 text-center text-xs text-[#6B6B66]">
          All CAS blobs have been evicted. Next pipeline run will repopulate the cache.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#E5E5E0] bg-[#FAFAFA] text-[11px] font-medium text-[#6B6B66]">
                <th className="py-2.5 px-4">SHA-256 Digest</th>
                <th className="py-2.5 px-4">Step</th>
                <th className="py-2.5 px-4">Repository</th>
                <th className="py-2.5 px-4 text-right">Size</th>
                <th className="py-2.5 px-4 text-right">Cache Hits</th>
                <th className="py-2.5 px-4 text-right">Last Accessed</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E5E0] text-xs">
              {artifacts.map((art) => (
                <tr key={art.digest} className="hover:bg-[#FAFAFA] transition-colors">
                  <td className="py-3 px-4 font-mono text-[#141413] whitespace-nowrap">
                    {art.digest.slice(0, 16)}...
                  </td>
                  <td className="py-3 px-4 font-mono font-medium text-[#141413] whitespace-nowrap">
                    {art.stepName}
                  </td>
                  <td className="py-3 px-4 text-[#52524D] whitespace-nowrap">
                    {art.projectId}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-[#52524D] whitespace-nowrap">
                    {art.sizeMb.toFixed(1)} MB
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-[#141413] whitespace-nowrap">
                    {art.hits}
                  </td>
                  <td className="py-3 px-4 text-right text-[#6B6B66] whitespace-nowrap">
                    {art.lastAccessed}
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onEvictArtifact(art.digest)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#DC2626] bg-white border border-[#E5E5E0] rounded-md hover:bg-[#FEF2F2] transition-colors whitespace-nowrap shrink-0"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden="true" />
                      <span>Evict</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface WorkerNodesViewProps {
  workers: WorkerNode[];
  onToggleDrain: (workerId: string) => void;
}

export function WorkerNodesView({
  workers,
  onToggleDrain,
}: WorkerNodesViewProps) {
  return (
    <section className="border border-[#E5E5E0] bg-white rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E5E5E0] flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#141413]">
            Registered Worker Pool
          </h2>
          <p className="text-xs text-[#6B6B66] mt-0.5">
            Static-binary Linux runner nodes executing sandboxed DAG steps over gRPC leases.
          </p>
        </div>
        <span className="text-xs text-[#52524D] font-mono tabular-nums whitespace-nowrap shrink-0">
          {workers.filter((w) => w.state !== 'draining').length} active / {workers.length} total
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#E5E5E0] bg-[#FAFAFA] text-[11px] font-medium text-[#6B6B66]">
              <th className="py-2.5 px-4">Worker ID</th>
              <th className="py-2.5 px-4">Target Arch</th>
              <th className="py-2.5 px-4">Region</th>
              <th className="py-2.5 px-4">State</th>
              <th className="py-2.5 px-4 text-right">Leases</th>
              <th className="py-2.5 px-4 text-right">CPU</th>
              <th className="py-2.5 px-4 text-right">Memory</th>
              <th className="py-2.5 px-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0] text-xs">
            {workers.map((w) => {
              const stateColor =
                w.state === 'draining'
                  ? 'text-[#D97706]'
                  : w.state === 'busy'
                  ? 'text-[#2563EB]'
                  : 'text-[#16A34A]';
              const stateLabel =
                w.state === 'draining'
                  ? 'Draining'
                  : w.state === 'busy'
                  ? 'Busy'
                  : 'Online';

              return (
                <tr key={w.id} className="hover:bg-[#FAFAFA] transition-colors">
                  <td className="py-3 px-4 whitespace-nowrap">
                    <div className="font-mono font-medium text-[#141413]">
                      {w.id}
                    </div>
                    <div className="text-[11px] text-[#6B6B66] font-mono">
                      {w.hostname}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono text-[#52524D] whitespace-nowrap">
                    {w.arch}
                  </td>
                  <td className="py-3 px-4 font-mono text-[#52524D] whitespace-nowrap">
                    {w.region}
                  </td>
                  <td className={`py-3 px-4 font-medium whitespace-nowrap ${stateColor}`}>
                    {stateLabel}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-[#141413] whitespace-nowrap">
                    {w.activeLeases}/{w.maxConcurrency}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-[#52524D] whitespace-nowrap">
                    {w.cpuUtilizationPct}%
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-[#52524D] whitespace-nowrap">
                    {w.memoryUsedGb.toFixed(1)}/{w.memoryTotalGb} GB
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onToggleDrain(w.id)}
                      className="px-2.5 py-1 text-xs font-medium text-[#141413] bg-white border border-[#E5E5E0] rounded-md hover:bg-[#F6F6F4] transition-colors whitespace-nowrap shrink-0"
                    >
                      {w.state === 'draining' ? 'Resume' : 'Drain'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

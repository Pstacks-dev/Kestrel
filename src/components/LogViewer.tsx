import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  RotateCcw,
  Search,
  Square,
  Terminal,
} from 'lucide-react';
import { JobStep } from '../types/pipeline';
import { formatDuration, StatusIndicator } from './StatusIndicator';

interface LogViewerProps {
  job: JobStep | undefined;
  onRerunJob: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
}

type StreamFilter = 'all' | 'stdout' | 'stderr';

export function LogViewer({ job, onRerunJob, onCancelJob }: LogViewerProps) {
  const [streamFilter, setStreamFilter] = useState<StreamFilter>('all');
  const [logQuery, setLogQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const filteredLogs = useMemo(() => {
    if (!job) return [];
    const q = logQuery.trim().toLowerCase();
    return job.logs.filter((entry) => {
      if (streamFilter !== 'all' && entry.stream !== streamFilter) {
        return false;
      }
      if (q && !entry.message.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [job, streamFilter, logQuery]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLogs.length, autoScroll, job?.id]);

  const handleCopy = async () => {
    if (!job) return;
    const text = filteredLogs
      .map((l) => `${l.timestamp} [${l.stream}] ${l.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  if (!job) {
    return (
      <section className="flex flex-col items-center justify-center h-full min-h-[380px] border border-[#E5E5E0] bg-white rounded-lg p-8 text-center">
        <Terminal className="w-6 h-6 text-[#73736D] mb-3" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-[#141413]">No job selected</h3>
        <p className="mt-1 text-xs text-[#6B6B66] max-w-xs">
          Select a pipeline step from the job list to inspect its sandbox output and execution logs.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label={`Logs for ${job.name}`}
      className="flex flex-col border border-[#E5E5E0] bg-white rounded-lg overflow-hidden h-full min-h-[440px]"
    >
      {/* Selected Job Metadata Header */}
      <div className="px-4 py-3.5 border-b border-[#E5E5E0] bg-white space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-semibold text-[#141413] font-mono truncate">
              {job.name}
            </h2>
            <StatusIndicator status={job.status} />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {job.status === 'running' ? (
              <button
                type="button"
                onClick={() => onCancelJob(job.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#DC2626] bg-white border border-[#E5E5E0] rounded-md hover:bg-[#FEF2F2] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#DC2626]"
              >
                <Square className="w-3 h-3" aria-hidden="true" />
                <span>Cancel Step</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onRerunJob(job.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#141413] bg-white border border-[#E5E5E0] rounded-md hover:bg-[#F6F6F4] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#141413]"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                <span>Re-run Step</span>
              </button>
            )}
          </div>
        </div>

        {/* Unboxed metadata row */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#6B6B66]">
          <span className="font-mono text-[#141413] truncate max-w-full">
            $ {job.command}
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">Duration {formatDuration(job.durationMs)}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{job.workerId}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{job.arch}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            {job.memoryLimitMb} MB / {(job.cpuMillicores / 1000).toFixed(1)} vCPU
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">
            SHA-256 {job.cacheDigest.slice(0, 12)}
          </span>
        </div>
      </div>

      {/* Log Stream Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-[#E5E5E0] bg-[#FAFAFA]">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <div className="flex items-center gap-1 p-0.5 bg-[#EFEFEA] rounded-md">
            {(['all', 'stdout', 'stderr'] as StreamFilter[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setStreamFilter(mode)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  streamFilter === mode
                    ? 'bg-white text-[#141413] shadow-xs'
                    : 'text-[#6B6B66] hover:text-[#141413]'
                }`}
              >
                {mode === 'all' ? 'All' : mode === 'stdout' ? 'Stdout' : 'Stderr'}
              </button>
            ))}
          </div>

          <div className="relative flex-1 max-w-xs">
            <Search
              className="w-3.5 h-3.5 text-[#73736D] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={logQuery}
              onChange={(e) => setLogQuery(e.target.value)}
              placeholder="Filter log lines..."
              aria-label="Filter log lines"
              className="w-full h-8 pl-8 pr-2.5 text-xs bg-white border border-[#E5E5E0] rounded-md text-[#141413] placeholder:text-[#8E8E87] focus:outline-none focus:border-[#141413]"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setAutoScroll((prev) => !prev)}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              autoScroll
                ? 'bg-[#141413] text-white border-[#141413]'
                : 'bg-white text-[#52524D] border-[#E5E5E0] hover:text-[#141413]'
            }`}
          >
            {autoScroll ? 'Auto-scroll On' : 'Auto-scroll Off'}
          </button>

          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[#141413] bg-white border border-[#E5E5E0] rounded-md hover:bg-[#F6F6F4] transition-colors whitespace-nowrap shrink-0"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Monospace Log Viewport */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-[#141413] text-[#EDEDEA] font-mono text-xs leading-5 p-3 sm:p-4 min-h-[280px] max-h-[540px]"
      >
        {filteredLogs.length === 0 ? (
          <div className="py-10 text-center text-[#8E8E87]">
            {job.logs.length === 0
              ? 'No log lines emitted for this step yet.'
              : 'No log lines match the active filter.'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredLogs.map((entry, idx) => {
              const isError =
                entry.stream === 'stderr' ||
                entry.message.includes('FAIL') ||
                entry.message.includes('AssertionError');
              const isSuccess =
                entry.message.includes('exit 0') ||
                entry.message.includes('passed') ||
                entry.message.includes('CAS ref hit') ||
                entry.message.includes('0 errors');

              return (
                <div
                  key={entry.id}
                  className={`flex items-start gap-3 px-2 py-0.5 rounded hover:bg-white/5 ${
                    isError ? 'bg-[#DC2626]/10' : ''
                  }`}
                >
                  <span className="w-7 shrink-0 text-right text-[#6B6B66] tabular-nums select-none">
                    {idx + 1}
                  </span>
                  <span className="shrink-0 text-[#8E8E87] tabular-nums select-none">
                    {entry.timestamp}
                  </span>
                  <span
                    className={`min-w-0 break-all whitespace-pre-wrap ${
                      isError
                        ? 'text-[#FCA5A5]'
                        : isSuccess
                        ? 'text-[#86EFAC]'
                        : 'text-[#EDEDEA]'
                    }`}
                  >
                    {entry.message}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

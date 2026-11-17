import {
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  XCircle,
} from 'lucide-react';
import { JobStatus } from '../types/pipeline';

interface StatusIndicatorProps {
  status: JobStatus;
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  switch (status) {
    case 'succeeded':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#16A34A] whitespace-nowrap shrink-0">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Succeeded</span>
        </span>
      );
    case 'cached':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0F766E] whitespace-nowrap shrink-0">
          <Database className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Cached</span>
        </span>
      );
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2563EB] whitespace-nowrap shrink-0">
          <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span>Running</span>
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#DC2626] whitespace-nowrap shrink-0">
          <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Failed</span>
        </span>
      );
    case 'canceled':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#73736D] whitespace-nowrap shrink-0">
          <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Canceled</span>
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#A1A19A] whitespace-nowrap shrink-0">
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Skipped</span>
        </span>
      );
    case 'queued':
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#6B6B66] whitespace-nowrap shrink-0">
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Queued</span>
        </span>
      );
  }
}

export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

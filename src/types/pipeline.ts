export type JobStatus = 'succeeded' | 'running' | 'failed' | 'cached' | 'queued' | 'canceled' | 'skipped';

export type NavSection = 'pipelines' | 'runs' | 'cache' | 'workers';

export interface LogEntry {
  id: string;
  seq: number;
  timestamp: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

export interface JobStep {
  id: string;
  name: string;
  stage: 'push' | 'build' | 'checks' | 'canary' | 'promote';
  command: string;
  workingDirectory?: string;
  needs: string[];
  status: JobStatus;
  durationMs: number;
  workerId: string;
  arch: 'linux/amd64' | 'linux/arm64';
  cacheDigest: string;
  cacheHit: boolean;
  exitCode: number | null;
  memoryLimitMb: number;
  cpuMillicores: number;
  logs: LogEntry[];
}

export interface ResourceSample {
  elapsedSec: number;
  cpuPct: number;
  memoryPct: number;
  memoryMb: number;
  activeStep: string;
}

export interface PipelineRun {
  id: string;
  runNumber: number;
  projectId: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  author: string;
  triggeredAt: string;
  jobs: JobStep[];
  telemetry?: ResourceSample[];
}

export interface PipelineProject {
  id: string;
  name: string;
  repo: string;
  defaultBranch: string;
  region: string;
}

export interface WorkerNode {
  id: string;
  hostname: string;
  arch: 'linux/amd64' | 'linux/arm64';
  region: string;
  state: 'online' | 'busy' | 'draining';
  activeLeases: number;
  maxConcurrency: number;
  cpuUtilizationPct: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  uptime: string;
}

export interface CacheArtifact {
  digest: string;
  stepName: string;
  projectId: string;
  sizeMb: number;
  hits: number;
  lastAccessed: string;
}

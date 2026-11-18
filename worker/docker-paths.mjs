import path from 'node:path';

/**
 * Resolve a workspace path as seen by the host Docker daemon.
 * The worker agent may run inside a container while talking to the host
 * daemon through /var/run/docker.sock; the daemon cannot bind-mount paths
 * that exist only in the agent container's filesystem namespace.
 */
export function getDockerHostWorkspacePath(workerRoot, hostRoot, workspacePath) {
  const resolvedWorkerRoot = path.resolve(workerRoot);
  const resolvedWorkspace = path.resolve(workspacePath);
  const relative = path.relative(resolvedWorkerRoot, resolvedWorkspace);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Worker workspace must be inside KESTREL_WORKER_WORKDIR');
  }

  return path.join(path.resolve(hostRoot || workerRoot), relative);
}

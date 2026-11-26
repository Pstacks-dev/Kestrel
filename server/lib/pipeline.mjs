function safeWorkingDirectory(value) {
  if (value === undefined || value === null || value === '' || value === '.') return true;
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..' && !/[\u0000-\u001f]/.test(part));
}


function safeArtifactPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..' && !/[\u0000-\u001f]/.test(part));
}

export function validatePipelineJobs(jobs) {
  const fail = (message) => {
    throw Object.assign(new Error(message), { status: 400 });
  };

  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 100) {
    fail('A pipeline must contain 1–100 jobs');
  }

  if (jobs.some((j) => !j || typeof j !== 'object' || Array.isArray(j))) {
    fail('Every job must be an object');
  }

  const safe = jobs.map((j, i) => {
    const rawId = String(j.id || `job-${i + 1}`).trim();
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(rawId)) {
      fail(`Job id "${rawId}" must contain only alphanumeric characters, dashes, dots, or underscores (up to 64 chars)`);
    }

    const command = String(j.command || '').trim();
    if (!command || command.length > 12000) {
      fail(`Job ${rawId} must have a command between 1 and 12,000 characters`);
    }

    const memory = Math.min(
      8192,
      Math.max(256, Number.isFinite(Number(j.memoryLimitMb)) ? Number(j.memoryLimitMb) : 2048)
    );
    const cpu = Math.min(
      4000,
      Math.max(250, Number.isFinite(Number(j.cpuMillicores)) ? Number(j.cpuMillicores) : 1000)
    );
    const timeoutSeconds = Math.min(
      86400,
      Math.max(10, Number.isFinite(Number(j.timeoutSeconds)) ? Number(j.timeoutSeconds) : 1800)
    );
    const maxRetries = Math.min(
      10,
      Math.max(0, Number.isFinite(Number(j.maxRetries)) ? Number(j.maxRetries) : 2)
    );

    return {
      id: rawId,
      name: String(j.name || `Job ${i + 1}`).trim().slice(0, 160),
      stage: String(j.stage || 'build').trim().slice(0, 80),
      command,
      workingDirectory: (safeWorkingDirectory(j.workingDirectory) ? (j.workingDirectory || '.') : fail(`Job ${rawId} has an unsafe working directory`)),
      needs: Array.isArray(j.needs) ? j.needs.map(String).map((s) => s.trim()) : [],
      memory,
      cpu,
      timeoutSeconds,
      maxRetries,
      artifacts: Array.isArray(j.artifacts) ? [...new Set(j.artifacts.map((p) => String(p).trim()).filter(safeArtifactPath))].slice(0, 50) : [],
    };
  });

  const ids = new Set(safe.map((j) => j.id));
  if (ids.size !== safe.length) {
    fail('Job IDs must be unique');
  }

  for (const j of safe) {
    if (j.needs.some((n) => !ids.has(n) || n === j.id)) {
      fail(`Job ${j.id} has an invalid dependency`);
    }
  }

  const map = new Map(safe.map((j) => [j.id, j]));
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of map.get(id).needs) {
      if (!visit(dep)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  }

  if (!safe.every((j) => visit(j.id))) {
    fail('Pipeline dependencies contain a cycle');
  }

  return safe;
}

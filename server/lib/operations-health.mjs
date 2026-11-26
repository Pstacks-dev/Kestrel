export function summarizeManagedHostingHealth({
  automationQueueRows = [],
  deploymentRows = [],
  imageBuildRows = [],
} = {}) {
  const automationQueue = Object.fromEntries(
    automationQueueRows.map((row) => [row.status, Number(row.count)]),
  );
  const imageBuilds = Object.fromEntries(
    imageBuildRows.map((row) => [row.status, Number(row.count)]),
  );
  const deploymentsByProvider = {};
  for (const row of deploymentRows) {
    if (!row.provider_id || !row.status) continue;
    deploymentsByProvider[row.provider_id] ||= {};
    deploymentsByProvider[row.provider_id][row.status] = Number(row.count);
  }
  return { automationQueue, deploymentsByProvider, imageBuilds };
}

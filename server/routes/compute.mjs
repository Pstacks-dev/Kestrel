import crypto from 'node:crypto';

const MEMBER_ROLES = ['owner', 'admin', 'developer'];
const PROVIDERS = ['incus', 'firecracker', 'kubevirt'];
const ACTIVE_INSTANCE_STATES = ['provisioning', 'starting', 'running', 'stopping', 'stopped', 'deleting'];

const fail = (res, status, error) => res.status(status).json({ error });
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const validName = (value) => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const validSshKey = (value) => {
  if (value == null || value === '') return true;
  if (typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)) return false;
  const [kind, data] = value.trim().split(/\s+/);
  return ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'].includes(kind)
    && /^[A-Za-z0-9+/=]+$/.test(data || '');
};

function nodeAgentAuth(query) {
  return async (req, res, next) => {
    try {
      const nodeId = String(req.headers['x-compute-node-id'] || '');
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!nodeId || !token) return fail(res, 401, 'Compute node credentials required');
      const result = await query(
        `select n.id, n.provider, n.state, n.desired_state
         from public.compute_node_credentials c
         join public.compute_nodes n on n.id = c.node_id
         where c.node_id = $1 and c.token_hash = $2 and c.revoked_at is null`,
        [nodeId, tokenHash(token)]
      );
      if (!result.rowCount) return fail(res, 401, 'Compute node authentication failed');
      req.computeNode = result.rows[0];
      next();
    } catch (error) { next(error); }
  };
}

async function requireOrganizationRole(query, userId, organizationId) {
  const result = await query(
    'select role from public.organization_members where organization_id = $1 and user_id = $2',
    [organizationId, userId]
  );
  return result.rowCount ? result.rows[0].role : null;
}

export function registerComputeRoutes(app, { userAuth, platformAdmin, query, transaction }) {
  const agentAuth = nodeAgentAuth(query);

  // Provider hosts are provisioned by platform operators, never by workspace members.
  app.get('/api/admin/compute/nodes', userAuth, platformAdmin, async (_req, res) => {
    try {
      const result = await query(
        `select n.id, n.provider, n.hostname, n.region, n.architecture, n.state, n.desired_state as "desiredState",
                n.total_vcpu as "totalVcpu", n.total_memory_mib as "totalMemoryMib",
                n.total_disk_gib as "totalDiskGib", n.allocated_vcpu as "allocatedVcpu",
                n.allocated_memory_mib as "allocatedMemoryMib", n.allocated_disk_gib as "allocatedDiskGib",
                n.max_instances as "maxInstances", n.last_seen_at as "lastSeenAt",
                count(i.id) filter (where i.status not in ('deleted','failed'))::int as "activeInstances"
         from public.compute_nodes n
         left join public.compute_instances i on i.node_id = n.id
         group by n.id order by n.created_at desc`
      );
      res.json({ nodes: result.rows });
    } catch { fail(res, 500, 'Could not load compute nodes'); }
  });

  app.post('/api/admin/compute/nodes', userAuth, platformAdmin, async (req, res) => {
    const body = req.body || {};
    const id = String(body.id || '').trim();
    const provider = String(body.provider || '');
    const hostname = String(body.hostname || '').trim();
    const region = String(body.region || 'unknown').trim();
    const totalVcpu = Number(body.totalVcpu);
    const totalMemoryMib = Number(body.totalMemoryMib);
    const totalDiskGib = Number(body.totalDiskGib);
    const maxInstances = Number(body.maxInstances || 100);
    if (!validName(id) || !PROVIDERS.includes(provider) || hostname.length < 1 || hostname.length > 128 ||
        region.length < 1 || region.length > 80 || !Number.isInteger(totalVcpu) || totalVcpu < 1 || totalVcpu > 4096 ||
        !Number.isInteger(totalMemoryMib) || totalMemoryMib < 512 || totalMemoryMib > 4194304 ||
        !Number.isInteger(totalDiskGib) || totalDiskGib < 5 || totalDiskGib > 1048576 ||
        !Number.isInteger(maxInstances) || maxInstances < 1 || maxInstances > 10000) {
      return fail(res, 400, 'Invalid provider node configuration');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    try {
      await transaction(async (c) => {
        await c.query(
          `insert into public.compute_nodes
           (id, provider, hostname, region, total_vcpu, total_memory_mib, total_disk_gib, max_instances, created_by)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, provider, hostname, region, totalVcpu, totalMemoryMib, totalDiskGib, maxInstances, req.user.id]
        );
        await c.query(
          'insert into public.compute_node_credentials(node_id, token_hash) values($1,$2)',
          [id, tokenHash(token)]
        );
        await c.query(
          'insert into public.audit_events(actor_id, action, target_type, target_id, metadata) values($1,$2,$3,$4,$5)',
          [req.user.id, 'compute.node.created', 'compute_node', id, JSON.stringify({ provider, region })]
        );
      });
      res.status(201).json({ node: { id, provider, hostname, region, state: 'offline' }, agentToken: token });
    } catch (error) {
      res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Compute node ID already exists' : 'Could not create compute node' });
    }
  });

  app.post('/api/admin/compute/nodes/:nodeId/state', userAuth, platformAdmin, async (req, res) => {
    const desiredState = String(req.body?.desiredState || '');
    if (!['online', 'draining', 'offline'].includes(desiredState)) return fail(res, 400, 'Invalid desired node state');
    const result = await query(
      `update public.compute_nodes set desired_state = $2,
         state = case when $2 = 'offline' then 'offline' when $2 = 'draining' then 'draining' else state end,
         updated_at = now() where id = $1 returning id, state, desired_state as "desiredState"`,
      [req.params.nodeId, desiredState]
    );
    if (!result.rowCount) return fail(res, 404, 'Compute node not found');
    res.json({ node: result.rows[0] });
  });

  app.post('/api/compute/agent/register', agentAuth, async (req, res) => {
    const hostname = String(req.body?.hostname || '').trim();
    const architecture = String(req.body?.architecture || 'linux/amd64').trim();
    if (!hostname || hostname.length > 128 || architecture.length > 64) return fail(res, 400, 'Invalid compute agent registration');
    const result = await query(
      `update public.compute_nodes set hostname = $2, architecture = $3,
         state = case when desired_state = 'offline' then 'offline' when desired_state = 'draining' then 'draining' else 'online' end,
         last_seen_at = now(), updated_at = now()
       where id = $1 returning id, provider, state, desired_state as "desiredState"`,
      [req.computeNode.id, hostname, architecture]
    );
    res.json({ ok: true, node: result.rows[0] });
  });

  app.post('/api/compute/agent/heartbeat', agentAuth, async (_req, res) => {
    const result = await query(
      `update public.compute_nodes set
         state = case when desired_state = 'offline' then 'offline' when desired_state = 'draining' then 'draining' else 'online' end,
         last_seen_at = now(), updated_at = now()
       where id = $1 returning state, desired_state as "desiredState"`,
      [req.computeNode.id]
    );
    res.json({ ok: true, ...result.rows[0] });
  });

  app.post('/api/compute/agent/claim', agentAuth, async (_req, res) => {
    try {
      const operation = await transaction(async (c) => {
        const node = await c.query('select * from public.compute_nodes where id = $1 for update', [req.computeNode.id]);
        if (!node.rowCount || node.rows[0].desired_state !== 'online' || node.rows[0].state !== 'online') return null;
        await c.query(
          `update public.compute_operations set status = 'queued', lease_token = null, lease_expires_at = null,
             available_at = now() + interval '10 seconds'
           where node_id = $1 and status = 'claimed' and lease_expires_at <= now() and attempts < max_attempts`,
          [req.computeNode.id]
        );
        const candidate = await c.query(
          `select o.* from public.compute_operations o
           where o.node_id = $1 and o.status = 'queued' and o.available_at <= now()
           order by o.created_at limit 1 for update skip locked`,
          [req.computeNode.id]
        );
        if (!candidate.rowCount) return null;
        const op = candidate.rows[0];
        const lease = crypto.randomBytes(32).toString('hex');
        const claimed = await c.query(
          `update public.compute_operations set status = 'claimed', attempts = attempts + 1,
             lease_token = $2, lease_expires_at = now() + interval '90 seconds', started_at = now()
           where id = $1 returning id, instance_id, action, payload, attempts`,
          [op.id, lease]
        );
        return { ...claimed.rows[0], operationId: claimed.rows[0].id, leaseToken: lease };
      });
      res.json({ operation });
    } catch { fail(res, 500, 'Could not claim compute operation'); }
  });

  app.post('/api/compute/agent/complete', agentAuth, async (req, res) => {
    const { operationId, leaseToken, success, providerId, state, ipv4 = [], error } = req.body || {};
    if (typeof operationId !== 'string' || typeof leaseToken !== 'string' || typeof success !== 'boolean' ||
        (providerId != null && (typeof providerId !== 'string' || providerId.length > 255)) ||
        !Array.isArray(ipv4) || ipv4.length > 16 || ipv4.some((ip) => typeof ip !== 'string' || ip.length > 64)) {
      return fail(res, 400, 'Invalid compute operation result');
    }
    try {
      const result = await transaction(async (c) => {
        const op = await c.query(
          `select * from public.compute_operations where id = $1 and node_id = $2
           and status = 'claimed' and lease_token = $3 and lease_expires_at > now() for update`,
          [operationId, req.computeNode.id, leaseToken]
        );
        if (!op.rowCount) return null;
        const current = op.rows[0];
        const instance = await c.query('select * from public.compute_instances where id = $1 for update', [current.instance_id]);
        if (!instance.rowCount) return null;
        const nextStatus = success ? (current.action === 'delete' ? 'deleted' : ['running','stopped'].includes(state) ? state : current.action === 'start' ? 'running' : current.action === 'stop' ? 'stopped' : 'stopped') : 'failed';
        await c.query(
          `update public.compute_operations set status = $2, lease_token = null, lease_expires_at = null,
             error_message = $3, finished_at = now() where id = $1`,
          [operationId, success ? 'succeeded' : 'failed', success ? null : String(error || 'Provider operation failed').slice(0, 2000)]
        );
        await c.query(
          `update public.compute_instances set
             provider_id = coalesce($2, provider_id),
             status = $3,
             ipv4 = case when $4::text[] is null then ipv4 else $4::text[] end,
             error_message = $5,
             deleted_at = case when $3 = 'deleted' then now() else deleted_at end,
             updated_at = now()
           where id = $1`,
          [current.instance_id, providerId || null, nextStatus, ipv4.length ? ipv4 : null, success ? null : String(error || 'Provider operation failed').slice(0, 2000)]
        );
        if (current.action === 'delete' && success) {
          await c.query(
            `update public.compute_nodes set allocated_vcpu = greatest(0, allocated_vcpu - $2),
               allocated_memory_mib = greatest(0, allocated_memory_mib - $3),
               allocated_disk_gib = greatest(0, allocated_disk_gib - $4), updated_at = now()
             where id = $1`,
            [instance.rows[0].node_id, instance.rows[0].vcpus, instance.rows[0].memory_mib, instance.rows[0].disk_gib]
          );
        }
        if (current.action === 'create' && !success) {
          await c.query(
            `update public.compute_nodes set allocated_vcpu = greatest(0, allocated_vcpu - $2),
               allocated_memory_mib = greatest(0, allocated_memory_mib - $3),
               allocated_disk_gib = greatest(0, allocated_disk_gib - $4), updated_at = now()
             where id = $1`,
            [instance.rows[0].node_id, instance.rows[0].vcpus, instance.rows[0].memory_mib, instance.rows[0].disk_gib]
          );
        }
        return { id: operationId, instanceId: current.instance_id, status: success ? 'succeeded' : 'failed' };
      });
      if (!result) return fail(res, 409, 'Compute operation lease is invalid or expired');
      res.json({ ok: true, operation: result });
    } catch { fail(res, 500, 'Could not complete compute operation'); }
  });

  app.get('/api/compute/instances', userAuth, async (req, res) => {
    const organizationId = String(req.query.organizationId || '');
    if (!organizationId) return fail(res, 400, 'organizationId required');
    if (!await requireOrganizationRole(query, req.user.id, organizationId)) return fail(res, 403, 'Workspace access denied');
    try {
      const result = await query(
        `select id, organization_id as "organizationId", node_id as "nodeId", provider_id as "providerId",
                provider, name, image, region, vcpus, memory_mib as "memoryMiB", disk_gib as "diskGiB",
                status, ipv4, ssh_public_key as "sshPublicKey", error_message as "errorMessage",
                created_at as "createdAt", updated_at as "updatedAt"
         from public.compute_instances where organization_id = $1 and deleted_at is null order by created_at desc`,
        [organizationId]
      );
      res.json({ instances: result.rows });
    } catch { fail(res, 500, 'Could not load compute instances'); }
  });

  app.post('/api/compute/instances', userAuth, async (req, res) => {
    const body = req.body || {};
    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationRole(query, req.user.id, organizationId);
    if (!role) return fail(res, 403, 'Workspace access denied');
    if (!MEMBER_ROLES.includes(role)) return fail(res, 403, 'Developer access required');
    const provider = String(body.provider || '');
    const name = String(body.name || '');
    const image = String(body.image || '');
    const region = body.region == null ? null : String(body.region);
    const vcpus = Number(body.vcpus), memoryMib = Number(body.memoryMiB), diskGib = Number(body.diskGiB);
    const sshPublicKey = body.sshPublicKey || null;
    if (!PROVIDERS.includes(provider) || !validName(name) || !image || image.length > 512 ||
        /[\r\n\0]/.test(image) || !Number.isInteger(vcpus) || vcpus < 1 || vcpus > 64 ||
        !Number.isInteger(memoryMib) || memoryMib < 512 || memoryMib > 262144 ||
        !Number.isInteger(diskGib) || diskGib < 5 || diskGib > 4096 ||
        (region && region.length > 80) || !validSshKey(sshPublicKey)) {
      return fail(res, 400, 'Invalid VM specification');
    }
    if (provider === 'firecracker' && !/^[A-Za-z0-9._-]{1,128}$/.test(image)) {
      return fail(res, 400, 'Firecracker image must be an installed rootfs filename');
    }
    try {
      const created = await transaction(async (c) => {
        await c.query('insert into public.compute_quotas(organization_id) values($1) on conflict do nothing', [organizationId]);
        const quotaResult = await c.query(
          'select max_instances, max_vcpu, max_memory_mib, max_disk_gib from public.compute_quotas where organization_id = $1 for update',
          [organizationId]
        );
        const usageResult = await c.query(
          `select count(*)::int as used_instances,
             coalesce(sum(vcpus),0)::bigint as used_vcpu,
             coalesce(sum(memory_mib),0)::bigint as used_memory,
             coalesce(sum(disk_gib),0)::bigint as used_disk
           from public.compute_instances where organization_id = $1 and status <> 'deleted'`,
          [organizationId]
        );
        const quota = { ...quotaResult.rows[0], ...usageResult.rows[0] };
        if (quota.used_instances >= quota.max_instances || Number(quota.used_vcpu) + vcpus > quota.max_vcpu ||
            Number(quota.used_memory) + memoryMib > Number(quota.max_memory_mib) ||
            Number(quota.used_disk) + diskGib > Number(quota.max_disk_gib)) {
          return { error: 'Workspace compute quota exceeded' };
        }
        const node = await c.query(
          `select n.* from public.compute_nodes n
           where n.provider = $1 and n.state = 'online' and n.desired_state = 'online'
             and n.last_seen_at >= now() - interval '45 seconds'
             and ( $2::text is null or n.region = $2 )
             and n.total_vcpu - n.allocated_vcpu >= $3
             and n.total_memory_mib - n.allocated_memory_mib >= $4
             and n.total_disk_gib - n.allocated_disk_gib >= $5
             and (select count(*) from public.compute_instances i where i.node_id = n.id and i.status not in ('deleted','failed')) < n.max_instances
           order by (n.allocated_vcpu::numeric / n.total_vcpu), n.last_seen_at desc
           limit 1 for update skip locked`,
          [provider, region, vcpus, memoryMib, diskGib]
        );
        if (!node.rowCount) return { error: 'No healthy compute node has enough capacity for this VM' };
        const selected = node.rows[0];
        const instance = await c.query(
          `insert into public.compute_instances
           (organization_id, node_id, provider, name, image, region, vcpus, memory_mib, disk_gib, ssh_public_key, created_by)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           returning id, node_id, provider, name, image, vcpus, memory_mib, disk_gib, status`,
          [organizationId, selected.id, provider, name, image, region, vcpus, memoryMib, diskGib, sshPublicKey, req.user.id]
        );
        await c.query(
          `update public.compute_nodes set allocated_vcpu = allocated_vcpu + $2,
             allocated_memory_mib = allocated_memory_mib + $3, allocated_disk_gib = allocated_disk_gib + $4,
             updated_at = now() where id = $1`,
          [selected.id, vcpus, memoryMib, diskGib]
        );
        const payload = { spec: { name, image, vcpus, memoryMiB: memoryMib, diskGiB: diskGib, region, sshPublicKey } };
        const op = await c.query(
          `insert into public.compute_operations(instance_id, organization_id, node_id, action, payload)
           values($1,$2,$3,'create',$4) returning id`,
          [instance.rows[0].id, organizationId, selected.id, JSON.stringify(payload)]
        );
        await c.query(
          'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata) values($1,$2,$3,$4,$5,$6)',
          [organizationId, req.user.id, 'compute.instance.create.queued', 'compute_instance', instance.rows[0].id, JSON.stringify({ provider, region, operationId: op.rows[0].id })]
        );
        return { instance: instance.rows[0], operationId: op.rows[0].id };
      });
      if (created.error) return fail(res, created.error.startsWith('Workspace') ? 403 : 409, created.error);
      res.status(202).json(created);
    } catch (error) {
      res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'VM name already exists on the selected provider node' : 'Could not queue VM creation' });
    }
  });

  app.post('/api/compute/instances/:instanceId/actions', userAuth, async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['start', 'stop', 'delete'].includes(action)) return fail(res, 400, 'Unsupported VM action');
    try {
      const queued = await transaction(async (c) => {
        const instance = await c.query(
          `select i.* from public.compute_instances i
           join public.organization_members m on m.organization_id = i.organization_id
           where i.id = $1 and m.user_id = $2 and m.role = any($3)
             and i.status <> 'deleted' for update of i`,
          [req.params.instanceId, req.user.id, MEMBER_ROLES]
        );
        if (!instance.rowCount) return { error: 'VM not found or access denied', status: 404 };
        const vm = instance.rows[0];
        if (action === 'start' && !['stopped'].includes(vm.status)) return { error: 'Only stopped VMs can be started', status: 409 };
        if (action === 'stop' && !['running'].includes(vm.status)) return { error: 'Only running VMs can be stopped', status: 409 };
        if (action === 'delete' && ['provisioning','starting','stopping','deleting'].includes(vm.status)) return { error: 'Wait for the current VM operation to finish', status: 409 };
        const pending = await c.query(
          "select id from public.compute_operations where instance_id = $1 and status in ('queued','claimed') limit 1",
          [vm.id]
        );
        if (pending.rowCount) return { error: 'A VM operation is already in progress', status: 409 };
        const nextStatus = action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'deleting';
        await c.query('update public.compute_instances set status = $2, updated_at = now() where id = $1', [vm.id, nextStatus]);
        const payload = { providerId: vm.provider_id, previousStatus: vm.status };
        const operation = await c.query(
          `insert into public.compute_operations(instance_id, organization_id, node_id, action, payload)
           values($1,$2,$3,$4,$5) returning id`,
          [vm.id, vm.organization_id, vm.node_id, action, JSON.stringify(payload)]
        );
        await c.query(
          'insert into public.audit_events(organization_id, actor_id, action, target_type, target_id, metadata) values($1,$2,$3,$4,$5,$6)',
          [vm.organization_id, req.user.id, 'compute.instance.' + action + '.queued', 'compute_instance', vm.id, JSON.stringify({ operationId: operation.rows[0].id })]
        );
        return { instanceId: vm.id, operationId: operation.rows[0].id, status: nextStatus };
      });
      if (queued.error) return fail(res, queued.status, queued.error);
      res.status(202).json(queued);
    } catch { fail(res, 500, 'Could not queue VM action'); }
  });
}

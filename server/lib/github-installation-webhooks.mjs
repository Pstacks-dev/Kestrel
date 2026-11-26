const SUPPORTED_INSTALLATION_ACTIONS = new Set([
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
]);

/**
 * Apply a verified GitHub App installation event inside the caller's transaction.
 * The delivery ledger insert, installation state change, and audit event commit
 * together, so a retry after a failed transaction can safely be processed again.
 */
export async function processGitHubInstallationDelivery(client, {
  deliveryId,
  eventName = 'installation',
  action,
  installationId,
}) {
  if (eventName !== 'installation' || !SUPPORTED_INSTALLATION_ACTIONS.has(action)) {
    throw new TypeError('Unsupported GitHub installation event');
  }
  if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) {
    throw new TypeError('Invalid GitHub delivery ID');
  }
  if (typeof installationId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(installationId) ||
      BigInt(installationId) > 9223372036854775807n) {
    throw new TypeError('Invalid GitHub installation ID');
  }

  const accepted = await client.query(
    `insert into public.github_app_webhook_deliveries(delivery_id, event_name, action, installation_id)
     values($1, $2, $3, $4) on conflict (delivery_id) do nothing returning delivery_id`,
    [deliveryId, eventName, action, installationId],
  );
  if (!accepted.rowCount) return { duplicate: true, linked: false };

  const suspendedAt = ['deleted', 'suspend'].includes(action) ? new Date().toISOString() : null;
  const updated = await client.query(
    'update public.github_app_installations set suspended_at = $2, updated_at = now() where installation_id = $1 returning organization_id',
    [installationId, suspendedAt],
  );
  if (updated.rowCount) {
    await client.query(
      `insert into public.audit_events(organization_id, action, target_type, target_id, metadata)
       values($1,$2,'github_app_installation',$3,$4::jsonb)`,
      [updated.rows[0].organization_id, `github_app.installation_${action}`, installationId, JSON.stringify({ action, deliveryId })],
    );
  }
  return { duplicate: false, linked: Boolean(updated.rowCount) };
}

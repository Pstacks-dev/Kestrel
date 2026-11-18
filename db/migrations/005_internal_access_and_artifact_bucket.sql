-- Keep the direct database hardening in source control and make it repeatable.
-- Internal tables are accessed only by the trusted control plane using the DB role.
REVOKE ALL ON TABLE public.github_webhook_deliveries FROM anon, authenticated;
REVOKE ALL ON TABLE public.kestrel_pending_signups FROM anon, authenticated;
REVOKE ALL ON TABLE public.kestrel_schema_migrations FROM anon, authenticated;
REVOKE ALL ON TABLE public.system_settings FROM anon, authenticated;
REVOKE ALL ON TABLE public.worker_credentials FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.recover_stale_leases() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_leases() TO service_role;

REVOKE EXECUTE ON FUNCTION public.is_org_member(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_org_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_admin(uuid) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS github_webhook_deliveries_run_id_idx
  ON public.github_webhook_deliveries(run_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_canceled_by_idx
  ON public.pipeline_runs(canceled_by);

-- Private object bucket. Only the service role may read/write objects; all access
-- is mediated by authenticated control-plane routes that verify workspace ownership.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kestrel-artifacts', 'kestrel-artifacts', false, 524288000, NULL)
ON CONFLICT (id) DO UPDATE
SET public = false, file_size_limit = 524288000;

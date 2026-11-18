-- Secrets and GitHub webhook signing keys are accessed only through the
-- authenticated control-plane API. Do not expose their base tables through PostgREST.
REVOKE ALL ON TABLE public.project_secrets FROM anon, authenticated;
REVOKE ALL ON TABLE public.github_webhooks FROM anon, authenticated;

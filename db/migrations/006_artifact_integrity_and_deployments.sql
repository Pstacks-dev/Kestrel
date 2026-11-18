-- Artifact byte integrity and deployment lifecycle.
ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS checksum_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_object_key_uidx ON public.artifacts(object_key);
CREATE TABLE IF NOT EXISTS public.deployment_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('vercel', 'netlify')),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  provider_site_id text NOT NULL,
  provider_team_id text,
  target_environment text NOT NULL DEFAULT 'production' CHECK (target_environment IN ('production', 'preview')),
  approval_required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS deployment_targets_project_idx ON public.deployment_targets(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES public.deployment_targets(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES public.pipeline_runs(id) ON DELETE RESTRICT,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','queued','deploying','ready','failed','rejected','rolling_back')),
  branch text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  provider_deployment_id text,
  deployment_url text,
  error_message text,
  rollback_of uuid REFERENCES public.deployments(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deployments_target_created_idx ON public.deployments(target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_run_idx ON public.deployments(run_id);
CREATE INDEX IF NOT EXISTS deployments_status_idx ON public.deployments(status);
ALTER TABLE public.deployment_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deployment_targets FROM anon, authenticated;
REVOKE ALL ON public.deployments FROM anon, authenticated;

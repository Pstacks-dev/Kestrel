ALTER TABLE public.deployments
  ADD COLUMN IF NOT EXISTS rollback_source_id uuid REFERENCES public.deployments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS deployments_rollback_source_idx ON public.deployments(rollback_source_id);
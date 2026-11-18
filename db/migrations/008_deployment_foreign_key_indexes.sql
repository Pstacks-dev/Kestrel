-- Cover all deployment foreign keys so deletes/updates and audit joins remain efficient.
CREATE INDEX IF NOT EXISTS deployment_targets_created_by_idx
  ON public.deployment_targets(created_by);
CREATE INDEX IF NOT EXISTS deployments_approved_by_idx
  ON public.deployments(approved_by);
CREATE INDEX IF NOT EXISTS deployments_requested_by_idx
  ON public.deployments(requested_by);
CREATE INDEX IF NOT EXISTS deployments_rollback_of_idx
  ON public.deployments(rollback_of);

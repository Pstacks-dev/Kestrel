-- Evaluate auth.uid() once per statement and avoid overlapping permissive SELECT
-- policies. Sensitive tables are server-only and have no client RLS policies.
DROP POLICY IF EXISTS "profile self read/update" ON public.profiles;
CREATE POLICY "profile self read/update" ON public.profiles
  FOR ALL USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "organization owner create" ON public.organizations;
CREATE POLICY "organization owner create" ON public.organizations
  FOR INSERT WITH CHECK (created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS "developers manage projects" ON public.projects;
CREATE POLICY "developers insert projects" ON public.projects
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = (SELECT auth.uid())
        AND m.role IN ('owner','admin','developer')
    )
  );
CREATE POLICY "developers update projects" ON public.projects
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = (SELECT auth.uid())
        AND m.role IN ('owner','admin','developer')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = (SELECT auth.uid())
        AND m.role IN ('owner','admin','developer')
    )
  );
CREATE POLICY "developers delete projects" ON public.projects
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = projects.organization_id
        AND m.user_id = (SELECT auth.uid())
        AND m.role IN ('owner','admin','developer')
    )
  );

DROP POLICY IF EXISTS "admins manage members" ON public.organization_members;
CREATE POLICY "admins insert members" ON public.organization_members
  FOR INSERT WITH CHECK (public.is_org_admin(organization_id));
CREATE POLICY "admins update members" ON public.organization_members
  FOR UPDATE USING (public.is_org_admin(organization_id))
  WITH CHECK (public.is_org_admin(organization_id));
CREATE POLICY "admins delete members" ON public.organization_members
  FOR DELETE USING (public.is_org_admin(organization_id));

DROP POLICY IF EXISTS "developers manage secrets" ON public.project_secrets;
DROP POLICY IF EXISTS "members read secret names" ON public.project_secrets;
DROP POLICY IF EXISTS "developers manage webhooks" ON public.github_webhooks;

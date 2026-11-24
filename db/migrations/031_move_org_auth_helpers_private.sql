-- Keep SECURITY DEFINER membership helpers out of the exposed public API schema.
-- Existing RLS policy dependencies follow ALTER FUNCTION ... SET SCHEMA automatically.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter function public.is_org_member(uuid) set schema private;
alter function public.is_org_admin(uuid) set schema private;

-- RLS policies execute these helpers as the requesting authenticated role.
-- Do not grant anon or PUBLIC execution, and do not expose the private schema
-- through PostgREST's exposed-schema configuration.
revoke all on function private.is_org_member(uuid) from public, anon, authenticated;
revoke all on function private.is_org_admin(uuid) from public, anon, authenticated;
grant execute on function private.is_org_member(uuid) to authenticated, service_role;
grant execute on function private.is_org_admin(uuid) to authenticated, service_role;

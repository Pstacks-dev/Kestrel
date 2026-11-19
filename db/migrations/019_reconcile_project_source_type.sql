-- Reconcile the projects schema with the control-plane API and upload-only project support.
-- Older production databases may not have received migration 005, while API routes
-- now read/write source_type. Keep this migration safe to apply more than once.

alter table public.projects
  add column if not exists source_type text not null default 'git';

update public.projects
set source_type = case when repository_url is null then 'upload' else 'git' end;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_source_type_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_source_type_check
      check (source_type in ('git', 'upload'));
  end if;
end $$;

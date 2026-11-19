-- Support projects created from a direct source upload without requiring a Git remote.
alter table public.projects alter column repository_url drop not null;
alter table public.projects
  add column if not exists source_type text not null default 'git'
  check (source_type in ('git', 'upload'));
update public.projects set source_type = 'git' where repository_url is not null;
update public.projects set source_type = 'upload' where repository_url is null;

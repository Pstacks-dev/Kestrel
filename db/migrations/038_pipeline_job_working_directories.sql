alter table public.jobs
  add column if not exists working_directory text not null default '.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'jobs_working_directory_safe'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_working_directory_safe
      check (
        working_directory = '.'
        or (
          length(working_directory) between 1 and 512
          and left(working_directory, 1) <> '/'
          and right(working_directory, 1) <> '/'
          and position(chr(92) in working_directory) = 0
          and position('//' in working_directory) = 0
          and working_directory !~ '(^|/)\.{1,2}(/|$)'
          and working_directory !~ '^[A-Za-z]:'
          and working_directory !~ '[[:cntrl:]]'
        )
      );
  end if;
end
$$;

comment on column public.jobs.working_directory is
  'Safe repository-relative directory used as the working directory for this pipeline job.';

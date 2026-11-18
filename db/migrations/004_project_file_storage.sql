-- Private object storage for project source uploads.
-- All access is mediated by the authenticated Kestrel API; the service key is server-only.
insert into storage.buckets (id, name, public, file_size_limit)
values ('kestrel-project-files', 'kestrel-project-files', false, 20971520)
on conflict (id) do update
set public = false, file_size_limit = 20971520;

-- Do not add public object policies. Kestrel's API verifies workspace membership
-- and uses short-lived signed download URLs for authorized project members.

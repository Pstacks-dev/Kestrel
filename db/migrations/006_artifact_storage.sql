-- Private storage bucket for build artifacts. All access is mediated by Kestrel.
insert into storage.buckets (id, name, public, file_size_limit)
values ('kestrel-artifacts', 'kestrel-artifacts', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = 104857600;

alter table public.artifacts
  add column if not exists content_type text not null default 'application/octet-stream';

-- Retry metadata for hosted deployments. Request payload is encrypted at application level.
alter table public.hosting_provider_deployments
  add column if not exists retry_count integer not null default 0 check (retry_count between 0 and 3),
  add column if not exists retry_payload_ciphertext text,
  add column if not exists retry_payload_iv text,
  add column if not exists retry_payload_tag text;

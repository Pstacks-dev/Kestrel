-- Use Supabase's managed Postgres scheduler for sub-minute platform queue work.
-- This avoids Vercel Hobby's once-per-day cron restriction while keeping the
-- durable queue and scheduling state inside the managed Supabase project.
create extension if not exists pg_cron;
create extension if not exists pg_net;

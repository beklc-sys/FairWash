-- FairWash V6: einmal im Supabase SQL Editor ausführen.
-- Danach unter Authentication > Providers > Anonymous Sign-Ins aktivieren.

create extension if not exists pgcrypto;

create table if not exists public.fairwash_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  invite_token uuid not null unique default gen_random_uuid(),
  state jsonb not null default '{"participantCount":2,"names":["Person 1","Person 2","Person 3","Person 4","Person 5"],"factors":{"amount":2,"fat":2,"difficulty":2},"history":[]}'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fairwash_group_devices (
  group_id uuid not null references public.fairwash_groups(id) on delete cascade,
  user_id uuid not null,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.fairwash_groups enable row level security;
alter table public.fairwash_group_devices enable row level security;

revoke all on public.fairwash_groups from anon, authenticated;
revoke all on public.fairwash_group_devices from anon, authenticated;
grant select, update on public.fairwash_groups to authenticated;
grant select on public.fairwash_group_devices to authenticated;

create or replace function public.is_fairwash_member(target_group uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.fairwash_group_devices
    where group_id = target_group and user_id = auth.uid()
  );
$$;

create policy "members can read group"
on public.fairwash_groups for select
to authenticated
using (public.is_fairwash_member(id));

create policy "members can update group"
on public.fairwash_groups for update
to authenticated
using (public.is_fairwash_member(id))
with check (public.is_fairwash_member(id));

create policy "devices can read own memberships"
on public.fairwash_group_devices for select
to authenticated
using (user_id = auth.uid());

create or replace function public.create_fairwash_group(group_name text, initial_state jsonb)
returns table(group_id uuid, invite_token uuid, name text, state jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_group public.fairwash_groups;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.fairwash_groups(name, state, created_by)
  values (trim(group_name), coalesce(initial_state, '{}'::jsonb), auth.uid())
  returning * into new_group;
  insert into public.fairwash_group_devices(group_id, user_id)
  values (new_group.id, auth.uid());
  return query select new_group.id, new_group.invite_token, new_group.name, new_group.state;
end;
$$;

create or replace function public.join_fairwash_group(token uuid)
returns table(group_id uuid, invite_token uuid, name text, state jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  found_group public.fairwash_groups;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into found_group from public.fairwash_groups where fairwash_groups.invite_token = token;
  if found_group.id is null then raise exception 'group not found'; end if;
  insert into public.fairwash_group_devices(group_id, user_id)
  values (found_group.id, auth.uid()) on conflict do nothing;
  return query select found_group.id, found_group.invite_token, found_group.name, found_group.state;
end;
$$;

grant execute on function public.is_fairwash_member(uuid) to authenticated;
grant execute on function public.create_fairwash_group(text, jsonb) to authenticated;
grant execute on function public.join_fairwash_group(uuid) to authenticated;

create or replace function public.touch_fairwash_group()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists fairwash_groups_touch on public.fairwash_groups;
create trigger fairwash_groups_touch before update on public.fairwash_groups
for each row execute function public.touch_fairwash_group();

-- Realtime für die Gruppentabelle aktivieren.
do $$ begin
  alter publication supabase_realtime add table public.fairwash_groups;
exception when duplicate_object then null;
end $$;

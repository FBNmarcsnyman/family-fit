-- Family Fit: private family data behind a real login.
-- Everything lives in its own schema, walled off from the other tables in this project.
-- The page never reads these tables directly. It calls the ff_* functions below, which check who is
-- signed in and what that person may do. Kids can only change their own things, can't approve
-- their own quests or runs, can't clear their own penalties, and can't change their own reward settings.
--
-- To remove it all:
--   drop schema familyfit cascade;
--   drop function public.ff_me(), public.ff_pull(bigint), public.ff_put(text, jsonb, bigint, boolean),
--     public.ff_holeshot_sync(), public.ff_app_version(), public.ff_app_code();
--   and delete the family logins from Authentication > Users.

create schema if not exists familyfit;
revoke all on schema familyfit from public, anon, authenticated;

-- Who is in the family. One row per login.
create table if not exists familyfit.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  who text not null unique check (who ~ '^[a-z]{2,20}$'),
  role text not null check (role in ('parent', 'kid')),
  created_at timestamptz not null default now()
);

-- Every saved thing is one document at a path such as log_name/2026-11-02 or settings/prefs_name,
-- the same paths the first version used. rev goes up by one on every change, so a device only
-- fetches what changed since it last looked. A deleted document stays as a marker so devices hear about it.
create sequence if not exists familyfit.rev_seq;
create table if not exists familyfit.docs (
  path text primary key check (path ~ '^[A-Za-z0-9_-]{1,60}/[A-Za-z0-9_.:@+-]{1,120}$'),
  data jsonb,
  deleted boolean not null default false,
  rev bigint not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index if not exists docs_rev on familyfit.docs (rev);

-- The app's own screens and logic. They hold personal details, so they are kept here behind the
-- login instead of on the public website. Only the publishing script writes this row.
create table if not exists familyfit.app (
  id int primary key default 1 check (id = 1),
  version text not null,
  code text not null,
  updated_at timestamptz not null default now()
);

-- Who is asking. Security definer so the row-level rules below can use it without looping.
create or replace function familyfit.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from familyfit.members where user_id = auth.uid()
$$;
create or replace function familyfit.my_who() returns text
language sql stable security definer set search_path = '' as $$
  select who from familyfit.members where user_id = auth.uid()
$$;

-- Row-level security. The tables can only be read by family members, and nothing can write
-- to them directly: changes go through ff_put, which applies the kid rules.
alter table familyfit.members enable row level security;
alter table familyfit.docs enable row level security;
alter table familyfit.app enable row level security;
drop policy if exists members_read on familyfit.members;
create policy members_read on familyfit.members for select to authenticated using (familyfit.my_role() is not null);
drop policy if exists docs_read on familyfit.docs;
create policy docs_read on familyfit.docs for select to authenticated using (familyfit.my_role() is not null);
drop policy if exists app_read on familyfit.app;
create policy app_read on familyfit.app for select to authenticated using (familyfit.my_role() is not null);
grant usage on schema familyfit to authenticated;
grant select on familyfit.members, familyfit.docs, familyfit.app to authenticated;
grant execute on function familyfit.my_role(), familyfit.my_who() to authenticated;

-- Where a kid may save. Their own log days and settings, plus the family's shared calendar,
-- invites and shopping list. A kid may only delete calendar items and invites they made.
create or replace function familyfit.kid_may(p_path text, p_who text, p_delete boolean, p_old jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_delete then
    return (p_path like 'events/%' or p_path like 'invites/%')
      and (p_old is null or coalesce(p_old->>'by', '') = p_who or coalesce(p_old->>'from', '') = p_who);
  end if;
  return starts_with(p_path, 'log_' || p_who || '/')
    or p_path = 'settings/prefs_' || p_who
    or p_path like 'events/%'
    or p_path like 'invites/%'
    or p_path = 'family/shopping';
end $$;

-- What a kid's save may change. Anything only a parent decides is put back the way it was:
-- reward settings and money, behaviour marks, quest approvals (2), run checks, and penalties,
-- where a kid may only send a "fixed it" photo (status 2) for a parent to check.
create or replace function familyfit.kid_guard(p_path text, p_who text, p_old jsonb, p_new jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  res jsonb := p_new;
  old jsonb := coalesce(p_old, '{}'::jsonb);
  k text;
  v jsonb;
  oq jsonb;
  nq jsonb;
  e jsonb;
  o jsonb;
  oarr jsonb;
  narr jsonb;
  outarr jsonb;
  ids text[];
begin
  if p_path = 'settings/prefs_' || p_who then
    foreach k in array array['xbRate', 'xbBase', 'xbMax', 'moneyMax', 'wkPts', 'jarPct', 'ledger', 'kid', 'hsMile'] loop
      if old ? k then res := jsonb_set(res, array[k], old->k); else res := res - k; end if;
    end loop;
    return res;
  end if;

  if not starts_with(p_path, 'log_' || p_who || '/') then
    return res;
  end if;

  -- Behaviour marks are a parent's.
  if old ? 'beh' then res := jsonb_set(res, '{beh}', old->'beh'); else res := res - 'beh'; end if;

  -- Quests: 1 is "done, waiting", 2 is "approved", and only a parent gives a 2.
  oq := case when jsonb_typeof(old->'q') = 'object' then old->'q' else '{}'::jsonb end;
  nq := case when jsonb_typeof(res->'q') = 'object' then res->'q' else '{}'::jsonb end;
  for k, v in select * from jsonb_each(nq) loop
    if v = '2'::jsonb and (oq->k) is distinct from '2'::jsonb then nq := jsonb_set(nq, array[k], '1'::jsonb); end if;
  end loop;
  for k, v in select * from jsonb_each(oq) loop
    if v = '2'::jsonb then nq := jsonb_set(nq, array[k], '2'::jsonb); end if;
  end loop;
  if res ? 'q' or nq <> '{}'::jsonb then res := jsonb_set(res, '{q}', nq); end if;

  -- Runs: a kid sends a new run (status 1). A run already saved can't be changed by a kid,
  -- and one a parent approved can't be removed.
  oarr := case when jsonb_typeof(old->'runs') = 'array' then old->'runs' else '[]'::jsonb end;
  narr := case when jsonb_typeof(res->'runs') = 'array' then res->'runs' else '[]'::jsonb end;
  outarr := '[]'::jsonb;
  ids := '{}';
  for e in select * from jsonb_array_elements(narr) loop
    o := null;
    select x into o from jsonb_array_elements(oarr) x where x->>'id' = e->>'id' limit 1;
    if o is not null then
      outarr := outarr || jsonb_build_array(o);
    else
      outarr := outarr || jsonb_build_array(jsonb_set(e, '{st}', '1'::jsonb));
    end if;
    ids := ids || coalesce(e->>'id', '');
  end loop;
  for o in select * from jsonb_array_elements(oarr) loop
    if o->>'st' = '2' and not (coalesce(o->>'id', '') = any (ids)) then outarr := outarr || jsonb_build_array(o); end if;
  end loop;
  if res ? 'runs' or jsonb_array_length(outarr) > 0 then res := jsonb_set(res, '{runs}', outarr); end if;

  -- Penalties: a parent gives them and clears them. A kid may only mark an open one as fixed
  -- (status 2) with a photo. Any a kid tries to drop come back.
  oarr := case when jsonb_typeof(old->'pen') = 'array' then old->'pen' else '[]'::jsonb end;
  narr := case when jsonb_typeof(res->'pen') = 'array' then res->'pen' else '[]'::jsonb end;
  outarr := '[]'::jsonb;
  ids := '{}';
  for o in select * from jsonb_array_elements(oarr) loop
    e := null;
    select x into e from jsonb_array_elements(narr) x where x->>'id' = o->>'id' limit 1;
    if e is not null and e->>'st' = '2' and coalesce(o->>'st', '1') in ('0', '1') then
      o := jsonb_set(o, '{st}', '2'::jsonb);
      if e ? 'img2' then o := jsonb_set(o, '{img2}', e->'img2'); end if;
    end if;
    outarr := outarr || jsonb_build_array(o);
    ids := ids || coalesce(o->>'id', '');
  end loop;
  for e in select * from jsonb_array_elements(narr) loop
    if not (coalesce(e->>'id', '') = any (ids)) then outarr := outarr || jsonb_build_array(jsonb_set(e, '{st}', '1'::jsonb)); end if;
  end loop;
  if res ? 'pen' or jsonb_array_length(outarr) > 0 then res := jsonb_set(res, '{pen}', outarr); end if;

  return res;
end $$;

-- Who am I? {ok, who, role}
create or replace function public.ff_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m familyfit.members%rowtype;
begin
  select * into m from familyfit.members where user_id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  return jsonb_build_object('ok', true, 'who', m.who, 'role', m.role);
end $$;

-- Everything that changed after rev p_since. {ok, rev, docs: [{p: path, d: data, x: deleted, r: rev}]}
create or replace function public.ff_pull(p_since bigint default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if familyfit.my_role() is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  select jsonb_build_object(
    'ok', true,
    'rev', coalesce(max(rev), coalesce(p_since, 0)),
    'docs', coalesce(jsonb_agg(jsonb_build_object('p', path, 'd', data, 'x', deleted, 'r', rev) order by rev), '[]'::jsonb))
  into v
  from familyfit.docs
  where rev > coalesce(p_since, 0) and (coalesce(p_since, 0) > 0 or not deleted);
  return v;
end $$;

-- Save or delete one document. p_base is the rev the device's copy came from. If someone else
-- saved it since, nothing is written and the newer copy comes back ("stale"), so the device can
-- fold its change into it and try again, and two devices never wipe each other's ticks.
create or replace function public.ff_put(p_path text, p_data jsonb, p_base bigint default null, p_delete boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_who text;
  v_role text;
  cur familyfit.docs%rowtype;
  had boolean;
  v_old jsonb;
  v_data jsonb := p_data;
  v_rev bigint;
begin
  select who, role into v_who, v_role from familyfit.members where user_id = auth.uid();
  if v_who is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  if p_path is null or p_path !~ '^[A-Za-z0-9_-]{1,60}/[A-Za-z0-9_.:@+-]{1,120}$' then
    return jsonb_build_object('ok', false, 'reason', 'path');
  end if;
  if not p_delete and (v_data is null or jsonb_typeof(v_data) <> 'object') then
    return jsonb_build_object('ok', false, 'reason', 'data');
  end if;
  if not p_delete and octet_length(v_data::text) > 3000000 then
    return jsonb_build_object('ok', false, 'reason', 'size');
  end if;

  -- One save at a time, so revs are handed out in the order they land.
  perform pg_advisory_xact_lock(hashtext('familyfit.docs'));
  select * into cur from familyfit.docs where path = p_path;
  had := found;
  v_old := case when had and not cur.deleted then cur.data else null end;

  if p_base is not null and had and cur.rev <> p_base then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', cur.rev, 'data', v_old);
  end if;

  if v_role <> 'parent' then
    if not coalesce(familyfit.kid_may(p_path, v_who, p_delete, v_old), false) then
      return jsonb_build_object('ok', false, 'reason', 'denied', 'rev', case when had then cur.rev else 0 end, 'data', v_old);
    end if;
    if not p_delete then v_data := familyfit.kid_guard(p_path, v_who, v_old, v_data); end if;
  end if;

  -- Holeshot minutes are worked out on the server only (ff_holeshot_sync), for everyone.
  if not p_delete and p_path ~ '^log_[a-z]+/' then
    if v_old ? 'hs' then v_data := jsonb_set(v_data, '{hs}', v_old->'hs'); else v_data := v_data - 'hs'; end if;
  end if;

  v_rev := nextval('familyfit.rev_seq');
  insert into familyfit.docs as d (path, data, deleted, rev, updated_at, updated_by)
  values (p_path, case when p_delete then null else v_data end, p_delete, v_rev, now(), auth.uid())
  on conflict (path) do update
    set data = excluded.data, deleted = excluded.deleted, rev = excluded.rev,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true, 'rev', v_rev, 'data', case when p_delete then null else v_data end);
end $$;

-- Holeshot results for today and yesterday, read from Holeshot's own results log and written
-- straight onto the boys' days. Rules approved on 2 November 2026: a stage is a race of 5 or more
-- questions scoring 70% or better (not a hot lap). Each stage pays 5 Xbox minutes, up to 6 stages
-- (30 minutes) a day, with no streak bonus. Minutes already given are never taken back.
-- Read-only on Holeshot: it never changes anything in the holeshot schema.
create or replace function public.ff_holeshot_sync() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  per constant int := 5;
  cap constant int := 6;
  sa_today date := (now() at time zone 'Africa/Johannesburg')::date;
  r record;
  v_path text;
  cur familyfit.docs%rowtype;
  v_data jsonb;
  v_hs jsonb;
  v_s int;
  v_m int;
  today jsonb := '{}'::jsonb;
  changed int := 0;
begin
  if familyfit.my_role() is null then return jsonb_build_object('ok', false, 'reason', 'member'); end if;
  perform pg_advisory_xact_lock(hashtext('familyfit.docs'));
  for r in
    select player, (finished_at at time zone 'Africa/Johannesburg')::date as day, count(distinct finished_at)::int as stages
    from holeshot.runs
    where finished_at >= ((sa_today - 1)::timestamp at time zone 'Africa/Johannesburg')
      and player in (select who from familyfit.members where role = 'kid')
      and mode <> 'lap' and total >= 5 and pct >= 70
    group by 1, 2
  loop
    if r.day = sa_today then today := today || jsonb_build_object(r.player, r.stages); end if;
    v_path := 'log_' || r.player || '/' || to_char(r.day, 'YYYY-MM-DD');
    select * into cur from familyfit.docs where path = v_path;
    v_data := case when found and not cur.deleted then cur.data else '{}'::jsonb end;
    v_s := greatest(r.stages, coalesce((v_data->'hs'->>'s')::int, 0));
    v_m := greatest(least(v_s, cap) * per, coalesce((v_data->'hs'->>'m')::int, 0));
    v_hs := jsonb_build_object('s', v_s, 'm', v_m, 'auto', 1);
    if (v_data->'hs') is distinct from v_hs then
      insert into familyfit.docs as d (path, data, deleted, rev, updated_at, updated_by)
      values (v_path, jsonb_set(v_data, '{hs}', v_hs), false, nextval('familyfit.rev_seq'), now(), auth.uid())
      on conflict (path) do update
        set data = excluded.data, deleted = false, rev = excluded.rev,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by;
      changed := changed + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'today', today, 'changed', changed, 'per', per, 'cap', cap);
end $$;

-- The app's screens, for family members only.
create or replace function public.ff_app_version() returns text
language sql stable security definer set search_path = '' as $$
  select version from familyfit.app where id = 1 and familyfit.my_role() is not null
$$;
create or replace function public.ff_app_code() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version', version, 'code', code) from familyfit.app where id = 1 and familyfit.my_role() is not null
$$;

-- Only signed-in people can call these, and the functions themselves check for a family login.
revoke all on function public.ff_me(), public.ff_pull(bigint), public.ff_put(text, jsonb, bigint, boolean),
  public.ff_holeshot_sync(), public.ff_app_version(), public.ff_app_code() from public, anon;
grant execute on function public.ff_me(), public.ff_pull(bigint), public.ff_put(text, jsonb, bigint, boolean),
  public.ff_holeshot_sync(), public.ff_app_version(), public.ff_app_code() to authenticated;
revoke all on function familyfit.kid_may(text, text, boolean, jsonb), familyfit.kid_guard(text, text, jsonb, jsonb) from public, anon, authenticated;

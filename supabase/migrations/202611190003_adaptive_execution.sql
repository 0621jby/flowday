begin;

-- Optional metadata kept beside the existing normalized workspace. Both are
-- committed under the same account row lock and revision.
create table public.workspace_execution (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  extra jsonb not null check (jsonb_typeof(extra) = 'object' and octet_length(extra::text) <= 5242880)
);
alter table public.workspace_execution enable row level security;
revoke all on public.workspace_execution from public, anon, authenticated;
grant select on public.workspace_execution to authenticated;
create policy own_execution on public.workspace_execution for select to authenticated
  using (user_id = (select auth.uid()));

alter function public.flowday_snapshot() rename to flowday_snapshot_v1;
create function public.flowday_snapshot() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_set(
    jsonb_set(
      jsonb_set(s.base || (e.extra - 'taskMeta' - 'growth' - 'tracking'),
        '{tasks}', (select coalesce(jsonb_agg(
          t.value || case when e.extra->'taskMeta' ? (t.value->>'id')
            then jsonb_build_object('execution', e.extra->'taskMeta'->(t.value->>'id'))
            else '{}'::jsonb end order by t.ordinality), '[]')
          from jsonb_array_elements(s.base->'tasks') with ordinality t)),
      '{settings}', (s.base->'settings') || coalesce(jsonb_build_object('growth',e.extra->'growth') - case when e.extra ? 'growth' then '' else 'growth' end,'{}')),
    '{session}', case when s.base->'session' <> 'null' and e.extra ? 'tracking'
      then (s.base->'session') || jsonb_build_object('tracking',e.extra->'tracking')
      else s.base->'session' end)
  from (select public.flowday_snapshot_v1() as base) s
  cross join (select coalesce((select x.extra from public.workspace_execution x where x.user_id=auth.uid()),'{}') as extra) e;
$$;
revoke all on function public.flowday_snapshot() from public, anon, authenticated;

alter function public.flowday_save(jsonb,bigint,uuid,boolean) rename to flowday_save_v1;
revoke all on function public.flowday_save_v1(jsonb,bigint,uuid,boolean) from public, anon, authenticated;
create function public.flowday_save(p_state jsonb,p_expected bigint,p_mutation uuid,p_import boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous jsonb;
  incoming jsonb;
  metadata jsonb;
  result jsonb;
  before_revision bigint;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  perform public.flowday_load();
  select revision into before_revision from public.workspaces where user_id=actor for update;
  result := public.flowday_save_v1(p_state,p_expected,p_mutation,p_import);
  if before_revision = (result#>>'{state,revision}')::bigint then
    return jsonb_set(result,'{state}',public.flowday_snapshot());
  end if;

  select extra into previous from public.workspace_execution where user_id=actor;
  if previous ? 'executionVersion' and (p_state->'executionVersion') is distinct from '1'::jsonb then
    raise exception 'INVALID_EXECUTION_VERSION';
  end if;
  previous := previous->'executionLog';
  incoming := p_state->'executionLog';
  if incoming is not null and (jsonb_typeof(incoming) <> 'array' or jsonb_array_length(incoming)>50000) then
    raise exception 'INVALID_EXECUTION_LOG';
  end if;
  if previous is not null and (incoming is null or jsonb_array_length(incoming)<jsonb_array_length(previous)
    or exists(select 1 from jsonb_array_elements(previous) with ordinality old
      where old.value is distinct from incoming->((old.ordinality-1)::int))) then
    raise exception 'INVALID_EXECUTION_HISTORY';
  end if;
  if exists(select 1 from jsonb_array_elements(p_state->'tasks') t
    where t ? 'execution' and jsonb_typeof(t->'execution') <> 'object') then
    raise exception 'INVALID_TASK_EXECUTION';
  end if;
  select coalesce(jsonb_object_agg(t->>'id',t->'execution'),'{}') into metadata
    from jsonb_array_elements(p_state->'tasks') t where t ? 'execution';
  insert into public.workspace_execution(user_id,extra) values(actor,
    coalesce((select jsonb_object_agg(key,value) from jsonb_each(p_state)
      where key in ('executionLog','availability','fixedTimes','executionVersion')),'{}')
    || jsonb_build_object('taskMeta',metadata)
    || case when (p_state->'settings') ? 'growth' then jsonb_build_object('growth',p_state#>'{settings,growth}') else '{}'::jsonb end
    || case when (p_state->'session') ? 'tracking' then jsonb_build_object('tracking',p_state#>'{session,tracking}') else '{}'::jsonb end)
  on conflict(user_id) do update set extra=excluded.extra;
  return jsonb_set(result,'{state}',public.flowday_snapshot());
end $$;
revoke all on function public.flowday_save(jsonb,bigint,uuid,boolean) from public, anon, authenticated;
grant execute on function public.flowday_save(jsonb,bigint,uuid,boolean) to authenticated;

-- The newer client uses this entry point so an unmigrated database fails
-- before touching the older tables.
create function public.flowday_save_v13(p_state jsonb,p_expected bigint,p_mutation uuid,p_import boolean default false) returns jsonb
language sql volatile security invoker set search_path='' as $$
  select public.flowday_save(p_state,p_expected,p_mutation,p_import);
$$;
revoke all on function public.flowday_save_v13(jsonb,bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.flowday_save_v13(jsonb,bigint,uuid,boolean) to authenticated;
commit;

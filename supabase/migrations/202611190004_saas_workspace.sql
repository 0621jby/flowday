begin;

alter table public.tasks add column execution jsonb check(execution is null or jsonb_typeof(execution)='object');
create table public.execution_history (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  id text not null check(length(id) between 1 and 128),
  task_id text not null check(length(task_id) between 1 and 128),
  at timestamptz not null,
  type text not null check(type in ('start','pause','resume','stop','complete','reopen','defer','abandon','restore','commit','split')),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<4096),
  position bigint generated always as identity,
  primary key(user_id,id)
);
create index history_page on public.execution_history(user_id,at desc,id desc);
create index history_task_page on public.execution_history(user_id,task_id,at desc,id desc);
create index history_kind_window on public.execution_history(user_id,type,at desc);
create index history_estimate_kind on public.execution_history(user_id,(payload->>'kind'),at desc)
  where type='complete' and payload->>'completeCoverage'='true';
create index event_page on public.execution_events(user_id,occurred_at desc,id desc);
create index event_task_page on public.execution_events(user_id,task_id,occurred_at desc,id desc);
create index event_position on public.execution_events(user_id,position desc);
create index task_position on public.tasks(user_id,position desc);
create index completed_task_page on public.tasks(user_id,completed_at desc,id desc) where completed_at is not null;
create table public.workspace_mutations (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  id uuid not null,
  digest text not null,
  revision bigint not null,
  created_at timestamptz not null default now(),
  primary key(user_id,id)
);
create index mutation_expiry on public.workspace_mutations(user_id,created_at);
alter table public.execution_history enable row level security;
alter table public.workspace_mutations enable row level security;
revoke all on public.execution_history,public.workspace_mutations from public,anon,authenticated;
grant select on public.execution_history to authenticated;
create policy own_execution_history on public.execution_history for select to authenticated using(user_id=(select auth.uid()));

-- Preserve the original imported data and split large collections from the metadata row.
create function public.flowday_promote_history(p_actor uuid) returns void
language plpgsql set search_path='' as $$
begin
  update public.tasks t set execution=x.extra->'taskMeta'->t.id
    from public.workspace_execution x
    where t.user_id=p_actor and x.user_id=t.user_id and (x.extra->'taskMeta') ? t.id;
  insert into public.execution_history(user_id,id,task_id,at,type,payload)
    select x.user_id,e.value->>'id',e.value->>'taskId',(e.value->>'at')::timestamptz,e.value->>'type',e.value
    from public.workspace_execution x cross join lateral jsonb_array_elements(x.extra->'executionLog') with ordinality e
    where x.user_id=p_actor order by e.ordinality on conflict do nothing;
  update public.workspace_execution set extra=extra-'taskMeta'-'executionLog' where user_id=p_actor;
end $$;
revoke all on function public.flowday_promote_history(uuid) from public,anon,authenticated;
do $$ declare owner uuid; begin
  for owner in select user_id from public.workspace_execution loop perform public.flowday_promote_history(owner); end loop;
end $$;

create function public.flowday_task_json(t public.tasks) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',t.id,'goalId',t.goal_id,'title',t.title,'notes',t.notes,'minutes',t.minutes,
    'priority',t.priority,'status',t.status,'date',coalesce(t.planned_date::text,''),'createdAt',t.created_at,'completedAt',t.completed_at)
    || case when t.execution is not null then jsonb_build_object('execution',t.execution) else '{}'::jsonb end
$$;
create function public.flowday_review_json(r public.daily_reviews) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('date',r.date,'text',r.text,'mood',r.mood,'drawing',r.drawing)
$$;
create function public.flowday_event_json(e public.execution_events) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object('id',e.id,'taskId',e.task_id,'type',e.type,'at',e.occurred_at,'seconds',e.seconds))
$$;

create function public.flowday_header() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'schemaVersion',1,'executionVersion',1,'revision',w.revision,
    'settings',jsonb_build_object('name',p.display_name,'dayStart',p.day_start,'dayEnd',p.day_end,'capacity',p.capacity)
      || coalesce(x.extra->'settingsExtra','{}')
      || case when x.extra ? 'growth' then jsonb_build_object('growth',x.extra->'growth') else '{}'::jsonb end,
    'goals',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'title',g.title,'description',g.description,'color',g.color,'targetDate',coalesce(g.target_date::text,'')) order by g.position,g.id)
      from public.goals g where g.user_id=w.user_id),'[]'),
    'blocks',coalesce((select jsonb_agg(jsonb_build_object('taskId',b.task_id,'date',b.date,'start',b.start_minute,'end',b.end_minute,'locked',b.locked) order by b.position,b.task_id)
      from public.schedule_blocks b where b.user_id=w.user_id),'[]'),
    'session',(select jsonb_build_object('taskId',f.task_id,'startedAt',f.started_at_ms,'accumulated',f.accumulated,'running',f.running)
      || case when x.extra ? 'tracking' then jsonb_build_object('tracking',x.extra->'tracking') else '{}'::jsonb end
      from public.focus_sessions f where f.user_id=w.user_id)
  ) || coalesce((select jsonb_object_agg(key,value) from jsonb_each(x.extra) where key in ('availability','fixedTimes')),'{}')
  from public.workspaces w join public.user_preferences p using(user_id)
  left join public.workspace_execution x using(user_id) where w.user_id=auth.uid()
$$;
revoke all on function public.flowday_header() from public,anon,authenticated;

create function public.flowday_bootstrap(p_today date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); base jsonb;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_today is null or abs(p_today-current_date)>2 then raise exception 'INVALID_DATE'; end if;
  insert into public.profiles(user_id) values(actor) on conflict do nothing;
  insert into public.workspaces(user_id) values(actor) on conflict do nothing;
  insert into public.user_preferences(user_id) values(actor) on conflict do nothing;
  -- Read payload and revision together in one SQL snapshot.
  with owned as materialized (select * from public.tasks where user_id=actor),
  linked as (
    select t.id from owned t where t.status='todo' or t.completed_at >= p_today - 30
    union select b.task_id from public.schedule_blocks b where b.user_id=actor
    union select t.execution->>'parentId' from owned t where t.execution ? 'parentId'
    union select jsonb_array_elements_text(t.execution->'dependencies') from owned t where jsonb_typeof(t.execution->'dependencies')='array'
  )
  select public.flowday_header() || jsonb_build_object(
    'tasks',coalesce((select jsonb_agg(public.flowday_task_json(t) order by t.position,t.id) from owned t join linked l on t.id=l.id),'[]'),
    'reviews',coalesce((select jsonb_agg(public.flowday_review_json(r)) from public.daily_reviews r where r.user_id=actor and r.date=p_today),'[]'),
    'events',coalesce((select jsonb_agg(public.flowday_event_json(e) order by e.position,e.id)
      from (select * from public.execution_events where user_id=actor and occurred_at>=p_today-2 order by occurred_at desc,id desc limit 300) e),'[]'),
    'executionLog',coalesce((select jsonb_agg(h.payload order by h.position)
      from (select * from public.execution_history where user_id=actor and (at>=p_today-2 or (type='complete' and at>=p_today-90 and payload->>'completeCoverage'='true'))
          order by at desc,id desc limit 400) h),'[]')
  ) into base;
  return base;
end $$;

create function public.flowday_export() returns jsonb
language sql stable security definer set search_path='' as $$
  select public.flowday_header() || jsonb_build_object(
    'tasks',coalesce((select jsonb_agg(public.flowday_task_json(t) order by t.position,t.id) from public.tasks t where t.user_id=auth.uid()),'[]'),
    'reviews',coalesce((select jsonb_agg(public.flowday_review_json(r) order by r.position,r.date) from public.daily_reviews r where r.user_id=auth.uid()),'[]'),
    'events',coalesce((select jsonb_agg(public.flowday_event_json(e) order by e.position,e.id) from public.execution_events e where e.user_id=auth.uid()),'[]'),
    'executionLog',coalesce((select jsonb_agg(h.payload order by h.position) from public.execution_history h where h.user_id=auth.uid()),'[]'))
$$;

create function public.flowday_import_v15(p_state jsonb,p_expected bigint,p_mutation uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  result:=public.flowday_save(p_state,p_expected,p_mutation,true);
  if not coalesce((result->>'alreadyImported')::boolean,false) then
    perform public.flowday_promote_history(actor);
    update public.workspace_execution set extra=extra || jsonb_build_object(
      'settingsExtra',coalesce((select jsonb_object_agg(key,value) from jsonb_each(p_state->'settings')
        where key in ('onboardingComplete','aiEnabled')),'{}')) where user_id=actor;
  end if;
  return jsonb_set(result,'{state}',public.flowday_export());
end $$;

create function public.flowday_apply_delta(p_revision bigint,p_mutation uuid,p_delta jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); current_revision bigint; receipt public.workspace_mutations%rowtype;
  digest text; item jsonb; extra jsonb; prefs jsonb; pos integer; block_dates date[]; removed_tasks text[]; graph_changed boolean;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_revision is null or p_mutation is null or jsonb_typeof(p_delta) is distinct from 'object' or octet_length(p_delta::text)>5242880 then raise exception 'INVALID_DELTA'; end if;
  digest:=encode(sha256(convert_to(p_delta::text,'UTF8')),'hex');
  select revision into current_revision from public.workspaces where user_id=actor for update;
  select * into receipt from public.workspace_mutations where user_id=actor and id=p_mutation;
  if found then
    if receipt.digest<>digest then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return jsonb_build_object('savedRevision',receipt.revision,'revision',current_revision);
  end if;
  if current_revision is distinct from p_revision then raise exception 'REVISION_CONFLICT'; end if;

  select coalesce((select x.extra from public.workspace_execution x where x.user_id=actor),'{}') into extra;
  select exists(
    select 1 from jsonb_array_elements(p_delta#>'{tasks,put}') row
    left join public.tasks t on t.user_id=actor and t.id=row->>'id'
    where coalesce(t.execution->'dependencies','[]')<>coalesce((row->'execution')->'dependencies','[]')
      or (t.execution->>'parentId') is distinct from (row#>>'{execution,parentId}')
  ) into graph_changed;
  if p_delta ? 'session' then delete from public.focus_sessions where user_id=actor; end if;
  delete from public.schedule_blocks where user_id=actor and task_id in (select jsonb_array_elements_text(p_delta#>'{blocks,remove}'));
  if p_delta#>'{goals,put}' is not null then select coalesce(max(position),0) into pos from public.goals where user_id=actor; end if;
  for item in select value from jsonb_array_elements(p_delta#>'{goals,put}') loop
    pos:=pos+1;
    insert into public.goals values(actor,item->>'id',item->>'title',item->>'description',item->>'color',nullif(item->>'targetDate','')::date,pos)
    on conflict(user_id,id) do update set title=excluded.title,description=excluded.description,color=excluded.color,target_date=excluded.target_date;
  end loop;
  if p_delta#>'{tasks,put}' is not null then select coalesce(max(position),0) into pos from public.tasks where user_id=actor; end if;
  for item in select value from jsonb_array_elements(p_delta#>'{tasks,put}') loop
    pos:=pos+1;
    insert into public.tasks(user_id,id,goal_id,title,notes,minutes,priority,status,planned_date,created_at,completed_at,position,execution)
    values(actor,item->>'id',item->>'goalId',item->>'title',item->>'notes',(item->>'minutes')::smallint,
      item->>'priority',item->>'status',nullif(item->>'date','')::date,(item->>'createdAt')::timestamptz,(item->>'completedAt')::timestamptz,pos,item->'execution')
    on conflict(user_id,id) do update set goal_id=excluded.goal_id,title=excluded.title,notes=excluded.notes,minutes=excluded.minutes,
      priority=excluded.priority,status=excluded.status,planned_date=excluded.planned_date,completed_at=excluded.completed_at,execution=excluded.execution;
  end loop;
  if exists(select 1 from jsonb_array_elements_text(p_delta->'removeGoalsWithTasks') g
    where not coalesce((p_delta#>'{goals,remove}') ? g.value,false)) then raise exception 'INVALID_GOAL_DELETE'; end if;
  select array_agg(id) into removed_tasks from (
    select value id from jsonb_array_elements_text(p_delta#>'{tasks,remove}')
    union select id from public.tasks where user_id=actor and goal_id in
      (select jsonb_array_elements_text(p_delta->'removeGoalsWithTasks'))
  ) removal;
  if exists(select 1 from public.focus_sessions where user_id=actor and task_id=any(removed_tasks)) then raise exception 'INVALID_ACTIVE_TASK'; end if;
  delete from public.tasks where user_id=actor and id=any(removed_tasks);
  if cardinality(removed_tasks)>0 then
    update public.tasks t set execution=(t.execution - case when t.execution->>'parentId'=any(removed_tasks) then 'parentId' else '' end)
      || case when jsonb_typeof(t.execution->'dependencies')='array' then jsonb_build_object('dependencies',
        coalesce((select jsonb_agg(d.value) from jsonb_array_elements_text(t.execution->'dependencies') d where not d.value=any(removed_tasks)),'[]'))
        else '{}'::jsonb end
      where t.user_id=actor and (t.execution->>'parentId'=any(removed_tasks) or (t.execution->'dependencies') ?| removed_tasks);
  end if;
  update public.tasks set goal_id=null where user_id=actor and goal_id in (select jsonb_array_elements_text(p_delta#>'{goals,remove}'));
  delete from public.goals where user_id=actor and id in (select jsonb_array_elements_text(p_delta#>'{goals,remove}'));
  if p_delta#>'{blocks,put}' is not null then select coalesce(max(position),0) into pos from public.schedule_blocks where user_id=actor; end if;
  for item in select value from jsonb_array_elements(p_delta#>'{blocks,put}') loop
    pos:=pos+1;
    insert into public.daily_plans values(actor,(item->>'date')::date) on conflict do nothing;
    insert into public.schedule_blocks values(actor,item->>'taskId',(item->>'date')::date,(item->>'start')::smallint,(item->>'end')::smallint,coalesce((item->>'locked')::boolean,false),pos)
    on conflict(user_id,task_id) do update set date=excluded.date,start_minute=excluded.start_minute,end_minute=excluded.end_minute,locked=excluded.locked;
  end loop;
  if p_delta ? 'blocks' or p_delta ? 'tasks' then
    if exists(select 1 from public.schedule_blocks b join public.tasks t on t.user_id=b.user_id and t.id=b.task_id
      where b.user_id=actor and (t.status<>'todo' or t.planned_date is distinct from b.date or t.execution ? 'abandonedAt')) then raise exception 'INVALID_SCHEDULE'; end if;
    select array_agg(distinct (value->>'date')::date) into block_dates from jsonb_array_elements(p_delta#>'{blocks,put}');
    if exists(select 1 from (select start_minute,lag(end_minute) over(partition by date order by start_minute,task_id) previous_end
      from public.schedule_blocks where user_id=actor and date=any(block_dates)) b where b.start_minute<b.previous_end) then raise exception 'SCHEDULE_CONFLICT'; end if;
  end if;
  if graph_changed then
    if exists(select 1 from public.tasks t cross join lateral
        jsonb_array_elements_text(coalesce(t.execution->'dependencies','[]') || case when t.execution ? 'parentId' then jsonb_build_array(t.execution->>'parentId') else '[]'::jsonb end) link
        where t.user_id=actor and not exists(select 1 from public.tasks d where d.user_id=actor and d.id=link.value))
    then raise exception 'INVALID_DEPENDENCY'; end if;
    if exists(with recursive edges as materialized (
      select t.id source,dep.value target from public.tasks t cross join lateral jsonb_array_elements_text(coalesce(t.execution->'dependencies','[]')) dep where t.user_id=actor
      union select t.execution->>'parentId',t.id from public.tasks t where t.user_id=actor and t.execution ? 'parentId'
    ), reach as (
      select e.source,e.target from edges e where e.source in (select value->>'id' from jsonb_array_elements(p_delta#>'{tasks,put}'))
      union select r.source,e.target from reach r join edges e on r.target=e.source
    ) select 1 from reach where source=target) then raise exception 'INVALID_DEPENDENCY_CYCLE'; end if;
  end if;
  delete from public.daily_reviews where user_id=actor and date in (select value::date from jsonb_array_elements_text(p_delta#>'{reviews,remove}'));
  if p_delta#>'{reviews,put}' is not null then select coalesce(max(position),0) into pos from public.daily_reviews where user_id=actor; end if;
  for item in select value from jsonb_array_elements(p_delta#>'{reviews,put}') loop
    pos:=pos+1;
    insert into public.daily_reviews values(actor,(item->>'date')::date,item->>'text',(item->>'mood')::smallint,coalesce(item->'drawing','[]'),pos)
    on conflict(user_id,date) do update set text=excluded.text,mood=excluded.mood,drawing=excluded.drawing;
  end loop;
  if p_delta ? 'events' then
    select coalesce(max(position),0) into pos from public.execution_events where user_id=actor;
    insert into public.execution_events(user_id,id,task_id,type,occurred_at,seconds,position)
      select actor,value->>'id',value->>'taskId',value->>'type',(value->>'at')::timestamptz,(value->>'seconds')::float8,pos+ordinality
      from jsonb_array_elements(p_delta->'events') with ordinality;
  end if;
  insert into public.execution_history(user_id,id,task_id,at,type,payload)
    select actor,value->>'id',value->>'taskId',(value->>'at')::timestamptz,value->>'type',value
    from jsonb_array_elements(p_delta->'executionLog') with ordinality order by ordinality;
  if p_delta ? 'settings' then
    prefs:=p_delta->'settings';
    update public.user_preferences set display_name=prefs->>'name',day_start=(prefs->>'dayStart')::smallint,day_end=(prefs->>'dayEnd')::smallint,capacity=(prefs->>'capacity')::smallint where user_id=actor;
    extra:=(extra-'growth'-'settingsExtra') || coalesce((select jsonb_object_agg(key,value) from jsonb_each(prefs) where key='growth'),'{}')
      || jsonb_build_object('settingsExtra',coalesce((select jsonb_object_agg(key,value) from jsonb_each(prefs) where key in ('onboardingComplete','aiEnabled')),'{}'));
  end if;
  if p_delta ? 'session' then
    item:=p_delta->'session'; extra:=extra-'tracking';
    if item<>'null' then
      insert into public.focus_sessions values(actor,item->>'taskId',(item->>'startedAt')::bigint,(item->>'accumulated')::float8,(item->>'running')::boolean);
      if item ? 'tracking' then extra:=extra || jsonb_build_object('tracking',item->'tracking'); end if;
    end if;
  end if;
  if exists(select 1 from public.focus_sessions f join public.tasks t on t.user_id=f.user_id and t.id=f.task_id where f.user_id=actor and (t.status<>'todo' or t.execution ? 'abandonedAt')) then raise exception 'INVALID_SESSION'; end if;
  if p_delta ? 'availability' then extra:=extra || jsonb_build_object('availability',p_delta->'availability'); end if;
  if p_delta ? 'fixedTimes' then extra:=extra || jsonb_build_object('fixedTimes',p_delta->'fixedTimes'); end if;
  if (p_delta ? 'settings' or p_delta ? 'session' or p_delta ? 'availability' or p_delta ? 'fixedTimes') then
    insert into public.workspace_execution(user_id,extra) values(actor,extra) on conflict(user_id) do update set extra=excluded.extra;
  end if;
  update public.workspaces set revision=revision+1,updated_at=now() where user_id=actor returning revision into current_revision;
  if p_delta ? 'blocks' then
    insert into public.schedule_history(user_id,revision,blocks) values(actor,current_revision,public.flowday_header()->'blocks');
  end if;
  insert into public.workspace_mutations(user_id,id,digest,revision) values(actor,p_mutation,digest,current_revision);
  delete from public.workspace_mutations where user_id=actor and created_at<now()-interval '7 days';
  return jsonb_build_object('savedRevision',current_revision,'revision',current_revision);
end $$;

-- The legacy writer is used only by the guarded empty-account import. It must
-- not bypass append-only history or erase fields a newer device has written.
revoke all on function public.flowday_load(),public.flowday_save(jsonb,bigint,uuid,boolean),public.flowday_save_v13(jsonb,bigint,uuid,boolean) from public,anon,authenticated;
revoke all on function public.flowday_bootstrap(date),public.flowday_export(),public.flowday_import_v15(jsonb,bigint,uuid),public.flowday_apply_delta(bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.flowday_bootstrap(date),public.flowday_export(),public.flowday_import_v15(jsonb,bigint,uuid),public.flowday_apply_delta(bigint,uuid,jsonb) to authenticated;
commit;

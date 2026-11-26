begin;
-- Existing rows keep their legacy identity so older saved edits can sync.
alter table public.schedule_blocks add column block_id text;
update public.schedule_blocks set block_id=task_id;
alter table public.schedule_blocks drop constraint schedule_blocks_pkey;
alter table public.schedule_blocks add primary key(user_id,block_id);
alter table public.schedule_blocks add constraint valid_schedule_block_id check(length(block_id) between 1 and 128);
create index schedule_blocks_task on public.schedule_blocks(user_id,task_id);

create function public.flowday_legacy_block_id() returns trigger
language plpgsql set search_path='' as $$
begin
  new.block_id:=coalesce(new.block_id,new.task_id);
  return new;
end $$;
create trigger flowday_legacy_block_id before insert on public.schedule_blocks
for each row execute function public.flowday_legacy_block_id();
create or replace function public.flowday_snapshot_v1() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'schemaVersion',1,'revision',w.revision,
  'settings',jsonb_build_object('name',p.display_name,'dayStart',p.day_start,'dayEnd',p.day_end,'capacity',p.capacity),
  'goals',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'title',g.title,'description',g.description,'color',g.color,'targetDate',coalesce(g.target_date::text,'')) order by g.position) from public.goals g where g.user_id=w.user_id),'[]'),
  'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'notes',t.notes,'minutes',t.minutes,'priority',t.priority,'status',t.status,'goalId',t.goal_id,'date',coalesce(t.planned_date::text,''),'createdAt',t.created_at,'completedAt',t.completed_at) order by t.position) from public.tasks t where t.user_id=w.user_id),'[]'),
  'blocks',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',nullif(b.block_id,b.task_id),'taskId',b.task_id,'date',b.date,'start',b.start_minute,'end',b.end_minute,'locked',b.locked)) order by b.position) from public.schedule_blocks b where b.user_id=w.user_id),'[]'),
  'reviews',coalesce((select jsonb_agg(jsonb_build_object('date',r.date,'text',r.text,'mood',r.mood,'drawing',r.drawing) order by r.position) from public.daily_reviews r where r.user_id=w.user_id),'[]'),
  'events',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',e.id,'taskId',e.task_id,'type',e.type,'at',e.occurred_at,'seconds',e.seconds)) order by e.position) from public.execution_events e where e.user_id=w.user_id),'[]'),
  'session',(select jsonb_build_object('taskId',f.task_id,'startedAt',f.started_at_ms,'accumulated',f.accumulated,'running',f.running) from public.focus_sessions f where f.user_id=w.user_id)
 ) from public.workspaces w join public.user_preferences p using(user_id) where w.user_id=auth.uid();
$$;

create or replace function public.flowday_save_v1(p_state jsonb, p_expected bigint, p_mutation uuid, p_import boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 actor uuid := auth.uid(); w public.workspaces%rowtype; v_source_hash text;
 before_blocks jsonb; x jsonb; pos bigint; counts jsonb; receipt public.local_imports%rowtype;
begin
 if actor is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_mutation is null or p_expected is null or p_state is null or p_import is null or jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text)>5242880 then raise exception 'INVALID_PAYLOAD'; end if;
 if p_state->>'schemaVersion' is distinct from '1' or p_state->>'revision' is distinct from p_expected::text then raise exception 'INVALID_PAYLOAD'; end if;
 foreach x in array array[p_state->'tasks',p_state->'goals',p_state->'blocks',p_state->'reviews',p_state->'events'] loop
   if x is null or jsonb_typeof(x) <> 'array' then raise exception 'INVALID_PAYLOAD'; end if;
 end loop;
 if jsonb_array_length(p_state->'tasks')>10000 or jsonb_array_length(p_state->'goals')>2000 or jsonb_array_length(p_state->'blocks')>10000 or jsonb_array_length(p_state->'reviews')>10000 or jsonb_array_length(p_state->'events')>50000 then raise exception 'INVALID_PAYLOAD'; end if;
 perform public.flowday_load();
 select * into w from public.workspaces where user_id=actor for update;
 v_source_hash := encode(sha256(convert_to((p_state-'revision')::text,'UTF8')),'hex');
 if p_import then
   select * into receipt from public.local_imports where user_id=actor and source_hash=v_source_hash;
   if found then return jsonb_build_object('state',public.flowday_snapshot(),'alreadyImported',true,'receipt',to_jsonb(receipt)-'user_id'); end if;
 end if;
 if w.last_mutation=p_mutation then
   if w.last_hash is distinct from v_source_hash then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
   return jsonb_build_object('state',public.flowday_snapshot(),'alreadyImported',false);
 end if;
 if w.revision <> p_expected then raise exception 'REVISION_CONFLICT'; end if;
 -- Import only into a never-edited account: no silent merge or overwriting.
 if p_import and w.revision <> 0 then raise exception 'IMPORT_NOT_EMPTY'; end if;
 before_blocks := public.flowday_snapshot()->'blocks';
 delete from public.focus_sessions where user_id=actor;
 delete from public.schedule_blocks where user_id=actor;
 delete from public.tasks where user_id=actor;
 delete from public.goals where user_id=actor;
 delete from public.daily_plans where user_id=actor;
 delete from public.daily_reviews where user_id=actor;
 delete from public.execution_events where user_id=actor;
 update public.user_preferences set display_name=p_state#>>'{settings,name}',day_start=(p_state#>>'{settings,dayStart}')::smallint,day_end=(p_state#>>'{settings,dayEnd}')::smallint,capacity=(p_state#>>'{settings,capacity}')::smallint where user_id=actor;
 for x,pos in select value,ordinality from jsonb_array_elements(p_state->'goals') with ordinality loop
   insert into public.goals values(actor,x->>'id',x->>'title',x->>'description',x->>'color',nullif(x->>'targetDate','')::date,pos);
 end loop;
 for x,pos in select value,ordinality from jsonb_array_elements(p_state->'tasks') with ordinality loop
   insert into public.tasks values(actor,x->>'id',x->>'goalId',x->>'title',x->>'notes',(x->>'minutes')::smallint,x->>'priority',x->>'status',nullif(x->>'date','')::date,(x->>'createdAt')::timestamptz,(x->>'completedAt')::timestamptz,pos);
 end loop;
 insert into public.daily_plans(user_id,date) select actor,planned_date from public.tasks where user_id=actor and planned_date is not null group by planned_date;
 for x,pos in select value,ordinality from jsonb_array_elements(p_state->'blocks') with ordinality loop
   insert into public.daily_plans(user_id,date) values(actor,(x->>'date')::date) on conflict do nothing;
   insert into public.schedule_blocks values(actor,x->>'taskId',(x->>'date')::date,(x->>'start')::smallint,(x->>'end')::smallint,coalesce((x->>'locked')::boolean,false),pos,coalesce(x->>'id',x->>'taskId'));
 end loop;
 if exists(select 1 from public.schedule_blocks b join public.tasks t on t.user_id=b.user_id and t.id=b.task_id where b.user_id=actor and (t.status<>'todo')) then raise exception 'INVALID_SCHEDULE'; end if;
 if exists(select 1 from public.schedule_blocks a join public.schedule_blocks b on a.user_id=b.user_id and a.date=b.date and a.block_id<b.block_id and a.start_minute<b.end_minute and b.start_minute<a.end_minute where a.user_id=actor) then raise exception 'SCHEDULE_CONFLICT'; end if;
 for x,pos in select value,ordinality from jsonb_array_elements(p_state->'reviews') with ordinality loop
   insert into public.daily_reviews values(actor,(x->>'date')::date,x->>'text',(x->>'mood')::smallint,coalesce(x->'drawing','[]'),pos);
 end loop;
 for x,pos in select value,ordinality from jsonb_array_elements(p_state->'events') with ordinality loop
   insert into public.execution_events values(actor,x->>'id',x->>'taskId',x->>'type',(x->>'at')::timestamptz,(x->>'seconds')::float8,pos);
 end loop;
 x := p_state->'session';
 if x is null then raise exception 'INVALID_SESSION'; end if;
 if x <> 'null'::jsonb then
   if not exists(select 1 from public.tasks where user_id=actor and id=x->>'taskId' and status='todo') then raise exception 'INVALID_SESSION'; end if;
   insert into public.focus_sessions values(actor,x->>'taskId',(x->>'startedAt')::bigint,(x->>'accumulated')::float8,(x->>'running')::boolean);
 end if;
 update public.workspaces set revision=revision+1,last_mutation=p_mutation,last_hash=v_source_hash,updated_at=now() where user_id=actor;
 if before_blocks is distinct from public.flowday_snapshot()->'blocks' then
   insert into public.schedule_history(user_id,revision,blocks) values(actor,w.revision+1,public.flowday_snapshot()->'blocks');
 end if;
 if p_import then
   counts := jsonb_build_object('tasks',jsonb_array_length(p_state->'tasks'),'goals',jsonb_array_length(p_state->'goals'),'blocks',jsonb_array_length(p_state->'blocks'),'reviews',jsonb_array_length(p_state->'reviews'),'events',jsonb_array_length(p_state->'events'));
   insert into public.local_imports(user_id,source_hash,imported_revision,counts) values(actor,v_source_hash,w.revision+1,counts) returning * into receipt;
 end if;
 return jsonb_build_object('state',public.flowday_snapshot(),'alreadyImported',false,'receipt',case when p_import then to_jsonb(receipt)-'user_id' else null end);
end $$;

create or replace function public.flowday_header() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'schemaVersion',1,'executionVersion',1,'revision',w.revision,
    'settings',jsonb_build_object('name',p.display_name,'dayStart',p.day_start,'dayEnd',p.day_end,'capacity',p.capacity)
      || coalesce(x.extra->'settingsExtra','{}')
      || case when x.extra ? 'growth' then jsonb_build_object('growth',x.extra->'growth') else '{}'::jsonb end,
    'goals',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'title',g.title,'description',g.description,'color',g.color,'targetDate',coalesce(g.target_date::text,'')) order by g.position,g.id)
      from public.goals g where g.user_id=w.user_id),'[]'),
    'blocks',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',nullif(b.block_id,b.task_id),'taskId',b.task_id,'date',b.date,'start',b.start_minute,'end',b.end_minute,'locked',b.locked)) order by b.position,b.task_id)
      from public.schedule_blocks b where b.user_id=w.user_id),'[]'),
    'session',(select jsonb_build_object('taskId',f.task_id,'startedAt',f.started_at_ms,'accumulated',f.accumulated,'running',f.running)
      || case when x.extra ? 'tracking' then jsonb_build_object('tracking',x.extra->'tracking') else '{}'::jsonb end
      from public.focus_sessions f where f.user_id=w.user_id)
  ) || coalesce((select jsonb_object_agg(key,value) from jsonb_each(x.extra) where key in ('availability','fixedTimes')),'{}')
  from public.workspaces w join public.user_preferences p using(user_id)
  left join public.workspace_execution x using(user_id) where w.user_id=auth.uid()
$$;

create or replace function public.flowday_apply_delta_internal(p_revision bigint,p_mutation uuid,p_delta jsonb) returns jsonb
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
  delete from public.schedule_blocks where user_id=actor and block_id in (select jsonb_array_elements_text(p_delta#>'{blocks,remove}'));
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
    insert into public.schedule_blocks values(actor,item->>'taskId',(item->>'date')::date,(item->>'start')::smallint,(item->>'end')::smallint,coalesce((item->>'locked')::boolean,false),pos,coalesce(item->>'id',item->>'taskId'))
    on conflict(user_id,block_id) do update set date=excluded.date,start_minute=excluded.start_minute,end_minute=excluded.end_minute,locked=excluded.locked;
  end loop;
  if p_delta ? 'blocks' or p_delta ? 'tasks' then
    if exists(select 1 from jsonb_array_elements(p_delta#>'{blocks,put}') as payload(segment) join public.schedule_blocks b on b.user_id=actor and b.block_id=coalesce(segment->>'id',segment->>'taskId') where b.task_id<>segment->>'taskId') then raise exception 'INVALID_SCHEDULE'; end if;
    if exists(select 1 from public.schedule_blocks b join public.tasks t on t.user_id=b.user_id and t.id=b.task_id
      where b.user_id=actor and (t.status<>'todo' or t.execution ? 'abandonedAt')) then raise exception 'INVALID_SCHEDULE'; end if;
    select array_agg(distinct (value->>'date')::date) into block_dates from jsonb_array_elements(p_delta#>'{blocks,put}');
    if exists(select 1 from (select start_minute,lag(end_minute) over(partition by date order by start_minute,block_id) previous_end
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
      || jsonb_build_object('settingsExtra',coalesce((select jsonb_object_agg(key,value) from jsonb_each(prefs) where key in ('onboardingComplete','aiEnabled','bufferPercent')),'{}'));
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
commit;

-- FlowDay V1.1. Apply to a NEW development Supabase project first.
-- Existing browser IDs are deliberately text, scoped by user; no lossy ID remap.
begin;
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.workspaces (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  last_mutation uuid,
  last_hash text,
  updated_at timestamptz not null default now()
);
create table public.user_preferences (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  display_name text not null default '朋友' check (length(display_name) between 1 and 30),
  day_start smallint not null default 9 check (day_start between 0 and 23),
  day_end smallint not null default 18 check (day_end between 1 and 24 and day_end > day_start),
  capacity smallint not null default 240 check (capacity between 30 and 720)
);
create table public.goals (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  id text not null check (length(id) between 1 and 128),
  title text not null check (length(title) between 1 and 200),
  description text not null check (length(description) <= 1000),
  color text not null check (color in ('green','blue','orange')),
  target_date date,
  position integer not null check (position >= 0),
  primary key(user_id,id)
);
create table public.tasks (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  id text not null check (length(id) between 1 and 128),
  goal_id text,
  title text not null check (length(title) between 1 and 200),
  notes text not null check (length(notes) <= 2000),
  minutes smallint not null check (minutes between 5 and 480),
  priority text not null check (priority in ('high','medium','low')),
  status text not null check (status in ('todo','done')),
  planned_date date,
  created_at timestamptz not null,
  completed_at timestamptz,
  position integer not null check (position >= 0),
  primary key(user_id,id),
  foreign key(user_id,goal_id) references public.goals(user_id,id),
  check ((status = 'done') = (completed_at is not null))
);
create index tasks_day on public.tasks(user_id,planned_date,status);
create index tasks_goal on public.tasks(user_id,goal_id);
create index tasks_completed on public.tasks(user_id,completed_at) where completed_at is not null;
-- MVP plans are projections of task dates. A persisted day links time blocks.
create table public.daily_plans (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  date date not null,
  primary key(user_id,date)
);
create table public.schedule_blocks (
  user_id uuid not null,
  task_id text not null,
  date date not null,
  start_minute smallint not null check (start_minute between 0 and 1439),
  end_minute smallint not null check (end_minute between 1 and 1440 and end_minute > start_minute),
  locked boolean not null default false,
  position integer not null,
  primary key(user_id,task_id),
  foreign key(user_id,task_id) references public.tasks(user_id,id) on delete cascade,
  foreign key(user_id,date) references public.daily_plans(user_id,date) on delete cascade
);
create index blocks_day on public.schedule_blocks(user_id,date,start_minute);
create table public.execution_events (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  id text not null check(length(id) between 1 and 128),
  -- Historical task identifier intentionally survives deletion of the task.
  task_id text not null check(length(task_id) between 1 and 128),
  type text not null check(type in ('complete','reopen','focus')),
  occurred_at timestamptz not null,
  seconds double precision check(seconds >= 0 and seconds < 'Infinity'::float8),
  position integer not null,
  primary key(user_id,id),
  check(type <> 'focus' or seconds is not null)
);
create index events_date on public.execution_events(user_id,occurred_at);
create table public.focus_sessions (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  task_id text not null,
  started_at_ms bigint not null check(started_at_ms >= 0),
  accumulated double precision not null check(accumulated >= 0 and accumulated < 'Infinity'::float8),
  running boolean not null,
  foreign key(user_id,task_id) references public.tasks(user_id,id) on delete cascade
);
create table public.daily_reviews (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  date date not null,
  text text not null check(length(text) <= 2000),
  mood smallint not null check(mood between 1 and 3),
  drawing jsonb not null default '[]' check(jsonb_typeof(drawing) = 'array' and jsonb_array_length(drawing) <= 40 and octet_length(drawing::text) <= 200000),
  position integer not null,
  primary key(user_id,date)
);
create table public.schedule_history (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  revision bigint not null,
  blocks jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,revision)
);
create table public.local_imports (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  source_hash text not null,
  imported_revision bigint not null,
  counts jsonb not null,
  imported_at timestamptz not null default now(),
  primary key(user_id,source_hash)
);

-- Browser and server both use the user JWT, never a service_role key.
-- Read is RLS scoped. Writes go ONLY through the atomic, actor-scoped RPC below.
do $$ declare t text; begin
  foreach t in array array['profiles','workspaces','user_preferences','goals','tasks','daily_plans','schedule_blocks','execution_events','focus_sessions','daily_reviews','schedule_history','local_imports'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy own_rows on public.%I for select to authenticated using (user_id = (select auth.uid()))',t);
  end loop;
end $$;

-- One SQL statement gives a consistent snapshot of every collection.
create function public.flowday_snapshot() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'schemaVersion',1,'revision',w.revision,
  'settings',jsonb_build_object('name',p.display_name,'dayStart',p.day_start,'dayEnd',p.day_end,'capacity',p.capacity),
  'goals',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'title',g.title,'description',g.description,'color',g.color,'targetDate',coalesce(g.target_date::text,'')) order by g.position) from public.goals g where g.user_id=w.user_id),'[]'),
  'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'notes',t.notes,'minutes',t.minutes,'priority',t.priority,'status',t.status,'goalId',t.goal_id,'date',coalesce(t.planned_date::text,''),'createdAt',t.created_at,'completedAt',t.completed_at) order by t.position) from public.tasks t where t.user_id=w.user_id),'[]'),
  'blocks',coalesce((select jsonb_agg(jsonb_build_object('taskId',b.task_id,'date',b.date,'start',b.start_minute,'end',b.end_minute,'locked',b.locked) order by b.position) from public.schedule_blocks b where b.user_id=w.user_id),'[]'),
  'reviews',coalesce((select jsonb_agg(jsonb_build_object('date',r.date,'text',r.text,'mood',r.mood,'drawing',r.drawing) order by r.position) from public.daily_reviews r where r.user_id=w.user_id),'[]'),
  'events',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',e.id,'taskId',e.task_id,'type',e.type,'at',e.occurred_at,'seconds',e.seconds)) order by e.position) from public.execution_events e where e.user_id=w.user_id),'[]'),
  'session',(select jsonb_build_object('taskId',f.task_id,'startedAt',f.started_at_ms,'accumulated',f.accumulated,'running',f.running) from public.focus_sessions f where f.user_id=w.user_id)
 ) from public.workspaces w join public.user_preferences p using(user_id) where w.user_id=auth.uid();
$$;

create function public.flowday_load() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); begin
 if actor is null then raise exception 'UNAUTHENTICATED'; end if;
 insert into public.profiles(user_id) values(actor) on conflict do nothing;
 insert into public.workspaces(user_id) values(actor) on conflict do nothing;
 insert into public.user_preferences(user_id) values(actor) on conflict do nothing;
 return public.flowday_snapshot();
end $$;

create function public.flowday_save(p_state jsonb, p_expected bigint, p_mutation uuid, p_import boolean default false) returns jsonb
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
   insert into public.schedule_blocks values(actor,x->>'taskId',(x->>'date')::date,(x->>'start')::smallint,(x->>'end')::smallint,coalesce((x->>'locked')::boolean,false),pos);
 end loop;
 if exists(select 1 from public.schedule_blocks b join public.tasks t on t.user_id=b.user_id and t.id=b.task_id where b.user_id=actor and (t.status<>'todo' or t.planned_date is distinct from b.date)) then raise exception 'INVALID_SCHEDULE'; end if;
 if exists(select 1 from public.schedule_blocks a join public.schedule_blocks b on a.user_id=b.user_id and a.date=b.date and a.task_id<b.task_id and a.start_minute<b.end_minute and b.start_minute<a.end_minute where a.user_id=actor) then raise exception 'SCHEDULE_CONFLICT'; end if;
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

revoke all on function public.flowday_snapshot(), public.flowday_load(), public.flowday_save(jsonb,bigint,uuid,boolean) from public, anon, authenticated;
grant execute on function public.flowday_load(), public.flowday_save(jsonb,bigint,uuid,boolean) to authenticated;
commit;

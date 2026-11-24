begin;
create table public.plan_policies (
  id text primary key check(id in ('free','pro')),
  ai_per_minute integer not null check(ai_per_minute between 0 and 30),
  ai_per_day integer not null check(ai_per_day between 0 and 1000),
  advanced_growth boolean not null,
  personalization boolean not null,
  extras jsonb not null default '{}'
);
-- Keep V1.3 functionality available by default. Entitlements are operator
-- configuration and independent of any payment provider or future price.
insert into public.plan_policies(id,ai_per_minute,ai_per_day,advanced_growth,personalization)
values ('free',6,60,true,true),('pro',10,120,true,true);
create table public.account_plans (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  plan_id text not null references public.plan_policies(id)
);
alter table public.plan_policies enable row level security;
alter table public.account_plans enable row level security;
revoke all on public.plan_policies,public.account_plans from public,anon,authenticated;
alter table public.ai_requests add column provider_calls integer check(provider_calls between 0 and 2);

create function public.flowday_access() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('plan',p.id,'aiPerMinute',p.ai_per_minute,'aiPerDay',p.ai_per_day,
    'advancedGrowth',p.advanced_growth,'personalization',p.personalization,'extras',p.extras,
    'aiEnabled',coalesce((x.extra#>>'{settingsExtra,aiEnabled}')::boolean,true),
    'usedToday',u.requests,'providerCallsToday',u.calls,'inputTokensToday',u.input_tokens,
    'outputTokensToday',u.output_tokens,'estimatedCostToday',u.known_cost,'unknownUsageToday',u.unknown_usage)
  from public.plan_policies p
  left join public.workspace_execution x on x.user_id=auth.uid()
  cross join lateral (
    select count(*) requests,coalesce(sum(a.provider_calls),0) calls,coalesce(sum(a.input_tokens),0) input_tokens,
      coalesce(sum(a.output_tokens),0) output_tokens,sum(a.estimated_cost_usd) known_cost,
      count(*) filter(where a.provider<>'mock' and (a.estimated_cost_usd is null or a.provider_calls is null)) unknown_usage
    from public.ai_requests a where a.user_id=auth.uid() and a.created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
  ) u where auth.uid() is not null and p.id=coalesce((select a.plan_id from public.account_plans a where a.user_id=auth.uid()),'free')
$$;

create or replace function public.flowday_ai_reserve(p_hash text,p_provider text,p_model text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); r public.ai_requests%rowtype; access jsonb;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_hash !~ '^[0-9a-f]{64}$' or p_hash is null then raise exception 'INVALID_REQUEST'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text,1202));
  access:=public.flowday_access();
  if not (access->>'aiEnabled')::boolean then raise exception 'AI_DISABLED'; end if;
  if (access->>'aiPerDay')::int=0 or (access->>'aiPerMinute')::int=0 then raise exception 'AI_RATE_LIMIT'; end if;
  select * into r from public.ai_requests where user_id=actor and request_hash=p_hash and created_at>now()-interval '5 minutes'
    and status in ('reserved','success') and (status='reserved' or result is not null) order by created_at desc limit 1;
  if found then
    if r.status='success' then return jsonb_build_object('id',r.id,'cached',r.result); end if;
    raise exception 'AI_BUSY';
  end if;
  if (access->>'usedToday')::int >= (access->>'aiPerDay')::int
     or (select count(*) from public.ai_requests where user_id=actor and created_at>now()-interval '1 minute') >= (access->>'aiPerMinute')::int then
    raise exception 'AI_RATE_LIMIT';
  end if;
  update public.ai_requests set result=null where user_id=actor and result is not null and created_at<now()-interval '10 minutes';
  insert into public.ai_requests(user_id,request_hash,provider,model) values(actor,p_hash,p_provider,p_model) returning * into r;
  return jsonb_build_object('id',r.id,'cached',null);
end $$;

create function public.flowday_ai_finish_v15(p_id uuid,p_success boolean,p_input bigint,p_output bigint,p_cost numeric,p_calls integer,p_prompt text,p_result jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform public.flowday_ai_finish(p_id,p_success,p_input,p_output,p_cost,p_prompt,p_result);
  update public.ai_requests set provider_calls=p_calls where user_id=auth.uid() and id=p_id;
end $$;
revoke all on function public.flowday_ai_finish(uuid,boolean,bigint,bigint,numeric,text,jsonb) from public,anon,authenticated;

create function public.flowday_history(p_kind text,p_limit integer,p_at timestamptz default null,p_id text default null,p_task text default null,p_day date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); n int:=least(greatest(coalesce(p_limit,25),1),50); result jsonb;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_kind='reviews' then
    select jsonb_agg(jsonb_build_object('at',r.date::text,'id',r.date::text,'entry',
      jsonb_build_object('date',r.date,'text',left(r.text,110),'mood',r.mood)) order by r.date desc) into result
    from (select * from public.daily_reviews where user_id=actor and (p_id is null or date<p_id::date) order by date desc limit n+1) r;
  elsif p_kind='review' then
    select jsonb_agg(jsonb_build_object('at',r.date::text,'id',r.date::text,'entry',public.flowday_review_json(r))) into result
      from public.daily_reviews r where r.user_id=actor and r.date=p_day;
  elsif p_kind='tasks' then
    select jsonb_agg(jsonb_build_object('at',t.completed_at,'id',t.id,'entry',public.flowday_task_json(t)) order by t.completed_at desc,t.id desc) into result
    from (select * from public.tasks where user_id=actor and completed_at is not null and
      (p_at is null or (completed_at,id)<(p_at,p_id)) order by completed_at desc,id desc limit n+1) t;
  elsif p_kind='execution' then
    select jsonb_agg(jsonb_build_object('at',h.at,'id',h.id,'entry',h.payload) order by h.at desc,h.id desc) into result
    from (select * from public.execution_history where user_id=actor and (p_task is null or task_id=p_task)
      and (p_at is null or (at,id)<(p_at,p_id)) order by at desc,id desc limit n+1) h;
  elsif p_kind='focus' then
    select jsonb_agg(jsonb_build_object('at',e.occurred_at,'id',e.id,'entry',public.flowday_event_json(e)||jsonb_build_object('title',t.title))
      order by e.occurred_at desc,e.id desc) into result
    from (select * from public.execution_events where user_id=actor and type='focus' and (p_task is null or task_id=p_task)
      and (p_at is null or (occurred_at,id)<(p_at,p_id)) order by occurred_at desc,id desc limit n+1) e
    left join public.tasks t on t.user_id=e.user_id and t.id=e.task_id;
  else raise exception 'INVALID_KIND'; end if;
  return coalesce(result,'[]');
end $$;

create function public.flowday_growth_period(first_day date,last_day date,settlement date,zone text) returns jsonb
language sql stable security definer set search_path='' as $$
  with event_rows as materialized (
    select e.task_id,e.type,e.seconds,e.occurred_at at time zone zone local_at
    from public.execution_events e where e.user_id=auth.uid() and e.occurred_at>=first_day::timestamp at time zone zone
      and e.occurred_at<(last_day+1)::timestamp at time zone zone and e.type in ('complete','focus')
  ), history as materialized (
    select h.type,h.payload,h.task_id,h.at from public.execution_history h where h.user_id=auth.uid()
      and h.at>=first_day::timestamp at time zone zone and h.at<(last_day+1)::timestamp at time zone zone
  ), samples as materialized (
    select distinct on (task_id) task_id,payload->>'kind' kind,(payload->>'estimate')::numeric estimate,
      coalesce(payload->>'sampleFocusSeconds',payload->>'focusSeconds')::numeric/60 focus
    from history where type='complete' and payload->>'completeCoverage'='true'
      and (payload->>'estimate')::numeric>0 and coalesce(payload->>'sampleFocusSeconds',payload->>'focusSeconds')::numeric>0
    order by task_id,at desc
  ), planned as (
    select distinct h.task_id,(h.payload->>'to')::date as plan_day from public.execution_history h where h.user_id=auth.uid() and h.type='commit'
      and h.payload->>'to' between first_day::text and least(last_day,settlement-1)::text
  )
  select jsonb_build_object('first',first_day,'last',last_day,
    'completed',(select count(*) from event_rows where type='complete'),
    'activeDays',(select count(distinct local_at::date) from event_rows where type='complete' or seconds>0),
    'focusMinutes',(select round(coalesce(sum(seconds),0)/60) from event_rows where type='focus'),
    'elapsedMinutes',(select round(coalesce(sum((payload->>'elapsedSeconds')::numeric),0)/60) from history),
    'postponements',(select count(*) from history where type='defer'),
    'pauses',(select count(*) from history where type='pause'),
    'samples',(select count(*) from samples),
    'estimateError',(select case when count(*)>=5 then round((percentile_cont(.5) within group(order by abs(focus-estimate)/estimate)*100)::numeric) end from samples),
    'planned',(select count(*) from planned),
    'matched',(select count(*) from planned p where exists(select 1 from event_rows e where e.type='complete' and e.task_id=p.task_id and e.local_at::date=p.plan_day)),
    'periods',(select jsonb_agg(jsonb_build_object('label',label,
      'completed',(select count(*) from event_rows where type='complete' and extract(hour from local_at)>=lo and extract(hour from local_at)<hi),
      'focusMinutes',(select round(coalesce(sum(seconds),0)/60) from event_rows where type='focus' and extract(hour from local_at)>=lo and extract(hour from local_at)<hi)) order by lo)
      from (values ('上午',0,12),('下午',12,18),('晚上',18,24)) p(label,lo,hi)),
    'categories',(select jsonb_agg(jsonb_build_object('kind',k.id,'label',k.label,
      'samples',(select count(*) from samples s where s.kind=k.id),
      'typicalMinutes',(select case when count(*)>=5 then round((percentile_cont(.5) within group(order by focus))::numeric) end from samples s where s.kind=k.id),
      'delays',(select count(*) from history h where h.type='defer' and h.payload->>'kind'=k.id),
      'completed',(select count(*) from history h where h.type='complete' and h.payload->>'kind'=k.id)))
      from (values ('study','学习'),('project','项目'),('admin','事务'),('routine','日常')) k(id,label)))
$$;
create function public.flowday_growth_report(p_end date,p_days int,p_zone text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare today date; access jsonb;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_end is null or p_days is null or p_days not in (1,7,30,90) or p_zone is null or length(p_zone)>80 then raise exception 'INVALID_WINDOW'; end if;
  today:=(now() at time zone p_zone)::date;
  if p_end>today then raise exception 'INVALID_WINDOW'; end if;
  access:=public.flowday_access();
  if p_days>7 and not (access->>'advancedGrowth')::boolean then raise exception 'ADVANCED_GROWTH_REQUIRED'; end if;
  return jsonb_build_object('current',public.flowday_growth_period(p_end-p_days+1,p_end,today,p_zone),
    'previous',public.flowday_growth_period(p_end-p_days*2+1,p_end-p_days,today,p_zone));
end $$;
create table public.account_totals (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  completed bigint not null default 0,
  focus_seconds double precision not null default 0,
  reviews bigint not null default 0
);
alter table public.account_totals enable row level security;
revoke all on public.account_totals from public,anon,authenticated;
insert into public.account_totals
select p.user_id,coalesce(t.n,0),coalesce(e.seconds,0),coalesce(r.n,0) from public.profiles p
  left join (select user_id,count(*) n from public.tasks where status='done' group by user_id) t using(user_id)
  left join (select user_id,sum(seconds) seconds from public.execution_events where type='focus' group by user_id) e using(user_id)
  left join (select user_id,count(*) n from public.daily_reviews group by user_id) r using(user_id);
create function public.flowday_rollup_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare owner uuid; added jsonb; removed jsonb; completions bigint:=0; focus double precision:=0; reviews_count bigint:=0;
begin
  if tg_op<>'DELETE' then added:=to_jsonb(new); owner:=new.user_id; end if;
  if tg_op<>'INSERT' then removed:=to_jsonb(old); owner:=old.user_id; end if;
  if tg_table_name='tasks' then
    completions:=coalesce((added->>'status'='done')::int,0)-coalesce((removed->>'status'='done')::int,0);
  elsif tg_table_name='execution_events' then
    focus:=case when added->>'type'='focus' then coalesce((added->>'seconds')::float8,0) else 0 end
      - case when removed->>'type'='focus' then coalesce((removed->>'seconds')::float8,0) else 0 end;
  else
    reviews_count:=(added is not null)::int-(removed is not null)::int;
  end if;
  if completions<>0 or focus<>0 or reviews_count<>0 then
    insert into public.account_totals as total
      select owner,completions,focus,reviews_count from public.profiles p where p.user_id=owner
    on conflict(user_id) do update set completed=total.completed+excluded.completed,
      focus_seconds=total.focus_seconds+excluded.focus_seconds,reviews=total.reviews+excluded.reviews;
  end if;
  return null;
end $$;
revoke all on function public.flowday_rollup_trigger() from public,anon,authenticated;
create trigger rollup_tasks after insert or update of status or delete on public.tasks for each row execute function public.flowday_rollup_trigger();
create trigger rollup_focus after insert or update of seconds,type or delete on public.execution_events for each row execute function public.flowday_rollup_trigger();
create trigger rollup_reviews after insert or delete on public.daily_reviews for each row execute function public.flowday_rollup_trigger();
create function public.flowday_totals() returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('completed',coalesce(a.completed,0),'focusMinutes',floor(coalesce(a.focus_seconds,0)/60),'reviews',coalesce(a.reviews,0))
  from (select auth.uid() id) p left join public.account_totals a on a.user_id=p.id
$$;
create function public.flowday_privacy_export() returns jsonb language sql stable security definer set search_path='' as $$
  select public.flowday_export() || jsonb_build_object('accountData',jsonb_build_object(
    'scheduleHistory',coalesce((select jsonb_agg(to_jsonb(s)-'user_id' order by s.revision) from public.schedule_history s where s.user_id=auth.uid()),'[]'),
    'aiUsage',coalesce((select jsonb_agg(to_jsonb(a)-'user_id'-'request_hash'-'result' order by a.created_at) from public.ai_requests a where a.user_id=auth.uid()),'[]'),
    'aiSuggestions',coalesce((select jsonb_agg(a.result-'token' order by a.created_at) from public.ai_requests a where a.user_id=auth.uid() and a.result is not null),'[]'),
    'entitlements',public.flowday_access()))
$$;
alter function public.flowday_apply_delta(bigint,uuid,jsonb) rename to flowday_apply_delta_internal;
revoke all on function public.flowday_apply_delta_internal(bigint,uuid,jsonb) from public,anon,authenticated;
create function public.flowday_apply_delta(p_revision bigint,p_mutation uuid,p_delta jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if (p_delta#>>'{settings,growth,personalize}')::boolean and not (public.flowday_access()->>'personalization')::boolean
    then raise exception 'PERSONALIZATION_REQUIRED'; end if;
  return public.flowday_apply_delta_internal(p_revision,p_mutation,p_delta);
end $$;
revoke all on function public.flowday_apply_delta(bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.flowday_apply_delta(bigint,uuid,jsonb) to authenticated;

alter function public.flowday_bootstrap(date) rename to flowday_bootstrap_internal;
revoke all on function public.flowday_bootstrap_internal(date) from public,anon,authenticated;
create function public.flowday_bootstrap(p_today date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb; preferences jsonb;
begin
  payload:=public.flowday_bootstrap_internal(p_today);
  if not (public.flowday_access()->>'personalization')::boolean then
    preferences:=coalesce(payload#>'{settings,growth}','{"shareWithAi":false,"preferred":"any"}');
    payload:=jsonb_set(payload,'{settings,growth}',preferences||'{"personalize":false}');
  end if;
  return payload;
end $$;
revoke all on function public.flowday_bootstrap(date) from public,anon,authenticated;
grant execute on function public.flowday_bootstrap(date) to authenticated;
create function public.flowday_clear(p_revision bigint) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); active_revision bigint;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  select revision into active_revision from public.workspaces where user_id=actor for update;
  if active_revision is distinct from p_revision or active_revision is null then raise exception 'REVISION_CONFLICT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text,1202));
  delete from public.focus_sessions where user_id=actor;
  delete from public.daily_plans where user_id=actor;
  delete from public.tasks where user_id=actor;
  delete from public.goals where user_id=actor;
  delete from public.daily_reviews where user_id=actor;
  delete from public.schedule_history where user_id=actor;
  delete from public.execution_events where user_id=actor;
  delete from public.execution_history where user_id=actor;
  delete from public.local_imports where user_id=actor;
  delete from public.workspace_mutations where user_id=actor;
  delete from public.workspace_execution where user_id=actor;
  update public.ai_requests set status='failed',result=null,request_hash=repeat('0',64) where user_id=actor;
  update public.user_preferences set display_name='朋友',day_start=9,day_end=18,capacity=240 where user_id=actor;
  update public.workspaces set revision=revision+1,last_mutation=null,last_hash=null,updated_at=now() where user_id=actor;
end $$;

revoke all on function public.flowday_access(),public.flowday_history(text,integer,timestamptz,text,text,date),
  public.flowday_growth_period(date,date,date,text),public.flowday_growth_report(date,int,text),public.flowday_totals(),public.flowday_clear(bigint),
  public.flowday_privacy_export(),
  public.flowday_ai_finish_v15(uuid,boolean,bigint,bigint,numeric,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.flowday_access(),public.flowday_history(text,integer,timestamptz,text,text,date),
  public.flowday_growth_report(date,int,text),public.flowday_totals(),public.flowday_clear(bigint),
  public.flowday_privacy_export(),
  public.flowday_ai_finish_v15(uuid,boolean,bigint,bigint,numeric,integer,text,jsonb) to authenticated;
commit;

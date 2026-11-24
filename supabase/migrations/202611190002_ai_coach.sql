begin;
create table public.ai_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  request_hash text not null check(length(request_hash)=64),
  provider text not null check(length(provider)<=40),
  model text not null check(length(model)<=150),
  status text not null default 'reserved' check(status in ('reserved','success','failed')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  input_tokens bigint check(input_tokens>=0),
  output_tokens bigint check(output_tokens>=0),
  estimated_cost_usd numeric check(estimated_cost_usd>=0),
  prompt_version text,
  -- Application cache contains the signed proposal and bounded user request.
  -- API never reuses it after expiry; old content is erased on the next reserve.
  result jsonb check(result is null or octet_length(result::text)<=150000)
);
create index ai_requests_quota on public.ai_requests(user_id,created_at desc);
create index ai_requests_cache on public.ai_requests(user_id,request_hash,created_at desc);
alter table public.ai_requests enable row level security;
revoke all on public.ai_requests from anon,authenticated;
grant select on public.ai_requests to authenticated;
create policy own_ai_requests on public.ai_requests for select to authenticated using(user_id=(select auth.uid()));

-- Hard limits cannot be raised by request parameters, changing tabs or restarting Next.
create function public.flowday_ai_reserve(p_hash text,p_provider text,p_model text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); r public.ai_requests%rowtype;
begin
 if actor is null then raise exception 'UNAUTHENTICATED'; end if;
 if p_hash is null or length(p_hash)<>64 or p_provider is null or p_model is null then raise exception 'INVALID_REQUEST'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text,1202));
 select * into r from public.ai_requests where user_id=actor and request_hash=p_hash and created_at>now()-interval '5 minutes' and status in ('success','reserved') order by created_at desc limit 1;
 if found then
   if r.status='success' then return jsonb_build_object('id',r.id,'cached',r.result); end if;
   raise exception 'AI_BUSY';
 end if;
 if (select count(*) from public.ai_requests where user_id=actor and created_at>now()-interval '1 minute')>=6
 or (select count(*) from public.ai_requests where user_id=actor and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')>=60 then raise exception 'AI_RATE_LIMIT'; end if;
 -- Erase cached content after expiry, retain minimal usage metadata.
 update public.ai_requests set result=null where user_id=actor and result is not null and created_at<now()-interval '10 minutes';
 insert into public.ai_requests(user_id,request_hash,provider,model) values(actor,p_hash,p_provider,p_model) returning * into r;
 return jsonb_build_object('id',r.id,'cached',null);
end $$;
create function public.flowday_ai_finish(p_id uuid,p_success boolean,p_input bigint,p_output bigint,p_cost numeric,p_prompt text,p_result jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
 update public.ai_requests set status=case when p_success then 'success' else 'failed' end,finished_at=now(),input_tokens=p_input,output_tokens=p_output,estimated_cost_usd=p_cost,prompt_version=p_prompt,result=p_result
 where id=p_id and user_id=auth.uid() and status='reserved';
 if not found then raise exception 'AI_REQUEST_NOT_RESERVED'; end if;
end $$;
revoke all on function public.flowday_ai_reserve(text,text,text),public.flowday_ai_finish(uuid,boolean,bigint,bigint,numeric,text,jsonb) from public,anon,authenticated;
grant execute on function public.flowday_ai_reserve(text,text,text),public.flowday_ai_finish(uuid,boolean,bigint,bigint,numeric,text,jsonb) to authenticated;
commit;

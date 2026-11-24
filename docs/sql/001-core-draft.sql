-- 架构评审草案，仅展示关键约束；不是全量迁移，未执行验证。
-- 前提：Supabase auth.users/auth.uid()；由部署角色执行。
begin;
create extension if not exists btree_gist;
create table public.profiles (
 id uuid primary key references auth.users(id),
 timezone text not null default 'Asia/Shanghai',
 locale text not null default 'zh-CN',
 created_at timestamptz not null default now()
);
create table public.tasks (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 parent_id uuid,
 title text not null check(length(title) between 1 and 500),
 status text not null default 'todo' check(status in ('todo','in_progress','blocked','done','cancelled')),
 priority smallint not null default 1 check(priority between 0 and 3),
 estimate_minutes integer check(estimate_minutes > 0),
 remaining_minutes integer check(remaining_minutes >= 0),
 due_at timestamptz,
 due_date date,
 due_timezone text,
 version bigint not null default 1 check(version > 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 deleted_at timestamptz,
 unique(user_id,id),
 foreign key(user_id,parent_id) references public.tasks(user_id,id),
 check(parent_id is null or parent_id <> id),
 check(not(due_at is not null and due_date is not null)),
 check(due_date is null or due_timezone is not null)
);
create index tasks_owner_status_due on public.tasks(user_id,status,due_at) where deleted_at is null;
create index tasks_parent on public.tasks(user_id,parent_id);
create table public.daily_plans (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 local_date date not null,
 timezone text not null,
 version bigint not null default 1 check(version>0),
 unique(user_id,id), unique(user_id,local_date)
);
create table public.time_blocks (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id),
 plan_id uuid not null,
 task_id uuid,
 start_at timestamptz not null,
 end_at timestamptz not null,
 state text not null default 'active' check(state in ('active','cancelled','completed')),
 locked boolean not null default false,
 version bigint not null default 1,
 unique(user_id,id),
 foreign key(user_id,plan_id) references public.daily_plans(user_id,id),
 foreign key(user_id,task_id) references public.tasks(user_id,id),
 check(end_at>start_at),
 exclude using gist(user_id with =, tstzrange(start_at,end_at,'[)') with &&)
 where (state in ('active','completed')) deferrable initially immediate
);
create index blocks_plan on public.time_blocks(user_id,plan_id,start_at);
create index blocks_task on public.time_blocks(user_id,task_id);
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
create policy profile_read on public.profiles for select to authenticated using(id=(select auth.uid()));
alter table public.tasks enable row level security;
alter table public.tasks force row level security;
create policy tasks_read on public.tasks for select to authenticated using(user_id=(select auth.uid()));
alter table public.daily_plans enable row level security;
alter table public.daily_plans force row level security;
create policy plans_read on public.daily_plans for select to authenticated using(user_id=(select auth.uid()));
alter table public.time_blocks enable row level security;
alter table public.time_blocks force row level security;
create policy blocks_read on public.time_blocks for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.profiles,public.tasks,public.daily_plans,public.time_blocks from anon;
revoke insert,update,delete on public.profiles,public.tasks,public.daily_plans,public.time_blocks from authenticated;
grant select on public.profiles,public.tasks,public.daily_plans,public.time_blocks to authenticated;
-- 写入经受限服务器用例；此草案故意不授予通用客户端写权限。
-- 下一迁移须建立受限写角色/函数并验证 actor；不可简单改为 service_role 全权调用。
-- 乐观锁模式：UPDATE tasks SET ..., version=version+1
-- WHERE user_id=:verified_actor AND id=:id AND version=:expected RETURNING id;
-- 0 行返回 409；同事务插入 task_events 和 outbox_events。
commit;

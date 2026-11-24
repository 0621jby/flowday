#!/usr/bin/env bash
set -euo pipefail
cd /work
export PGUSER=postgres PGDATABASE=flowday_test
createdb "$PGDATABASE"
psql -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
INSERT INTO auth.users VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
SQL

work=$(mktemp -d)
shopt -s nullglob
migrations=(supabase/migrations/*.sql)
migration_count=${#migrations[@]}
bash deploy/aliyun/postgres.sh migrate supabase/migrations "$work/before.dump"
psql -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
SELECT public.flowday_bootstrap('2026-11-24') IS NOT NULL;
SELECT set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
SELECT public.flowday_bootstrap('2026-11-24') IS NOT NULL;
INSERT INTO public.tasks(user_id,id,title,notes,minutes,priority,status,planned_date,created_at,position)
VALUES ('11111111-1111-4111-8111-111111111111','t1','User A task','',30,'medium','todo','2026-11-24',now(),0),
       ('22222222-2222-4222-8222-222222222222','t1','User B task','',30,'medium','todo','2026-11-24',now(),0);
INSERT INTO public.daily_plans SELECT id,'2026-11-24'::date FROM auth.users;
INSERT INTO public.schedule_blocks(user_id,task_id,date,start_minute,end_minute,position)
SELECT id,'t1','2026-11-24',540,570,0 FROM auth.users;
SQL

bash deploy/aliyun/postgres.sh migrate supabase/migrations "$work/backup.dump"
mkdir "$work/broken"
cp supabase/migrations/*.sql "$work/broken"
printf 'BEGIN;\nCREATE TABLE public.failed_migration(id int);\nSELECT 1/0;\nCOMMIT;\n' >"$work/broken/999999999999_test.sql"
if bash deploy/aliyun/postgres.sh migrate "$work/broken" "$work/failure.dump"; then
  echo 'Invalid migration unexpectedly succeeded' >&2
  exit 1
fi
[[ $(psql -X -Atc "SELECT to_regclass('public.failed_migration') IS NULL") == t ]]
[[ $(psql -X -Atc 'SELECT count(*) FROM flowday_ops.migrations') == "$migration_count" ]]

# Restore to a separate clean database in the disposable CI container.
createdb flowday_restored
pg_restore --dbname=flowday_restored --exit-on-error --no-owner --single-transaction "$work/backup.dump"
export PGDATABASE=flowday_restored
[[ $(psql -X -Atc 'SELECT count(*) FROM auth.users') == 2 ]]
[[ $(psql -X -Atc 'SELECT count(*) FROM public.schedule_blocks') == 2 ]]
[[ $(psql -X -Atc 'SELECT count(*) FROM flowday_ops.migrations') == "$migration_count" ]]
for actor in A B; do
  case "$actor" in
    A) user_id=11111111-1111-4111-8111-111111111111 ;;
    B) user_id=22222222-2222-4222-8222-222222222222 ;;
  esac
  [[ $(psql -X -Atq -v ON_ERROR_STOP=1 <<SQL
SET ROLE authenticated;
SET request.jwt.claim.sub='$user_id';
SELECT title FROM public.tasks;
SQL
  ) == "User $actor task" ]]
done
echo 'Restored both profiles, plans and tasks, and verified row isolation.'

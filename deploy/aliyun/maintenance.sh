#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

mkdir -p ops/backups
exec 9>ops/release.lock
flock -w 60 9

printf '[%s] Database usage and backup\n' "$(date -u +%FT%TZ)"
psql -X -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'database_bytes=' || pg_database_size(current_database());
SELECT to_regclass('storage.objects') IS NOT NULL AS has_storage \gset
\if :has_storage
SELECT 'storage_object_bytes=' || coalesce(sum((metadata->>'size')::numeric),0)
FROM storage.objects WHERE metadata->>'size' ~ '^[0-9]+$';
\endif
SQL
bash postgres.sh backup "ops/backups/daily-$(date -u +%Y%m%dT%H%M%SZ).dump"

#!/usr/bin/env bash
set -euo pipefail
umask 077

# Use libpq's PGSERVICE/PGPASSFILE or an already configured local connection.
# The maintenance account must own the FlowDay objects. Do not use it in the app.
backup() (
  local destination=$1 temporary
  temporary=$(mktemp "${destination}.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  pg_dump --format=custom --schema=public --schema=auth --schema=flowday_ops --file="$temporary"
  pg_restore --list "$temporary" >/dev/null
  pg_restore --exit-on-error --file=/dev/null "$temporary"
  chmod 600 "$temporary"
  # Publish atomically and refuse to replace an existing backup.
  ln -- "$temporary" "$destination"
  printf 'Created backup %s\n' "$destination"
)

migrate() (
  local directory=$1 destination=$2 file name digest
  local -a migrations
  export LC_ALL=C
  shopt -s nullglob
  migrations=("$directory"/*.sql)
  if (( ${#migrations[@]} == 0 )); then
    echo "No migrations found in $directory" >&2
    exit 1
  fi

  local script body
  script=$(mktemp)
  trap 'rm -f -- "$script"' EXIT
  cat >"$script" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SELECT pg_advisory_xact_lock(hashtext('flowday schema release'));
CREATE SCHEMA IF NOT EXISTS flowday_ops;
REVOKE ALL ON SCHEMA flowday_ops FROM PUBLIC;
CREATE TABLE IF NOT EXISTS flowday_ops.migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

  for file in "${migrations[@]}"; do
    name=${file##*/}
    [[ $name =~ ^[0-9]{12}_[a-z0-9_]+\.sql$ ]] || {
      printf 'Unexpected migration name: %s\n' "$name" >&2
      exit 1
    }
    digest=$(sha256sum "$file")
    digest=${digest%% *}
    # Only unwrap the opening/closing transaction from each checked-in file.
    # The psql session owns the transaction so changes and their ledger commit together.
    body=$(awk '
      { sub(/\r$/, ""); lines[NR]=$0 }
      END {
        for (first=1; first<=NR && lines[first] ~ /^[[:space:]]*(--.*)?$/; first++) {}
        for (last=NR; last>first && lines[last] ~ /^[[:space:]]*$/; last--) {}
        if (tolower(lines[first]) != "begin;" || tolower(lines[last]) != "commit;") exit 1
        for (i=first+1; i<last; i++) print lines[i]
      }
    ' "$file") || {
      printf 'Expected BEGIN/COMMIT in %s\n' "$name" >&2
      exit 1
    }

    cat >>"$script" <<SQL
DO \$flowday\$
BEGIN
  IF EXISTS (SELECT 1 FROM flowday_ops.migrations WHERE version='$name' AND checksum<>'$digest') THEN
    RAISE EXCEPTION 'Changed migration checksum: $name';
  END IF;
  IF EXISTS (SELECT 1 FROM flowday_ops.migrations WHERE version>'$name')
     AND NOT EXISTS (SELECT 1 FROM flowday_ops.migrations WHERE version='$name') THEN
    RAISE EXCEPTION 'Missing earlier migration: $name';
  END IF;
END
\$flowday\$;
SELECT NOT EXISTS (SELECT 1 FROM flowday_ops.migrations WHERE version='$name') AS apply_migration
\gset
\if :apply_migration
$body
INSERT INTO flowday_ops.migrations(version, checksum) VALUES ('$name', '$digest');
\endif
SQL
  done

  # Block older/incomplete deployments from using a newer database ledger.
  printf 'DO $flowday$ BEGIN IF EXISTS (SELECT 1 FROM flowday_ops.migrations WHERE version NOT IN (' >>"$script"
  local separator=
  for file in "${migrations[@]}"; do
    printf "%s'%s'" "$separator" "${file##*/}" >>"$script"
    separator=,
  done
  printf ")) THEN RAISE EXCEPTION 'Unknown database migration'; END IF; END \$flowday\$;\n" >>"$script"
  printf "NOTIFY pgrst, 'reload schema';\nCOMMIT;\n" >>"$script"

  backup "$destination"
  psql -X --quiet --set ON_ERROR_STOP=1 --file="$script"
  printf 'Migration ledger is current.\n'
)

case "${1:-}" in
  backup)  [[ $# -eq 2 ]] || exit 2; backup "$2" ;;
  migrate) [[ $# -eq 3 ]] || exit 2; migrate "$2" "$3" ;;
  *)
    echo 'Usage: postgres.sh backup BACKUP.dump | migrate MIGRATIONS_DIR BACKUP.dump' >&2
    exit 2
    ;;
esac

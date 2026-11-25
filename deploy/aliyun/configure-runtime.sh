#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID == 0 && -t 0 ]] || { echo 'Run in Workbench using sudo bash /opt/flowday/configure-runtime.sh' >&2; exit 1; }
cd /opt/flowday
source /etc/flowday/operations.env
export PGSERVICE PGSERVICEFILE PGPASSFILE PGCONNECT_TIMEOUT FLOWDAY_PG_IMAGE DOCKER_CONFIG

project=wigcksgpsjcaootcelwc
db_user=postgres.$project
ca=/etc/flowday/certs/prod-ca-2021.crt

check_database() {
  local service_file=$1 pass_file=$2 result
  result=$(PGSERVICEFILE="$service_file" PGPASSFILE="$pass_file" /opt/flowday/bin/psql \
    -X -w -qAt -v ON_ERROR_STOP=1 \
    -c "BEGIN READ ONLY; SELECT current_database(), session_user, current_setting('transaction_read_only'); COMMIT;") || return 1
  [[ $result == 'postgres|postgres|on' ]] || { echo 'Unexpected database, role or transaction mode.' >&2; return 1; }
  echo 'Supabase PostgreSQL authenticated (database=postgres, role=postgres, read-only query, verify-full).'
}

verify_database() (
  local pooler password escaped temporary
  [[ -r $ca ]] && openssl x509 -in "$ca" -noout -checkend 0 >/dev/null || {
    echo "Install the Supabase Dashboard CA at $ca before continuing." >&2
    exit 1
  }
  if [[ -f $PGSERVICEFILE || -f $PGPASSFILE ]]; then
    [[ -f $PGSERVICEFILE && -f $PGPASSFILE && ! -L $PGSERVICEFILE && ! -L $PGPASSFILE ]] &&
      grep -Fxq "user=$db_user" "$PGSERVICEFILE" &&
      grep -Fxq 'sslmode=verify-full' "$PGSERVICEFILE" &&
      grep -Fxq "sslrootcert=$ca" "$PGSERVICEFILE" || {
        echo 'Existing database files are incomplete or use a different TLS policy. Inspect them before retrying.' >&2
        exit 1
      }
    check_database "$PGSERVICEFILE" "$PGPASSFILE"
    exit
  fi

  read -r -p 'Supabase Session pooler hostname (Connect, Session pooler): ' pooler
  [[ $pooler =~ ^aws-[0-9]+-ap-southeast-1\.pooler\.supabase\.com$ ]] || { echo 'Expected the Singapore session pooler hostname'; exit 2; }
  read -rs -p 'Supabase database password: ' password
  printf '\n'
  [[ -n $password ]] || exit 2
  escaped=${password//\\/\\\\}
  escaped=${escaped//:/\\:}
  unset password

  temporary=$(mktemp -d /etc/flowday/.db-verify.XXXXXX)
  trap 'rm -f -- "$temporary/service.conf" "$temporary/pgpass"; rmdir -- "$temporary"' EXIT
  cat >"$temporary/service.conf" <<EOF
[$PGSERVICE]
host=$pooler
port=5432
user=$db_user
dbname=postgres
sslmode=verify-full
sslrootcert=$ca
EOF
  printf '%s:5432:postgres:%s:%s\n' "$pooler" "$db_user" "$escaped" >"$temporary/pgpass"
  unset escaped
  check_database "$temporary/service.conf" "$temporary/pgpass"
  # Publish only the verified configuration. Links refuse to overwrite another run.
  ln -- "$temporary/service.conf" "$PGSERVICEFILE"
  if ! ln -- "$temporary/pgpass" "$PGPASSFILE"; then
    rm -- "$PGSERVICEFILE"
    exit 1
  fi
)

runtime_target=runtime.env
case "${1:-}" in
  --verify-db)
    [[ $# -eq 1 ]] || exit 2
    verify_database
    echo 'Database verification complete. Application deployment was not started.'
    exit
    ;;
  --prepare-only)
    [[ $# -eq 1 ]] || exit 2
    runtime_target=runtime.pending
    ;;
  '') [[ $# -eq 0 ]] || exit 2 ;;
  *) echo 'Usage: configure-runtime.sh [--verify-db | --prepare-only]' >&2; exit 2 ;;
esac
for runtime_file in runtime.env runtime.pending; do
  [[ ! -e $runtime_file && ! -L $runtime_file ]] || { echo 'FlowDay runtime is already configured or staged.' >&2; exit 1; }
done
verify_database

read -rs -p 'Supabase Publishable key (sb_publishable_...): ' publishable
printf '\n'
[[ $publishable =~ ^sb_publishable_[A-Za-z0-9_-]+$ ]] || { echo 'Expected a Publishable key'; exit 2; }
printf 'apikey: %s\n' "$publishable" |
  curl --fail --silent --show-error --connect-timeout 5 --max-time 12 \
    --header @- "https://$project.supabase.co/auth/v1/settings" >/dev/null

install -d -m 0700 "$DOCKER_CONFIG"
if ! timeout 30 docker manifest inspect ghcr.io/0621jby/flowday:main >/dev/null 2>&1; then
  read -rs -p 'GitHub classic token with read:packages only: ' token
  printf '\n'
  [[ $token =~ ^ghp_[A-Za-z0-9]+$ ]] || { echo 'Expected a GitHub classic token'; exit 2; }
  printf '%s\n' "$token" | docker login ghcr.io -u 0621jby --password-stdin
  unset token
  if ! timeout 30 docker manifest inspect ghcr.io/0621jby/flowday:main >/dev/null 2>&1; then
    echo 'GHCR still cannot read the private FlowDay image. Check the token read:packages permission and try again.' >&2
    exit 1
  fi
fi
if [[ -f $DOCKER_CONFIG/config.json ]]; then chmod 0600 "$DOCKER_CONFIG/config.json"; fi
read -r -p 'FlowDay HTTPS origin [https://101.201.196.177]: ' origin
origin=${origin:-https://101.201.196.177}
[[ $origin =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo 'Expected a canonical HTTPS origin'; exit 2; }

config_tmp=$(mktemp /opt/flowday/.runtime.XXXXXX)
trap 'rm -f -- "$config_tmp"' EXIT
cat >"$config_tmp" <<EOF
FLOWDAY_REQUIRE_CLOUD=1
APP_ORIGIN=$origin
NEXT_PUBLIC_SUPABASE_URL=https://$project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$publishable
AI_PROPOSAL_SECRET=$(openssl rand -hex 32)
AI_PROVIDER=mock
AI_ENABLE_PAID_CALLS=false
EOF
ln -- "$config_tmp" "$runtime_target"
if [[ $runtime_target == runtime.pending ]]; then
  echo 'FlowDay runtime credentials staged. Deployment was not started.'
else
  echo 'FlowDay server credentials verified. Deployment will start automatically.'
fi

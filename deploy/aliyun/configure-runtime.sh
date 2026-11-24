#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID == 0 && -t 0 ]] || { echo 'Run in Workbench using sudo bash /opt/flowday/configure-runtime.sh' >&2; exit 1; }
cd /opt/flowday
source /etc/flowday/operations.env
export PGSERVICE PGSERVICEFILE PGPASSFILE PGCONNECT_TIMEOUT FLOWDAY_PG_IMAGE DOCKER_CONFIG
for path in "$PGSERVICEFILE" "$PGPASSFILE" /opt/flowday/runtime.env; do
  [[ ! -e $path && ! -L $path ]] || { printf 'Already configured: %s\n' "$path" >&2; exit 1; }
done

echo 'Enter Connection details from the flowday Supabase project. Sensitive input is hidden.'
read -r -p 'Supabase Publishable key (sb_publishable_...): ' publishable
[[ $publishable =~ ^sb_publishable_[A-Za-z0-9_-]+$ ]] || { echo 'Expected a Publishable key'; exit 2; }
read -r -p 'Supabase Session pooler hostname (Connect, Session pooler): ' pooler
[[ $pooler =~ ^aws-[0-9]+-ap-southeast-1\.pooler\.supabase\.com$ ]] || { echo 'Expected the Singapore session pooler hostname'; exit 2; }
read -rs -p 'Supabase database password: ' password
printf '\n'
[[ -n $password ]] || exit 2
read -rs -p 'GitHub classic token with read:packages only: ' token
printf '\n'
[[ $token =~ ^ghp_[A-Za-z0-9]+$ ]] || { echo 'Expected a GitHub classic token'; exit 2; }
read -r -p 'FlowDay HTTPS origin (e.g. https://flowday.example.com, no trailing slash): ' origin
[[ $origin =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo 'Expected a canonical HTTPS origin'; exit 2; }

project=wigcksgpsjcaootcelwc
db_user=postgres.$project
ca=system
if [[ -r /etc/flowday/postgres-ca/prod-supabase.cer ]]; then
  ca=/etc/flowday/postgres-ca/prod-supabase.cer
fi
escaped=${password//\\/\\\\}
escaped=${escaped//:/\\:}
install -d -m 0700 "$DOCKER_CONFIG" /etc/flowday/postgres-ca
printf '%s\n' "$token" | docker login ghcr.io -u 0621jby --password-stdin
unset token password
curl --fail --silent --show-error --connect-timeout 5 --max-time 12 \
  -H "apikey: $publishable" "https://$project.supabase.co/auth/v1/settings" >/dev/null

cat >"$PGSERVICEFILE" <<EOF
[$PGSERVICE]
host=$pooler
port=5432
user=$db_user
dbname=postgres
sslmode=verify-full
sslrootcert=$ca
EOF
printf '%s:5432:postgres:%s:%s\n' "$pooler" "$db_user" "$escaped" >"$PGPASSFILE"
unset escaped
if ! /opt/flowday/bin/psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT current_setting('"'server_version'"'), current_database()'; then
  mv -- "$PGSERVICEFILE" "$PGSERVICEFILE.failed"
  rm -f -- "$PGPASSFILE"
  echo 'Database verification failed. Correct the connection details before retrying.' >&2
  exit 1
fi

cat >runtime.env <<EOF
FLOWDAY_REQUIRE_CLOUD=1
APP_ORIGIN=$origin
NEXT_PUBLIC_SUPABASE_URL=https://$project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$publishable
AI_PROPOSAL_SECRET=$(openssl rand -hex 32)
AI_PROVIDER=mock
AI_ENABLE_PAID_CALLS=false
EOF
echo 'FlowDay server credentials verified. Deployment and HTTPS still need to be enabled.'

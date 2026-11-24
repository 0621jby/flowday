#!/usr/bin/env bash
set -euo pipefail

# Pass the exact public project URL from the dashboard. No keys are needed.
url=${1:-}
[[ $url =~ ^https://[a-z0-9]+\.supabase\.co$ ]] || {
  echo 'Usage: probe.sh https://PROJECT_REF.supabase.co' >&2
  exit 2
}

printf 'utc,http_status,dns_s,connect_s,tls_s,first_byte_s,total_s\n'
for ((sample=1; sample<=10; sample++)); do
  printf '%s,' "$(date -u +%FT%TZ)"
  curl --silent --show-error --output /dev/null --connect-timeout 5 --max-time 12 \
    --write-out '%{http_code},%{time_namelookup},%{time_connect},%{time_appconnect},%{time_starttransfer},%{time_total}\n' \
    "$url/auth/v1/health" || true
  sleep 1
done

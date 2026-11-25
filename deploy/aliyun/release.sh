#!/usr/bin/env bash
set -euo pipefail
umask 077

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
readonly repository=ghcr.io/0621jby/flowday
readonly health="http://127.0.0.1:${FLOWDAY_HTTP_PORT:-13100}/api/health"
command -v flock >/dev/null || { echo "flock is required" >&2; exit 1; }
mkdir -p ops/backups
exec 9>ops/release.lock
flock -n 9 || exit 0

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a ops/deployments.log
}

read_release() {
  if [[ -f "$1" ]]; then
    cat -- "$1"
  fi
}

require_digest() {
  [[ $1 =~ ^ghcr\.io/0621jby/flowday@sha256:[a-f0-9]{64}$ ]]
}

switch_app() {
  FLOWDAY_IMAGE=$1 docker compose up -d --no-deps --pull never app
}

check_app() {
  local image=$1 response sha
  sha=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  [[ $sha =~ ^[a-f0-9]{40}$ ]] || return 1
  for ((attempt=1; attempt<=30; attempt++)); do
    if response=$(curl --fail --silent --max-time 3 "$health") &&
      [[ $response == *"\"release\":\"$sha\""* &&
         $response == *'"mode":"cloud-configured"'* ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

check_auth() {
  FLOWDAY_IMAGE=$1 docker compose exec -T app node -e '
    const url = new URL("/auth/v1/settings", process.env.NEXT_PUBLIC_SUPABASE_URL);
    fetch(url, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(8000),
    }).then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));
  '
}

save_release() {
  local image=$1 file=$2
  printf '%s\n' "$image" >"$file.tmp"
  mv -f -- "$file.tmp" "$file"
}

current=$(read_release ops/current)
if [[ -n $current ]]; then
  require_digest "$current" || { log "Invalid current image reference"; exit 1; }
fi

if [[ ${1:-} == rollback ]]; then
  previous=$(read_release ops/previous)
  require_digest "$previous" || { log "No valid rollback image"; exit 1; }
  if switch_app "$previous" && check_app "$previous"; then
    save_release "$previous" ops/current
    [[ -z $current ]] || save_release "$current" ops/previous
    # Keep the timer from redeploying the same rejected channel image.
    [[ -z $current ]] || save_release "$current" ops/rejected
    log "Rolled back to $previous"
  else
    [[ -z $current ]] || switch_app "$current"
    log "Rollback failed"
    exit 1
  fi
  exit
fi
[[ $# -eq 0 ]] || exit 2

if [[ -z $current && -f ops/first-release-image ]]; then
  candidate=$(read_release ops/first-release-image)
  require_digest "$candidate" || { log "Invalid approved first-release image digest"; exit 1; }
  docker pull "$candidate"
else
  docker pull "$repository:main"
  candidate=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$repository:main" |
    awk -v prefix="$repository@" 'index($0,prefix)==1 {print; exit}')
fi
require_digest "$candidate" || { log "Invalid channel image digest"; exit 1; }
[[ $candidate != "$current" && $candidate != "$(read_release ops/rejected)" ]] || exit 0

work=$(mktemp -d)
container=
cleanup() {
  [[ -z $container ]] || docker rm "$container" >/dev/null
  rm -r -- "$work"
}
trap cleanup EXIT
container=$(docker create "$candidate")
docker cp "$container:/app/migrations" "$work/migrations"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="ops/backups/${timestamp}-${candidate: -12}.dump"

log "Preparing $candidate"
if ! bash postgres.sh migrate "$work/migrations" "$backup"; then
  log "Backup or migration failed, candidate was not started"
  exit 1
fi
if switch_app "$candidate" && check_app "$candidate" && check_auth "$candidate"; then
  [[ -z $current ]] || save_release "$current" ops/previous
  save_release "$candidate" ops/current
  log "Deployed $candidate"
else
  save_release "$candidate" ops/rejected
  if [[ -n $current ]]; then
    if switch_app "$current" && check_app "$current"; then
      log "Candidate failed, restored $current"
    else
      log "Candidate failed and previous app did not pass the local health check"
    fi
  else
    FLOWDAY_IMAGE=$candidate docker compose stop app
    log "Initial candidate failed and was stopped"
  fi
  exit 1
fi

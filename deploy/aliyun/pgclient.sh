#!/usr/bin/env bash
set -euo pipefail
tool=${0##*/}
case $tool in psql|pg_dump|pg_restore) ;; *) exit 2 ;; esac
[[ ${FLOWDAY_PG_IMAGE:-} =~ ^public\.ecr\.aws/docker/library/postgres@sha256:[0-9a-f]{64}$ ]]

exec /usr/bin/docker run --rm -i \
  --workdir /opt/flowday \
  --env PGSERVICE --env PGSERVICEFILE --env PGPASSFILE --env PGCONNECT_TIMEOUT \
  --mount "type=bind,src=$PGSERVICEFILE,dst=$PGSERVICEFILE,readonly" \
  --mount "type=bind,src=$PGPASSFILE,dst=$PGPASSFILE,readonly" \
  --mount type=bind,src=/etc/flowday/certs,dst=/etc/flowday/certs,readonly \
  --mount type=bind,src=/opt/flowday/ops,dst=/opt/flowday/ops \
  --entrypoint "$tool" "$FLOWDAY_PG_IMAGE" "$@"

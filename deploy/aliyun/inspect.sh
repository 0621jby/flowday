#!/usr/bin/env bash
set -u

section() { printf '\n[%s]\n' "$1"; }

section "System"
sed -n '/^PRETTY_NAME=/p' /etc/os-release
uname -m
getconf _NPROCESSORS_ONLN
uptime

section "Memory and swap"
free -m
ps -eo comm,rss --sort=-rss | head -n 12
swapon --show --bytes

section "Root disk and inode capacity"
df -hT /
df -ih /

section "Listening sockets"
ss -lntup

section "Active system services"
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --state=running --no-pager --no-legend
fi

section "Container runtime"
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
fi

section "Installed application components"
for command_name in nginx caddy node psql pg_dump; do
  if command -v "$command_name" >/dev/null 2>&1; then
    command -v "$command_name"
  fi
done

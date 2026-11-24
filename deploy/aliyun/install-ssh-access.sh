#!/usr/bin/env bash
set -euo pipefail
umask 077

account=flowday-deploy
home=/var/lib/flowday-ssh
keys=/etc/ssh/flowday-deploy.keys
config=/etc/ssh/sshd_config.d/90-flowday-deploy.conf
sudoers=/etc/sudoers.d/90-flowday-deploy
gate=/usr/local/libexec/flowday-ssh
control=/usr/local/libexec/flowday-control
public_key=${1:-}

[[ $EUID -eq 0 && $public_key =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+\ flowday-deploy@aliyun$ ]]
read -r client_ip _ _ _ <<<"${SSH_CONNECTION:-127.0.0.1 0 127.0.0.1 22}"
if getent passwd "$account" >/dev/null; then
  echo "Deployment account already exists. Inspect its state before proceeding." >&2
  exit 1
fi
for path in "$home" "$keys" "$config" "$sudoers" "$gate" "$control"; do
  if [[ -e $path || -L $path ]]; then
    printf 'Refusing to overwrite %s\n' "$path" >&2
    exit 1
  fi
done

created=0
committed=0
cleanup() {
  if (( committed )); then return; fi
  rm -f -- "$keys" "$config" "$sudoers" "$gate" "$control"
  if (( created )); then /usr/sbin/userdel "$account" || true; fi
  if [[ -d $home ]]; then rmdir -- "$home" || true; fi
  if /usr/sbin/sshd -t; then /usr/bin/systemctl reload sshd || true; fi
}
trap cleanup EXIT
/usr/bin/install -d -m 0755 "$home"
# Invalid crypt value, with public-key authentication explicitly enforced by sshd.
# A shadow value beginning with '!' can block even public-key login with UsePAM=no.
/usr/sbin/useradd -M -d "$home" -s /bin/sh -p '*' "$account"
created=1

printf 'restrict %s\n' "$public_key" >"$keys"
# sshd temporarily reads authorized_keys as the authenticating UID.
chmod 0644 "$keys"

cat >"$gate" <<'SH'
#!/bin/sh
set -eu
case "${SSH_ORIGINAL_COMMAND:-}" in
  status|logs|update|rollback)
    exec /usr/bin/sudo -n /usr/local/libexec/flowday-control "$SSH_ORIGINAL_COMMAND"
    ;;
  *)
    printf '%s\n' 'Only status, logs, update and rollback are allowed.' >&2
    exit 126
    ;;
esac
SH

cat >"$control" <<'SH'
#!/bin/sh
set -eu
[ "$#" -eq 1 ] || exit 126
case "$1" in
  status)
    for unit in flowday-release.service flowday-release.timer flowday-backup.timer; do
      printf '\n[%s]\n' "$unit"
      /usr/bin/systemctl show "$unit" -p LoadState -p ActiveState -p SubState -p Result
    done
    ;;
  logs)
    /usr/bin/journalctl --no-pager -n 60 -t flowday-control
    if [ -f /opt/flowday/ops/deployments.log ]; then
      /usr/bin/tail -n 40 -- /opt/flowday/ops/deployments.log
    fi
    ;;
  update|rollback)
    if [ "$1" = update ]; then
      unit=flowday-release.service
    else
      unit=flowday-rollback.service
    fi
    /usr/bin/logger -t flowday-control -- "Requested $1"
    /usr/bin/systemctl start "$unit"
    /usr/bin/logger -t flowday-control -- "Completed $1"
    ;;
  *) exit 126 ;;
esac
SH
chmod 0755 "$gate" "$control"

cat >"$sudoers" <<'SUDO'
flowday-deploy ALL=(root) NOPASSWD: NOSETENV: /usr/local/libexec/flowday-control status, /usr/local/libexec/flowday-control logs, /usr/local/libexec/flowday-control update, /usr/local/libexec/flowday-control rollback
SUDO
chmod 0440 "$sudoers"
cat >"$config" <<'SSH'
Match User flowday-deploy
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile /etc/ssh/flowday-deploy.keys
    AuthorizedKeysCommand none
    TrustedUserCAKeys none
    ForceCommand /usr/local/libexec/flowday-ssh
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    PermitTunnel no
Match all
SSH
if command -v restorecon >/dev/null; then
  restorecon "$home" "$keys" "$config" "$sudoers" "$gate" "$control"
fi

/usr/sbin/visudo -c
/usr/sbin/sshd -t
effective=$(/usr/sbin/sshd -T -C "user=$account,host=localhost,addr=$client_ip")
for rule in \
  'authenticationmethods publickey' \
  'passwordauthentication no' \
  'kbdinteractiveauthentication no' \
  "authorizedkeysfile $keys" \
  "forcecommand $gate" \
  'disableforwarding yes' \
  'permittty no'; do
  grep -Fxq "$rule" <<<"$effective" || { echo "Missing SSH rule: $rule" >&2; exit 1; }
done
/usr/bin/systemctl reload sshd
committed=1
printf 'Installed and validated SSH rules for %s.\n' "$account"

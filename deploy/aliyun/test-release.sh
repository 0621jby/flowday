#!/usr/bin/env bash
set -euo pipefail

source_dir=$(dirname -- "${BASH_SOURCE[0]}")
work=$(mktemp -d)
trap 'rm -r -- "$work"' EXIT
cp "$source_dir/release.sh" "$work/"
cd -- "$work"
mkdir bin ops
export PATH="$work/bin:$PATH"
export FLOWDAY_TEST_OLD="ghcr.io/0621jby/flowday@sha256:$(printf 'b%.0s' {1..64})"
export FLOWDAY_TEST_NEW="ghcr.io/0621jby/flowday@sha256:$(printf 'a%.0s' {1..64})"
export FLOWDAY_TEST_RELEASE="$(printf 'c%.0s' {1..40})"
printf '%s\n' "$FLOWDAY_TEST_OLD" >ops/current
cat >bin/docker <<'SH'
#!/usr/bin/env bash
case "$*" in
  'image inspect '*RepoDigests*) echo "$FLOWDAY_TEST_NEW" ;;
  'image inspect '*) echo "$FLOWDAY_TEST_RELEASE" ;;
  'create '*) echo temp-container ;;
  'cp '*) mkdir "$3" ;;
  'compose up '*) printf '%s\n' "$FLOWDAY_IMAGE" >>ops/switches ;;
  'compose exec '*) [[ $FLOWDAY_IMAGE == "$FLOWDAY_TEST_OLD" ]] ;;
  'pull '*|'rm temp-container') ;;
  *) exit 99 ;;
esac
SH
cat >bin/curl <<'SH'
#!/usr/bin/env bash
printf '{"mode":"cloud-configured","release":"%s"}\n' "$FLOWDAY_TEST_RELEASE"
SH
cat >bin/sleep <<'SH'
#!/usr/bin/env bash
exit 0
SH
if ! command -v flock >/dev/null; then
  cp bin/sleep bin/flock # Git for Windows lacks flock. CI uses the real lock.
fi
cat >postgres.sh <<'SH'
printf '%s\n' "$1" >>ops/database-steps
SH
chmod +x bin/*

if bash release.sh; then
  echo 'Unhealthy candidate unexpectedly deployed' >&2
  exit 1
fi
[[ $(cat ops/current) == "$FLOWDAY_TEST_OLD" ]]
[[ $(cat ops/rejected) == "$FLOWDAY_TEST_NEW" ]]
[[ $(cat ops/database-steps) == migrate ]]
[[ $(cat ops/switches) == "$FLOWDAY_TEST_NEW"$'\n'"$FLOWDAY_TEST_OLD" ]]
bash release.sh
[[ $(wc -l <ops/switches) -eq 2 ]]
echo 'Failed candidate rolled back and was skipped on the following run.'

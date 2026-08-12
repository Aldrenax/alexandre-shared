#!/usr/bin/env bash
set -euo pipefail

container="${HERMES_CONTAINER:-hermes-agent}"
owner="${HERMES_DOCKER_USER:-10000:10000}"
uid="${owner%%:*}"
gid="${owner##*:}"

if [[ ! "$uid" =~ ^[0-9]+$ || ! "$gid" =~ ^[0-9]+$ ]]; then
  echo "HERMES_DOCKER_USER invalide: $owner" >&2
  exit 2
fi

"${DOCKER_BIN:-/usr/bin/docker}" exec --user 0:0 "$container" /bin/sh -c '
  set -eu
  uid="$1"
  gid="$2"
  mkdir -p /opt/data/logs
  chown "$uid:$gid" /opt/data/logs
  chmod 0700 /opt/data/logs
  for file in /opt/data/logs/*.log; do
    [ -e "$file" ] || continue
    chown "$uid:$gid" "$file"
    chmod 0600 "$file"
  done
' ensure-hermes-log-permissions "$uid" "$gid"

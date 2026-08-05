#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--apply" ]]; then
  echo "Lecture seule. Relancer avec --apply après validation explicite du déploiement."
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ce script doit être lancé en root sur le VPS chaimbault." >&2
  exit 1
fi
command -v jq >/dev/null || { echo "jq est requis." >&2; exit 1; }

set -a
source /etc/alexandre-media-engine/media-engine.env
set +a
preflight="$(/usr/bin/node /opt/alexandre-media-engine/current/bin/media-engine.mjs preflight --json)"
printf '%s\n' "$preflight" | jq .
if [[ "$(printf '%s' "$preflight" | jq -r '.readyForShadow')" != "true" ]]; then
  echo "Préflight shadow refusé." >&2
  exit 1
fi

if [[ ! -e /etc/alexandre-media-engine/shadow.env ]]; then
  install -m 0640 /dev/null /etc/alexandre-media-engine/shadow.env
  printf 'MEDIA_ENGINE_SHADOW_STARTED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /etc/alexandre-media-engine/shadow.env
fi

systemctl enable --now \
  alexandre-media-network.timer \
  alexandre-media-video.timer \
  alexandre-media-guide.timer \
  alexandre-media-monitor.timer

echo "Mode shadow actif. Publication et push restent désactivés."

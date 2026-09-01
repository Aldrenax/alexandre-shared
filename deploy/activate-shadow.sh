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
set -a
source /etc/alexandre-media-engine/media-engine.env
set +a
preflight="$(/usr/bin/node /opt/alexandre-media-engine/current/bin/media-engine.mjs preflight --json)"
printf '%s\n' "$preflight" | /usr/bin/node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(input), null, 2)));
'
if ! printf '%s' "$preflight" | /usr/bin/node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    process.exit(JSON.parse(input).readyForShadow === true ? 0 : 1);
  });
'; then
  echo "Préflight shadow refusé." >&2
  exit 1
fi

if ! thumbnail_vision_preflight="$(/usr/bin/node /opt/alexandre-media-engine/current/bin/thumbnail-vision-preflight.mjs)"; then
  printf '%s\n' "$thumbnail_vision_preflight"
  echo "Canari Hermes vision refusé; aucun timer n'a été activé." >&2
  exit 1
fi
printf '%s\n' "$thumbnail_vision_preflight" | /usr/bin/node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    process.exit(result.check === "thumbnail-vision-preflight" && result.passed === true ? 0 : 1);
  });
' || {
  echo "Verdict du canari Hermes vision invalide; aucun timer n'a été activé." >&2
  exit 1
}
printf '%s\n' "$thumbnail_vision_preflight" | /usr/bin/node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => console.log(JSON.stringify(JSON.parse(input), null, 2)));
'

if [[ ! -e /etc/alexandre-media-engine/shadow.env ]]; then
  install -m 0640 /dev/null /etc/alexandre-media-engine/shadow.env
  printf 'MEDIA_ENGINE_SHADOW_STARTED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /etc/alexandre-media-engine/shadow.env
fi

systemctl enable --now \
  alexandre-media-network.timer \
  alexandre-media-video.timer \
  alexandre-media-guide.timer \
  alexandre-media-thumbnail-refresh.timer \
  alexandre-media-monitor.timer

echo "Mode shadow actif. Publication et push restent désactivés."

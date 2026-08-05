#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--apply" || "${2:-}" != "AUTOMATIC_PUBLICATION_APPROVED" ]]; then
  echo "Activation refusée. Syntaxe: $0 --apply AUTOMATIC_PUBLICATION_APPROVED" >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ce script doit être lancé en root sur le VPS chaimbault." >&2
  exit 1
fi
command -v jq >/dev/null || { echo "jq est requis." >&2; exit 1; }
if ! systemctl is-active --quiet alexandre-media-engine-events.path; then
  echo "Le pont Hermes/Telegram n'est pas actif. Publication refusée." >&2
  exit 1
fi

CONFIG_DIR=/etc/alexandre-media-engine
set -a
source "$CONFIG_DIR/media-engine.env"
source "$CONFIG_DIR/shadow.env"
set +a
preflight="$(
  MEDIA_ENGINE_PUBLICATION_MODE=automatic \
  MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED=true \
  MEDIA_ENGINE_PUSH_ENABLED=true \
  /usr/bin/node /opt/alexandre-media-engine/current/bin/media-engine.mjs preflight --json
)"
printf '%s\n' "$preflight" | jq .
if [[ "$(printf '%s' "$preflight" | jq -r '.readyForPublishing')" != "true" ]]; then
  echo "Préflight publication refusé. Aucun timer n'a été modifié." >&2
  exit 1
fi

publication_tmp="$CONFIG_DIR/publication.env.$$.tmp"
install -m 0640 /dev/null "$publication_tmp"
printf '%s\n' \
  'MEDIA_ENGINE_PUBLICATION_MODE=automatic' \
  'MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED=true' \
  'MEDIA_ENGINE_PUSH_ENABLED=true' > "$publication_tmp"
if [[ -e "$CONFIG_DIR/publication.env" ]]; then
  cp -a "$CONFIG_DIR/publication.env" "$CONFIG_DIR/publication.env.backup-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mv -f "$publication_tmp" "$CONFIG_DIR/publication.env"

systemctl disable --now \
  tesla-tech-news.timer \
  investissement-news.timer \
  entreprise-news.timer \
  affiliation-news.timer \
  logiciels-news.timer
if ! systemctl enable --now alexandre-media-publish.timer; then
  systemctl enable --now \
    tesla-tech-news.timer \
    investissement-news.timer \
    entreprise-news.timer \
    affiliation-news.timer \
    logiciels-news.timer
  echo "Activation du nouveau timer échouée. Anciens timers réactivés." >&2
  exit 1
fi

echo "Publication automatique activée. Vérifier immédiatement le premier reçu HTTP et Git."

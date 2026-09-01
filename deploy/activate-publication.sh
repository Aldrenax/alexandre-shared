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
CONFIG_DIR="${MEDIA_ENGINE_CONFIG_DIR:-/etc/alexandre-media-engine}"
CURRENT_DIR="${MEDIA_ENGINE_CURRENT_DIR:-/opt/alexandre-media-engine/current}"
NODE_BIN="${MEDIA_ENGINE_NODE_BIN:-/usr/bin/node}"
SYSTEMCTL_BIN="${MEDIA_ENGINE_SYSTEMCTL_BIN:-systemctl}"
publisher_timer=alexandre-media-publish.timer
legacy_timers=(
  tesla-tech-news.timer
  investissement-news.timer
  entreprise-news.timer
  affiliation-news.timer
  logiciels-news.timer
)
managed_timers=("$publisher_timer" "${legacy_timers[@]}")
initial_timer_enabled=()
initial_timer_active=()

if ! "$SYSTEMCTL_BIN" is-active --quiet alexandre-media-engine-events.path; then
  echo "Le pont Hermes/Telegram n'est pas actif. Publication refusée." >&2
  exit 1
fi
for unit in "${managed_timers[@]}"; do
  if "$SYSTEMCTL_BIN" is-enabled --quiet "$unit"; then
    initial_timer_enabled+=(true)
  else
    initial_timer_enabled+=(false)
  fi
  if "$SYSTEMCTL_BIN" is-active --quiet "$unit"; then
    initial_timer_active+=(true)
  else
    initial_timer_active+=(false)
  fi
done

set -a
source "$CONFIG_DIR/media-engine.env"
source "$CONFIG_DIR/shadow.env"
set +a
preflight="$(
  MEDIA_ENGINE_PUBLICATION_ENV_FILE=/dev/null \
  MEDIA_ENGINE_PUBLICATION_MODE=automatic \
  MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED=true \
  MEDIA_ENGINE_PUSH_ENABLED=true \
  "$NODE_BIN" "$CURRENT_DIR/bin/media-engine.mjs" preflight --json
)"
printf '%s\n' "$preflight"
if [[ "$("$NODE_BIN" -e 'process.stdout.write(String(JSON.parse(process.argv[1]).readyForPublishing === true))' "$preflight")" != "true" ]]; then
  echo "Préflight publication refusé. Aucun timer n'a été modifié." >&2
  exit 1
fi

publication_tmp="$CONFIG_DIR/publication.env.$$.tmp"
publication_rollback_tmp="$CONFIG_DIR/publication.env.$$.rollback.tmp"
publication_backup=''
had_previous_publication_env=false
cleanup() {
  rm -f -- "$publication_tmp" "$publication_rollback_tmp"
}
rollback_publication() {
  local rollback_status=0
  if [[ "$had_previous_publication_env" == true ]]; then
    cp -a -- "$publication_backup" "$publication_rollback_tmp" || rollback_status=1
    if [[ "$rollback_status" -eq 0 ]]; then
      mv -f -- "$publication_rollback_tmp" "$CONFIG_DIR/publication.env" || rollback_status=1
    fi
  else
    rm -f -- "$CONFIG_DIR/publication.env" || rollback_status=1
  fi
  for index in "${!managed_timers[@]}"; do
    unit="${managed_timers[$index]}"
    if [[ "${initial_timer_enabled[$index]}" == true ]]; then
      "$SYSTEMCTL_BIN" enable "$unit" || rollback_status=1
    else
      "$SYSTEMCTL_BIN" disable "$unit" || rollback_status=1
    fi
  done
  for index in "${!managed_timers[@]}"; do
    unit="${managed_timers[$index]}"
    if [[ "${initial_timer_active[$index]}" == true ]]; then
      "$SYSTEMCTL_BIN" start "$unit" || rollback_status=1
    else
      "$SYSTEMCTL_BIN" stop "$unit" || rollback_status=1
    fi
  done
  return "$rollback_status"
}
trap cleanup EXIT
install -m 0640 /dev/null "$publication_tmp"
cutover_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ -r "$CONFIG_DIR/publication.env" ]]; then
  previous_cutover="$(sed -n 's/^MEDIA_ENGINE_AUTOMATIC_CUTOVER_AT=//p' "$CONFIG_DIR/publication.env" | tail -n 1)"
  [[ -n "$previous_cutover" ]] && cutover_at="$previous_cutover"
fi
# Cadence réseau validée en production. Elle préserve un débit élevé tout en
# conservant les leases, contrôles QA, reprises bornées et vérifications publiques.
printf '%s\n' \
  'MEDIA_ENGINE_PUBLICATION_MODE=automatic' \
  'MEDIA_ENGINE_AUTOMATIC_PUBLICATION_APPROVED=true' \
  'MEDIA_ENGINE_PUSH_ENABLED=true' \
  "MEDIA_ENGINE_AUTOMATIC_CUTOVER_AT=$cutover_at" \
  'MEDIA_ENGINE_PUBLICATION_DAILY_LIMIT=36' \
  'MEDIA_ENGINE_PUBLICATION_NEWS_DAILY_LIMIT=30' \
  'MEDIA_ENGINE_PUBLICATION_EXTRA_NEWS_DAILY_LIMIT=6' \
  'MEDIA_ENGINE_PUBLICATION_NON_NEWS_DAILY_LIMIT=6' \
  'MEDIA_ENGINE_PUBLICATION_PER_MEDIA_DAILY_LIMIT=6' \
  'MEDIA_ENGINE_NEWS_PER_MEDIA_DAILY_LIMIT=6' \
  'MEDIA_ENGINE_NON_NEWS_PER_MEDIA_DAILY_LIMIT=2' \
  'MEDIA_ENGINE_VIDEO_PER_MEDIA_DAILY_LIMIT=1' \
  'MEDIA_ENGINE_GUIDE_PER_MEDIA_WEEKLY_LIMIT=2' \
  'MEDIA_ENGINE_PUBLICATION_MIN_INTERVAL_MINUTES=10' \
  'MEDIA_ENGINE_PUBLICATION_PER_MEDIA_MIN_INTERVAL_MINUTES=60' \
  "MEDIA_ENGINE_NEWS_MAX_AGE_HOURS=${MEDIA_ENGINE_NEWS_MAX_AGE_HOURS:-72}" \
  "MEDIA_ENGINE_VIDEO_LOOKBACK_DAYS=${MEDIA_ENGINE_VIDEO_LOOKBACK_DAYS:-7}" > "$publication_tmp"
# La curation doit réussir avec l'ancien override encore effectif. La nouvelle
# cadence n'est rendue visible qu'après cette étape.
"$NODE_BIN" "$CURRENT_DIR/bin/media-engine.mjs" curate \
  --apply \
  --cutover-at "$cutover_at" \
  --news-max-age-hours "${MEDIA_ENGINE_NEWS_MAX_AGE_HOURS:-72}" \
  --json

if [[ -e "$CONFIG_DIR/publication.env" ]]; then
  had_previous_publication_env=true
  publication_backup="$CONFIG_DIR/publication.env.backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a -- "$CONFIG_DIR/publication.env" "$publication_backup"
fi
mv -f -- "$publication_tmp" "$CONFIG_DIR/publication.env"

if ! "$SYSTEMCTL_BIN" disable --now "${legacy_timers[@]}"; then
  if rollback_publication; then
    echo "Désactivation des anciens timers échouée. Configuration précédente restaurée." >&2
  else
    echo "Désactivation des anciens timers et rollback incomplets : intervention manuelle requise." >&2
  fi
  exit 1
fi
if ! "$SYSTEMCTL_BIN" enable --now "$publisher_timer"; then
  if rollback_publication; then
    echo "Activation du nouveau timer échouée. Configuration et états initiaux des timers restaurés." >&2
  else
    echo "Activation du nouveau timer et rollback incomplets : intervention manuelle requise." >&2
  fi
  exit 1
fi

postcondition_ok=true
if ! "$SYSTEMCTL_BIN" is-enabled --quiet "$publisher_timer" \
  || ! "$SYSTEMCTL_BIN" is-active --quiet "$publisher_timer"; then
  postcondition_ok=false
fi
for unit in "${legacy_timers[@]}"; do
  if "$SYSTEMCTL_BIN" is-enabled --quiet "$unit" \
    || "$SYSTEMCTL_BIN" is-active --quiet "$unit"; then
    postcondition_ok=false
  fi
done
if [[ "$postcondition_ok" != true ]]; then
  if rollback_publication; then
    echo "Postcondition timers invalide. Configuration et états initiaux restaurés." >&2
  else
    echo "Postcondition timers invalide et rollback incomplet : intervention manuelle requise." >&2
  fi
  exit 1
fi

echo "Publication automatique activée. Vérifier immédiatement le premier reçu HTTP et Git."

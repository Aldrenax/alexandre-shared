#!/usr/bin/env bash
set -euo pipefail

apply=false
prune_stale=false
for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --prune-stale) prune_stale=true ;;
    *)
      echo "Argument inconnu: $argument" >&2
      exit 2
      ;;
  esac
done

if [[ "$apply" != true ]]; then
  echo "Lecture seule. Relancer avec --apply après validation explicite du déploiement."
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ce script doit être lancé en root sur le VPS chaimbault." >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_ROOT=/opt/alexandre-media-engine
CONFIG_DIR=/etc/alexandre-media-engine
RUNTIME_DIR=/var/lib/alexandre-media-engine
RELEASE_ID="$(git -C "$SOURCE_DIR" rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$RELEASE_ROOT/releases/$RELEASE_ID"

install -d -m 0750 "$RELEASE_ROOT/releases" "$CONFIG_DIR" "$RUNTIME_DIR" /var/lib/hermes-agent/media-engine/assets "$RELEASE_DIR"
git -C "$SOURCE_DIR" archive HEAD | tar -x -C "$RELEASE_DIR"
/usr/bin/npm ci --omit=dev --ignore-scripts --prefix "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$RELEASE_ROOT/current.next"
mv -Tf "$RELEASE_ROOT/current.next" "$RELEASE_ROOT/current"

# Une installation ne supprime aucun rollback par défaut. Le nettoyage est une
# action destructive séparée, à n'exécuter qu'après autorisation explicite.
if [[ "$prune_stale" == true ]]; then
  mapfile -t stale_releases < <(
    find "$RELEASE_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
      | sort -nr \
      | tail -n +7 \
      | cut -d' ' -f2-
  )
  for stale_release in "${stale_releases[@]}"; do
    [[ "$stale_release" == "$RELEASE_DIR" ]] && continue
    case "$stale_release" in
      "$RELEASE_ROOT"/releases/*) rm -rf -- "$stale_release" ;;
      *)
        echo "Refus de supprimer une cible hors du répertoire des releases: $stale_release" >&2
        exit 1
        ;;
    esac
  done
else
  echo "Releases précédentes conservées; aucun nettoyage demandé."
fi

if [[ ! -e "$CONFIG_DIR/media-engine.env" ]]; then
  install -m 0640 "$SOURCE_DIR/deploy/media-engine.env.example" "$CONFIG_DIR/media-engine.env"
fi
if ! grep -q '^HERMES_DOCKER_USER=' "$CONFIG_DIR/media-engine.env"; then
  printf '\nHERMES_DOCKER_USER=10000:10000\n' >> "$CONFIG_DIR/media-engine.env"
fi
if [[ ! -e "$CONFIG_DIR/sites.json" ]]; then
  install -m 0640 "$SOURCE_DIR/deploy/sites.example.json" "$CONFIG_DIR/sites.json"
fi

for unit in "$SOURCE_DIR"/deploy/systemd/*.{service,timer}; do
  [[ -e "$unit" ]] || continue
  install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload

echo "Release installée: $RELEASE_DIR"
echo "Aucun timer n'a été activé. Lancer le préflight puis activate-shadow.sh --apply."

#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--apply" ]]; then
  echo "Lecture seule. Relancer avec --apply après validation explicite du déploiement shadow."
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ce script doit être lancé en root sur le VPS chaimbault." >&2
  exit 1
fi

CONFIG_DIR=/etc/alexandre-media-engine
ENV_PATH="$CONFIG_DIR/newsletter-shadow.env"
install -d -m 0750 "$CONFIG_DIR" /var/lib/alexandre-media-engine

if [[ ! -e "$ENV_PATH" ]]; then
  secret="$(openssl rand -hex 32)"
  install -m 0640 /dev/null "$ENV_PATH"
  {
    printf 'NEWSLETTER_SHADOW_MODE=shadow\n'
    printf 'NEWSLETTER_SHADOW_HOST=127.0.0.1\n'
    printf 'NEWSLETTER_SHADOW_PORT=8097\n'
    printf 'NEWSLETTER_ATTRIBUTION_HMAC_SECRET=%s\n' "$secret"
  } > "$ENV_PATH"
  unset secret
fi

if ! grep -q '^NEWSLETTER_SHADOW_MODE=shadow$' "$ENV_PATH"; then
  echo "Configuration refusée : NEWSLETTER_SHADOW_MODE doit rester à shadow." >&2
  exit 1
fi

systemctl enable --now alexandre-newsletter-shadow.service
curl --fail --silent --show-error http://127.0.0.1:8097/health
printf '\nRécepteur newsletter shadow actif en local. Aucun proxy public et aucun appel Systeme.io.\n'

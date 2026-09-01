import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(new URL('../deploy/install-media-engine.sh', import.meta.url), 'utf8');
const activateShadow = readFileSync(new URL('../deploy/activate-shadow.sh', import.meta.url), 'utf8');
const thumbnailRefreshService = readFileSync(
  new URL('../deploy/systemd/alexandre-media-thumbnail-refresh.service', import.meta.url),
  'utf8',
);
const thumbnailRefreshTimer = readFileSync(
  new URL('../deploy/systemd/alexandre-media-thumbnail-refresh.timer', import.meta.url),
  'utf8',
);

test('installation Media Engine: aucune release précédente n’est supprimée par défaut', () => {
  assert.match(installer, /prune_stale=false/u);
  assert.match(installer, /if \[\[ "\$prune_stale" == true \]\]; then/u);
  assert.match(installer, /Releases précédentes conservées; aucun nettoyage demandé/u);
  assert.doesNotMatch(
    installer.slice(0, installer.indexOf('if [[ "$prune_stale" == true ]]')),
    /rm -rf/u,
  );
});

test('installation Media Engine: le nettoyage reste borné au répertoire des releases', () => {
  assert.match(installer, /--prune-stale\) prune_stale=true/u);
  assert.match(installer, /"\$RELEASE_ROOT"\/releases\/\*\) rm -rf -- "\$stale_release"/u);
  assert.match(installer, /Refus de supprimer une cible hors du répertoire des releases/u);
});

test('installation Media Engine: le timer de reprise est installé sans être activé', () => {
  assert.match(installer, /deploy\/systemd\/\*\.\{service,timer,path\}/u);
  assert.doesNotMatch(installer, /systemctl\s+(?:enable|start|enable\s+--now)/u);
  assert.match(installer, /Aucun timer n'a été activé/u);
  assert.match(activateShadow, /systemctl enable --now[\s\S]*alexandre-media-thumbnail-refresh\.timer/u);
});

test('upgrade Media Engine: toutes les unités courantes doivent être inactives avant mutation systemd ou symlink', () => {
  const guardIndex = installer.indexOf('for unit in \\\n  alexandre-media-network.timer');
  const unitInstallIndex = installer.indexOf('for unit in "$SOURCE_DIR"/deploy/systemd');
  const daemonReloadIndex = installer.indexOf('systemctl daemon-reload');
  const symlinkIndex = installer.indexOf('ln -sfn "$RELEASE_DIR" "$RELEASE_ROOT/current.next"');
  assert.ok(guardIndex >= 0, 'guard upgrade absent');
  assert.ok(unitInstallIndex > guardIndex, 'unités modifiées avant le guard');
  assert.ok(daemonReloadIndex > unitInstallIndex, 'daemon-reload mal ordonné');
  assert.ok(symlinkIndex > daemonReloadIndex, 'symlink basculé avant systemd');
  for (const unit of [
    'alexandre-media-publish.path',
    'alexandre-media-publish.service',
    'alexandre-wordpress-draft.timer',
    'alexandre-wordpress-draft.service',
    'alexandre-media-monitor.service',
    'alexandre-newsletter-shadow.service',
  ]) assert.match(installer, new RegExp(unit.replaceAll('.', '\\.'), 'u'));
  assert.match(installer, /systemctl is-active --quiet "\$unit" \|\| systemctl is-enabled --quiet "\$unit"/u);
  assert.doesNotMatch(installer, /systemctl\s+stop/u);
});

test('activation shadow: le vrai canari Hermes vision précède et conditionne tous les timers', () => {
  const canaryCommand = '/usr/bin/node /opt/alexandre-media-engine/current/bin/thumbnail-vision-preflight.mjs';
  const canaryIndex = activateShadow.indexOf(canaryCommand);
  const shadowStartIndex = activateShadow.indexOf('MEDIA_ENGINE_SHADOW_STARTED_AT=');
  const activationIndex = activateShadow.indexOf('systemctl enable --now');
  assert.ok(canaryIndex >= 0, 'commande du canari vision absente');
  assert.ok(shadowStartIndex > canaryIndex, 'période shadow démarrée avant le canari vision');
  assert.ok(activationIndex > canaryIndex, 'timers activés avant le canari vision');
  assert.ok(activationIndex > shadowStartIndex, 'timers activés avant le début explicite de la période shadow');
  assert.match(activateShadow, /result\.check === "thumbnail-vision-preflight" && result\.passed === true/u);
  assert.match(activateShadow, /Canari Hermes vision refusé; aucun timer n'a été activé/u);
  assert.match(activateShadow, /Verdict du canari Hermes vision invalide; aucun timer n'a été activé/u);
});

test('systemd miniatures: reprise planifiée complète, durcie et bornée par le coupe-circuit', () => {
  assert.match(
    thumbnailRefreshService,
    /^ExecStart=\/usr\/bin\/node \/opt\/alexandre-media-engine\/current\/bin\/refresh-article-thumbnails\.mjs --apply --scheduled$/m,
  );
  assert.doesNotMatch(thumbnailRefreshService, /--limit(?:\s|=)/u);
  assert.match(thumbnailRefreshService, /^Requires=docker\.service$/m);
  assert.match(thumbnailRefreshService, /^NoNewPrivileges=true$/m);
  assert.match(thumbnailRefreshService, /^PrivateTmp=true$/m);
  assert.match(thumbnailRefreshService, /^PrivateDevices=true$/m);
  assert.match(thumbnailRefreshService, /^ProtectSystem=strict$/m);
  assert.match(thumbnailRefreshService, /^ProtectHome=true$/m);
  assert.match(
    thumbnailRefreshService,
    /^ReadOnlyPaths=\/opt\/alexandre-media-engine\/current \/var\/lib\/hermes-agent\/business-data \/var\/lib\/hermes-agent\/cache\/images$/m,
  );
  assert.match(
    thumbnailRefreshService,
    /^ReadWritePaths=\/var\/lib\/alexandre-media-engine \/var\/lib\/hermes-agent\/media-engine$/m,
  );
  assert.match(thumbnailRefreshTimer, /^OnCalendar=\*-\*-\* \*:07\/15:00 Europe\/Paris$/m);
  assert.match(thumbnailRefreshTimer, /^Persistent=true$/m);
  assert.match(thumbnailRefreshTimer, /^Unit=alexandre-media-thumbnail-refresh\.service$/m);
});

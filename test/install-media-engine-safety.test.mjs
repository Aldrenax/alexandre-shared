import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(new URL('../deploy/install-media-engine.sh', import.meta.url), 'utf8');

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

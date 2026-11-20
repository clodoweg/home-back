# Guide de test

Le projet a deux suites de tests, une par dépôt :

- **Back (ce dépôt)** : Vitest, rapide, sans réseau ni base réelle. Logique, sécurité, permissions,
  appels Home Assistant mockés. Couverture bloquante : 80 % global, 95 % sur le périmètre sécurité
  (`vitest.config.mts`).
- **Front (`../home`)** : Playwright E2E. Voir [`../home/e2e/GUIDE.md`](../home/e2e/GUIDE.md).

Une nouvelle fonctionnalité qui touche l'API met à jour **les deux** suites.

## Sources de vérité

- Conventions de test (mocks, helpers, couverture attendue) :
  [`.claude/rules/testing.md`](.claude/rules/testing.md).
- Ajouter une route avec son test : [`.claude/skills/new-api-route/SKILL.md`](.claude/skills/new-api-route/SKILL.md).

## Filets à connaître

- **Matrice des droits** (`__tests__/api/permission-matrix.test.ts`) : statut attendu de chaque route
  pour admin, user et children, sur le réseau maison et hors réseau. Une ligne qui change est un
  changement du modèle de droits.
- **Caractérisation** (`petkit-characterization`, `alerts-detector-characterization`) : snapshots de
  la synthèse Petkit et des alertes. Ne les régénère (`-u`) que pour un changement voulu, et relis
  le diff des `.snap`.
- **Isolation** : `fetch` non mocké et DNS réel sont interdits par `__tests__/setup.ts` ; la suite
  doit passer en ordre aléatoire (`npx vitest run --sequence.shuffle`). Les tests tournent en UTC.

## Commandes

Voir la section « Commandes » de [`CLAUDE.md`](CLAUDE.md). Pour des erreurs détaillées :
`npx vitest run --reporter=verbose`.

## Si un widget du front ne s'affiche plus après un changement d'API

1. Le format JSON de sortie a-t-il changé (enveloppe `data`, nouveau champ) ?
2. Le mock `../home/e2e/fixtures/api-mocks.ts` renvoie-t-il exactement la même structure ?

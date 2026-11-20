---
paths:
  - "lib/integrations/**"
---

# Intégrations tierces

- Une intégration par dossier `lib/integrations/<nom>/`, avec un `index.ts` qui ré-exporte l'API
  publique. Le nouveau code importe depuis `@/lib/integrations/<nom>` ; seuls les tests unitaires
  importent les fichiers internes.
- Prends les fichiers dont tu as besoin, sur le modèle d'Enedis (`lib/integrations/enedis/`) :
  - `types.ts` : contrats de données ;
  - `client.ts` : seulement s'il y a des appels HTTP directs vers le tiers (requêtes brutes) ;
  - `sync.ts` : seulement s'il y a écriture en base (upserts Prisma) ;
  - `service.ts` : logique métier et orchestration, appelée par les routes.
  Une intégration qui ne lit que Home Assistant (GRDF, Suez) se limite à `types` / `service` / `index`.
  Une synthèse volumineuse se découpe en fichiers de fonctions pures à côté de `service.ts`
  (ex. Petkit : `schedule.ts`, `feeder.ts`, `fountain.ts`).
- Transformations non triviales (parsing, agrégations, calculs de dates) : fonctions pures exportées,
  couvertes par un test dans `__tests__/unit/`.
- Dates : le serveur tourne en UTC sur Vercel mais pas forcément en local. Toute clé de jour
  (`YYYY-MM-DD`, colonne `@db.Date`) se construit avec `Date.UTC` / `getUTC*` /
  `toISOString().split('T')[0]`, pas avec `getDate()` ou `getHours()` locaux.
  Si la source fournit une heure locale de Paris (Home Assistant, Petkit), ou si le résultat est
  affiché par jour ou par heure de la maison, passe par `lib/paris-time.ts`
  (`parseParisTimestamp`, `getParisDayInt`, `getParisDate`, `getParisClock`).

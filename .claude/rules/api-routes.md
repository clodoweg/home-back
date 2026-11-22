---
paths:
  - "app/api/**"
  - "proxy.ts"
  - "lib/api-middleware.ts"
  - "lib/permissions.ts"
  - "lib/validators.ts"
---

# Routes API

- Toute route est exportée via `withAuth(async (request, { params, user, userId, userEmail }) => …)`,
  typée sur ses paramètres de chemin (`withAuth<{ entity_id: string }>`). Un paramètre de chemin ou de
  query qui atteint Home Assistant est validé (patterns de `lib/validators.ts`, `lib/ha-paths.ts`)
  puis encodé : Next décode `..%2F` et `fetch` normalise `..`.
  Une route publique est une exception justifiée par un commentaire `WARNING:` et protégée autrement
  (secret comparé à temps constant avec `safeCompare` de `lib/secure-compare.ts`). Aucune route
  ne renvoie de secret.
- Corps de requête : schéma Zod dans `lib/validators.ts`, puis
  `const v = await validateBody(request, schema); if (!v.success) return v.error;`.
  Query params de période : `parseDateRange` (`lib/date-utils.ts`). Toute nouvelle route valide ses
  entrées, même si des routes existantes ne le font pas.
- Réponses : `ApiResponse.success` / `badRequest` / `unauthorized` / `forbidden` / `notFound` /
  `serverError` / `text` / `image`, ou `ApiResponse.error(message, status, details, code)` pour un
  code métier (le code va dans `code`, jamais dans `details`). Aucune erreur interne (message, pile,
  IP) dans la réponse : détail dans `logger`, message générique au client. Réponse authentifiée :
  `Cache-Control: private`.
- Droits : helpers de `lib/permissions.ts` (`canAccessHistory`, `canAccessCameras`,
  `canProxyCamera`, `canSeeCameraEntities`, `canCallHAService`, `canRunHAAction`). Une action
  Home Assistant passe par `canRunHAAction` : tout pour l'admin, les seules actions du tableau de
  bord (`DASHBOARD_ACTIONS`) pour les autres groupes. Un refus se journalise avec
  `logger.security(...)`.
- Contrôleur léger : la logique métier et le filtrage vont dans `lib/integrations/`, pas dans la route.
- Home Assistant uniquement via `haGet` / `haPost` / `haFetch` / `haFetchBinary` (`lib/haClient.ts`),
  jamais par `fetch` direct.
- Journalisation via `logger` (`lib/logger.ts`), pas de `console.log` de debug.

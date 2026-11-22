# CLAUDE.md — home-back (API)

Back **Next.js 16 (App Router, API uniquement)** déployé sur Vercel : proxy sécurisé entre le front
`home` et Home Assistant, plus les intégrations tierces (Enedis, GRDF, Suez, Petkit,
Arlo via HA). Auth Clerk 7, PostgreSQL (Supabase) via Prisma 7 (adaptateur `pg`), rate limit
Upstash, stockage R2.

## Commandes

```bash
npm run dev                          # next dev -H 0.0.0.0 (port 3000, visible sur le LAN)
npm run build                        # prisma generate + next build
npm run test                         # Vitest, une passe
npx vitest run __tests__/api/ha-call.test.ts     # Un seul fichier
npm run test:coverage                # Couverture avec seuils bloquants (lib/**, app/api/**, proxy.ts)
npm run typecheck                    # Vérification des types (tsc --noEmit)
npm run lint                         # ESLint, zéro avertissement
npx prisma migrate dev --name <nom>  # Nouvelle migration (local), puis :
npx prisma generate                  # Prisma 7 ne régénère plus le client après une migration
npx prisma studio                    # Explorateur de base
```

## Vérifier ton travail

Avant de considérer une tâche terminée : `npm run typecheck`, `npm run lint` (ESLint flat config,
zéro avertissement toléré) puis `npm run test:coverage` (seuils bloquants). Les trois doivent passer ;
la CI GitHub lance la même chaîne, sur les PR seulement (quota Actions limité : pas de déclencheur
`push`, pas de run pour un changement limité aux `.md` ; l’audit npm ne tourne que si `package.json`
ou `package-lock.json` change, et chaque semaine).

## Architecture

Cycle d'une requête :

1. `proxy.ts` (ex-`middleware.ts`, renommé par Next 16) : Clerk, CORS (liste `lib/cors.ts`), préflight.
2. `withAuth()` (`lib/api-middleware.ts`) : rate limit, vérification du JWT Clerk (en-tête Bearer
   uniquement), chargement de l'utilisateur, restriction réseau, en-têtes CORS.
3. Handler `app/api/**/route.ts` : reçoit `{ params, user, userId, userEmail }`, valide, vérifie les
   droits (`lib/permissions.ts`), délègue à `lib/integrations/` ou `lib/haClient.ts`, répond via
   `ApiResponse` (`lib/api-response.ts`).

- `lib/haClient.ts` : tous les appels Home Assistant (`haGet`, `haPost`, `haFetch`, `haFetchBinary`
  pour les images) ; timeout 10 s, une nouvelle tentative sur erreur réseau seulement, jamais de cache.
  Le token HA n'est lu qu'ici et ne part que vers l'origine HA.
- `lib/ha-paths.ts` : construction des chemins HA à partir d'entrées client (listes autorisées,
  encodage) ; `lib/validators.ts` : schémas Zod et formats d'`entity_id`.
- `lib/integrations/<nom>/` : une intégration par dossier (Enedis = modèle complet ; Petkit et Arlo
  y vivent aussi). Utilitaires partagés : `lib/paris-time.ts` (heure de Paris), `lib/redis.ts`,
  `lib/ha-states-cache.ts`, `lib/client-ip.ts`, `lib/request-context.ts` (X-Request-Id jusqu'à HA).
- Modèles de données : `prisma/schema.prisma` ; client généré dans `lib/generated/prisma` (ignoré par
  git, produit par `prisma generate`), configuration du CLI dans `prisma.config.ts`.
- Tests : Vitest dans `__tests__/` (`api/`, `unit/`, `middleware/`), mocks globaux dans
  `__tests__/setup.ts`.

## Pièges non évidents

- Création des comptes (`lib/user.ts`, `provisionUser`) : au premier appel d'un compte Clerk
  inconnu, `withAuth` lit son email **vérifié** dans l'API Clerk (jamais les claims du jeton) et ne
  crée l'utilisateur que si cet email est dans `ALLOWED_EMAILS` ou `ADMIN_EMAILS` (admin pour ce
  dernier) ; sinon 403 `USER_NOT_FOUND`, sans rien écrire en base. Un utilisateur déjà en base avec
  cet email est **rattaché** au nouvel id Clerk (groupe, préférences, notifications conservés) : les ids
  changent au passage de l'instance Clerk de développement à celle de production. L'inscription
  Clerk doit rester fermée (invitation ou allowlist), cette liste n'en est que le second verrou.
- Instances Clerk (depuis le 22 novembre 2026) : **production** (`clerk.home.psaltery.org`,
  Invite-only, Google avec les identifiants OAuth du propriétaire) avec `CLERK_SECRET_KEY=sk_live_…`
  et `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_…` sur Vercel ; **développement**
  (`eager-penguin-61`, clés `sk_test_` / `pk_test_`) pour le local seulement. Le front et le back
  doivent viser la même instance. Pour ajouter un membre de la famille : compte dans Clerk
  (production) **et** e-mail dans `ALLOWED_EMAILS`.
- IP cliente (`lib/client-ip.ts`) : `cf-connecting-ip` n'est cru que si l'en-tête `x-origin-secret`
  injecté par Cloudflare vaut `CF_ORIGIN_SECRET` ; sinon l'IP posée par Vercel fait foi. Tout repose
  sur ce secret : il ne doit **jamais** apparaître dans une réponse (règle Cloudflare de type
  *Request Header*, pas *Response Header*). Le domaine de prod reste joignable chez Vercel sans
  passer par Cloudflare : `proxy.ts` appelle d'abord `guardOrigin` (`lib/origin-guard.ts`), qui en
  production Vercel journalise chaque requête (`Origin check ok` / `missing` / `mismatch`) et, avec
  `ENFORCE_ORIGIN_SECRET=true`, refuse en 403 (`ORIGIN_FORBIDDEN`) celles sans le bon secret. Une
  règle du pare-feu Vercel faisant ce contrôle refusait toutes les requêtes, bien que l'en-tête
  arrive aux fonctions : elle reste en *Log*. Changer le secret = Vercel (variable, règle du
  pare-feu) + Cloudflare.
  Réseau maison (`isOnHomeNetwork`, `lib/permissions.ts`) : réseau local, plus l'IP publique du nom
  DDNS de `HOME_DDNS_HOSTNAME` (variable Vercel, jamais en dur : elle révèle l'IP de la maison).
- Le dépôt est **public** : aucun identifiant personnel en dur (numéros de compteur, de contrat,
  de série, d'appareil, noms, adresses). Ils viennent de variables Vercel (`HOME_DDNS_HOSTNAME`,
  `SUEZ_COUNTER_ID`, `PETKIT_DEVICE_ID`) ; les tests utilisent des valeurs fictives
  (`__tests__/setup.ts`).
- États et historique HA (`lib/ha-state-filter.ts`) : `GET /api/ha/states` et `/api/ha/history`
  retirent, pour tous les groupes, la position GPS (`latitude`, `longitude`…) et les accès caméra
  (`access_token`, `entity_picture`, `last_video`) ; `last_thumbnail` perd sa query string (la
  signature), le front lit l'horodatage de son chemin. Un nouvel attribut sensible s'y ajoute.
- Rate limit (`lib/ratelimit.ts`) : Upstash, partagé par les instances ; sans Upstash ou s'il
  tombe, une fenêtre en mémoire par instance prend le relais (jamais illimité, jamais de 500).
- CORS : en production, seule l'origine du front ; `localhost:5173` seulement hors production (le
  front en local vise un back local, `VITE_API_URL=http://localhost:3000`).
- Le JWT ne passe **jamais** en query string (`?token=` refusé) : le front charge les images avec
  `fetch` + `Authorization`.
- Les droits sont portés par `UserGroup.permissions` : drapeaux (`remote`, `history`, `cameras`,
  `admin`), joker `*` ou `entity_id` autorisés. Le groupe admin passe les contrôles d'entités ; sans
  permission `remote`, l'accès est limité au réseau de la maison.
- Actions Home Assistant (`POST /api/ha/call`, `canRunHAAction`) : le groupe admin (le
  propriétaire) lance tout ; les autres groupes (la famille) **seulement les actions que le
  tableau de bord propose** (`DASHBOARD_ACTIONS` de `lib/permissions.ts` : lumières, prises,
  climat, listes de choix, boutons, scènes, alarme avec le droit `alarm_control`, jamais pour
  `children`). Scripts, automatisations, serrures, portes, `input_*`… restent à l'admin. Le back
  parle à HA avec un seul jeton : HA ne sait pas qui agit, cette liste est le seul verrou. Un
  service que le front se met à appeler s'y ajoute, sinon la famille reçoit un 403.
- `POST /api/ha/template` (Jinja libre, exécuté avec le token admin HA) est **réservé au groupe
  admin** (`canRenderHATemplate`). Le front lit les pièces / étages / modèles via
  `GET /api/ha/metadata` (template figé côté serveur, en `tojson`) et la météo via
  `GET /api/ha/forecast` : n'ajoute jamais de template construit par le client.
- Ne recopie jamais le statut HTTP de Home Assistant dans la réponse : un 401/403 de HA (token HA
  invalide) passerait pour une session Clerk expirée côté front. Erreur HA → 502 générique ; seul un
  404 d'entité inconnue (images, caméras) reste 404.
- Routes sans `withAuth`, protégées autrement : `health` (publique : statut seulement, jamais la
  version déployée), `cron` (Bearer `CRON_SECRET`).
- Planification : **un seul job** chez cron-job.org, `/api/cron?task=check-alerts` chaque minute. Après
  les alertes, il lance au plus une tâche de maintenance due (`lib/integrations/maintenance`) :
  compteurs d'usage de la veille, synchro Enedis toutes les 4 h, purge R2 (images de plus de 7 jours)
  chaque jour ; dernière tentative dans `SystemState` (`maintenance.<tâche>`). Les autres `?task=`
  restent appelables à la main. Changer `CRON_SECRET` = Vercel + ce job.
- Historique (onglet du front, droit `history`) : `GET /api/ha/statistics` lit les statistiques long
  terme du recorder HA (moyenne, min, max, cumul par heure, jour, semaine, mois), qui ne passent que
  par l'API **WebSocket** de HA (`lib/ha-websocket.ts` : une connexion par appel, même délai de 10 s,
  même jeton) ; la REST `history` s'arrête à la purge HA (10 jours). `GET /api/history/usage` relit
  la table `DailyUsage` (heures d'allumage, cycles, détections, repas, alertes par jour), calculée
  par `lib/integrations/daily-usage/` à partir de l'historique HA : le `check-alerts` calcule la veille (rattrapage jusqu'à 9 jours, 3 par passage, un appel HA et un
  enregistrement par jour, marqueur `dailyUsage.lastDay` dans `SystemState`) ; `?task=daily-usage`
  rattrape tout d'un coup et renvoie l'étape en échec dans `details` (`&redo=1` recalcule les 9
  derniers jours, après un nouveau compteur). Le spa (`climate`, sans statistiques long terme) lit
  ses attributs : heures de chauffe = `hvac_action` `heating`, température moyenne de l'eau pondérée
  par le temps. Les détections caméra (`motion:*`) exigent le droit
  caméras.
- Notifications (cloche du front et Web Push, `lib/integrations/notifications/`) : le moteur
  d'alertes enregistre chaque alerte pour **chaque admin** (table `Notification`, gardée 30 jours)
  et la pousse sur ses appareils abonnés (`WebPushSubscription`) ; c'est le seul canal (Telegram et
  les photos jointes aux alertes ont été retirés en novembre 2026). Routes admin : `GET /api/notifications`,
  `POST /api/notifications/read`, `POST /api/push/subscription`, `POST /api/push/unsubscribe`
  (POST : la CORS n'autorise que GET et POST), `GET /api/push/public-key`. Le push exige
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` (`mailto:…`) ; sans elles, les
  notifications sont seulement stockées. Un appareil que le service push ne connaît plus (404/410)
  est oublié.
- Les en-têtes de sécurité (dont la CSP `default-src 'none'`) sont définis **uniquement** dans
  `next.config.ts`.
- Le build ne lance pas les migrations : elles s'appliquent à part sur la base de prod
  (`npx prisma migrate deploy`) avec `DIRECT_URL`, le pooler Supabase en mode **session** (port
  5432) ; l'application utilise `DATABASE_URL`, le mode transaction (port 6543). Par le port 6543,
  `migrate` reste bloqué indéfiniment sur son verrou (advisory lock).
- Vercel Hobby : `cron` déclare `maxDuration = 60` ; les autres routes gardent
  le défaut Vercel (300 s avec Fluid compute, 10 s sans).
- Les tests tournent en `TZ=UTC` comme Vercel. Les snapshots de caractérisation (Petkit, alertes) ne
  se mettent à jour (`-u`) que pour un changement de comportement voulu et expliqué.
- Secrets dans `.env.local` (HA, Clerk, Upstash, Enedis, R2, `CRON_SECRET`,
  `CF_ORIGIN_SECRET`) : ne les lis pas et ne les recopie jamais dans du code, un log ou une config.

## Projet multi-dépôts

- Ce dépôt est le back. Le front est `../home` (Vite + React 19, Playwright), avec son propre
  `CLAUDE.md`.
- Production : back `https://home-back.psaltery.org`, front `https://home.psaltery.org`. Une nouvelle
  origine front doit être ajoutée dans `lib/cors.ts`.
- Contrat : `Authorization: Bearer <JWT Clerk>` ; erreurs `{ error, details, code }` via
  `ApiResponse` ; le front réagit aux codes `USER_NOT_FOUND` et `IP_RESTRICTED`.
- **Toute nouvelle route ici implique son client dans `../home/src/services/<domaine>.ts` et son mock
  dans `../home/e2e/fixtures/api-mocks.ts`** ; inversement, tout appel ajouté au front doit exister
  ici. Un changement de format de réponse se fait dans les deux dépôts.

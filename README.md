# Home Back — API du tableau de bord domotique

Back Next.js (API uniquement) du projet Home Sweet Home. Il sert de proxy sécurisé entre le front
[`home`](../home) et Home Assistant, gère l'authentification Clerk, les droits par groupe
d'utilisateurs, et les intégrations tierces (Enedis, GRDF, Suez, Petkit, Telegram).

- Production : https://home-back.psaltery.org (Vercel)
- Base : PostgreSQL (Supabase) via Prisma 7 ; rate limit Upstash Redis ; stockage Cloudflare R2.
- Derrière le proxy Cloudflare, qui injecte l'en-tête `x-origin-secret` (voir `CF_ORIGIN_SECRET`).

## Démarrage

Prérequis : Node.js 22.12+ (24 recommandé, comme la CI), une instance Home Assistant accessible en
HTTPS, un compte Clerk.

```bash
npm install
npx prisma generate  # client Prisma généré dans lib/generated/prisma
npm run dev          # http://localhost:3000 (écoute aussi sur le LAN)
```

`.env.local` doit contenir au minimum :

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
HA_BASE_URL=https://votre-instance-ha
HA_ACCESS_TOKEN=token_longue_duree
DATABASE_URL=postgresql://...      # URL poolée (application)
DIRECT_URL=postgresql://...        # URL non poolée (CLI Prisma : migrations) ; facultative en local
```

Les autres variables activent les fonctions correspondantes :

- `ADMIN_EMAILS` : emails promus admin à leur première connexion (aucun par défaut) ;
- `CF_ORIGIN_SECRET` : secret injecté par Cloudflare ; sans lui en production, la restriction
  « réseau maison » refuse les groupes sans droit `remote` ;
- `HOME_DDNS_HOSTNAME` : nom DDNS de la maison (QuickConnect, DuckDNS…), dont l'IP publique compte
  comme « réseau maison » ; sans lui, seules les adresses du réseau local comptent ;
- `SUEZ_COUNTER_ID` : numéro du compteur Suez, qui nomme ses capteurs HA
  (`sensor.<numéro>_consommation_d_eau_hier`) ; sans lui, pas de données d'eau ;
- `PETKIT_DEVICE_ID` : identifiant du distributeur Petkit, qui nomme le dossier de ses photos dans
  les médias HA ; sans lui, pas de photos des repas ;
- `CRON_SECRET`, Upstash, Enedis, R2, Telegram, webhooks d'alerte de sécurité.

## API

Les routes sont dans `app/api/`. Sauf `health`, `cron` et `telegram/webhook`, elles
exigent un en-tête `Authorization: Bearer <JWT Clerk>` obtenu par le front (jamais en query string).

## Vérifications

```bash
npm run typecheck && npm run lint && npm run test:coverage
```

La CI GitHub lance la même chaîne (seuils de couverture bloquants) et un audit `npm audit --omit=dev` (dépendances de production, vulnérabilités hautes ou critiques) sur les PR et chaque semaine.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) et [`.claude/`](.claude) — commandes, architecture, pièges, règles et
  procédures (lisibles aussi par les humains).
- [`TESTING_GUIDE.md`](TESTING_GUIDE.md) — tests.

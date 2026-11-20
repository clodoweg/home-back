---
paths:
  - "prisma/**"
---

# Prisma et base de données

- PostgreSQL (Supabase) avec Prisma 7.10 (versions de `prisma`, `@prisma/client` et `@prisma/adapter-pg`
  épinglées ensemble). Le client est généré dans `lib/generated/prisma` (ignoré par git) : les types
  s'importent depuis `@/lib/generated/prisma/client`, jamais depuis `@prisma/client`. À l'exécution,
  `lib/prisma.ts` passe par l'adaptateur `@prisma/adapter-pg` avec `DATABASE_URL` (pooler Supabase en mode transaction, port 6543).
- Toute modification de `schema.prisma` passe par `npx prisma migrate dev --name <nom_explicite>`, puis
  `npx prisma generate` (Prisma 7 ne régénère plus le client ni ne lance le seed après une migration) :
  jamais de migration sans nom (comme `20260418132754_`), jamais de modification d'une migration
  déjà appliquée.
- Le CLI lit sa configuration dans `prisma.config.ts` : il charge `.env.local` puis `.env` (sans écraser
  les variables déjà définies) et utilise `DIRECT_URL` (pooler Supabase en mode session, port 5432,
  nécessaire aux verrous de `migrate` : par le port 6543, `migrate` reste bloqué) ou, à défaut,
  `DATABASE_URL`.
- `npx prisma db push` sert au prototypage local uniquement, jamais pour la prod.
- Le build ne lance que `prisma generate` : signale dans ton compte rendu toute migration à appliquer
  sur la base de prod.
- `mockPrisma` (`mockDeep<PrismaClient>`, typé depuis le client généré) couvre les modèles générés ; seuls les mocks écrits à la main
  dans `__tests__/setup.ts` sont à mettre à jour quand un modèle change.
- Les colonnes « jour » sont en `@db.Date` (minuit UTC) ; les horodatages en `DateTime`. Voir la règle
  sur les dates dans `.claude/rules/integrations.md`.

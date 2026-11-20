---
name: new-api-route
description: Crée une nouvelle route API Next.js dans home-back (route avec withAuth, schéma Zod, droits, logique dans lib/, test Vitest) et liste le travail correspondant côté front. À utiliser pour tout nouvel endpoint ou nouvelle méthode HTTP.
argument-hint: "<METHODE> </api/chemin> [description]"
---

# Ajouter une route API

Route demandée : $ARGUMENTS. Les conventions détaillées sont dans `.claude/rules/api-routes.md`,
`integrations.md` et `testing.md` ; cette procédure ne fait que les enchaîner.

## 1. Logique métier

- Place la logique dans `lib/integrations/<nom>/` (nouveau dossier ou existant), exportée par son
  `index.ts`. Si la route ne fait que relayer Home Assistant, appelle `haGet` / `haPost`.
- Ajoute un test unitaire dans `__tests__/unit/` pour toute transformation non triviale.

## 2. Route

1. Si la route reçoit un corps : ajoute le schéma Zod dans `lib/validators.ts` (avec son type inféré).
2. Crée `app/api/<chemin>/route.ts` :

```ts
/** <Nom> — <responsabilité de la route> */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { validateBody, monSchema } from '@/lib/validators';

/**
 * POST /api/<chemin> — <ce que fait la route>.
 * @returns 200 avec <forme de la réponse>, 400 si le corps est invalide, 403 sans droit.
 */
export const POST = withAuth(async (request, { user }) => {
  const validation = await validateBody(request, monSchema);
  if (!validation.success) return validation.error;
  // route dynamique : withAuth<{ id: string }>(…), puis const { id } = await params;
  // un paramètre qui atteint HA est validé (lib/validators.ts) puis encodé
  // droits via lib/permissions.ts ; refus → logger.security(...) puis ApiResponse.forbidden()
  // appel à lib/integrations/<nom>
  return ApiResponse.success(result);
});
```

## 3. Test

Crée `__tests__/api/<route>.test.ts` en partant d'un test voisin (ex. `ha-call.test.ts`) :
`beforeEach` avec `vi.clearAllMocks()`, `clearMockUsers()` (de `../setup`), `resetHAMocks()`, puis
`mockAsAdmin()` + `setMockUser(ADMIN_USER.clerkId, ADMIN_USER)`. Couvre : succès, 401
(`mockAsUnauthenticated`), 400 (corps invalide), 403 pour chaque groupe privé du droit, et l'erreur
amont (`mockHAError` ou `fetch` stubé).

## 4. Vérification

```bash
npx vitest run __tests__/api/<route>.test.ts
npx tsc --noEmit
npm run test
```

## 5. Côté front (`../home`) — à faire ou à signaler

- Client dans `src/services/<domaine>.ts` (avec `traceApi` + `authHeaders`), ré-exporté par
  `src/services/api.ts`, et hook TanStack Query dans `src/hooks/`.
- Mock de la route dans `e2e/fixtures/api-mocks.ts`, avec la même enveloppe de réponse.
- Si tu ne modifies pas le front dans cette tâche, liste ces points dans ton compte rendu.

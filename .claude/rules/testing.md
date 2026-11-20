---
paths:
  - "__tests__/**"
  - "vitest.config.mts"
---

# Tests Vitest

- `__tests__/setup.ts` mocke globalement Prisma (`mockPrisma`, via `vitest-mock-extended`), Clerk,
  `next/headers` (réinitialisé avant chaque test), le rate limit, le logger, `haFetch` / `haGet` /
  `haPost` (`haFetchBinary` reste réel, sur le `fetch` stubé), les alertes de sécurité et le DNS. Un
  `fetch` non stubé fait échouer le test. N'importe pas de vrai client : réutilise ces mocks.
- Helpers : `mockAsAdmin` / `mockAsUser` / `mockAsChildren` / `mockAsUnauthenticated` /
  `mockBearerToken` (`helpers/mock-auth.ts`), utilisateurs `ADMIN_USER` / `STANDARD_USER` /
  `CHILDREN_USER` / `LOCAL_ONLY_USER` (`helpers/test-users.ts`) à enregistrer avec `setMockUser`
  (`clearMockUsers` dans `beforeEach` ; ces deux-là sont exportés par `__tests__/setup.ts`), Home Assistant via `mockHAStates` / `mockHACallService` /
  `mockHAError` / `resetHAMocks` (`helpers/mock-ha.ts`).
- Zéro réseau réel : tout `fetch` vers un tiers est stubé avec `vi.spyOn(global, 'fetch')`.
- Toute route a son fichier `__tests__/api/<route>.test.ts`, qui couvre au minimum le cas nominal,
  le non-authentifié et chaque groupe dont les droits changent la réponse (admin, user, children),
  et une ligne dans `__tests__/api/permission-matrix.test.ts`.
- Un test qui modifie l'environnement (`vi.stubEnv`), les timers ou un mock global le restaure dans
  `afterEach` : la suite doit passer avec `--sequence.shuffle`.
- Logique pure : `__tests__/unit/`, sans mock Prisma. Construis les dates avec `Date.UTC` pour que
  le test ne dépende pas du fuseau de la machine.
- Les routes s'appellent directement : `await GET(new Request(url), { params: Promise.resolve({}) })`.

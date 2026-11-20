# Nommage et commentaires

- Noms explicites : `isUserSubscriptionActive` plutôt que `isActive`.
- Ne commente jamais le QUOI (`// boucle sur les items`) : le code doit se lire seul.
- Commente le POURQUOI : logique métier complexe, décision technique non évidente, contournement
  d'un bug d'une API tierce.
- JSDoc obligatoire sur toute fonction exportée que tu crées ou modifies : description courte,
  paramètres, type de retour.
- `TODO: [action]` pour une tâche en attente ; `WARNING:` pour une section sensible (sécurité,
  performance critique).
- Tout nouveau fichier de code commence par un en-tête `/** Nom — responsabilité du module */`.
- Si tu modifies une logique commentée, mets le commentaire à jour dans le même changement.

# DulonBet — Plan de tests hors production

Ce plan s'applique à la fonction préparatoire `dulonbet-notify-admin`. Aucun test ne doit utiliser un vrai dépôt, un vrai retrait ou déclencher les fonctions financières existantes.

## Préconditions avant test
- [ ] Domaine Resend entièrement vérifié et expéditeur autorisé.
- [ ] Clé Resend divulguée précédemment révoquée; nouvelle clé créée et stockée uniquement dans les secrets Supabase.
- [ ] Secrets dédiés aux notifications configurés dans un environnement de test, jamais dans GitHub ni dans le navigateur.
- [ ] Adresse destinataire de test confirmée.
- [ ] La fonction est déployée uniquement dans un environnement de test explicitement choisi.
- [ ] Aucun déclencheur financier existant n'appelle encore la fonction.

## Tests négatifs (ne doivent envoyer aucun e-mail)
1. Méthode GET au lieu de POST → 405.
2. Secret interne absent ou incorrect → 401.
3. Configuration incomplète → 503.
4. JSON invalide → 400.
5. Type d'événement non autorisé → 400.
6. Identifiant d'événement invalide → 400.
7. Montant négatif, non entier ou supérieur à 2 000 000 FCFA → 400.
8. Référence mal formée → 400.

## Tests positifs avec événements fictifs
- [ ] `deposit_requested` produit un message qui indique explicitement que le paiement n'est pas confirmé.
- [ ] `deposit_confirmed_feexpay` précise que le crédit 1XBET doit être vérifié séparément.
- [ ] `deposit_credited_1xbet` est utilisé uniquement après une réponse positive réelle de l'API, jamais lors d'un simple statut « en attente ».
- [ ] `withdrawal_validated_1xbet` précise que le paiement Mobile Money n'est pas confirmé.
- [ ] `withdrawal_paid_confirmed` n'est jamais déclenché automatiquement sans preuve de paiement autorisée.
- [ ] Même `event_id` répété dans la fenêtre d'idempotence du fournisseur ne produit pas de nouvel envoi.

## Limites à résoudre avant activation
- La clé d'idempotence Resend seule ne constitue pas un registre métier permanent. Ajouter un registre persistant des événements et des états d'envoi, avec contrainte unique sur l'identifiant d'événement, avant branchement aux événements de production.
- Les notifications ne doivent jamais modifier `dulonbet_transactions`, créditer un compte ou valider un retrait.
- Les erreurs d'envoi doivent pouvoir être réessayées sans rejouer l'opération financière.
- Les journaux ne doivent contenir ni clé API, ni secret interne, ni code de retrait.
- Les tests WhatsApp restent distincts et désactivés jusqu'à validation d'une méthode officielle compatible avec les groupes.

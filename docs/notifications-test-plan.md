# DulonBet — Plan de tests hors production

Ce plan s'applique à la fonction préparatoire `dulonbet-notify-admin`. Aucun test ne doit utiliser un vrai dépôt, un vrai retrait ou déclencher les fonctions financières existantes.

## Préconditions avant test
- [ ] Domaine Resend entièrement vérifié et expéditeur autorisé.
- [ ] Clé Resend divulguée précédemment révoquée; nouvelle clé créée et stockée uniquement dans les secrets Supabase.
- [ ] Secrets dédiés aux notifications configurés dans un environnement de test, jamais dans GitHub ni dans le navigateur.
- [ ] Adresse destinataire de test confirmée.
- [ ] La fonction est déployée uniquement dans un environnement de test explicitement choisi.
- [ ] Aucun déclencheur financier existant n'appelle encore la fonction.
- [ ] Registre persistant d'idempotence implémenté et revu avant de tester l'idempotence métier.

## Tests négatifs (ne doivent envoyer aucun e-mail)
1. Méthode GET au lieu de POST → 405.
2. Secret interne absent ou incorrect → 401.
3. Configuration incomplète → 503.
4. JSON invalide → 400.
5. Type d'événement non autorisé → 400.
6. Identifiant d'événement invalide → 400.
7. Montant négatif, non entier ou supérieur à 2 000 000 FCFA → 400.
8. Référence mal formée → 400.
9. Appel sans secret de base de données/registre configuré → échec fermé, aucun e-mail.
10. Fournisseur e-mail en erreur ou indisponible → erreur contrôlée, aucune validation financière.

## Tests positifs avec événements fictifs uniquement
- [ ] `deposit_requested` produit un message qui indique explicitement que le paiement n'est pas confirmé.
- [ ] `deposit_confirmed_feexpay` précise que le crédit 1XBET doit être vérifié séparément.
- [ ] `deposit_credited_1xbet` est utilisé uniquement après une réponse positive réelle de l'API, jamais lors d'un simple statut « en attente ».
- [ ] `withdrawal_validated_1xbet` précise que le paiement Mobile Money n'est pas confirmé.
- [ ] `withdrawal_paid_confirmed` n'est jamais déclenché sans preuve de paiement autorisée.
- [ ] Deux appels simultanés avec le même `event_id` ne créent qu'un seul envoi.
- [ ] Le même `event_id` après état `sent` ne crée aucun nouvel envoi.
- [ ] Un événement `failed` peut être repris selon une transition atomique et une limite de tentatives.
- [ ] Une interruption pendant l'envoi ne laisse pas un événement bloqué indéfiniment sans procédure de reprise.
- [ ] Les journaux ne contiennent aucune clé, aucun secret, code de retrait, numéro de téléphone ou payload complet.

## Limites à résoudre avant activation
- La fonction actuelle est un brouillon et utilise seulement la clé d'idempotence Resend; **elle n'est pas encore protégée par un registre métier persistant**. Ne pas la relier aux événements de production avant ce travail.
- La conception proposée est décrite dans [notifications-idempotency-ledger.md](notifications-idempotency-ledger.md); elle n'a pas été appliquée à Supabase.
- Les notifications ne doivent jamais modifier `dulonbet_transactions`, créditer un compte ou valider un retrait.
- Les erreurs d'envoi doivent pouvoir être réessayées sans rejouer l'opération financière.
- Les tests WhatsApp restent distincts et désactivés jusqu'à validation d'une méthode officielle compatible avec les groupes.
- Le code n'a pas encore été compilé ni exécuté; aucune réussite de test n'est revendiquée.

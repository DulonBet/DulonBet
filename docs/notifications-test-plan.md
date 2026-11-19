# DulonBet — Plan de tests hors production

Ce plan concerne le code de préparation `dulonbet-notify-admin`. Aucun test ne doit utiliser un vrai dépôt, un vrai retrait ni déclencher les fonctions financières. Le code et le SQL restent non déployés.

## Préconditions avant tout test
- [ ] Révoquer la clé Resend qui a été partagée dans une conversation; créer une nouvelle clé et la conserver uniquement dans les secrets de l’environnement de test.
- [ ] Domaine et expéditeur Resend entièrement vérifiés; destinataire de test confirmé.
- [ ] Les secrets e-mail et `SUPABASE_SERVICE_ROLE_KEY` sont définis uniquement côté serveur, jamais dans GitHub ni dans le navigateur.
- [ ] SQL du registre revu, généré selon la procédure CLI Supabase du dépôt, appliqué uniquement à une base de développement dédiée.
- [ ] Les deux RPC `claim_dulonbet_notification_event` et `finish_dulonbet_notification_event` sont testées sur cette base.
- [ ] La fonction est déployée uniquement dans un environnement de test explicitement choisi.
- [ ] Aucun déclencheur financier existant n'appelle la fonction.

## Tests négatifs — aucun e-mail ne doit partir
1. GET au lieu de POST → 405.
2. Secret interne absent/incorrect → 401.
3. Configuration e-mail ou registre incomplète → 503.
4. JSON invalide ou corps non objet → 400.
5. Type d'événement ou identifiant non autorisé → 400.
6. Montant non entier, inférieur à 100 FCFA ou supérieur à 2 000 000 FCFA → 400.
7. Référence mal formée → 400.
8. Registre/RPC inaccessible → 503, sans appeler Resend.
9. Même identifiant avec un autre type d'événement → 409.
10. Tentatives épuisées → 429, sans appeler Resend.
11. Fournisseur e-mail en erreur/indisponible → erreur contrôlée et statut de registre marqué failed si possible.

## Tests d'idempotence — événements fictifs seulement
- [ ] Premier événement valide : une seule réservation est créée, puis l'e-mail est envoyé.
- [ ] Deux appels simultanés avec le même `event_id` : un seul obtient `claimed`; l'autre reçoit `busy`.
- [ ] Même événement après `sent` : réponse doublon, aucun nouvel appel Resend.
- [ ] Même identifiant avec un autre type : conflit, aucun e-mail.
- [ ] Événement échoué : reprise atomique, nombre de tentatives incrémenté et plafonné à 5.
- [ ] Événement bloqué en `processing` : reprise possible seulement après expiration du verrou de 2 minutes.
- [ ] Réponse Resend acceptée mais échec de mise à jour du registre : réponse d'erreur contrôlée et même clé Resend utilisée lors de la reprise.
- [ ] Réponse de finalisation du registre vérifiée; `false` ne doit pas être traité comme un succès.
- [ ] Les logs ne contiennent ni clés, ni secrets, ni code de retrait, ni téléphone, ni corps complet de requête.

## Vérification du contenu
- [ ] `deposit_requested` dit explicitement que le paiement n'est pas confirmé.
- [ ] `deposit_confirmed_feexpay` précise que le crédit 1XBET doit être vérifié séparément.
- [ ] `deposit_credited_1xbet` ne peut être envoyé qu'après confirmation réelle de l'API.
- [ ] `withdrawal_validated_1xbet` précise que le paiement Mobile Money n'est pas confirmé.
- [ ] `withdrawal_paid_confirmed` est réservé à une preuve de paiement autorisée.
- [ ] Les notifications ne modifient jamais les tables financières.

## Limites restantes
- La clé d'idempotence Resend réduit les doublons externes mais ne garantit pas à elle seule un envoi exactement une fois.
- Le SQL de [notifications-ledger-sql-draft.md](notifications-ledger-sql-draft.md) est une proposition non exécutée, pas une migration.
- Le code n'a pas encore été compilé ni exécuté dans Deno/Supabase; aucune réussite de test n'est revendiquée.
- WhatsApp reste désactivé tant qu'un fournisseur officiel compatible avec l'envoi aux groupes n'est pas validé.


## Cas supplémentaires à exécuter après compilation
- [ ] Corps de requête supérieur à 16 Kio, avec ou sans en-tête `Content-Length` fiable → 413; Resend ne doit pas être appelé.
- [ ] Montant envoyé comme chaîne JSON (`"200"`) → 400; seul un nombre JSON entier est accepté.
- [ ] Référence de type nombre, objet ou tableau → 400.
- [ ] Vérifier que les réponses d'erreur ne contiennent jamais les secrets, le corps complet ou des données personnelles.
- [ ] Vérifier les codes HTTP et les champs de réponse pour chaque scénario, puis archiver les résultats de test.

**État d'exécution :** ces tests sont préparés mais non exécutés. Deno n'est pas installé dans l'environnement de vérification disponible; la compilation de la fonction Edge n'est donc pas confirmée.
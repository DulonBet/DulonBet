# DulonBet — Plan de tests de la fonction de notification

## État réel au 19 novembre 2026
- Migration du registre appliquée au projet Supabase de production `abagofwqjostilsilafk`.
- Les deux RPC ont été testées avec un événement fictif, puis la ligne de test a été supprimée.
- `dulonbet-notify-admin` est déployée en production, version 1, avec authentification par en-tête secret dans le code et `verify_jwt=false`.
- **Aucun appel HTTP à la fonction ni aucun e-mail réel n'a encore été testé.**
- Les secrets du projet ne sont pas lisibles via les outils disponibles ici; leurs noms doivent être vérifiés dans Supabase Dashboard sans communiquer les valeurs.
- La fonction n'est pas encore reliée aux événements métier des fonctions dépôt/retrait. Aucun code financier existant n'a été modifié.

## Secrets requis côté serveur
- `RESEND_API_KEY` — créer/faire tourner la clé si une ancienne a été partagée dans une conversation.
- `DULONBET_NOTIFICATION_INTERNAL_SECRET` — secret aléatoire propre à la fonction.
- `DULONBET_ADMIN_EMAIL` — adresse de réception de l'administrateur.
- `RESEND_FROM_EMAIL` — expéditeur autorisé, par exemple `DulonBet <notifications@dulonbet.com>`.
- `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` — secrets d'environnement requis par le code; ne jamais les exposer au navigateur ni dans GitHub.

## Tests négatifs — aucun e-mail ne doit partir
1. GET au lieu de POST → 405.
2. Secret interne absent/incorrect → 401, une fois la configuration complète.
3. Configuration requise incomplète → 503.
4. JSON invalide ou corps non objet → 400.
5. Type d'événement ou identifiant non autorisé → 400.
6. Montant non entier, inférieur à 100 FCFA ou supérieur à 2 000 000 FCFA → 400.
7. Référence mal formée → 400.
8. Registre/RPC inaccessible → 503, sans appeler Resend.
9. Même identifiant avec un autre type d'événement → 409.
10. Tentatives épuisées → 429, sans appeler Resend.
11. Erreur réseau/HTTP du fournisseur → erreur contrôlée; seules les erreurs réseau, HTTP 429 et HTTP 5xx sont réessayables.

## Tests d'idempotence
- [x] Premier événement : réservation créée.
- [x] Doublon pendant le traitement : `busy`.
- [x] Même événement après succès : `sent`, aucun second envoi.
- [x] Même identifiant avec un autre type : `conflict`.
- [ ] Deux appels HTTP simultanés à la fonction.
- [ ] Vérifier les reprises après erreur réseau/429/5xx et le plafond de cinq tentatives.
- [ ] Vérifier que les erreurs fournisseur permanentes ne sont pas relancées.
- [ ] Vérifier le cas où Resend accepte le message mais la mise à jour du registre échoue.
- [ ] Vérifier que les logs ne contiennent ni clés, ni secrets, ni code de retrait, ni téléphone, ni corps complet de requête.

## Contenu métier
- `deposit_requested` doit dire explicitement que le paiement n'est pas confirmé.
- `deposit_confirmed_feexpay` doit préciser que le crédit 1XBET doit être vérifié séparément.
- `deposit_credited_1xbet` ne peut être envoyé qu'après confirmation réelle de l'API.
- `withdrawal_validated_1xbet` ne signifie pas que le paiement Mobile Money est confirmé.
- `withdrawal_paid_confirmed` est réservé à une preuve de paiement autorisée.
- Les notifications ne doivent jamais modifier les tables financières.

## Limites restantes
- Aucun test d'exécution Deno/HTTP n'a été réalisé par les outils disponibles ici.
- Aucun e-mail réel n'a été envoyé ni reçu.
- L'appel de la fonction depuis les événements métier n'est pas encore intégré.
- La clé d'idempotence Resend réduit les doublons externes sans garantir un envoi exactement une fois.
- WhatsApp reste désactivé tant qu'un fournisseur officiel compatible n'est pas validé.

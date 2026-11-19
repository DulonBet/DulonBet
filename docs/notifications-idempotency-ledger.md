# DulonBet — registre d'idempotence des notifications

**État actuel : préparation uniquement.** Le code de la branche `preview/notifications-prep-2026-11-19` appelle maintenant deux RPC atomiques, mais le SQL associé n'a pas été appliqué ni testé. La fonction échoue volontairement sans le registre : aucun e-mail ne doit être envoyé tant que la base de développement n'est pas préparée.

## Données du registre
- `event_id` : clé primaire, stable pour une notification métier.
- `event_type` : liste autorisée identique à celle du code.
- `status` : `processing`, `sent`, `failed`.
- `attempts` : compteur limité à 5.
- `provider_message_id`, `last_error_code`, `created_at`, `updated_at`, `sent_at`.

## Transitions attendues
1. `claim_dulonbet_notification_event` réserve atomiquement l'événement. Elle retourne `claimed`, `sent`, `busy`, `conflict` ou `exhausted`.
2. Le fournisseur Resend n'est appelé que pour une réservation `claimed`.
3. `finish_dulonbet_notification_event` marque `sent` ou `failed` et confirme que la ligne a bien été mise à jour.
4. Un événement `sent` ne doit jamais déclencher un second envoi.
5. Un événement `processing` ne peut être repris qu'après expiration du verrou de 2 minutes; les tentatives sont limitées à 5.
6. La clé d'idempotence Resend reste stable, dérivée de `event_id`, pour réduire le risque de doublon après un délai réseau.
7. La table privée n'accorde aucun accès direct à `anon` ou `authenticated`; les RPC sont limitées à `service_role` et ne doivent pas utiliser `SECURITY DEFINER`.
8. Le registre ne prouve jamais un paiement et ne modifie aucune table financière.

## Fichiers de référence
- [Brouillon SQL des RPC et de la table](notifications-ledger-sql-draft.md) — conception non exécutée, pas une migration Supabase.
- [Plan de tests hors production](notifications-test-plan.md) — tests à réaliser avant toute activation.
- [Fonction préparatoire](../supabase/functions/dulonbet-notify-admin/index.ts) — non déployée.

## Étapes requises avant activation
- Vérifier les conventions et l'état du schéma privé, sans modifier les privilèges globaux existants sans audit.
- Générer une migration avec la procédure CLI Supabase du dépôt et la tester sur une base de développement dédiée.
- Tester la concurrence, les doublons, les erreurs réseau, la reprise et les 5 tentatives maximales.
- Compiler et exécuter la fonction dans l'environnement de test.
- Ne relier aucun déclencheur financier et ne déployer en production qu'après revue et accord explicite.

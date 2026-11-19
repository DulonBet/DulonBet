# DulonBet — registre d'idempotence des notifications (proposition uniquement)

**Statut : conception non appliquée.** Ce document ne crée aucune table et ne change pas Supabase. La fonction d'envoi ne doit pas être reliée aux flux financiers avant implémentation et tests de ce registre.

## Pourquoi
La clé d'idempotence du fournisseur e-mail n'est pas un registre métier permanent. Pour éviter qu'un nouvel appel ou une relance après délai renvoie un même événement, DulonBet doit enregistrer chaque identifiant d'événement dans sa propre base.

## Schéma proposé
Créer une table privée, non accessible depuis le navigateur, avec au minimum :
- `event_id` : texte, clé primaire ou contrainte UNIQUE ;
- `event_type` : texte validé par liste autorisée ;
- `status` : `processing`, `sent`, `failed` ;
- `attempts` : entier non négatif ;
- `provider_message_id` : texte nullable ;
- `last_error_code` : code technique expurgé, sans secret ni contenu sensible ;
- `created_at`, `updated_at`, `sent_at` : horodatages UTC.

## Règles obligatoires
1. L'enregistrement de l'événement doit être atomique grâce à la contrainte UNIQUE sur `event_id`.
2. Un événement marqué `sent` ne doit jamais être envoyé de nouveau.
3. Un événement `processing` récent ne doit pas être pris par un second appel concurrent.
4. Un événement `failed` ou bloqué après un délai doit être repris uniquement par une transition atomique avec verrouillage/condition, et le nombre de tentatives doit être limité.
5. Si le fournisseur accepte la clé d'idempotence, continuer à utiliser une clé stable dérivée de `event_id`.
6. Les erreurs persistées doivent être minimales : aucun secret, code de retrait, numéro de téléphone ou payload complet.
7. La table doit avoir RLS activée et aucun droit `anon`/ `authenticated`. Seul le backend autorisé peut y accéder.
8. Le registre d'envoi ne doit jamais être utilisé comme preuve de paiement ni modifier les tables financières.

## Avant de produire une migration
- Confirmer le schéma privé disponible et les conventions de migration du dépôt.
- Écrire une migration dans la branche de préparation seulement.
- Revoir les privilèges/RLS et faire une vérification de sécurité.
- Tester les appels simultanés, la relance après erreur, la reprise après interruption et le même événement après succès.
- Ne pas appliquer la migration au projet Supabase de production sans accord explicite.

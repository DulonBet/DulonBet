# DulonBet — brouillon SQL du registre d’idempotence des notifications

**DOCUMENT DE CONCEPTION UNIQUEMENT — NE PAS EXÉCUTER.**  
Ce fichier n’est pas une migration Supabase. Il n’a pas été exécuté ni testé sur la base de données. Il ne doit pas être copié dans le SQL Editor de production.

## Objectif

Empêcher l’envoi en double d’une notification administrative, y compris lors de deux requêtes simultanées ou d’une relance après délai. Ce registre ne prouve jamais un paiement et ne doit jamais modifier les transactions financières.

## Schéma SQL proposé

Le nom du schéma privé doit être vérifié dans le projet avant de retenir ce brouillon. Si le projet possède déjà une convention de schéma privé, la suivre plutôt que créer un nouveau schéma.

```sql
-- BROUILLON NON EXÉCUTÉ : revoir le schéma privé et les privilèges avant usage.
create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.dulonbet_notification_ledger (
  event_id text primary key,
  event_type text not null check (
    event_type in (
      'deposit_requested',
      'deposit_confirmed_feexpay',
      'deposit_credited_1xbet',
      'withdrawal_requested',
      'withdrawal_validated_1xbet',
      'withdrawal_paid_confirmed',
      'payment_attention_required'
    )
  ),
  status text not null check (status in ('processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table private.dulonbet_notification_ledger enable row level security;
revoke all on private.dulonbet_notification_ledger from public, anon, authenticated;
grant select, insert, update on private.dulonbet_notification_ledger to service_role;
```

## Points à résoudre avant d’en faire une vraie migration

1. Vérifier si le schéma `private` existe déjà et quelles sont les conventions de migrations du dépôt.
2. Définir une opération atomique de réservation d’événement : une simple séquence « SELECT puis INSERT » n’est pas suffisante contre les appels concurrents.
3. Définir la reprise d’un événement bloqué en `processing`, avec expiration, nombre maximal de tentatives et transition atomique.
4. Vérifier si `service_role` est le rôle de backend prévu pour cette fonction et limiter les droits au strict nécessaire.
5. Ajouter des tests pour doublon simultané, événement déjà envoyé, erreur fournisseur, reprise après interruption et absence de secret dans les logs.
6. Exécuter les contrôles de sécurité et les tests sur un environnement non-production avant toute application.

## État

- Aucun SQL exécuté.
- Aucune table créée.
- Aucun secret modifié.
- Aucune fonction déployée.
- Aucune modification de production.

# DulonBet — registre d’idempotence des notifications

**État : appliqué en production Supabase le 19 novembre 2026. Ne pas réexécuter ce document comme migration.** Les migrations enregistrées sont :
- `20261119082918_create_notification_idempotency_ledger`
- `20261119082950_restrict_notification_ledger_policy`

Le registre est privé et séparé des tables financières. Il ne crédite aucun compte et ne valide aucun retrait.

## Schéma appliqué

- Table : `private.dulonbet_notification_ledger`
- Clé primaire : `event_id`
- Types autorisés : dépôt demandé, paiement FeexPay confirmé, crédit 1XBET confirmé, retrait demandé, validation 1XBET, retrait payé confirmé, attention requise.
- Statuts : `processing`, `sent`, `failed`
- Limite : 5 tentatives; reprise d'un traitement bloqué après 2 minutes.
- RLS activée; aucune permission directe à `anon` ou `authenticated`.
- Les deux RPC publiques sont en droits de l'appelant (pas `SECURITY DEFINER`) et exécutables uniquement par `service_role`.
- Politique explicite de table réservée à `service_role`.

## SQL de référence

Le contenu ci-dessous documente la structure appliquée. Il est fourni pour audit, pas pour être relancé dans SQL Editor.

```sql
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.dulonbet_notification_ledger (
  event_id text primary key,
  event_type text not null check (event_type in (
    'deposit_requested', 'deposit_confirmed_feexpay', 'deposit_credited_1xbet',
    'withdrawal_requested', 'withdrawal_validated_1xbet',
    'withdrawal_paid_confirmed', 'payment_attention_required'
  )),
  status text not null check (status in ('processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table private.dulonbet_notification_ledger enable row level security;
revoke all on private.dulonbet_notification_ledger from public, anon, authenticated;
grant select, insert, update on private.dulonbet_notification_ledger to service_role;

create or replace function public.claim_dulonbet_notification_event(
  p_event_id text, p_event_type text
) returns text
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_type text;
  v_status text;
  v_attempts integer;
  v_error_code text;
begin
  if p_event_id is null or length(p_event_id) < 8 or length(p_event_id) > 128
     or p_event_id !~ '^[A-Za-z0-9._:-]+$'
     or p_event_type is null
     or p_event_type not in (
       'deposit_requested', 'deposit_confirmed_feexpay', 'deposit_credited_1xbet',
       'withdrawal_requested', 'withdrawal_validated_1xbet',
       'withdrawal_paid_confirmed', 'payment_attention_required'
     ) then
    return 'conflict';
  end if;

  insert into private.dulonbet_notification_ledger
    (event_id, event_type, status, attempts, updated_at)
  values (p_event_id, p_event_type, 'processing', 1, now())
  on conflict (event_id) do update
    set status = 'processing',
        attempts = private.dulonbet_notification_ledger.attempts + 1,
        updated_at = now(),
        last_error_code = null
    where private.dulonbet_notification_ledger.event_type = excluded.event_type
      and private.dulonbet_notification_ledger.attempts < 5
      and (
        (private.dulonbet_notification_ledger.status = 'failed'
          and (
            private.dulonbet_notification_ledger.last_error_code = 'provider_network_error'
            or private.dulonbet_notification_ledger.last_error_code = 'provider_http_429'
            or private.dulonbet_notification_ledger.last_error_code ~ '^provider_http_5[0-9]{2}$'
          ))
        or (private.dulonbet_notification_ledger.status = 'processing'
            and private.dulonbet_notification_ledger.updated_at < now() - interval '2 minutes')
      )
  returning 'claimed' into v_status;

  if found then return v_status; end if;

  select event_type, status, attempts, last_error_code
    into v_type, v_status, v_attempts, v_error_code
  from private.dulonbet_notification_ledger where event_id = p_event_id;

  if not found or v_type <> p_event_type then return 'conflict';
  elsif v_status = 'sent' then return 'sent';
  elsif v_attempts >= 5 then return 'exhausted';
  elsif v_status = 'failed' then return 'permanent_failure';
  else return 'busy';
  end if;
end;
$$;

create or replace function public.finish_dulonbet_notification_event(
  p_event_id text, p_status text,
  p_provider_message_id text default null, p_error_code text default null
) returns boolean
language plpgsql
set search_path = pg_catalog
as $$
declare v_count integer;
begin
  if p_status not in ('sent', 'failed') then return false; end if;
  update private.dulonbet_notification_ledger
  set status = p_status,
      provider_message_id = case when p_status = 'sent' then left(p_provider_message_id, 200) else null end,
      last_error_code = case when p_status = 'failed' then left(p_error_code, 80) else null end,
      sent_at = case when p_status = 'sent' then now() else null end,
      updated_at = now()
  where event_id = p_event_id and status = 'processing';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.claim_dulonbet_notification_event(text, text) from public, anon, authenticated;
revoke all on function public.finish_dulonbet_notification_event(text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_dulonbet_notification_event(text, text) to service_role;
grant execute on function public.finish_dulonbet_notification_event(text, text, text, text) to service_role;

create policy "service_role_manage_notification_ledger"
on private.dulonbet_notification_ledger
for all to service_role
using (true) with check (true);
```

## Vérification réalisée

Un événement de test fictif a été réservé puis nettoyé :
- premier appel : `claimed`
- doublon pendant le traitement : `busy`
- finalisation en `sent` : `true`
- doublon après succès : `sent`
- même identifiant avec un autre type : `conflict`

Aucun e-mail n'a été envoyé par ce test SQL. Les tests HTTP, l'envoi Resend réel et la connexion aux événements métier restent à faire.

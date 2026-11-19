# DulonBet — brouillon SQL du registre d’idempotence des notifications

**DOCUMENT DE CONCEPTION UNIQUEMENT — NE PAS EXÉCUTER.** Ce SQL n’a pas été exécuté ni testé. Il n’est pas une migration générée par la CLI Supabase et ne doit pas être copié dans le SQL Editor de production.

## Objectif et garde-fous
- Table privée, réservation atomique par clé primaire `event_id`, blocage après succès.
- Verrou de 2 minutes pour reprise après interruption et maximum de 5 tentatives.
- RPC en droits de l’appelant (pas `SECURITY DEFINER`), exécutable uniquement par `service_role`.
- Aucun accès ni changement aux tables financières.

## SQL proposé à revoir

```sql
-- BROUILLON NON EXÉCUTÉ. Confirmer les schémas et droits avant usage.
create schema if not exists private;

create table if not exists private.dulonbet_notification_ledger (
  event_id text primary key,
  event_type text not null check (event_type in (
    'deposit_requested', 'deposit_confirmed_feexpay', 'deposit_credited_1xbet',
    'withdrawal_requested', 'withdrawal_validated_1xbet',
    'withdrawal_paid_confirmed', 'payment_attention_required'
  )),
  status text not null check (status in ('processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table private.dulonbet_notification_ledger enable row level security;
grant usage on schema private to service_role;
revoke all on private.dulonbet_notification_ledger from public, anon, authenticated;
grant select, insert, update on private.dulonbet_notification_ledger to service_role;

create or replace function public.claim_dulonbet_notification_event(
  p_event_id text, p_event_type text
) returns text
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_claim text;
  v_type text;
  v_status text;
  v_attempts integer;
  v_error_code text;
begin
  if p_event_id is null or length(p_event_id) < 8 or length(p_event_id) > 128
     or p_event_id !~ '^[A-Za-z0-9._:-]+$' then return 'conflict'; end if;

  insert into private.dulonbet_notification_ledger
    (event_id, event_type, status, attempts, updated_at)
  values (p_event_id, p_event_type, 'processing', 1, now())
  on conflict (event_id) do update
    set status = 'processing',
        attempts = private.dulonbet_notification_ledger.attempts + 1,
        updated_at = now(), last_error_code = null
    where private.dulonbet_notification_ledger.event_type = excluded.event_type
      and private.dulonbet_notification_ledger.attempts < 5
      and (
        (private.dulonbet_notification_ledger.status = 'failed'
          and (
            private.dulonbet_notification_ledger.last_error_code = 'provider_network_error'
            or private.dulonbet_notification_ledger.last_error_code = 'provider_http_429'
            or private.dulonbet_notification_ledger.last_error_code ~ '^provider_http_5[0-9]{2}
      )
  returning 'claimed' into v_claim;

  if found then return v_claim; end if;
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
```

## Vérifications obligatoires avant migration
1. Vérifier si le schéma `private` existe déjà. Ne pas révoquer globalement les droits de ce schéma sans audit, car d’autres fonctions pourraient l’utiliser.
2. Vérifier les droits effectifs de `service_role`, les privilèges de la table et l’exposition des RPC par PostgREST.
3. Tester les appels simultanés, le doublon après succès, la reprise après expiration, l’épuisement des 5 tentatives et le même identifiant avec un autre type.
4. Vérifier le cas où Resend accepte un e-mail mais où la réponse réseau est perdue. La clé d’idempotence stable de Resend réduit les doublons externes, sans garantir un envoi exactement une fois.
5. Générer une vraie migration via la procédure CLI Supabase du dépôt, faire la revue de sécurité et tester en développement.
6. Ne pas appliquer ce SQL en production sans accord explicite.

## État
- Aucun SQL exécuté; aucune table créée.
- Les reprises après échec sont limitées aux erreurs réseau, HTTP 429 et HTTP 5xx; les erreurs fournisseur permanentes ne sont pas relancées automatiquement.
- Aucun secret modifié; aucune fonction déployée.
- Aucun flux financier modifié.

          ))
        or (private.dulonbet_notification_ledger.status = 'processing'
            and private.dulonbet_notification_ledger.updated_at < now() - interval '2 minutes')
      )
  returning 'claimed' into v_claim;

  if found then return v_claim; end if;
  select event_type, status, attempts into v_type, v_status, v_attempts
  from private.dulonbet_notification_ledger where event_id = p_event_id;

  if not found or v_type <> p_event_type then return 'conflict';
  elsif v_status = 'sent' then return 'sent';
  elsif v_attempts >= 5 then return 'exhausted';
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
```

## Vérifications obligatoires avant migration
1. Vérifier si le schéma `private` existe déjà. Ne pas révoquer globalement les droits de ce schéma sans audit, car d’autres fonctions pourraient l’utiliser.
2. Vérifier les droits effectifs de `service_role`, les privilèges de la table et l’exposition des RPC par PostgREST.
3. Tester les appels simultanés, le doublon après succès, la reprise après expiration, l’épuisement des 5 tentatives et le même identifiant avec un autre type.
4. Vérifier le cas où Resend accepte un e-mail mais où la réponse réseau est perdue. La clé d’idempotence stable de Resend réduit les doublons externes, sans garantir un envoi exactement une fois.
5. Générer une vraie migration via la procédure CLI Supabase du dépôt, faire la revue de sécurité et tester en développement.
6. Ne pas appliquer ce SQL en production sans accord explicite.

## État
- Aucun SQL exécuté; aucune table créée.
- Aucun secret modifié; aucune fonction déployée.
- Aucun flux financier modifié.

-- DULONBET V25 — migration sans intégration FeexPay ni API 1XBET
-- Sauvegarder la base Supabase avant exécution.
-- Cette migration retire les éléments techniques des anciennes intégrations; elle ne supprime pas les demandes de transactions existantes.



-- SUPPRESSION DEFINITIVE DES CAISSIERS ET COMMISSIONS
-- Cette partie supprime les anciennes structures en base, pas seulement leur affichage.
-- Sauvegarder la base avant exécution : les données de la table des caissiers seront perdues.
drop function if exists public.dulonbet_set_commission();

do $$
begin
  if to_regclass('public.dulonbet_transactions') is not null then
    execute 'drop trigger if exists dulonbet_commission_on_approval on public.dulonbet_transactions';
    execute 'alter table public.dulonbet_transactions drop column if exists cashier_id';
    execute 'alter table public.dulonbet_transactions drop column if exists cashier_name';
    execute 'alter table public.dulonbet_transactions drop column if exists commission_rate';
    execute 'alter table public.dulonbet_transactions drop column if exists commission_amount_fcfa';
  end if;
end; $$;

drop table if exists public.dulonbet_cashiers cascade;

-- Supprimer l'expiration automatique conçue pour les paiements FeexPay.
do $$
declare j bigint;
begin
  if to_regclass('cron.job') is not null then
    select jobid into j from cron.job where jobname = 'dulonbet-expire-deposits-5m' limit 1;
    if j is not null then perform cron.unschedule(j); end if;
  end if;
end; $$;

drop trigger if exists dulonbet_block_expired_deposit_approval_trigger on public.dulonbet_transactions;
drop function if exists public.dulonbet_block_expired_deposit_approval();
drop function if exists public.dulonbet_expire_unpaid_deposits_5m();
drop index if exists public.dulonbet_feexpay_reference_unique;
drop index if exists public.dulonbet_deposit_expiration_5m_idx;

-- Retirer les colonnes de suivi propres aux intégrations FeexPay / API 1XBET.
alter table public.dulonbet_transactions
  drop column if exists feexpay_reference,
  drop column if exists feexpay_status,
  drop column if exists feexpay_payment_url,
  drop column if exists feexpay_request_started_at,
  drop column if exists payment_verified_at,
  drop column if exists payment_verified_by,
  drop column if exists xbet_credited_at,
  drop column if exists xbet_provider_status,
  drop column if exists xbet_provider_message,
  drop column if exists last_error;

-- Supprimer les anciennes protections qui exigeaient la validation par fonction API.
drop trigger if exists dulonbet_guard_approval_trigger on public.dulonbet_transactions;
drop function if exists public.dulonbet_guard_approval();

-- Retirer le journal technique utilisé par les fonctions d'intégration.
drop table if exists public.dulonbet_transaction_events;

-- Les protections de session administrateur restent en place.
select 'DulonBet V25 : éléments d’intégration FeexPay et API 1XBET retirés' as resultat;

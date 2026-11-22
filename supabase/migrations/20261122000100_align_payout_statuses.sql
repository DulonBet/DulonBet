-- DulonBet: align transaction statuses with the payout lifecycle.
-- Prepared for review; not executed automatically.
begin;

alter table public.dulonbet_transactions
  drop constraint if exists dulonbet_transactions_status_check;

alter table public.dulonbet_transactions
  add constraint dulonbet_transactions_status_check
  check (status = any (array[
    'pending'::text,
    'processing'::text,
    'approved'::text,
    'xbet_validated'::text,
    'paid'::text,
    'rejected'::text,
    'failed'::text
  ]));

-- Enforce anti-duplicate guarantees at the database level, including concurrent requests.
-- Existing rows were checked before preparing this change: no duplicate non-null keys were found.
create unique index if not exists dulonbet_transactions_idempotency_key_uidx
  on public.dulonbet_transactions (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists dulonbet_transactions_withdrawal_code_hash_uidx
  on public.dulonbet_transactions (withdrawal_code_hash)
  where withdrawal_code_hash is not null;

commit;

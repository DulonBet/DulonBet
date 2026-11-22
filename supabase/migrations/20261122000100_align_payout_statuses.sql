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

commit;

-- Restrict anonymous direct inserts to deposits only.
-- Withdrawals must be created by the server-side onexbet-withdrawal-request
-- Edge Function, which encrypts the 1XBET withdrawal code before storage.
-- Existing deposit submission behavior and amount limits are preserved.

DROP POLICY IF EXISTS "Public submit pending requests" ON public.dulonbet_transactions;

CREATE POLICY "Public submit pending deposits"
ON public.dulonbet_transactions
FOR INSERT
TO anon, authenticated
WITH CHECK (
  operation_type = 'Dépôt'
  AND status = 'pending'
  AND amount_fcfa >= 100
  AND amount_fcfa <= 2000000
);

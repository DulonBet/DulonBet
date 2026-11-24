import { createClient } from "npm:@supabase/supabase-js@2";
import { decryptWithdrawalCode } from "../_shared/withdrawal-code.ts";
import { createHash } from "node:crypto";

const envFirst = (...names: string[]) => {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HASH = envFirst("CASHDESK_HASH", "CASHDESKBOT_HASH", "ONEXBET_HASH");
const CASHIERPASS = envFirst("CASHDESK_PASS", "CASHDESKBOT_CASHIERPASS", "ONEXBET_CASHIERPASS");
const CASHDESKID = envFirst("CASHDESK_ID", "CASHDESKBOT_CASHDESKID", "ONEXBET_CASHDESKID");
const LNG = Deno.env.get("ONEXBET_LNG") ?? "ru";
const INTERNAL_SECRET = Deno.env.get("DULONBET_FEEXPAY_INTERNAL_SECRET") ?? "";
const WITHDRAWAL_CODE_ENCRYPTION_KEY = Deno.env.get("WITHDRAWAL_CODE_ENCRYPTION_KEY") ?? "";
const PAYOUT_ENABLED = (Deno.env.get("ONEXBET_PAYOUT_ENABLED") ?? "false").trim().toLowerCase() === "true";
const PAYOUT_DRY_RUN = (Deno.env.get("ONEXBET_PAYOUT_DRY_RUN") ?? "true").trim().toLowerCase() !== "false";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://dulonbet.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dulonbet-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
});
const norm = (v: unknown) => String(v ?? "").trim();
const md5 = (v: string) => createHash("md5").update(v, "utf8").digest("hex");
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const safeEqual = (a: string, b: string) => {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !INTERNAL_SECRET || !WITHDRAWAL_CODE_ENCRYPTION_KEY) return json({ error: "Configuration serveur incomplète." }, 503);
  if (!safeEqual(req.headers.get("x-dulonbet-internal-secret") ?? "", INTERNAL_SECRET)) return json({ error: "Accès refusé." }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON invalide." }, 400); }
  const reference = norm(body?.reference);
  if (!/^DB-[0-9a-f-]{36}$/i.test(reference)) return json({ error: "Référence invalide." }, 400);

  const { data: tx, error } = await supabase.from("dulonbet_transactions")
    .select("reference,operation_type,amount_fcfa,requested_amount_fcfa,xbet_id,withdrawal_code,status,network,phone,customer_name")
    .eq("reference", reference).maybeSingle();
  if (error || !tx) return json({ error: "Transaction introuvable." }, 404);
  if (tx.operation_type !== "Retrait") return json({ error: "Cette référence ne correspond pas à un retrait." }, 409);

  if (tx.status !== "pending") {
    return json({ reference, status: tx.status, api_called: false, duplicate_prevented: true,
      message: "Cette demande a déjà quitté l'état pending. Aucun nouvel appel 1XBET ne sera effectué." }, 200);
  }

  const userId = norm(tx.xbet_id);
  let code = "";
  try { code = await decryptWithdrawalCode(norm(tx.withdrawal_code), WITHDRAWAL_CODE_ENCRYPTION_KEY); }
  catch { return json({ reference, status: tx.status, error: "Code protégé illisible. Aucune requête 1XBET envoyée.", api_called: false }, 409); }
  const amount = Number(tx.requested_amount_fcfa ?? tx.amount_fcfa);
  const problems: string[] = [];
  if (!/^[0-9]{1,30}$/.test(userId)) problems.push("ID 1XBET invalide ou absent");
  if (!code || code.length > 128) problems.push("Code de retrait absent ou invalide");
  if (!Number.isSafeInteger(amount) || amount < 900 || amount > 2000000) problems.push("Montant hors limites");
  if (!norm(tx.phone)) problems.push("Numéro Mobile Money absent");
  if (!norm(tx.network)) problems.push("Réseau de paiement absent");
  if (problems.length) return json({ reference, status: tx.status, ready: false, problems, api_called: false }, 422);

  if (!HASH || !CASHIERPASS || !/^[0-9]+$/.test(CASHDESKID)) return json({ reference, status: tx.status, error: "Configuration de caisse incomplète.", api_called: false }, 503);
  if (!PAYOUT_ENABLED || PAYOUT_DRY_RUN) {
    return json({ reference, status: tx.status, mode: "dry_run", ready: true, payout_enabled: PAYOUT_ENABLED,
      dry_run: PAYOUT_DRY_RUN, api_called: false, database_modified: false,
      note: "Mode simulation : aucun appel Payout n'a été envoyé à 1XBET." }, 200);
  }

  const first = sha256(`hash=${HASH}&lng=${LNG}&UserId=${userId}`);
  const second = md5(`code=${code}&cashierpass=${CASHIERPASS}&cashdeskid=${CASHDESKID}`);
  const sign = sha256(first + second);
  const confirm = md5(`${userId}:${HASH}`);

  const { data: claimed, error: claimError } = await supabase.from("dulonbet_transactions")
    .update({ status: "processing", last_error: null })
    .eq("reference", reference).eq("status", "pending")
    .select("reference,status").maybeSingle();
  if (claimError) return json({ reference, error: "Impossible de réserver cette demande. Aucun appel 1XBET envoyé.", api_called: false }, 503);
  if (!claimed) {
    const { data: latest } = await supabase.from("dulonbet_transactions").select("status").eq("reference", reference).maybeSingle();
    return json({ reference, status: latest?.status ?? "verification_required", api_called: false, duplicate_prevented: true }, 200);
  }

  let apiResponse: Response;
  try {
    apiResponse = await fetch(
      `https://partners.servcul.com/CashdeskBotAPI/Deposit/${encodeURIComponent(userId)}/Payout`,
      { method: "POST", headers: { "content-type": "application/json", "sign": sign },
        body: JSON.stringify({ cashdeskId: Number(CASHDESKID), lng: LNG, code, confirm }),
        signal: AbortSignal.timeout(15000) },
    );
  } catch {
    await supabase.from("dulonbet_transactions").update({ status: "verification_required", last_error: "1XBET_NETWORK_OR_TIMEOUT_UNKNOWN" })
      .eq("reference", reference).eq("status", "processing");
    return json({ reference, status: "verification_required", api_called: true,
      message: "Réponse 1XBET incertaine. Vérification manuelle obligatoire; aucun nouvel essai automatique." }, 202);
  }

  let result: any = null;
  try { result = await apiResponse.json(); } catch { /* An unreadable response is uncertain. */ }

  if (apiResponse.ok && result?.success === true && Number(result?.summa) === amount) {
    const { data: updated, error: updateError } = await supabase.from("dulonbet_transactions")
      .update({ status: "xbet_validated", xbet_validated_at: new Date().toISOString(), last_error: null })
      .eq("reference", reference).eq("status", "processing")
      .select("reference,status,amount_fcfa,requested_amount_fcfa").maybeSingle();
    if (updateError || !updated) {
      console.error("DULONBET_PAYOUT_DB_FINALIZE_UNCONFIRMED", { reference });
      return json({ reference, status: "processing", api_called: true,
        message: "Réponse 1XBET positive mais mise à jour locale non confirmée. Vérification manuelle requise." }, 202);
    }
    return json({ reference, status: "xbet_validated", mode: "live", api_called: true,
      amount_fcfa: amount, xbet_amount_fcfa: Number(result.summa),
      message: "Code accepté par 1XBET et montant confirmé. Le paiement Mobile Money reste manuel." }, 200);
  }

  const safeError = !apiResponse.ok ? `1XBET_HTTP_${apiResponse.status}`
    : result?.success === false ? "1XBET_PAYOUT_NOT_CONFIRMED" : "1XBET_RESPONSE_UNCERTAIN";
  await supabase.from("dulonbet_transactions").update({ status: "verification_required", last_error: safeError })
    .eq("reference", reference).eq("status", "processing");
  return json({ reference, status: "verification_required", api_called: true,
    message: "1XBET n'a pas fourni une confirmation positive avec le montant exact. Vérification manuelle requise; aucun nouvel essai automatique." }, 202);
});

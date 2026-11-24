import { createClient } from "npm:@supabase/supabase-js@2";
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
function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function decryptWithdrawalCode(envelope: string) {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("Le code enregistré n'est pas chiffré au format attendu.");
  }
  const rawKey = base64ToBytes(WITHDRAWAL_CODE_ENCRYPTION_KEY);
  if (rawKey.length !== 32) throw new Error("Clé de chiffrement indisponible ou invalide.");
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(parts[2]) }, key, base64ToBytes(parts[3]));
  return new TextDecoder().decode(clear);
}
const safeEqual = (a: string, b: string) => {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !INTERNAL_SECRET || !WITHDRAWAL_CODE_ENCRYPTION_KEY) {
    return json({ error: "Configuration serveur incomplète." }, 503);
  }
  if (!safeEqual(req.headers.get("x-dulonbet-internal-secret") ?? "", INTERNAL_SECRET)) {
    return json({ error: "Accès refusé." }, 403);
  }
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON invalide." }, 400); }
  const reference = norm(body?.reference);
  if (!/^DB-[0-9a-f-]{36}$/i.test(reference)) return json({ error: "Référence invalide." }, 400);

  const { data: tx, error } = await supabase.from("dulonbet_transactions")
    .select("reference,operation_type,amount_fcfa,requested_amount_fcfa,xbet_id,withdrawal_code,status,network,phone,customer_name")
    .eq("reference", reference).maybeSingle();
  if (error || !tx) return json({ error: "Transaction introuvable." }, 404);
  if (tx.operation_type !== "Retrait") return json({ error: "Cette référence ne correspond pas à un retrait." }, 409);

  const userId = norm(tx.xbet_id);
  let code = "";
  try { code = await decryptWithdrawalCode(norm(tx.withdrawal_code)); }
  catch { return json({ error: "Code de retrait non chiffré ou clé de chiffrement incorrecte. Aucune validation 1XBET effectuée." }, 409); }
  const amount = Number(tx.requested_amount_fcfa ?? tx.amount_fcfa);
  const problems: string[] = [];
  if (!/^[0-9]{1,30}$/.test(userId)) problems.push("ID 1XBET invalide ou absent");
  if (!code || code.length > 128) problems.push("Code de retrait absent ou invalide");
  if (!Number.isSafeInteger(amount) || amount < 350 || amount > 2000000) problems.push("Montant hors limites");
  if (!norm(tx.phone)) problems.push("Numéro Mobile Money absent");
  if (!norm(tx.network)) problems.push("Réseau de paiement absent");
  if (problems.length) return json({ reference, mode: "dry_run", ready: false, problems, api_called: false, database_modified: false }, 422);

  if (!HASH || !CASHIERPASS || !/^[0-9]+$/.test(CASHDESKID)) {
    return json({ reference, mode: "dry_run", ready: false, problems: ["Configuration de caisse incomplète"], api_called: false, database_modified: false }, 503);
  }

  // Pré-calcul conforme à la section Payout du document API. Aucun appel réseau 1XBET n'est effectué.
  const first = sha256(`hash=${HASH}&lng=${LNG}&UserId=${userId}`);
  const second = md5(`code=${code}&cashierpass=${CASHIERPASS}&cashdeskid=${CASHDESKID}`);
  const sign = sha256(first + second);
  const confirm = md5(`${userId}:${HASH}`);

  return json({
    reference,
    mode: "dry_run",
    ready: true,
    transaction_status: tx.status,
    player_id_present: true,
    withdrawal_code_present: true,
    payment_destination_present: true,
    amount_fcfa: amount,
    cashdesk_id_configured: true,
    signature_calculated: Boolean(sign),
    confirmation_calculated: Boolean(confirm),
    payout_enabled: PAYOUT_ENABLED,
    dry_run: PAYOUT_DRY_RUN,
    api_called: false,
    database_modified: false,
    note: "Simulation uniquement : aucune requête Payout n'a été envoyée à 1XBET."
  });
});


import { createClient } from "npm:@supabase/supabase-js@2";
import { createHash } from "node:crypto";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const envFirst = (...names: string[]) => {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
};
export const ONEXBET_HASH = envFirst("CASHDESK_HASH", "CASHDESKBOT_HASH", "ONEXBET_HASH");
export const ONEXBET_CASHIERPASS = envFirst("CASHDESK_PASS", "CASHDESKBOT_CASHIERPASS", "ONEXBET_CASHIERPASS");
export const ONEXBET_CASHDESKID = envFirst("CASHDESK_ID", "CASHDESKBOT_CASHDESKID", "ONEXBET_CASHDESKID");
export const ONEXBET_LOGIN = Deno.env.get("ONEXBET_LOGIN") ?? ""; // fourni par le gestionnaire; non utilisé dans les méthodes décrites par le PDF
export const ONEXBET_LNG = Deno.env.get("ONEXBET_LNG") ?? "ru";
export const ONEXBET_CURRENCY_ID = Deno.env.get("ONEXBET_CURRENCY_ID") ?? "";
export const ONEXBET_API_ENABLED = (Deno.env.get("ONEXBET_API_ENABLED") ?? "false").trim().toLowerCase();
export const ONEXBET_API_BASE = "https://partners.servcul.com/CashdeskBotAPI";
export const INTERNAL_SECRET = Deno.env.get("DULONBET_PAYOUT_INTERNAL_SECRET") ?? "";

export const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dulonbet-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
export function norm(v: unknown) { return String(v ?? "").trim(); }
export function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function md5(value: string) { return createHash("md5").update(value, "utf8").digest("hex"); }
export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
export function allowedOrigin(req: Request) {
  const origin = req.headers.get("origin") || "";
  if (!origin) return true; // appels serveur-à-serveur
  return origin === "https://dulonbet.com" || origin === "https://www.dulonbet.com" ||
    origin === "https://dulonbet.vercel.app" || /^https:\/\/dulonbet-[a-z0-9-]+\.vercel\.app$/.test(origin);
}
export function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ONEXBET_HASH && ONEXBET_CASHIERPASS && ONEXBET_CASHDESKID && /^[0-9]+$/.test(ONEXBET_CASHDESKID) && INTERNAL_SECRET && /^[0-9]+$/.test(ONEXBET_CURRENCY_ID) && ONEXBET_API_ENABLED === "true");
}
export function confirmFor(userId: string) { return md5(`${userId}:${ONEXBET_HASH}`); }
export function signFor(userId: string, lng: string, requestMd5: string) {
  // Formule documentée : SHA256(SHA256(hash=...&lng=...&userid=...) + MD5(paramètres))
  const first = sha256(`hash=${ONEXBET_HASH}&lng=${lng}&UserId=${userId}`);
  return sha256(first + requestMd5);
}
export async function onexbetRequest(path: string, body: Record<string, unknown>, sign: string) {
  return await fetch(`${ONEXBET_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "sign": sign },
    body: JSON.stringify(body),
  });
}

export async function onexbetPlayerLookup(userId: string) {
  const first = sha256(`hash=${ONEXBET_HASH}&userid=${userId}&cashdeskid=${ONEXBET_CASHDESKID}`);
  const second = md5(`userid=${userId}&cashierpass=${ONEXBET_CASHIERPASS}&hash=${ONEXBET_HASH}`);
  const sign = sha256(first + second);
  const url = `${ONEXBET_API_BASE}/Users/${encodeURIComponent(userId)}?confirm=${encodeURIComponent(confirmFor(userId))}&cashdeskId=${encodeURIComponent(ONEXBET_CASHDESKID)}`;
  return await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json", "sign": sign },
  });
}

async function notifyAdmin(eventType: string, reference: string, amount_fcfa?: number) {
  const secret = Deno.env.get("DULONBET_NOTIFICATION_INTERNAL_SECRET") ?? "";
  if (!secret || !SUPABASE_URL || !SERVICE_ROLE_KEY) return;
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/dulonbet-notify-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SERVICE_ROLE_KEY, "Authorization": `Bearer ${SERVICE_ROLE_KEY}`, "x-dulonbet-notification-secret": secret },
      body: JSON.stringify({ event_id: `${reference}:${eventType}`, event_type: eventType, reference, ...(amount_fcfa === undefined ? {} : { amount_fcfa }) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) console.error("DULONBET_NOTIFICATION_CALL_FAILED", { eventType, reference, http_status: response.status });
  } catch (error) { console.error("DULONBET_NOTIFICATION_CALL_ERROR", { eventType, reference, message: String(error) }); }
}

// ---- Fonction onexbet-payout ----

function digits(v: unknown) { return norm(v).replace(/\D/g, ""); }
function uuidKey(v: unknown) { return /^[a-z0-9-]{16,128}$/i.test(norm(v)); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    if (!allowedOrigin(req)) return json({ error: "Origine non autorisée." }, 403);
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  if (!allowedOrigin(req)) return json({ error: "Origine non autorisée." }, 403);
  if (!configured()) return json({ error: "Service temporairement indisponible." }, 503);
  // Endpoint interne uniquement : le secret est transmis par le proxy serveur, jamais par le navigateur.
  if (!safeEqual(norm(req.headers.get("x-dulonbet-internal-secret")), INTERNAL_SECRET)) {
    return json({ error: "Authentification interne requise." }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Demande invalide." }, 400); }
  // Ce header n'est accepté qu'après vérification du secret interne ci-dessus.
  const forwarded = req.headers.get("x-dulonbet-client-ip") || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(-1)[0] || "unknown";
  const rateKey = await sha256(forwarded);
  const { data: allowed, error: rateError } = await supabase.rpc("dulonbet_check_payout_rate_limit", { p_key_hash: rateKey });
  if (rateError) {
    console.error("PAYOUT_RATE_LIMIT_ERROR", { message: rateError.message });
    return json({ error: "Service de retrait temporairement indisponible." }, 503);
  }
  if (allowed !== true) return json({ error: "Trop de tentatives. Attends 15 minutes avant de réessayer." }, 429);
  const userId = norm(body?.xbet_id);
  const code = norm(body?.withdrawal_code);
  const amountRequested = Number(body?.amount_fcfa);
  const phone = digits(body?.phone);
  const country = norm(body?.country || "Bénin");
  const network = norm(body?.network);
  const customerName = norm(body?.customer_name);
  const idempotencyKey = norm(body?.idempotency_key);

  if (!/^[0-9]{1,30}$/.test(userId)) return json({ error: "Identifiant 1XBET invalide." }, 400);
  if (!code || code.length > 128) return json({ error: "Code de retrait invalide." }, 400);
  if (!Number.isSafeInteger(amountRequested) || amountRequested < 350 || amountRequested > 2000000) {
    return json({ error: "Montant demandé invalide." }, 400);
  }
  if (!/^01[0-9]{8}$/.test(phone) || country !== "Bénin") return json({ error: "Numéro Mobile Money béninois invalide." }, 400);
  if (!["MTN MoMo", "Moov Money", "Celtiis Cash"].includes(network)) return json({ error: "Réseau Mobile Money non pris en charge." }, 400);
  if (!customerName || customerName.length > 120) return json({ error: "Nom complet invalide." }, 400);
  if (!uuidKey(idempotencyKey)) return json({ error: "Référence de demande invalide." }, 400);

  const { data: sameRequest } = await supabase.from("dulonbet_transactions")
    .select("reference,status,amount_fcfa,provider_status")
    .eq("idempotency_key", idempotencyKey).maybeSingle();
  if (sameRequest) {
    return json({
      reference: sameRequest.reference, status: sameRequest.status, amount_fcfa: sameRequest.amount_fcfa,
      message: "Cette même demande a déjà été reçue. Consulte son statut avant toute nouvelle tentative.",
    }, 202);
  }

  const codeHash = await sha256(code);
  const { data: activeCode } = await supabase.from("dulonbet_transactions")
    .select("reference,status").eq("withdrawal_code_hash", codeHash)
    .in("status", ["processing", "xbet_validated", "paid"]).maybeSingle();
  if (activeCode) {
    return json({ reference: activeCode.reference, status: activeCode.status, error: "Ce code de retrait a déjà été traité ou doit être vérifié. Ne le soumets pas une seconde fois." }, 409);
  }

  // Sécurité métier : le joueur doit déjà avoir un dépôt confirmé via DulonBet.
  // Ce contrôle est en lecture seule et n'appelle pas l'API de retrait 1XBET.
  const { data: priorDeposit, error: priorDepositError } = await supabase
    .from("dulonbet_transactions")
    .select("reference")
    .eq("operation_type", "Dépôt")
    .eq("xbet_id", userId)
    .eq("status", "approved")
    .eq("provider_status", "SUCCESSFUL")
    .not("payment_verified_at", "is", null)
    .limit(1)
    .maybeSingle();

  if (priorDepositError) {
    console.error("PAYOUT_PRIOR_DEPOSIT_CHECK_ERROR", { message: priorDepositError.message });
    return json({ error: "Impossible de vérifier l'historique de dépôt. Aucun retrait n'a été demandé." }, 503);
  }
  if (!priorDeposit) {
    return json({ error: "Retrait refusé : aucun dépôt confirmé via la caisse DulonBet pour ce compte 1XBET." }, 403);
  }

  const reference = `DB-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const { error: insertError } = await supabase.from("dulonbet_transactions").insert({
    reference, operation_type: "Retrait", amount_fcfa: amountRequested,
    requested_amount_fcfa: amountRequested, network, country, xbet_id: userId, phone,
    customer_name: customerName, withdrawal_code: null, withdrawal_code_hash: codeHash,
    idempotency_key: idempotencyKey, status: "processing", provider_status: "1XBET_REQUESTED",
    updated_at: now,
  });
  if (insertError) {
    console.error("ONEXBET_PAYOUT_INSERT_ERROR", { message: insertError.message, code: (insertError as any).code });
    return json({ error: "Impossible d'enregistrer la demande. Ne soumets pas le même code avant vérification." }, 409);
  }

  await notifyAdmin("withdrawal_requested", reference, amountRequested);

  let playerResponse: Response;
  try { playerResponse = await onexbetPlayerLookup(userId); }
  catch (error) {
    await supabase.from("dulonbet_transactions").update({
      status: "failed", provider_status: "PLAYER_LOOKUP_UNKNOWN",
      last_error: "La recherche du joueur a échoué avant la demande de retrait.",
      updated_at: new Date().toISOString(),
    }).eq("reference", reference);
    return json({ reference, status: "failed", message: "Le compte 1XBET n'a pas pu être vérifié. Aucun retrait n'a été demandé." }, 502);
  }
  const playerRaw = await playerResponse.text();
  let player: any = {};
  try { player = JSON.parse(playerRaw); } catch { player = {}; }
  if (!playerResponse.ok || String(player?.userId ?? player?.UserId ?? player?.userid ?? player?.userID ?? player?.id ?? "") !== userId || Number(player?.currencyId ?? player?.CurrencyId ?? player?.currencyID ?? player?.currency_id ?? player?.Currency ?? player?.currency) !== Number(ONEXBET_CURRENCY_ID)) {
    await supabase.from("dulonbet_transactions").update({
      status: "rejected", provider_status: "PLAYER_OR_CURRENCY_INVALID",
      last_error: `Compte 1XBET introuvable, devise non autorisée ou recherche refusée (HTTP ${playerResponse.status}).`,
      updated_at: new Date().toISOString(),
    }).eq("reference", reference);
    await supabase.from("dulonbet_payment_events").insert({
      reference, event_type: "ONEXBET_PAYOUT_PLAYER_OR_CURRENCY_INVALID", provider_status: "MISMATCH",
      details: { http_status: playerResponse.status, user_match: String(player?.userId ?? player?.UserId ?? player?.userid ?? player?.userID ?? player?.id ?? "") === userId, currency_match: Number(player?.currencyId ?? player?.CurrencyId ?? player?.currencyID ?? player?.currency_id ?? player?.Currency ?? player?.currency) === Number(ONEXBET_CURRENCY_ID) },
    });
    return json({ reference, status: "rejected", message: "Le compte 1XBET ou sa devise n'a pas pu être validé. Aucun paiement Mobile Money n'a été demandé." });
  }

  const requestMd5 = md5(`code=${code}&cashierpass=${ONEXBET_CASHIERPASS}&cashdeskid=${ONEXBET_CASHDESKID}`);
  const sign = signFor(userId, ONEXBET_LNG, requestMd5);
  const confirm = confirmFor(userId);
  let response: Response;
  try {
    response = await onexbetRequest(`/Deposit/${encodeURIComponent(userId)}/Payout`, {
      cashdeskId: Number(ONEXBET_CASHDESKID), lng: ONEXBET_LNG, code, confirm,
    }, sign);
  } catch (error) {
    console.error("ONEXBET_PAYOUT_NETWORK_UNKNOWN", { reference, message: String(error) });
    await supabase.from("dulonbet_transactions").update({
      status: "processing", provider_status: "1XBET_UNKNOWN",
      last_error: "Réponse API incertaine; vérifier la caisse avant toute nouvelle tentative.",
      updated_at: new Date().toISOString(),
    }).eq("reference", reference);
    await supabase.from("dulonbet_payment_events").insert({
      reference, event_type: "ONEXBET_PAYOUT_UNKNOWN", provider_status: "UNKNOWN",
      details: { reason: "network_error" },
    });
    return json({ reference, status: "processing", message: "La demande est en cours de vérification. Ne soumets pas à nouveau ce code." }, 202);
  }

  const raw = await response.text();
  let result: any = {};
  let validJson = false;
  try {
    result = JSON.parse(raw);
    validJson = Boolean(result && typeof result === "object" && !Array.isArray(result));
  } catch { result = {}; }

  // Une réponse HTTP non-OK ne prouve pas que le retrait n'a pas été exécuté.
  // On conserve donc processing et on exige une vérification manuelle avant toute reprise.
  if (!response.ok) {
    await supabase.from("dulonbet_transactions").update({
      status: "processing", provider_status: `1XBET_HTTP_${response.status}_UNKNOWN`,
      last_error: `Résultat incertain après réponse HTTP ${response.status} de l'API 1XBET; vérification manuelle obligatoire.`,
      updated_at: new Date().toISOString(),
    }).eq("reference", reference);
    await supabase.from("dulonbet_payment_events").insert({
      reference, event_type: "ONEXBET_PAYOUT_UNKNOWN", provider_status: String(response.status),
      details: { http_status: response.status, messageId: result?.messageId ?? null },
    });
    return json({ reference, status: "processing", message: "Résultat incertain. Vérifie la caisse 1XBET avant toute autre action; ne soumets pas à nouveau ce code." }, 202);
  }

  // Une réponse vide, mal formée ou sans booléen success est ambiguë, pas un refus.
  if (!validJson || typeof result?.success !== "boolean") {
    await supabase.from("dulonbet_transactions").update({
      status: "processing", provider_status: "1XBET_RESPONSE_UNKNOWN",
      last_error: "Réponse API 1XBET illisible ou incomplète; vérification manuelle obligatoire.",
      updated_at: new Date().toISOString(),
    }).eq("reference", reference);
    await supabase.from("dulonbet_payment_events").insert({
      reference, event_type: "ONEXBET_PAYOUT_UNKNOWN", provider_status: "UNKNOWN",
      details: { http_status: response.status, response_parseable: validJson },
    });
    return json({ reference, status: "processing", message: "La réponse de 1XBET est ambiguë. Ne soumets pas à nouveau ce code; une vérification administrative est nécessaire." }, 202);
  }

  if (result.success === false) {
    await supabase.from("dulonbet_transactions").update({
      status: "rejected", provider_status: "1XBET_REJECTED",
      last_error: norm(result?.message).slice(0, 300) || "L'API 1XBET a refusé le retrait.",
      updated_at: new Date().toISOString(),
    }).eq("reference", reference);
    await supabase.from("dulonbet_payment_events").insert({
      reference, event_type: "ONEXBET_PAYOUT_REJECTED", provider_status: "FAILED",
      details: { messageId: result?.messageId ?? null },
    });
    return json({ reference, status: "rejected", message: "1XBET a refusé le code ou la demande. Aucun paiement Mobile Money n'a été demandé." });
  }

  const actualAmount = Number(result?.summa);
  if (!Number.isSafeInteger(actualAmount) || actualAmount <= 0) {
    await supabase.from("dulonbet_transactions").update({
      status: "processing", provider_status: "1XBET_SUCCESS_AMOUNT_UNKNOWN",
      last_error: "1XBET indique success=true mais ne retourne pas un montant exploitable; revue manuelle obligatoire.",
      updated_at: new Date().toISOString(),
    }).eq("reference", reference);
    await supabase.from("dulonbet_admin_notifications").insert({
      reference, notification_type: "withdrawal_review",
      title: "Retrait 1XBET à vérifier",
      message: "L'API 1XBET a répondu success=true mais le montant retourné est absent ou invalide. Ne paie pas avant vérification.",
      details: { messageId: result?.messageId ?? null },
    });
    await supabase.from("dulonbet_payment_events").insert({
      reference, event_type: "ONEXBET_PAYOUT_SUCCESS_AMOUNT_UNKNOWN", provider_status: "SUCCESS",
      details: { messageId: result?.messageId ?? null },
    });
    return json({ reference, status: "processing", message: "1XBET a répondu, mais le montant doit être vérifié avant paiement." }, 202);
  }

  const mismatch = actualAmount !== amountRequested;
  const { data: finalizedRow, error: updateError } = await supabase.from("dulonbet_transactions").update({
    status: "xbet_validated", amount_fcfa: actualAmount, provider_status: "1XBET_SUCCESS",
    xbet_validated_at: new Date().toISOString(),
    last_error: mismatch ? `Montant saisi (${amountRequested}) différent du montant confirmé par 1XBET (${actualAmount}); payer uniquement le montant confirmé par l'API.` : null,
    updated_at: new Date().toISOString(),
  }).eq("reference", reference).eq("status", "processing").select("reference,status").maybeSingle();
  if (updateError || !finalizedRow || finalizedRow.status !== "xbet_validated") {
    console.error("ONEXBET_PAYOUT_DB_FINALIZE_ERROR", {
      reference,
      message: updateError?.message ?? "Aucune ligne processing n'a été modifiée",
      row_found: Boolean(finalizedRow),
    });
    return json({ reference, status: "processing", message: "1XBET a répondu positivement, mais la validation en base n'est pas confirmée. Ne relance pas le code; une vérification administrative est nécessaire." }, 202);
  }

  await supabase.from("dulonbet_admin_notifications").insert({
    reference, notification_type: "withdrawal_validated",
    title: "Retrait 1XBET validé — paiement Mobile Money à effectuer",
    message: `Retrait confirmé par 1XBET : ${actualAmount} FCFA. Payer manuellement le numéro ${phone} (${network}) après vérification.`,
    details: { amount_fcfa: actualAmount, phone, network, xbet_id: userId, amount_mismatch: mismatch },
  });
  await supabase.from("dulonbet_payment_events").insert({
    reference, event_type: "ONEXBET_PAYOUT_VALIDATED", provider_status: "SUCCESSFUL",
    details: { amount_fcfa: actualAmount, amount_mismatch: mismatch, messageId: result?.messageId ?? null },
  });
  await notifyAdmin("withdrawal_validated_1xbet", reference, actualAmount);
  return json({
    reference, status: "xbet_validated", amount_fcfa: actualAmount,
    message: mismatch
      ? `1XBET a validé un retrait de ${actualAmount} FCFA. Le montant saisi différait; le montant confirmé par 1XBET fait foi.`
      : `1XBET a validé le retrait de ${actualAmount} FCFA. Le paiement Mobile Money reste manuel.`,
  });
});

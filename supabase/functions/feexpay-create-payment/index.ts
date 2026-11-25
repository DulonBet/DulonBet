import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FEEXPAY_API_KEY = Deno.env.get("FEEXPAY_API_KEY") ?? "";
const INTERNAL_SECRET = Deno.env.get("DULONBET_FEEXPAY_INTERNAL_SECRET") ?? "";
const LIVE_DEPOSITS_ENABLED = (Deno.env.get("DULONBET_LIVE_DEPOSITS_ENABLED") ?? "false").trim().toLowerCase();
const FEEXPAY_SHOP_ID = Deno.env.get("FEEXPAY_SHOP_ID") ?? "";

// Fonction FeexPay de création et vérification des paiements.
// Dans Supabase Secrets, FEEXPAY_MODE doit être exactement "live".
// Utiliser uniquement FEEXPAY_API_KEY et FEEXPAY_SHOP_ID de production.
const FEEXPAY_MODE = (Deno.env.get("FEEXPAY_MODE") ?? "").trim().toLowerCase();
const FEEXPAY_API_BASE = FEEXPAY_MODE === "live"
  ? "https://api-v2.feexpay.me"
  : "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
function norm(v: unknown) { return String(v ?? "").trim(); }
function digits(v: unknown) { return norm(v).replace(/\D/g, ""); }
function beninLocalPhone(v: unknown): string {
  const d = digits(v);
  if (d.length === 10 && /^01[0-9]{8}$/.test(d)) return d;
  if (d.length === 13 && d.startsWith("229") && /^01[0-9]{8}$/.test(d.slice(3))) return d.slice(3);
  return "";
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function parseStatus(body: any): string {
  // Accepte les formats courants, mais ne considère jamais un champ absent comme un succès.
  return norm(body?.status ?? body?.data?.status ?? body?.transaction?.status).toUpperCase();
}
function providerReference(body: any): string {
  return norm(body?.reference ?? body?.data?.reference ??
    body?.transaction?.reference ?? body?.data?.transaction?.reference);
}

async function recordEvent(reference: string, event_type: string, provider_status = "", details: unknown = {}) {
  await supabase.from("dulonbet_payment_events").insert({
    reference, event_type, provider_status: provider_status || null, details,
  });
}



async function notifyAdmin(eventType: string, reference: string, amount_fcfa?: number) {
  const secret = Deno.env.get("DULONBET_NOTIFICATION_INTERNAL_SECRET") ?? "";
  if (!secret || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("DULONBET_NOTIFICATION_NOT_CONFIGURED", { eventType, reference });
    return;
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/dulonbet-notify-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "x-dulonbet-notification-secret": secret,
      },
      body: JSON.stringify({
        event_id: `${reference}:${eventType}`,
        event_type: eventType,
        reference,
        ...(amount_fcfa === undefined ? {} : { amount_fcfa }),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error("DULONBET_NOTIFICATION_CALL_FAILED", { eventType, reference, http_status: response.status });
    }
  } catch (error) {
    console.error("DULONBET_NOTIFICATION_CALL_ERROR", { eventType, reference, message: String(error) });
  }
}

async function triggerXbetCredit(reference: string) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/feexpay-credit-1xbet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "x-dulonbet-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ reference }),
    });
    if (!response.ok) {
      console.error("XBET_CREDIT_TRIGGER_FAILED", { reference, http_status: response.status });
    }
  } catch (error) {
    console.error("XBET_CREDIT_TRIGGER_NETWORK_ERROR", { reference, message: String(error) });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin") || "";
    if (origin && origin !== "https://www.dulonbet.com" && origin !== "https://dulonbet.com" && origin !== "https://dulonbet.vercel.app" &&
        !/^https:\/\/dulonbet-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
      return json({ error: "Origin non autorisée." }, 403);
    }
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  const origin = req.headers.get("origin") || "";
  if (origin && origin !== "https://www.dulonbet.com" &&
      origin !== "https://dulonbet.com" && origin !== "https://dulonbet.vercel.app" &&
      !/^https:\/\/dulonbet-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
    return json({ error: "Origin non autorisée." }, 403);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !FEEXPAY_API_KEY || !FEEXPAY_SHOP_ID || !FEEXPAY_API_BASE || !INTERNAL_SECRET) {
    console.error("Configuration serveur incomplète : secrets Supabase ou FEEXPAY_MODE manquant/invalide.");
    return json({ error: "Configuration serveur incomplète." }, 503);
  }
  if (FEEXPAY_MODE !== "live") {
    console.error("Cette version est réservée à FeexPay Live : FEEXPAY_MODE doit être live.");
    return json({ error: "Configuration de paiement indisponible." }, 503);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON invalide." }, 400); }
  const action = norm(body?.action);

  if (action === "initiate") {
    if (LIVE_DEPOSITS_ENABLED !== "true") {
      return json({ error: "Les dépôts réels sont temporairement désactivés pendant la validation de l'intégration." }, 503);
    }
    const amount = Number(body?.amount_fcfa);
    const xbetId = norm(body?.xbet_id);
    const phone = beninLocalPhone(body?.phone);
    const country = norm(body?.country || "Bénin");
    const network = norm(body?.network || "MTN MoMo");
    const customerName = norm(body?.customer_name);
    const idempotencyKey = norm(body?.idempotency_key);

    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 2000000) {
      return json({ error: "Montant invalide." }, 400);
    }
    // Dépôts clients autorisés dans la plage commerciale; conserver les contrôles de paiement et d'idempotence.
    if (!xbetId || xbetId.length > 80) return json({ error: "ID 1XBET invalide." }, 400);
    if (!phone) return json({ error: "Saisis un numéro béninois valide : 10 chiffres locaux ou 13 chiffres avec l’indicatif 229." }, 400);
    const networkKey = network.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
    const endpointByNetwork: Record<string, string> = {
      "mtnmomo": `${FEEXPAY_API_BASE}/api/transactions/public/requesttopay/mtn`,
      "moovmoney": `${FEEXPAY_API_BASE}/api/transactions/public/requesttopay/moov`,
      "celtiiscash": `${FEEXPAY_API_BASE}/api/transactions/public/requesttopay/celtiis_bj`,
    };
    const endpoint = endpointByNetwork[networkKey];
    if (!endpoint) return json({ error: "Réseau Mobile Money non pris en charge." }, 400);
    if (country !== "Bénin") return json({ error: "Pour le moment, seul le Bénin est activé pour FeexPay." }, 400);
    // beninLocalPhone a déjà normalisé le numéro en 10 chiffres locaux.
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      return json({ error: "Clé de demande manquante. Recharge le formulaire et réessaie." }, 400);
    }

    // Les dépôts peuvent être relancés à tout moment, même pour le même compte, montant ou téléphone.
    // Chaque tentative garde sa propre référence; l'idempotency_key bloque seulement le renvoi exact
    // de la même demande technique. Le statut FeexPay en attente ne bloque pas une nouvelle tentative.

    // L'idempotency_key protège aussi contre le renvoi accidentel de la même demande.
    const { data: existing, error: existingCheckError } = await supabase.from("dulonbet_transactions")
      .select("reference,status,amount_fcfa,provider_reference")
      .eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingCheckError) {
      console.error("IDEMPOTENCY_CHECK_FAILED", { message: existingCheckError.message });
      return json({ error: "Vérification de la demande indisponible. Réessaie plus tard." }, 503);
    }
    if (existing) {
      return json({ error: "Cette même demande a déjà été reçue.", reference: existing.reference, status: existing.status }, 409);
    }

    const reference = `DB-${crypto.randomUUID()}`;
    const token = randomToken();
    const token_hash = await sha256(token);

    const { error: insertError } = await supabase.from("dulonbet_transactions").insert({
      reference,
      operation_type: "Dépôt",
      amount_fcfa: amount,
      network,
      country,
      xbet_id: xbetId,
      phone,
      customer_name: customerName || null,
      withdrawal_code: null,
      status: "pending",
      payment_provider: "feexpay",
      provider_status: "CREATED",
      idempotency_key: idempotencyKey,
      payment_created_at: new Date().toISOString(),
    });
    if (insertError) {
      console.error("Transaction insert failed:", insertError);
      return json({ error: "Impossible d'enregistrer la demande." }, 500);
    }

    const { error: tokenError } = await supabase.from("dulonbet_payment_attempts")
      .insert({ reference, token_hash });
    if (tokenError) {
      await recordEvent(reference, "TOKEN_STORE_FAILED", "", { message: tokenError.message });
      return json({ error: "Demande créée mais sécurisation incomplète. Contacte le support.", reference }, 500);
    }


    // Endpoints de dépôt FeexPay Bénin documentés par réseau.
    let providerBody: any;
    const response = await fetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FEEXPAY_API_KEY}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          phoneNumber: Number(`229${phone}`),
          amount,
          shop: FEEXPAY_SHOP_ID,
          // FeexPay V2 docs: description is optional and must not contain special characters.
          description: "DulonBet depot",
        }),
      },
    ).catch((e) => {
      console.error("FeexPay request failed:", e);
      return null;
    });

    if (!response) {
      await supabase.from("dulonbet_transactions").update({
        provider_status: "INITIATION_UNKNOWN", status: "processing",
      }).eq("reference", reference).eq("status", "pending");
      await recordEvent(reference, "INITIATION_UNKNOWN");
      // Ne pas lancer une seconde requête automatiquement : le fournisseur a pu recevoir la première.
      return json({ reference, token, status: "processing", message: "La demande de paiement est en cours de vérification. Ne recommence pas ce même paiement." }, 202);
    }

    const raw = await response.text();
    try { providerBody = JSON.parse(raw); } catch { providerBody = { raw_text: raw.slice(0, 1000) }; }
    const pRef = providerReference(providerBody);
    const pStatus = parseStatus(providerBody) || (response.ok ? "PENDING" : "INITIATION_FAILED");

    await supabase.from("dulonbet_transactions").update({
      provider_reference: pRef || null,
      provider_status: pStatus,
      status: response.ok ? "pending" : "processing",
    }).eq("reference", reference).eq("status", "pending");

    // Diagnostic fournisseur sans exposer de numéro, de clé API ni de données sensibles.
    const providerDiagnostics = {
      http_status: response.status,
      network_key: networkKey,
      endpoint_type: networkKey === "mtnmomo" ? "requesttopay_mtn" : networkKey === "moovmoney" ? "requesttopay_moov" : "requesttopay_celtiis_bj",
      provider_reference_present: Boolean(pRef),
      response_keys: Object.keys(providerBody || {}).slice(0, 30),
      provider_response_code: norm(providerBody?.responsecode ?? providerBody?.data?.responsecode).slice(0, 80) || null,
      provider_response_message: norm(providerBody?.responsemsg ?? providerBody?.message ?? providerBody?.data?.responsemsg ?? providerBody?.data?.message).slice(0, 240) || null,
      provider_description: norm(providerBody?.description ?? providerBody?.data?.description).slice(0, 240) || null,
      provider_reason: norm(providerBody?.reason ?? providerBody?.data?.reason).slice(0, 240) || null,
      provider_status: pStatus,
    };
    await recordEvent(reference, "INITIATION_RESPONSE", pStatus, providerDiagnostics);
    if (networkKey === "mtnmomo") {
      console.log("FEEXPAY_MTN_INITIATION_DIAGNOSTIC", { reference, ...providerDiagnostics });
    }

    if (!response.ok) {
      // Pas de rejet définitif sur une réponse ambiguë : il faut vérifier le statut fournisseur.
      return json({ reference, token, status: "processing", message: "FeexPay n'a pas confirmé le lancement. Le statut doit être vérifié avant toute nouvelle tentative." }, 202);
    }
    return json({
      reference,
      token,
      status: "pending",
      provider_reference: pRef || null,
      message: "Demande envoyée. Le dépôt ne sera validé qu'après confirmation du statut par FeexPay.",
    }, 200);
  }

  if (action === "verify") {
    const reference = norm(body?.reference);
    const token = norm(body?.token);
    if (!/^DB-[0-9a-f-]{36}$/i.test(reference) || token.length < 32 || token.length > 128) {
      return json({ error: "Référence ou jeton invalide." }, 400);
    }

    const { data: attempt, error: attemptError } = await supabase.from("dulonbet_payment_attempts")
      .select("token_hash,expires_at,check_count")
      .eq("reference", reference).maybeSingle();
    if (attemptError || !attempt) return json({ error: "Demande introuvable." }, 404);
    if (new Date(attempt.expires_at).getTime() < Date.now()) {
      return json({ error: "Le jeton de vérification a expiré. Contacte le support." }, 410);
    }
    if ((await sha256(token)) !== attempt.token_hash) return json({ error: "Accès refusé." }, 403);

    const { data: tx, error: txError } = await supabase.from("dulonbet_transactions")
      .select("reference,operation_type,amount_fcfa,phone,status,provider_reference,provider_status")
      .eq("reference", reference).maybeSingle();
    if (txError || !tx) return json({ error: "Transaction introuvable." }, 404);
    if (tx.operation_type !== "Dépôt") return json({ error: "Cette vérification ne concerne pas un dépôt." }, 400);
    if (tx.status === "approved") {
      await triggerXbetCredit(reference);
      return json({ reference, status: "approved", message: "Paiement déjà confirmé. Crédit 1XBET en cours de traitement." });
    }
    if (["rejected", "failed"].includes(String(tx.status).toLowerCase())) {
      return json({ reference, status: tx.status, message: "Cette demande est déjà clôturée." });
    }
    if (!tx.provider_reference) {
      await supabase.from("dulonbet_payment_attempts").update({
        last_checked_at: new Date().toISOString(), check_count: Number(attempt.check_count || 0) + 1,
      }).eq("reference", reference);
      return json({ reference, status: "processing", message: "Référence fournisseur pas encore disponible. Réessaie plus tard." }, 202);
    }

    const statusResponse = await fetch(
      `${FEEXPAY_API_BASE}/api/transactions/public/single/status/${encodeURIComponent(tx.provider_reference)}`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${FEEXPAY_API_KEY}`, "Accept": "application/json" },
      },
    ).catch((e) => {
      console.error("FeexPay status check failed:", e);
      return null;
    });

    if (!statusResponse) return json({ reference, status: "processing", message: "Vérification momentanément indisponible. Réessaie plus tard." }, 202);
    const rawStatus = await statusResponse.text();
    let statusBody: any;
    try { statusBody = JSON.parse(rawStatus); } catch { statusBody = {}; }
    const status = parseStatus(statusBody);
    const providerFailureText = [
      statusBody?.responsemsg, statusBody?.reason, statusBody?.comment, statusBody?.description,
      statusBody?.data?.responsemsg, statusBody?.data?.reason, statusBody?.data?.comment,
      statusBody?.data?.description,
    ].map((v) => norm(v)).filter(Boolean).join(" | ").slice(0, 500);
    const mentionsWallet = /(?:phone|number|operator|network|wallet|account|subscriber|msisdn|mobile money|num[eé]ro|portefeuille|compte|op[eé]rateur|r[eé]seau)/i.test(providerFailureText);
    const signalsMismatch = /(?:invalid|not found|not registered|does not exist|unsupported|not supported|wrong|mismatch|incompatible|not active|unknown|incorrect|inexistant|introuvable|non valide|non enregistr[eé]|pas reconnu|n'existe pas)/i.test(providerFailureText);
    const incompatibleWallet = mentionsWallet && signalsMismatch;
    await supabase.from("dulonbet_payment_attempts").update({
      last_checked_at: new Date().toISOString(), check_count: Number(attempt.check_count || 0) + 1,
    }).eq("reference", reference);

    await recordEvent(reference, "STATUS_CHECK", status || "UNKNOWN", {
      http_status: statusResponse.status,
      response_keys: Object.keys(statusBody || {}).slice(0, 30),
      provider_response_code: norm(statusBody?.responsecode ?? statusBody?.data?.responsecode).slice(0, 80) || null,
      provider_response_message: norm(statusBody?.responsemsg ?? statusBody?.data?.responsemsg).slice(0, 240) || null,
      provider_reason: norm(statusBody?.reason ?? statusBody?.data?.reason).slice(0, 240) || null,
      provider_comment: norm(statusBody?.comment ?? statusBody?.data?.comment).slice(0, 240) || null,
    });

    if (!statusResponse.ok || !status) {
      return json({ reference, status: "processing", message: "Réponse FeexPay non concluante. Aucun crédit effectué." }, 202);
    }

    // Fail-closed : seule la valeur SUCCESSFUL est reconnue comme succès.
    if (status === "SUCCESSFUL") {
      // Les champs de comparaison sont contrôlés s'ils sont renvoyés par l'API.
      const reportedAmount = statusBody?.amount ?? statusBody?.data?.amount;
      const reportedPhone = statusBody?.phoneNumber ?? statusBody?.data?.phoneNumber;
      const reportedRef = providerReference(statusBody);
      if (reportedAmount !== undefined && Number(reportedAmount) !== Number(tx.amount_fcfa)) {
        await recordEvent(reference, "AMOUNT_MISMATCH", status, {});
        return json({ reference, status: "processing", message: "Le montant retourné par FeexPay ne correspond pas. Vérification manuelle requise." }, 202);
      }
      if (reportedPhone !== undefined && beninLocalPhone(reportedPhone) !== beninLocalPhone(tx.phone)) {
        await recordEvent(reference, "PHONE_MISMATCH", status, {});
        return json({ reference, status: "processing", message: "Le numéro retourné par FeexPay ne correspond pas. Vérification manuelle requise." }, 202);
      }
      if (reportedRef && reportedRef !== tx.provider_reference) {
        await recordEvent(reference, "REFERENCE_MISMATCH", status, {});
        return json({ reference, status: "processing", message: "La référence retournée par FeexPay ne correspond pas. Vérification manuelle requise." }, 202);
      }

      const { data: updated, error: updateError } = await supabase.from("dulonbet_transactions")
        .update({
          status: "approved",
          provider_status: "SUCCESSFUL",
          payment_verified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("reference", reference)
        .in("status", ["pending", "processing"])
        .select("reference,status")
        .maybeSingle();

      if (updateError) {
        console.error("Could not approve confirmed payment:", updateError);
        return json({ reference, status: "processing", message: "Paiement reçu chez FeexPay, validation interne en attente. Ne recommence pas le paiement." }, 202);
      }
      await recordEvent(reference, updated ? "PAYMENT_CONFIRMED" : "PAYMENT_ALREADY_PROCESSED", status, {});
      await triggerXbetCredit(reference);
      return json({ reference, status: "approved", message: "FeexPay confirme le paiement reçu. Crédit 1XBET en cours de traitement." });
    }

    if (status === "FAILED") {
      const { data: updated, error: updateError } = await supabase.from("dulonbet_transactions")
        .update({ status: "rejected", provider_status: status, updated_at: new Date().toISOString() })
        .eq("reference", reference)
        .in("status", ["pending", "processing"])
        .select("reference")
        .maybeSingle();
      if (updateError) return json({ reference, status: "processing", message: "Échec reçu mais mise à jour interne impossible." }, 202);
      await recordEvent(reference, updated ? "PAYMENT_FAILED" : "PAYMENT_ALREADY_PROCESSED", status, {
        provider_failure_message: providerFailureText || null,
        incompatible_wallet_hint: incompatibleWallet,
      });
      const failureMessage = incompatibleWallet
        ? "NUMÉRO INCOMPATIBLE : FeexPay n’a pas pu utiliser le portefeuille Mobile Money sélectionné avec ce numéro. Vérifie le numéro et le compte MTN MoMo, Moov Money ou Celtiis Cash choisi."
        : "FeexPay indique que le paiement a échoué. Vérifie le numéro et le portefeuille Mobile Money sélectionné avant de réessayer.";
      return json({
        reference,
        status: updated ? "rejected" : tx.status,
        message: failureMessage,
        error_code: incompatibleWallet ? "MOBILE_MONEY_NUMBER_INCOMPATIBLE" : "PAYMENT_FAILED",
      });
    }

    // PENDING / IN_PENDING_STATE / tout statut inconnu : ne jamais créditer ni clôturer.
    await supabase.from("dulonbet_transactions")
      .update({ provider_status: status, status: "processing", updated_at: new Date().toISOString() })
      .eq("reference", reference)
      .in("status", ["pending", "processing"]);
    return json({ reference, status: "processing", provider_status: status, message: "Paiement en attente chez FeexPay. Aucun crédit effectué." }, 202);
  }

  return json({ error: "Action inconnue." }, 400);
});

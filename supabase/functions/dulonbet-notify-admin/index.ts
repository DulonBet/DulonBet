import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/** PREPARATION BRANCH ONLY — not deployed. Email alerts only; no financial mutations. */
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const INTERNAL_SECRET = Deno.env.get("DULONBET_NOTIFICATION_INTERNAL_SECRET") ?? "";
const ADMIN_EMAIL = Deno.env.get("DULONBET_ADMIN_EMAIL") ?? "";
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_EVENTS = {
  deposit_requested: { subject: "DulonBet — nouveau dépôt à suivre", status: "Demande enregistrée, paiement non confirmé." },
  deposit_confirmed_feexpay: { subject: "DulonBet — paiement FeexPay confirmé", status: "Paiement confirmé par le serveur FeexPay. Le crédit 1XBET doit être vérifié séparément." },
  deposit_credited_1xbet: { subject: "DulonBet — crédit 1XBET confirmé", status: "Le crédit 1XBET a reçu une confirmation positive." },
  withdrawal_requested: { subject: "DulonBet — retrait à vérifier", status: "Demande reçue, aucun paiement Mobile Money n'est confirmé." },
  withdrawal_validated_1xbet: { subject: "DulonBet — retrait validé côté 1XBET", status: "Validation côté 1XBET uniquement. Paiement Mobile Money non confirmé." },
  withdrawal_paid_confirmed: { subject: "DulonBet — paiement de retrait confirmé", status: "Le paiement Mobile Money a été confirmé par le processus autorisé." },
  payment_attention_required: { subject: "DulonBet — vérification nécessaire", status: "État incertain ou erreur : vérification manuelle nécessaire." },
} as const;

type EventType = keyof typeof ALLOWED_EVENTS;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function ledgerRpc(name: string, payload: Record<string, unknown>) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`LEDGER_RPC_${name}_${response.status}`);
  return await response.json();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  if (!INTERNAL_SECRET || !RESEND_API_KEY || !ADMIN_EMAIL || !FROM_EMAIL || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "Service de notification non configuré." }, 503);
  }
  if (!safeEqual(req.headers.get("x-dulonbet-notification-secret") ?? "", INTERNAL_SECRET)) {
    return json({ error: "Non autorisé." }, 401);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return json({ error: "Content-Type application/json requis." }, 415);
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return json({ error: "Corps de requête trop volumineux." }, 413);
  }
  if (!req.body) return json({ error: "Corps de requête absent." }, 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      totalBytes += part.value.byteLength;
      if (totalBytes > 16_384) {
        await reader.cancel();
        return json({ error: "Corps de requête trop volumineux." }, 413);
      }
      chunks.push(part.value);
    }
  } catch {
    return json({ error: "Corps de requête illisible." }, 400);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return json({ error: "Corps JSON invalide ou encodage incorrect." }, 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "Le corps doit être un objet JSON." }, 400);
  }

  const body = parsed as Record<string, unknown>;
  // Reject wrong types and overlong values instead of silently coercing/truncating them.
  const eventId = typeof body.event_id === "string" ? body.event_id.trim() : "";
  const eventTypeValue = typeof body.event_type === "string" ? body.event_type.trim() : "";
  const eventType = eventTypeValue as EventType;
  const reference = body.reference === undefined
    ? ""
    : typeof body.reference === "string" ? body.reference.trim() : null;
  const rawAmount = body.amount_fcfa;
  const amount = typeof rawAmount === "number" ? rawAmount : NaN;

  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(eventId)) return json({ error: "Identifiant d'événement invalide." }, 400);
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_EVENTS, eventTypeValue)) return json({ error: "Type d'événement non autorisé." }, 400);
  if (reference === null || (reference !== "" && !/^[A-Za-z0-9._:-]{1,100}$/.test(reference))) {
    return json({ error: "Référence invalide." }, 400);
  }
  if (rawAmount !== undefined && (!Number.isSafeInteger(amount) || amount < 100 || amount > 2000000)) {
    return json({ error: "Montant invalide." }, 400);
  }

  // Reserve event atomically before sending. Any ledger error fails closed.
  let claim: unknown;
  try {
    claim = await ledgerRpc("claim_dulonbet_notification_event", { p_event_id: eventId, p_event_type: eventType });
  } catch {
    console.error("DULONBET_NOTIFICATION_LEDGER_CLAIM_ERROR", { eventType, eventId });
    return json({ error: "Registre de notification indisponible.", retryable: true }, 503);
  }

  const claimStatus = typeof claim === "string" ? claim : "";
  if (claimStatus === "sent") return json({ accepted: true, duplicate: true, event_id: eventId }, 200);
  if (claimStatus === "busy") return json({ error: "Événement déjà en cours de traitement.", retryable: true }, 409);
  if (claimStatus === "exhausted") return json({ error: "Limite de tentatives atteinte; vérification manuelle requise." }, 429);
  if (claimStatus === "conflict") return json({ error: "Identifiant déjà utilisé pour un autre type d'événement." }, 409);
  if (claimStatus !== "claimed") {
    console.error("DULONBET_NOTIFICATION_LEDGER_UNEXPECTED_STATUS", { eventType, eventId });
    return json({ error: "État du registre invalide.", retryable: false }, 503);
  }

  const event = ALLOWED_EVENTS[eventType];
  const lines = [
    "Notification automatique DulonBet", "", event.status,
    reference ? `Référence : ${reference}` : "",
    body.amount_fcfa !== undefined ? `Montant : ${amount.toLocaleString("fr-FR")} FCFA` : "",
    "", "Cet e-mail est une alerte opérationnelle, pas une preuve de paiement.", `Événement : ${eventId}`,
  ].filter(Boolean);

  let providerResponse: Response;
  try {
    providerResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": `dulonbet-notification/${eventId}`,
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [ADMIN_EMAIL], subject: event.subject, text: lines.join("\n") }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    await markFailed(eventId, eventType, "provider_network_error");
    console.error("DULONBET_NOTIFICATION_NETWORK_ERROR", { eventType, eventId });
    return json({ error: "Fournisseur de notification inaccessible.", retryable: true }, 502);
  }

  if (!providerResponse.ok) {
    const retryable = providerResponse.status >= 500 || providerResponse.status === 429;
    await markFailed(eventId, eventType, `provider_http_${providerResponse.status}`);
    console.error("DULONBET_NOTIFICATION_PROVIDER_ERROR", { status: providerResponse.status, eventType, eventId });
    return json({ error: "Envoi de notification échoué.", retryable }, 502);
  }

  let providerMessageId: string | null = null;
  try {
    const result = await providerResponse.json();
    if (result && typeof result.id === "string") providerMessageId = result.id.slice(0, 200);
  } catch { /* Provider accepted request; message ID is optional. */ }

  try {
    const finished = await ledgerRpc("finish_dulonbet_notification_event", {
      p_event_id: eventId, p_status: "sent", p_provider_message_id: providerMessageId, p_error_code: null,
    });
    if (finished !== true) throw new Error("LEDGER_FINISH_NOT_CONFIRMED");
  } catch {
    console.error("DULONBET_NOTIFICATION_LEDGER_FINISH_ERROR", { eventType, eventId });
    return json({ error: "Notification acceptée mais statut non confirmé dans le registre.", retryable: true }, 503);
  }

  return json({ accepted: true, event_id: eventId, provider_message_id: providerMessageId }, 202);
});

async function markFailed(eventId: string, eventType: string, errorCode: string) {
  try {
    const updated = await ledgerRpc("finish_dulonbet_notification_event", {
      p_event_id: eventId, p_status: "failed", p_provider_message_id: null, p_error_code: errorCode,
    });
    if (updated !== true) console.error("DULONBET_NOTIFICATION_LEDGER_FAILURE_NOT_CONFIRMED", { eventType, eventId });
  } catch {
    // A stuck processing event can be reclaimed after the SQL-defined lease expires.
    console.error("DULONBET_NOTIFICATION_LEDGER_FAILURE_UPDATE_ERROR", { eventType, eventId });
  }
}

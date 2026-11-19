import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * DRAFT ONLY — not deployed.
 * Internal email notification sender. It does not read or modify payment records.
 * Configure secrets only after review and DNS verification.
 */
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const INTERNAL_SECRET = Deno.env.get("DULONBET_NOTIFICATION_INTERNAL_SECRET") ?? "";
const ADMIN_EMAIL = Deno.env.get("DULONBET_ADMIN_EMAIL") ?? "";
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "";

const ALLOWED_EVENTS = {
  deposit_requested: {
    subject: "DulonBet — nouveau dépôt à suivre",
    status: "Demande enregistrée, paiement non confirmé.",
  },
  deposit_confirmed_feexpay: {
    subject: "DulonBet — paiement FeexPay confirmé",
    status: "Paiement confirmé par le serveur FeexPay. Le crédit 1XBET doit être vérifié séparément.",
  },
  deposit_credited_1xbet: {
    subject: "DulonBet — crédit 1XBET confirmé",
    status: "Le crédit 1XBET a reçu une confirmation positive.",
  },
  withdrawal_requested: {
    subject: "DulonBet — retrait à vérifier",
    status: "Demande reçue, aucun paiement Mobile Money n'est confirmé.",
  },
  withdrawal_validated_1xbet: {
    subject: "DulonBet — retrait validé côté 1XBET",
    status: "Validation côté 1XBET uniquement. Paiement Mobile Money non confirmé.",
  },
  withdrawal_paid_confirmed: {
    subject: "DulonBet — paiement de retrait confirmé",
    status: "Le paiement Mobile Money a été confirmé par le processus autorisé.",
  },
  payment_attention_required: {
    subject: "DulonBet — vérification nécessaire",
    status: "État incertain ou erreur : vérification manuelle nécessaire.",
  },
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

function clean(value: unknown, max = 120) {
  return String(value ?? "").trim().replace(/[\r\n\t]/g, " ").slice(0, max);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  // Fail closed: do not send if any required secret/configuration is missing.
  if (!INTERNAL_SECRET || !RESEND_API_KEY || !ADMIN_EMAIL || !FROM_EMAIL) {
    return json({ error: "Service de notification non configuré." }, 503);
  }

  const suppliedSecret = req.headers.get("x-dulonbet-notification-secret") ?? "";
  if (!safeEqual(suppliedSecret, INTERNAL_SECRET)) {
    return json({ error: "Non autorisé." }, 401);
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "Content-Type application/json requis." }, 415);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: "Corps JSON invalide." }, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "Le corps doit être un objet JSON." }, 400);
  }
  const body = parsed as Record<string, unknown>;

  const eventId = clean(body.event_id, 128);
  const eventType = clean(body.event_type, 64) as EventType;
  const reference = clean(body.reference, 100);
  const amount = Number(body.amount_fcfa);

  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(eventId)) {
    return json({ error: "Identifiant d'événement invalide." }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_EVENTS, eventType)) {
    return json({ error: "Type d'événement non autorisé." }, 400);
  }
  if (reference && !/^[A-Za-z0-9._:-]{1,100}$/.test(reference)) {
    return json({ error: "Référence invalide." }, 400);
  }
  if (body.amount_fcfa !== undefined && (!Number.isSafeInteger(amount) || amount < 0 || amount > 2000000)) {
    return json({ error: "Montant invalide." }, 400);
  }

  const event = ALLOWED_EVENTS[eventType];
  const lines = [
    "Notification automatique DulonBet",
    "",
    event.status,
    reference ? `Référence : ${reference}` : "",
    body.amount_fcfa !== undefined ? `Montant : ${amount.toLocaleString("fr-FR")} FCFA` : "",
    "",
    "Cet e-mail est une alerte opérationnelle, pas une preuve de paiement.",
    `Événement : ${eventId}`,
  ].filter(Boolean);

  // Resend idempotency key reduces duplicate sends on retries of the same event.
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": `dulonbet-notification/${eventId}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [ADMIN_EMAIL],
        subject: event.subject,
        text: lines.join("\n"),
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Network/timeout errors are intentionally sanitized. No financial state is changed.
    console.error("DULONBET_NOTIFICATION_NETWORK_ERROR", { eventType, eventId });
    return json({ error: "Fournisseur de notification inaccessible.", retryable: true }, 502);
  }

  if (!response.ok) {
    const providerStatus = response.status;
    // Do not return provider response bodies or secrets to callers.
    console.error("DULONBET_NOTIFICATION_PROVIDER_ERROR", { status: providerStatus, eventType, eventId });
    return json({ error: "Envoi de notification échoué.", retryable: providerStatus >= 500 || providerStatus === 429 }, 502);
  }

  let result: { id?: string } = {};
  try { result = await response.json(); } catch { /* response id is optional */ }
  return json({ accepted: true, event_id: eventId, provider_message_id: result.id ?? null }, 202);
});

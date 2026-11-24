import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const ALLOWED_ORIGINS = new Set(["https://dulonbet.com", "https://www.dulonbet.com"]);
const ALLOWED_NETWORKS = new Set(["MTN MoMo", "Moov Money", "Celtiis Cash"]);
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200, origin = "") {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (ALLOWED_ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(JSON.stringify(body), { status, headers });
}
const norm = (v: unknown) => String(v ?? "").trim();
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function samePayload(row: any, p: any, codeHash: string) {
  return row.operation_type === "Retrait" &&
    row.xbet_id === p.xbet_id &&
    Number(row.requested_amount_fcfa ?? row.amount_fcfa) === p.amount_fcfa &&
    row.phone === p.phone &&
    row.network === p.network &&
    row.country === p.country &&
    row.customer_name === p.customer_name &&
    row.withdrawal_code_hash === codeHash;
}

async function verifyTurnstile(token: string, ip: string) {
  const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
  if (ip) form.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result?.success === true &&
    ["dulonbet.com", "www.dulonbet.com"].includes(String(result?.hostname ?? "").toLowerCase());
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") {
    if (!ALLOWED_ORIGINS.has(origin)) return new Response("Forbidden origin", { status: 403 });
    return json({ ok: true }, 200, origin);
  }
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405, origin);
  if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "Origine non autorisée." }, 403, origin);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !TURNSTILE_SECRET_KEY) {
    return json({ error: "Configuration serveur incomplète." }, 503, origin);
  }
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > 12000) return json({ error: "Requête trop volumineuse." }, 413, origin);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON invalide." }, 400, origin); }

  const p = {
    xbet_id: norm(body?.xbet_id),
    withdrawal_code: norm(body?.withdrawal_code),
    amount_fcfa: Number(body?.amount_fcfa),
    phone: norm(body?.phone),
    customer_name: norm(body?.customer_name),
    network: norm(body?.network),
    country: norm(body?.country),
    idempotency_key: norm(body?.idempotency_key),
  };
  const token = norm(body?.turnstile_token);
  if (!token || token.length > 2048) return json({ error: "Vérification de sécurité requise." }, 400, origin);
  if (!/^[0-9]{1,30}$/.test(p.xbet_id)) return json({ error: "Identifiant 1XBET invalide." }, 400, origin);
  if (!p.withdrawal_code || p.withdrawal_code.length > 128 || /[\u0000-\u001f\u007f]/.test(p.withdrawal_code)) {
    return json({ error: "Code de retrait invalide." }, 400, origin);
  }
  if (!Number.isSafeInteger(p.amount_fcfa) || p.amount_fcfa < 350 || p.amount_fcfa > 2000000) {
    return json({ error: "Montant hors limites." }, 400, origin);
  }
  if (!/^01[0-9]{8}$/.test(p.phone) || p.country !== "Bénin" || !ALLOWED_NETWORKS.has(p.network)) {
    return json({ error: "Coordonnées Mobile Money invalides." }, 400, origin);
  }
  if (p.customer_name.length < 2 || p.customer_name.length > 120) {
    return json({ error: "Nom du bénéficiaire invalide." }, 400, origin);
  }
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(p.idempotency_key)) {
    return json({ error: "Clé de demande invalide." }, 400, origin);
  }

  const forwarded = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = forwarded.slice(0, 64);
  if (!(await verifyTurnstile(token, ip))) {
    return json({ error: "Vérification de sécurité échouée. Recharge le contrôle et réessaie." }, 403, origin);
  }
  const codeHash = await sha256(p.withdrawal_code);

  // Une reprise avec la même clé renvoie la transaction existante, sans en créer une seconde.
  const { data: existing, error: lookupError } = await supabase
    .from("dulonbet_transactions")
    .select("reference,status,operation_type,xbet_id,requested_amount_fcfa,amount_fcfa,phone,network,country,customer_name,withdrawal_code_hash")
    .eq("idempotency_key", p.idempotency_key)
    .maybeSingle();
  if (lookupError) return json({ error: "Impossible de vérifier la demande existante." }, 503, origin);
  if (existing) {
    if (!samePayload(existing, p, codeHash)) return json({ error: "Cette clé de demande est déjà utilisée." }, 409, origin);
    return json({
      reference: existing.reference,
      status: existing.status,
      amount_fcfa: Number(existing.requested_amount_fcfa ?? existing.amount_fcfa),
      reused: true,
      xbet_validation_performed: false,
    }, 200, origin);
  }

  // Limitation atomique existante : 8 demandes par adresse IP hachée sur 15 minutes.
  const rateKey = await sha256((ip || "ip-indisponible") + "|" + TURNSTILE_SECRET_KEY);
  const { data: allowed, error: rateError } = await supabase.rpc("dulonbet_check_payout_rate_limit", { p_key_hash: rateKey });
  if (rateError) return json({ error: "Protection anti-abus indisponible. Réessaie plus tard." }, 503, origin);
  if (allowed !== true) return json({ error: "Trop de tentatives. Réessaie dans 15 minutes." }, 429, origin);

  const reference = "DB-" + crypto.randomUUID();
  const { data: inserted, error: insertError } = await supabase
    .from("dulonbet_transactions")
    .insert({
      reference,
      operation_type: "Retrait",
      amount_fcfa: p.amount_fcfa,
      requested_amount_fcfa: p.amount_fcfa,
      network: p.network,
      country: p.country,
      xbet_id: p.xbet_id,
      phone: p.phone,
      customer_name: p.customer_name,
      withdrawal_code: p.withdrawal_code,
      withdrawal_code_hash: codeHash,
      idempotency_key: p.idempotency_key,
      status: "pending",
    })
    .select("reference,status,amount_fcfa")
    .single();

  if (insertError) {
    // Si deux requêtes identiques arrivent simultanément, récupérer la première insertion.
    const { data: retryRow } = await supabase
      .from("dulonbet_transactions")
      .select("reference,status,operation_type,xbet_id,requested_amount_fcfa,amount_fcfa,phone,network,country,customer_name,withdrawal_code_hash")
      .eq("idempotency_key", p.idempotency_key)
      .maybeSingle();
    if (retryRow && samePayload(retryRow, p, codeHash)) {
      return json({
        reference: retryRow.reference,
        status: retryRow.status,
        amount_fcfa: Number(retryRow.requested_amount_fcfa ?? retryRow.amount_fcfa),
        reused: true,
        xbet_validation_performed: false,
      }, 200, origin);
    }
    // Ne jamais révéler si un code fourni correspond à une transaction déjà enregistrée.
    return json({ error: "Demande déjà utilisée ou impossible à enregistrer. Contacte le support." }, 409, origin);
  }

  return json({
    reference: inserted.reference,
    status: inserted.status,
    amount_fcfa: Number(inserted.amount_fcfa),
    reused: false,
    xbet_validation_performed: false,
    message: "Demande enregistrée. La validation 1XBET n'a pas encore été exécutée.",
  }, 201, origin);
});

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INTERNAL_SECRET = Deno.env.get("DULONBET_FEEXPAY_INTERNAL_SECRET") ?? "";

const ALLOWED_ORIGINS = new Set([
  "https://dulonbet.com",
  "https://www.dulonbet.com",
  "https://dulonbet.vercel.app",
]);
const PREVIEW_ORIGIN = /^https:\/\/dulonbet-[a-z0-9-]+\.vercel\.app$/;

function originAllowed(origin: string) {
  return !origin || ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin);
}
function responseJson(body: unknown, status: number, origin: string) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin && originAllowed(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type");
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  if (!originAllowed(origin)) return responseJson({ error: "Origine non autorisée." }, 403, "");
  if (req.method === "OPTIONS") return new Response(null, {
    status: 204,
    headers: {
      ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin",
    },
  });
  if (req.method !== "POST") return responseJson({ error: "Méthode non autorisée." }, 405, origin);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !INTERNAL_SECRET) {
    console.error("WITHDRAWAL_PROXY_NOT_CONFIGURED");
    return responseJson({ error: "Service de retrait temporairement indisponible." }, 503, origin);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 12000) return responseJson({ error: "Demande trop volumineuse." }, 413, origin);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as Record<string, unknown>;
  } catch {
    return responseJson({ error: "Demande invalide." }, 400, origin);
  }

  const payload = {
    xbet_id: body.xbet_id,
    withdrawal_code: body.withdrawal_code,
    amount_fcfa: body.amount_fcfa,
    phone: body.phone,
    customer_name: body.customer_name,
    network: body.network,
    country: body.country,
    idempotency_key: body.idempotency_key,
  };
  const clientIp = req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    (req.headers.get("x-forwarded-for") ?? "").split(",").map(v => v.trim()).filter(Boolean).slice(-1)[0] ??
    "unknown";

  try {
    const upstream = await fetch(`${SUPABASE_URL}/functions/v1/onexbet-payout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "x-dulonbet-internal-secret": INTERNAL_SECRET,
        "x-dulonbet-client-ip": clientIp,
      },
      body: JSON.stringify(payload),
    });
    const resultText = await upstream.text();
    return new Response(resultText, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Vary": "Origin",
        ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      },
    });
  } catch {
    return responseJson({
      status: "processing",
      message: "Résultat non confirmé. Ne soumets pas une nouvelle demande; contacte le support pour vérifier le statut.",
    }, 202, origin);
  }
});

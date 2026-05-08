// AeroBroker proxy — Cloudflare Worker
// Forwards chat requests to api.anthropic.com using a server-held API key.
// Designed for a public demo: enforces per-IP and global daily request caps,
// caps max_tokens per request, restricts allowed models, and gates by Origin.
//
// Bindings expected (see wrangler.toml):
//   - secret  ANTHROPIC_API_KEY
//   - KV      RATE_LIMITS
//   - var     ALLOWED_ORIGINS               (comma-separated, or "*" for any)
//   - var     MAX_REQUESTS_PER_IP_PER_DAY   (default: 20)
//   - var     MAX_GLOBAL_REQUESTS_PER_DAY   (default: 200)
//   - var     MAX_TOKENS_PER_REQUEST        (default: 1500)
//   - var     ALLOWED_MODELS                (comma-separated)

const DEFAULTS = {
  MAX_REQUESTS_PER_IP_PER_DAY: 20,
  MAX_GLOBAL_REQUESTS_PER_DAY: 200,
  MAX_TOKENS_PER_REQUEST: 1500,
  ALLOWED_MODELS: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
};

function todayKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function corsHeaders(origin, allowed) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (allowed) h["Access-Control-Allow-Origin"] = origin || "*";
  return h;
}

function jsonResp(obj, status, origin, allowed) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, allowed) }
  });
}

function loadConfig(env) {
  const parseInt10 = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    MAX_REQUESTS_PER_IP_PER_DAY: parseInt10(env.MAX_REQUESTS_PER_IP_PER_DAY, DEFAULTS.MAX_REQUESTS_PER_IP_PER_DAY),
    MAX_GLOBAL_REQUESTS_PER_DAY: parseInt10(env.MAX_GLOBAL_REQUESTS_PER_DAY, DEFAULTS.MAX_GLOBAL_REQUESTS_PER_DAY),
    MAX_TOKENS_PER_REQUEST:      parseInt10(env.MAX_TOKENS_PER_REQUEST,      DEFAULTS.MAX_TOKENS_PER_REQUEST),
    ALLOWED_MODELS: (env.ALLOWED_MODELS || DEFAULTS.ALLOWED_MODELS.join(","))
                      .split(",").map(s => s.trim()).filter(Boolean),
    ALLOWED_ORIGINS: (env.ALLOWED_ORIGINS || "*")
                      .split(",").map(s => s.trim()).filter(Boolean)
  };
}

function isOriginAllowed(origin, allowedList) {
  if (allowedList.includes("*")) return true;
  return allowedList.includes(origin);
}

export async function handle(request, env) {
  const cfg = loadConfig(env);
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  const corsAllowed = isOriginAllowed(origin, cfg.ALLOWED_ORIGINS);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin, corsAllowed) });
  }

  if (!corsAllowed) {
    return jsonResp({ error: "Origin not allowed", origin }, 403, origin, false);
  }
  if (request.method !== "POST") {
    return jsonResp({ error: "Use POST" }, 405, origin, corsAllowed);
  }
  // Accept any path; clients commonly point at /v1/messages.
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResp({ error: "Server not configured: ANTHROPIC_API_KEY missing" }, 500, origin, corsAllowed);
  }
  if (!env.RATE_LIMITS) {
    return jsonResp({ error: "Server not configured: RATE_LIMITS KV binding missing" }, 500, origin, corsAllowed);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400, origin, corsAllowed);
  }

  const { messages, system, model, max_tokens } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResp({ error: "messages must be a non-empty array" }, 400, origin, corsAllowed);
  }
  if (messages.length > 50) {
    return jsonResp({ error: "messages array too long (max 50)" }, 400, origin, corsAllowed);
  }
  const usedModel = (typeof model === "string" && model) ? model : cfg.ALLOWED_MODELS[0];
  if (!cfg.ALLOWED_MODELS.includes(usedModel)) {
    return jsonResp({
      error: `Model not allowed: ${usedModel}. Allowed: ${cfg.ALLOWED_MODELS.join(", ")}`
    }, 400, origin, corsAllowed);
  }
  const reqMax = parseInt(max_tokens, 10);
  const usedMaxTokens = Math.min(
    Number.isFinite(reqMax) && reqMax > 0 ? reqMax : cfg.MAX_TOKENS_PER_REQUEST,
    cfg.MAX_TOKENS_PER_REQUEST
  );

  // Rate limits
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = todayKey();
  const ipKey = `rl:ip:${day}:${ip}`;
  const globalKey = `rl:global:${day}`;

  const [ipCountStr, globalCountStr] = await Promise.all([
    env.RATE_LIMITS.get(ipKey),
    env.RATE_LIMITS.get(globalKey)
  ]);
  const ipCount = parseInt(ipCountStr || "0", 10);
  const globalCount = parseInt(globalCountStr || "0", 10);

  if (globalCount >= cfg.MAX_GLOBAL_REQUESTS_PER_DAY) {
    return jsonResp({
      error: "Daily global limit reached. Try again tomorrow, or use your own API key in Settings.",
      type: "global_rate_limit",
      limit: cfg.MAX_GLOBAL_REQUESTS_PER_DAY
    }, 503, origin, corsAllowed);
  }
  if (ipCount >= cfg.MAX_REQUESTS_PER_IP_PER_DAY) {
    return jsonResp({
      error: `Per-user daily limit (${cfg.MAX_REQUESTS_PER_IP_PER_DAY}) reached. Try again tomorrow.`,
      type: "ip_rate_limit",
      limit: cfg.MAX_REQUESTS_PER_IP_PER_DAY
    }, 429, origin, corsAllowed);
  }

  // Increment counters before the upstream call (pessimistic; better to over-count than under).
  // KV is eventually consistent — exact counts can drift slightly, but this is a soft cap by design.
  await Promise.all([
    env.RATE_LIMITS.put(ipKey, String(ipCount + 1), { expirationTtl: 86400 * 2 }),
    env.RATE_LIMITS.put(globalKey, String(globalCount + 1), { expirationTtl: 86400 * 2 })
  ]);

  const anthropicBody = {
    model: usedModel,
    max_tokens: usedMaxTokens,
    messages,
    ...(typeof system === "string" && system.length > 0 ? { system } : {})
  };

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(anthropicBody)
    });
  } catch (e) {
    return jsonResp({ error: "Upstream fetch failed: " + e.message }, 502, origin, corsAllowed);
  }

  const respText = await upstream.text();
  return new Response(respText, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, corsAllowed) }
  });
}

export default {
  fetch(request, env) { return handle(request, env); }
};

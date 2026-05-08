# Deploying the AeroBroker proxy

A tiny Cloudflare Worker that holds your Anthropic API key server-side, so visitors to your GitHub Pages demo can use Live Claude mode without bringing their own key — and without your key ever being exposed in browser-readable code.

## What you get
- Your API key lives in Cloudflare's secret store, not in any committed file or page source.
- Per-IP daily request cap (default 20).
- Global daily request cap (default 200) — a hard ceiling on the worst-case daily spend.
- Per-request `max_tokens` cap and a model whitelist.
- Origin gating so only your Pages site can call the worker.

## Prerequisites
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js installed locally (you already have it if you ran the demo's verification).
- An Anthropic API key.

## One-time setup

```bash
# 1. Install wrangler (Cloudflare's CLI)
npm install -g wrangler

# 2. From this folder (containing wrangler.toml), log in
cd path/to/proxy
wrangler login

# 3. Create the KV namespace used for rate-limit counters
wrangler kv:namespace create RATE_LIMITS
# It prints something like:
#   { binding = "RATE_LIMITS", id = "abcdef0123456789..." }
# Open wrangler.toml and replace PASTE_KV_NAMESPACE_ID_HERE with that id.

# 4. Edit wrangler.toml: set ALLOWED_ORIGINS to your GitHub Pages URL.
#    Example: ALLOWED_ORIGINS = "https://kevinkelly.github.io"
#    (No trailing slash. Use the origin only — not the full path.)

# 5. Set the API key as a secret (interactive — paste when prompted)
wrangler secret put ANTHROPIC_API_KEY

# 6. Deploy
wrangler deploy
```

After deploy, wrangler prints a URL like:
```
https://aerobroker-proxy.<your-subdomain>.workers.dev
```
That's your worker URL.

## Wire the demo to use the proxy

Open `index.html` (the one you uploaded to your GitHub Pages repo) and find this line near the top of the `<script>` block:

```js
const DEFAULT_PROXY_URL = "";
```

Set it to your worker URL plus `/v1/messages`:

```js
const DEFAULT_PROXY_URL = "https://aerobroker-proxy.<your-subdomain>.workers.dev/v1/messages";
```

Commit and push the updated `index.html`. GitHub Pages will redeploy in ~30 seconds.

Visit your Pages URL, switch to **Live Claude** mode in the header — the chip will read `live · via shared proxy`. Visitors can chat without entering an API key.

## What it costs (worst case)

With the defaults (200 global requests/day × 1500 max output tokens, Sonnet at ~$15/M output tokens):
- **~$4.50/day worst case**, or ~$135/month if maxed every day.

Adjust `MAX_GLOBAL_REQUESTS_PER_DAY` and `MAX_TOKENS_PER_REQUEST` in `wrangler.toml` to your tolerance, then `wrangler deploy` again.

Cloudflare Workers free plan covers 100k requests/day and the KV operations needed here.

## Operating it

- **See logs in real time:** `wrangler tail`
- **Rotate the key:** `wrangler secret put ANTHROPIC_API_KEY` (overwrites the existing secret), then `wrangler deploy`.
- **Kill switch:** to disable Live mode for visitors immediately, set `DEFAULT_PROXY_URL = ""` in `index.html` and push, OR run `wrangler delete` to take the worker down.
- **Reset rate-limit counters:** they expire on their own after 2 days, but you can also delete keys via `wrangler kv:key list --binding=RATE_LIMITS`.
- **Watch your Anthropic bill:** the global cap is a worst-case bound, not a guarantee against bugs. Check the Anthropic console weekly.

## Security notes
- The worker rejects requests from origins not in `ALLOWED_ORIGINS`, but Origin headers can be forged by non-browser clients. The cap structure protects you against runaway spend regardless.
- KV is eventually consistent — counters can drift slightly under heavy concurrent load. For a demo this is fine; if you ever need exact accounting, switch to a Durable Object.
- The proxy is unauthenticated by design (the whole point is no-key access). If you want stronger gating later, add a per-visitor token issued by your Pages site (e.g., a captcha-backed JWT) and require it on the worker.

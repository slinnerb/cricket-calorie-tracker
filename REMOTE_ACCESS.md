# Remote access — let Eric reach the LLM over the internet

Eric is out of state and can't reach `10.0.0.54` (that address only exists on
your home LAN). We publish the Ollama endpoint at **`https://ai.wrenchandram.com`**
using your existing **Caddy** reverse proxy + your **static IP**, so Eric's app
gets a real HTTPS certificate and keeps using the same Bearer token.

## What's on the server today (10.0.0.54)
- **Ollama** on `127.0.0.1:11434`, model **`qwen2.5:7b`**.
- Caddy at `C:\Users\Garak\OllamaProxy\Caddyfile` exposes it on **:11435** over a
  self-signed cert, requiring `Authorization: Bearer <token>` and allowing only
  `/api/chat`, `/api/tags`, `/api/generate`. That same Caddy already serves a
  public Let's Encrypt site (`sign.wrenchandram.com`), so adding another public
  site is a known-good pattern.

## Steps (do these in order — the cert only issues once DNS + ports are live)

### 1. DNS
At whoever hosts `wrenchandram.com`'s DNS, add an **A record**:
```
ai   →   <your static IP>
```

### 2. Router
Forward inbound TCP **443** (and **80**, so Caddy can complete the ACME HTTP
challenge) to **`10.0.0.54`**.

### 3. Caddy — add the public site
Append this block to `C:\Users\Garak\OllamaProxy\Caddyfile` (it mirrors your
existing token + path gate, but gets a real public cert and proxies straight to
Ollama):

```caddy
# Public HTTPS for the Cricket calorie app (Eric, out of state).
ai.wrenchandram.com {
    route {
        # Use the SAME Bearer token as your existing :11435 block in this Caddyfile.
        # (Copy the exact token string from that block — don't commit it to git.)
        @noauth not header Authorization "Bearer <YOUR-BEARER-TOKEN>"
        respond @noauth "Unauthorized" 401

        # only the inference paths — admin endpoints stay blocked
        @badpath not path /api/chat /api/tags /api/generate
        respond @badpath "Forbidden" 403

        reverse_proxy 127.0.0.1:11434 {
            header_up Host localhost
            flush_interval -1
        }
    }
}
```

Reload Caddy (from the `OllamaProxy` folder):
```powershell
& .\caddy.exe reload --config .\Caddyfile
```
Caddy will fetch a Let's Encrypt certificate automatically (needs steps 1–2 done first).

### 4. Verify from off-network
From your phone on cellular (not Wi-Fi), or any outside machine:
```powershell
curl.exe https://ai.wrenchandram.com/api/tags -H "Authorization: Bearer <TOKEN>"
```
A JSON model list with a valid cert = success. A cert warning means DNS/ports
aren't fully propagated yet.

## App settings after this is live
- **Eric:** Base URL `https://ai.wrenchandram.com`, "Allow self-signed" **OFF**,
  paste the token, model `qwen2.5:7b`, click **Test connection**. (These are the
  shipped defaults except the token, which he pastes once.)
- **BJ on the LAN:** Base URL `https://10.0.0.54:11435`, "Allow self-signed" **ON**
  (internal cert), same token — lower latency on the home network.

## Hardening (recommended)
- **Keep the model warm** so Eric's first request doesn't cold-load (~100s):
  set the `OLLAMA_KEEP_ALIVE=-1` environment variable for the Ollama service and
  restart it, or ping `/api/tags` every few minutes.
- Consider Cloudflare (proxy the A record) for free rate-limiting / WAF if you
  ever see abuse — the Bearer token is the primary lock either way.
- Rotate the token if a build or note ever leaks it; it only gates the LLM.
- Don't log prompt bodies (the food text is personal). Keep Caddy access logs to
  metadata only.

## Note on latency
`qwen2.5:7b` on this busy server takes ~40–57s per estimate warm (~100s cold).
The app is built to handle this gracefully — entries save instantly and the
calorie number fills in when the estimate returns — so the wait is never blocking.

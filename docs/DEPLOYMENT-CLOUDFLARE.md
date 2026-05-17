# Cloudflare Tunnel Deployment

Use this when exposing Nerve through a private Cloudflare Tunnel, for example:

```bash
https://ai-assist.lpv.agency -> http://127.0.0.1:3080
```

## Required `.env`

```bash
HOST=0.0.0.0
PORT=3080
SSL_PORT=3443

NERVE_AUTH=true
NERVE_PASSWORD_HASH=<scrypt hash from setup>
NERVE_ALLOW_GATEWAY_TOKEN_LOGIN=false
NERVE_SESSION_SECRET=<long random secret>

NERVE_PUBLIC_ORIGIN=https://ai-assist.lpv.agency
ALLOWED_ORIGINS=https://ai-assist.lpv.agency,http://192.168.40.222:3080,https://192.168.40.222:3443
CSP_CONNECT_EXTRA=https://ai-assist.lpv.agency wss://ai-assist.lpv.agency http://192.168.40.222:3080 https://192.168.40.222:3443 ws://192.168.40.222:3080 wss://192.168.40.222:3443

GATEWAY_URL=http://127.0.0.1:18789
WS_ALLOWED_HOSTS=127.0.0.1,localhost,192.168.40.222
```

## Security Rules

- Use a dedicated login password hash for tunnel access.
- Set `NERVE_ALLOW_GATEWAY_TOKEN_LOGIN=false` before exposing the tunnel.
- Keep the OpenClaw gateway on `127.0.0.1`; expose Nerve only.
- Keep Cloudflare Access enabled if possible.
- Do not put the gateway token into browser storage.

## Mobile Safari

- Open the Cloudflare `https://` URL, not `127.0.0.1`.
- Tap the mic button for normal voice.
- Tap the live voice button for repeat voice turns.
- iOS does not allow reliable always-on wake word listening in the browser, so live voice restarts after each reply instead of running a permanent background listener.

# Serving Moni over TLS

Moni is HTTPS-only in code: `src/proxy.ts` rejects any request that did not
arrive over TLS, the session cookie is unconditionally `Secure`, and HSTS is
always sent. **No TLS terminator is deployed yet**, and that is deliberate —
see [ADR 0004](../adr/0004-the-app-is-https-only-the-terminator-is-deferred.md).

## Today: local development

```sh
npm run dev          # http://localhost:3000
```

Nothing else is needed. `localhost` is a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
so WebAuthn works there, and `src/proxy.ts` exempts loopback because nothing
crossed a wire to intercept.

**Use Chrome or Firefox.** Both accept `Secure` cookies over `http://localhost`;
Safari does not, so the session cookie will silently fail to stick and logins
will appear broken for no visible reason.

## When a second device needs access

The moment Moni must be reachable from anything other than the host machine —
a phone, a family member's laptop — a real certificate is required, because
neither `http://192.168.x.x` nor a bare LAN hostname is a secure context.

The shape is always the same, whichever option you pick:

```
browser ──TLS──▶ reverse proxy :443 ──plaintext, loopback──▶ next start :3000
```

[`Caddyfile.example`](./Caddyfile.example) has both site blocks ready to
uncomment. The options, and why each might win:

| Option | Cost | Origin stable across the move to cloud? |
|---|---|---|
| **Domain you own + Let's Encrypt (DNS-01)** | ~$10/yr, a DNS API token | **Yes.** Passkeys survive. The best end state. |
| **Tailscale node cert** | A Tailscale account, and a client on every device | No — the origin is Tailscale's. |
| **mkcert / private CA** | A private root CA installed on every device; manual trust toggle on iOS | No. Throwaway by design. |
| **ngrok** | — | No, and worse: free-tier subdomains rotate, so passkeys break on every restart, and it publishes an app holding bank credentials to the public internet. |

Whichever you choose, run Next bound to loopback so the proxy is the only
reachable listener:

```sh
npm run build
npx next start -H 127.0.0.1 -p 3000
```

The `-H 127.0.0.1` is the primary control that keeps plaintext off the wire.
`src/proxy.ts` is the backstop for when it is forgotten, or when a terminator is
misconfigured.

## Verifying, once a terminator is running

```sh
# 1. TLS terminates and HSTS is present.
curl -sI https://<host>/ | grep -i strict-transport-security
#    expect: strict-transport-security: max-age=63072000; includeSubDomains

# 2. The app is NOT reachable directly from another machine.
#    Run this from a *different* device; expect a connection refusal.
curl -sS --max-time 5 http://<host-lan-ip>:3000/

# 3. The app fails closed if something does reach it in the clear.
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: <host>' http://127.0.0.1:3000/
#    expect: 400 — the Host is not loopback, and no X-Forwarded-Proto is set

# 4. Logging in sets a Secure cookie.
curl -sI https://<host>/api/auth/login | grep -i set-cookie
```

## Database

`src/db/client.ts` refuses to start when `DATABASE_URL` points somewhere other
than loopback without `sslmode=verify-full`. The local docker-compose Postgres
is unaffected; a managed provider will need the parameter (`require` is
rejected — it encrypts without verifying the server's identity).

# The app is HTTPS-only; where TLS terminates is deferred

Moni enforces HTTPS in code — `src/proxy.ts` rejects any request that did not
arrive over TLS, the session cookie is unconditionally `Secure`, HSTS is always
sent, and a non-loopback database without `sslmode=verify-full` refuses to boot.
**No TLS terminator is deployed.** Development happens on `http://localhost`,
and the choice of certificate authority is left to issue #5, which owns hosting.

This looks like a half-finished job, so the reasoning is worth recording: the
two halves have very different lifetimes. The app-side rules are permanent and
deployment-agnostic — they will be identical on a VPS, in a container, or behind
any proxy. The certificate story is specific to wherever Moni ends up living,
which has not been decided. Building the second half now would mean building it
against a deployment we are going to replace.

## Why nothing needs a certificate yet

`http://localhost` is a secure context. WebAuthn works there, and so does
everything else that requires one. The argument that made transit encryption
urgent — that a family member on `http://192.168.x.x` cannot register a passkey,
blocking issue #7 — is real, but it only applies **once a second device is
involved.** For a single developer on the host machine it never applies, and
that is the only way Moni is used today.

## The options, recorded so #5 does not re-derive them

- **A domain we own, with Let's Encrypt via DNS-01** — the best end state, and
  the one to reach for. DNS-01 issues a publicly-trusted certificate for a host
  that need not be reachable from the internet, so it works on a LAN box today
  and unchanged in the cloud later. Its only cost is buying the domain, and its
  decisive advantage is a **stable origin**: a WebAuthn credential is bound to
  its RP ID, so an origin that never changes is one that never invalidates a
  passkey.
- **Tailscale** — a free, publicly-trusted, auto-renewed certificate with no
  domain purchase and no CA installed on any client, plus off-LAN access. Costs
  an account and a client on every device, and the origin belongs to Tailscale,
  so moving off it invalidates every passkey. Reasonable if family needs access
  well before the cloud move; overkill when the app is only being tested locally.
- **mkcert / a private CA** — one command, no third party. Requires installing a
  private root on every device that touches Moni, with a manual trust toggle on
  iOS, and a family-wide private root is a liability of its own. Throwaway.
- **ngrok** — rejected outright. Free-tier subdomains rotate, so the RP ID
  changes on every restart and passkeys break continuously; and it publishes an
  application holding live bank credentials to the public internet behind a
  guessable URL.

[`docs/deployment/Caddyfile.example`](../deployment/Caddyfile.example) holds
ready-to-uncomment site blocks for the first two.

## Consequences

- **The app must never learn which proxy is in front of it.** It reads
  `X-Forwarded-Proto` and nothing else about the transport, so choosing a
  terminator later is a deployment change, not a code change.
- **Rejection, not redirection.** A plaintext request is answered `400`. A
  redirect to https would fire only after the request — session cookie included
  — had already crossed the wire in the clear.
- **`Secure` is unconditional.** The session cookie was previously
  `secure: NODE_ENV === "production"`, which tied a security property to a build
  flag and silently downgraded any non-production deployment. Loopback `Host` is
  now the only exemption, and it describes how the request actually arrived. The
  visible cost: Safari refuses `Secure` cookies on `http://localhost`, so local
  development happens in Chrome or Firefox.
- **HSTS is `max-age=63072000; includeSubDomains`, without `preload`.**
  Preloading needs an apex domain we control and is the one genuinely
  irreversible piece; it is re-decided when a real domain arrives.
- **A loopback database stays exempt from TLS.** `sslmode=verify-full` is
  enforced at boot only when the database is not on loopback. Requiring
  certificates for the docker-compose Postgres would cost setup and reduce no
  threat; the check exists for the managed provider #5 is considering.
- **Sequencing matters for #7.** If passkeys are introduced before the hosting
  move, they are registered against a throwaway origin and everyone
  re-registers afterwards. Landing #7 *after* #5 avoids that entirely, and is
  free to do.

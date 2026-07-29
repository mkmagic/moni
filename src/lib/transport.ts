/**
 * Transit-security predicates (issue #16, threat-model §8, ADR 0004).
 *
 * Everything here is pure and deployment-agnostic: `src/proxy.ts`,
 * `next.config.ts` and `src/db/client.ts` are thin wrappers over these, so the
 * rules are testable without a server and stay true when the reverse proxy in
 * front changes.
 */

/** HSTS: two years, subdomains included, deliberately no `preload` (ADR 0004). */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Strips the port from a `Host`-style value, tolerating bare IPv6 literals. */
function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  // More than one colon means an unbracketed IPv6 literal, not host:port.
  return host.split(":").length > 2 ? host : host.split(":")[0];
}

/**
 * Whether a `Host` header names the loopback interface.
 *
 * This — not `NODE_ENV` — is what exempts `npm run dev` from the HTTPS
 * requirement. A build flag says nothing about how a request actually
 * arrived; the previous `secure: NODE_ENV === "production"` cookie was exactly
 * that mistake, and it silently downgraded any non-production deployment.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(host).toLowerCase());
}

/**
 * Fail-closed transport check. Any deployment terminates TLS at a reverse
 * proxy and forwards to Next over loopback, so the app's own socket is always
 * plaintext — `x-forwarded-proto` is the only header carrying the truth about
 * the browser-facing hop.
 *
 * A missing or non-`https` value is a rejection, never a maybe. The only
 * exemption is a request that arrived on loopback, where nothing crossed a
 * wire to intercept.
 */
export function isTransportAcceptable(
  host: string | null | undefined,
  forwardedProto: string | null | undefined,
): boolean {
  if (isLoopbackHost(host)) return true;
  if (!forwardedProto) return false;
  // Chained proxies append; the client-facing hop is the first value.
  return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
}

/**
 * Refuses to boot when the app→Postgres hop would cross a network in the
 * clear (principles §19, threat-model §8). A loopback database is exempt —
 * that traffic never leaves the box, and requiring certificates for the
 * docker-compose Postgres would buy nothing.
 *
 * `verify-full` specifically, not `require`: `require` encrypts but skips
 * identity verification, so it stops passive sniffing and not an active MITM.
 *
 * Never include the connection string in the error — it carries the password.
 */
export function assertDatabaseTls(connectionString: string | undefined): void {
  // An absent URL is the pool's failure to report, not this check's.
  if (!connectionString) return;

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return; // Malformed URLs are likewise the driver's to reject, with its own message.
  }

  if (isLoopbackHost(url.hostname)) return;
  if (url.searchParams.get("sslmode") === "verify-full") return;

  throw new Error(
    `Refusing to start: the database at ${url.hostname} is not on loopback, so ` +
      "its connection string must set sslmode=verify-full (see .env.example and " +
      "docs/security/security-design-principles.md §19). `require` is not " +
      "sufficient — it encrypts without verifying the server's identity.",
  );
}

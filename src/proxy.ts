import { NextResponse, type NextRequest } from "next/server";
import { isTransportAcceptable } from "@/lib/transport";

/**
 * HTTPS-only gate (issue #16, threat-model §8). Any real deployment terminates
 * TLS at a reverse proxy and forwards to Next on loopback; the loopback bind is
 * the primary control, and this is the second one — it catches a misconfigured
 * terminator that exposes the app directly, which is the plausible failure once
 * #5 moves the deployment off a single box.
 *
 * ("Proxy" is Next 16's name for the old `middleware` file convention, not a
 * reference to the reverse proxy in front — this runs inside the app.)
 *
 * Local development needs none of that: requests arrive on loopback, which is
 * exempt below and which browsers already treat as a secure context.
 *
 * It rejects rather than redirecting to https. A redirect fires only after the
 * request has already crossed the wire in the clear, session cookie included;
 * upgrading it afterwards protects nothing that was not already exposed.
 */
export function proxy(req: NextRequest): NextResponse {
  const acceptable = isTransportAcceptable(
    req.headers.get("host"),
    req.headers.get("x-forwarded-proto"),
  );
  if (!acceptable) {
    return new NextResponse("Moni is HTTPS-only.\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.next();
}

export const config = {
  // Everything the user's browser requests, minus Next's own build output.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

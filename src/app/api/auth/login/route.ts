import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, SESSION_COOKIE, SESSION_COOKIE_ATTRS } from "@/domain/auth";
import { SESSION_TTL_SECONDS } from "@/lib/auth/session-store";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export async function POST(req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // The password arrives as a JS string (immutable, unwipeable) at the HTTP/
  // JSON boundary — an unavoidable residual, bounded by the short-lived
  // request (threat-model §5.5, cf. the israeli-bank-scrapers string caveat).
  // Move it into a wipeable Buffer at once and wipe after use.
  const password = Buffer.from(parsed.data.password, "utf8");
  try {
    const sessionId = await authenticate(parsed.data.email, password);
    if (!sessionId) {
      return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, sessionId, {
      ...SESSION_COOKIE_ATTRS,
      maxAge: SESSION_TTL_SECONDS,
    });
    return res;
  } finally {
    password.fill(0);
  }
}

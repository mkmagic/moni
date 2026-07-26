// Registration route (task 16). Calls the existing createUser() to mint key
// custody, then hands the returned dataKey STRAIGHT to createSession() for
// auto-login — no second Argon2id derivation (docs plan §A2). Gated by
// MONI_SIGNUP_TOKEN, enforced inside createUser() itself; this route just
// forwards the token from the request body.
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createUser,
  EmailAlreadyExistsError,
  InvalidSignupTokenError,
} from "@/domain/registration";
import { SESSION_COOKIE } from "@/domain/auth";
import { createSession } from "@/lib/auth/session-store";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const SignupSchema = z.object({
  email: z.email(),
  password: z.string().min(8, "Use at least 8 characters"),
  signupToken: z.string().min(1),
});

export async function POST(req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // The password arrives as a JS string (immutable, unwipeable) at the HTTP/
  // JSON boundary — an unavoidable residual, bounded by the short-lived
  // request (threat-model §5.5, same as the login route). Move it into a
  // wipeable Buffer at once and wipe after use.
  const password = Buffer.from(parsed.data.password, "utf8");
  try {
    const { userId, dataKey } = await createUser(
      parsed.data.email,
      password,
      parsed.data.signupToken,
    );
    // Auto-login: dataKey goes straight into the session, no re-derivation.
    const sessionId = createSession(userId, dataKey, "ILS");
    const res = NextResponse.json({ ok: true }, { status: 201 });
    res.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    return res;
  } catch (err) {
    if (err instanceof InvalidSignupTokenError) {
      return NextResponse.json({ error: "invalid signup token" }, { status: 403 });
    }
    if (err instanceof EmailAlreadyExistsError) {
      return NextResponse.json({ error: "email already registered" }, { status: 409 });
    }
    throw err;
  } finally {
    password.fill(0);
  }
}

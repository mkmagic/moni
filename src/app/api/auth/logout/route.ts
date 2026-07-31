import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_COOKIE_ATTRS, endSession } from "@/domain/auth";

// Reads the session id off the request's own cookie jar rather than
// `next/headers`' `cookies()`. Both work in production; only this one is
// callable from a test, because `cookies()` throws outside a live request
// scope — which is why the cookie-attribute contract this route is half of
// had no test until now (tests/db/session-cookie.test.ts). Same shape as
// /api/account, the other route that clears this cookie.
//
// Note it takes the RAW cookie value and does not resolve it to a live
// session first: `endSession()` must still run for an EXPIRED id, so the
// credential window and any half-finished passkey ceremony keyed to it get
// cleared too. Looking the session up would return null for exactly that
// case and silently skip both.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const id = req.cookies.get(SESSION_COOKIE)?.value;
  if (id) endSession(id); // wipes the data key from RAM

  const res = NextResponse.json({ ok: true });
  // Attributes must match the ones the cookie was set with, or the browser
  // treats this as a different cookie and the original survives — hence the
  // shared `SESSION_COOKIE_ATTRS` rather than a copy.
  res.cookies.set(SESSION_COOKIE, "", { ...SESSION_COOKIE_ATTRS, maxAge: 0 });
  return res;
}

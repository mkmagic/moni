// Account deletion (issue #31). Separate from /api/profile on purpose: that
// route edits the `users` row, this one destroys it and everything hanging
// off it, and the two should not share a handler file.
//
// A live session is necessary but NOT sufficient — the request must also
// carry the login password, re-verified server-side. The session cookie
// alone would make this reachable by anything that gets one (a borrowed
// browser, a CSRF-shaped bug), and there is no undo for it. The domain layer
// owns that check (src/domain/account-deletion.ts) so it cannot be skipped
// by a future second caller.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest, SESSION_COOKIE, SESSION_COOKIE_ATTRS } from "@/domain/auth";
import { deleteAccount } from "@/domain/account-deletion";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const DeleteSchema = z.object({
  password: z.string().min(1),
});

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // The password arrives as a JS string (immutable, unwipeable) at the HTTP/
  // JSON boundary — an unavoidable residual, bounded by the short-lived
  // request (threat-model §5.5). Move it into a wipeable Buffer at once and
  // wipe after use, exactly as the login route does.
  const password = Buffer.from(parsed.data.password, "utf8");
  try {
    const result = await deleteAccount(session.userId, password);
    if (result === "invalid-password") {
      return NextResponse.json({ error: "invalid password" }, { status: 401 });
    }
  } finally {
    password.fill(0);
  }

  // `deleteAccount()` already ended every RAM session for this user. Clear
  // the cookie too, with the same attributes it was set with — otherwise the
  // browser keeps a cookie pointing at a session that no longer exists.
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...SESSION_COOKIE_ATTRS, maxAge: 0 });
  return res;
}

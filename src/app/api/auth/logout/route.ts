import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, endSession } from "@/domain/auth";

export async function POST(): Promise<NextResponse> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) endSession(id); // wipes the data key from RAM

  const res = NextResponse.json({ ok: true });
  // Attributes must match the ones the cookie was set with, or the browser
  // treats this as a different cookie and the original survives.
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  });
  return res;
}

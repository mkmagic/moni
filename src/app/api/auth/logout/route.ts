import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, endSession } from "@/domain/auth";

export async function POST(): Promise<NextResponse> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) endSession(id); // wipes the data key from RAM

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

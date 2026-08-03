// The user's own display name and sync preference. No key material is
// involved — `users` carries no ciphertext columns — so unlike the connection
// routes this one never asks for a password.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { getProfile, updateProfile } from "@/domain/profile";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const PatchSchema = z
  .object({
    displayName: z.string().max(80).nullable().optional(),
    autoSyncOnLogin: z.boolean().optional(),
    smartCategorize: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfile(session.userId);
  if (!profile) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(profile);
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  await updateProfile(session.userId, parsed.data);
  return NextResponse.json({ ok: true });
}

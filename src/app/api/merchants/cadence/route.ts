// PATCH /api/merchants/cadence — the user correcting what the dates imply.
//
// Keyed by match text, not by merchant id: the recurring view groups payees
// derived from entry descriptions, so a row can exist before any `merchants`
// row backs it. The domain layer creates one on demand.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { setMerchantCadence } from "@/domain/merchants";

const BodySchema = z.object({
  matchText: z.string().min(1).max(400),
  // `null` clears the override and hands the answer back to the dates.
  // "unknown" and "irregular" are outcomes of derivation, never choices.
  cadence: z.enum(["monthly", "bi-monthly", "quarterly", "yearly"]).nullable(),
});

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  await setMerchantCadence(session, parsed.data.matchText, parsed.data.cadence);
  return NextResponse.json({ ok: true });
}

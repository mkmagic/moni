// Configure one shared category (issue #115) — a single PATCH discriminated by
// `op`, since all four edits target the same resource and the /household view
// makes them side by side:
//   split   — set the per-member weights (must sum to exactly 1)
//   ceiling — set the group-owned household ceiling (encrypted under the group
//             key, so this op needs the caller's live DK)
//   map     — fold one of the caller's own local categories into this line
//   unmap   — remove one of the caller's local categories
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import {
  SharedCategoryError,
  mapLocalCategory,
  setHouseholdCeiling,
  setSplit,
  unmapLocalCategory,
} from "@/domain/shared-categories";
import { SharedCategoryPatchSchema } from "../../schema";

const ParamsSchema = z.object({ id: z.uuid() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = ParamsSchema.safeParse(await params);
  if (!p.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const parsed = SharedCategoryPatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const sharedCategoryId = p.data.id;
  const { userId, dataKey } = session;
  const data = parsed.data;

  try {
    switch (data.op) {
      case "split":
        await setSplit(userId, data.householdId, sharedCategoryId, data.weights);
        break;
      case "ceiling":
        await setHouseholdCeiling(
          userId,
          dataKey,
          data.householdId,
          sharedCategoryId,
          data.amount,
          data.effectiveFrom,
          data.rollover,
        );
        break;
      case "map":
        await mapLocalCategory(userId, data.householdId, sharedCategoryId, data.localCategoryId);
        break;
      case "unmap":
        await unmapLocalCategory(userId, data.householdId, sharedCategoryId, data.localCategoryId);
        break;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SharedCategoryError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

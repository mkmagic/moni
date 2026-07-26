// Status-polling endpoint for the sync UI (task 15). Also where the lazy
// orphaned-run self-heal (task 19) actually runs — see getSyncRun's own
// doc comment in src/domain/sync-promotion.ts.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { getSyncRun } from "@/domain/sync-promotion";

const ParamsSchema = z.object({ id: z.uuid() });

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const run = await getSyncRun(session.userId, parsedParams.data.id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(run);
}

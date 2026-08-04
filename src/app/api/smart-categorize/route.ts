// Smart Categorization trigger route.
//
// Sends unrecognized merchant match texts to an LLM in batches and writes
// cached responses to `merchant_lookups`. Suggestions derived from the cache
// render as chips; nothing is written to `entries.category_id` automatically.

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import {
  enrichUnknownMerchants,
  LlmNotConfiguredError,
  SmartCategorizeDisabledError,
} from "@/domain/categorization";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await enrichUnknownMerchants(session);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SmartCategorizeDisabledError) {
      return NextResponse.json(
        { error: "Smart categorization is disabled in settings" },
        { status: 400 },
      );
    }
    if (err instanceof LlmNotConfiguredError) {
      return NextResponse.json(
        { error: "No API key configured for smart categorization" },
        { status: 400 },
      );
    }
    throw err;
  }
}

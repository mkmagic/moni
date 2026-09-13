import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest } from "@/domain/auth";
import { OpeningLotImportError, previewOpeningLotImport } from "@/domain/investment-opening-lots";
import { OpeningLotCsvError, parseOpeningLotsCsv } from "@/lib/investments/opening-lots-csv";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "Choose a CSV file." }, { status: 400 });
  if (file.size > 10 * 1024 * 1024)
    return NextResponse.json({ error: "The CSV must be 10 MB or smaller." }, { status: 413 });
  try {
    const rows = parseOpeningLotsCsv(Buffer.from(await file.arrayBuffer()));
    const preview = await previewOpeningLotImport({
      userId: session.userId,
      dataKey: session.dataKey,
      rows,
    });
    return NextResponse.json({ preview, rows });
  } catch (error) {
    if (error instanceof OpeningLotCsvError)
      return NextResponse.json(
        {
          error:
            error.code === "invalid_header"
              ? "The header does not match Moni's opening-lot template."
              : error.row
                ? `Row ${error.row} has missing or invalid values.`
                : "The CSV could not be read.",
          row: error.row ?? null,
        },
        { status: 400 },
      );
    if (error instanceof OpeningLotImportError)
      return NextResponse.json({ error: error.code.replaceAll("_", " ") }, { status: 400 });
    throw error;
  }
}

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

// Deployment health probe (deploy/release.sh). `/` only 307s to /dashboard
// without touching the database, so a release with a dead DB connection or an
// un-migrated schema would still look healthy. This ping proves the app can
// reach Postgres AND that migrations have run: `to_regclass` returns NULL for
// a missing table (no error, no rows scanned, so no RLS concern), so a
// non-null result means the pool connected as moni_app and the schema exists.
// Route Handlers aren't cached by default and a DB query defers to request
// time, so this runs live on every call.
export async function GET(): Promise<NextResponse> {
  try {
    const res = await db.execute(sql`select to_regclass('public.users') is not null as ok`);
    const ok = (res.rows[0] as { ok: boolean } | undefined)?.ok === true;
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "schema missing" }, { status: 503 });
  } catch {
    return NextResponse.json({ ok: false, error: "db unreachable" }, { status: 503 });
  }
}

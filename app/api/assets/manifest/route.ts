/* GET /api/assets/manifest — which visual assets are overridden (public).

   The engine fetches this at boot (fail-open) to decide whether to load
   bundled art or a DB-backed override. No payloads here — just keys, meta,
   and updated stamps (used as cache-busters). */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getAssetManifest } from "@/lib/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    // degraded: we couldn't KNOW — clients must keep whatever art they have
    // (a bare [] here reverted the whole reskin mid-game; review catch)
    if (!db) return NextResponse.json({ assets: [], degraded: true });
    const manifest = await getAssetManifest(db);
    return NextResponse.json(
      { assets: manifest },
      { headers: { "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch {
    return NextResponse.json({ assets: [], degraded: true }); // couldn't know — clients keep current art
  }
}

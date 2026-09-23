/* GET /api/config — the PUBLIC game-tuning subset (bonus + gore cosmetics).

   Used by the engine for unranked (no-account) play so free games feel the
   same as ranked ones. Ranked runs get an authoritative snapshot from
   /api/run/start instead. Item-drop odds and other server-only knobs are NOT
   exposed here. Falls back to code defaults when the DB isn't configured. */

import { NextResponse } from "next/server";
import { getDb, isDbConfigured } from "@/lib/db";
import { getGameConfig, publicConfig, DEFAULT_CONFIG } from "@/lib/gameConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isDbConfigured()) return NextResponse.json(publicConfig(DEFAULT_CONFIG));
  try {
    const cfg = await getGameConfig(getDb()!);
    return NextResponse.json(publicConfig(cfg));
  } catch {
    return NextResponse.json(publicConfig(DEFAULT_CONFIG));
  }
}

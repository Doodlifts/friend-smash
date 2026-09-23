/* /api/admin/config — read + edit the game-tuning config (admin-gated).

   GET  -> { config }            (current live config, defaults if unset)
   PUT  -> body { config } → sanitized into hard bounds, stored, returned.

   Replay safety: ranked runs snapshot the config at run start, so edits here
   only affect NEW runs — a mid-flight run still verifies against the values
   it was played with. */

import { NextResponse } from "next/server";
import { adminContext } from "@/lib/admin";
import { getGameConfig, setGameConfig } from "@/lib/gameConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ config: await getGameConfig(ctx.db) });
}

export async function PUT(req: Request) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await req.json().catch(() => null)) as { config?: unknown } | null;
  if (!body || typeof body.config !== "object" || body.config === null) {
    return NextResponse.json({ error: "Missing config object." }, { status: 400 });
  }
  const stored = await setGameConfig(ctx.db, body.config);
  return NextResponse.json({ config: stored });
}

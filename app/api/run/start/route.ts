/* POST /api/run/start — open a server-sanctioned run.

   Auth required. The server (not the client) picks the RNG seed and returns a
   signed run token binding {runId, userId, seed, issuedAt}. The client plays the
   deterministic game from this seed and submits its run to /api/run/finish. */

import { NextResponse } from "next/server";
import { randomInt } from "crypto";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { isSigningConfigured, signRunToken } from "@/lib/runToken";
import { createRun, reapExpiredRuns } from "@/lib/runs";
import { isRunStartLimited, isIpRunStartLimited, MAX_RUN_AGE_MS } from "@/lib/rateLimit";
import { clientIp } from "@/lib/clientIp";
import { getGameConfig, publicConfig } from "@/lib/gameConfig";
import { BONUS_ALGO_V } from "@/lib/bonus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;

  if (!isSigningConfigured()) {
    return NextResponse.json(
      { configured: false, error: "Run signing not configured." },
      { status: 503 },
    );
  }

  // Rate limit: cap how many runs a user (and IP) can open per minute.
  const ip = clientIp(req);
  if ((await isRunStartLimited(ctx.db, ctx.user.id)) || (await isIpRunStartLimited(ctx.db, ip))) {
    return NextResponse.json(
      { error: "Slow down — too many runs. Try again in a moment." },
      { status: 429 },
    );
  }

  // Housekeeping: close out this user's EXPIRED open runs (older than the
  // token max-age — unfinishable by definition). Recent opens are left alone;
  // a second tab may legitimately hold a prefetched run.
  await reapExpiredRuns(ctx.db, ctx.user.id, MAX_RUN_AGE_MS);

  // Server-chosen, unpredictable seed (crypto, not Math.random).
  const seed = randomInt(0, 0x100000000);
  // Snapshot the live game config onto the run — the replay verifies against
  // THIS snapshot, so tuning edits never break in-flight runs.
  const config = await getGameConfig(ctx.db);
  // DEPLOY-SKEW GUARD: pin the snapshot's bonus algorithm version to what the
  // CLIENT's bundle can actually play (a stale pre-deploy tab sends no body →
  // v1). Both algorithms are fair, deterministic, and server-seeded, so
  // letting a client pin the OLDER geometry gives no scoring edge — v1 sword
  // rounds can only whiff (≤ v2 on average).
  const body = (await req.json().catch(() => null)) as { bonusV?: number } | null;
  const rawV = body && typeof body.bonusV === "number" && Number.isFinite(body.bonusV) ? Math.trunc(body.bonusV) : 1;
  config.bonus.v = Math.min(config.bonus.v ?? BONUS_ALGO_V, Math.max(1, Math.min(BONUS_ALGO_V, rawV)));
  const run = await createRun(ctx.db, ctx.user.id, seed, ip, config);
  const runToken = signRunToken({
    runId: run.id,
    userId: ctx.user.id,
    seed,
    issuedAt: Date.now(),
  });

  // The client plays with the same snapshot (bonus tuning + cosmetics).
  return NextResponse.json({ runId: run.id, seed, runToken, config: publicConfig(config) });
}

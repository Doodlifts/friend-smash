/* POST /api/admin/ops — admin on-chain operations.

   This build's RF economy is SIMULATED (lib/rf/ledger.ts). There are no keys,
   no contracts and nothing to execute; lib/rf/settlement.ts documents exactly
   which calls each ledger movement becomes once a reviewed pool contract
   exists. The endpoint stays so the admin panel renders an honest status. */

import { NextResponse } from "next/server";
import { adminContext } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({
    ok: false,
    status: "not_configured",
    message: "Simulated RF economy — no on-chain operations exist. See lib/rf/settlement.ts for the planned mapping.",
  });
}

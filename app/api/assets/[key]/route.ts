/* /api/assets/[key] — serve / replace / revert one visual-asset override.

   GET    public — the override's binary (game art is public in the bundle
          anyway); cached, cache-busted by ?v=updatedAt from the manifest.
   PUT    admin  — JSON {mime, b64, meta:{dx,dy,fw,fh}}; validated + upserted.
   DELETE admin  — remove the override (the bundled asset takes over again). */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { adminContext } from "@/lib/admin";
import { getAsset, putAsset, deleteAsset, ASSET_KEYS } from "@/lib/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { key: string } }) {
  const key = params.key;
  if (!ASSET_KEYS.includes(key)) return NextResponse.json({ error: "Unknown asset." }, { status: 404 });
  const db = getDb();
  if (!db) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  let row: Awaited<ReturnType<typeof getAsset>> = null;
  try {
    row = await getAsset(db, key);
  } catch {
    row = null; // table missing pre-migration → behave like "no override"
  }
  if (!row) return NextResponse.json({ error: "No override for this asset." }, { status: 404 });
  const buf = Buffer.from(row.data, "base64");
  const headers: Record<string, string> = {
    "Content-Type": row.mime,
    "Content-Length": String(buf.length),
    "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${row.updatedAt ? new Date(row.updatedAt).getTime() : 0}"`,
  };
  // SVGs render fine in <img>/canvas under this CSP, but a direct navigation
  // to the URL can never execute anything (uploads are also script-scanned).
  if (row.mime === "image/svg+xml") {
    headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";
  }
  return new NextResponse(buf, { headers });
}

export async function PUT(req: Request, { params }: { params: { key: string } }) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await req.json().catch(() => null)) as { mime?: string; b64?: string; meta?: unknown } | null;
  if (!body || !body.mime || !body.b64) {
    return NextResponse.json({ error: "Missing mime or payload." }, { status: 400 });
  }
  const res = await putAsset(ctx.db, { key: params.key, mime: body.mime, b64: body.b64, meta: body.meta });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}

export async function DELETE(req: Request, { params }: { params: { key: string } }) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;
  const ok = await deleteAsset(ctx.db, params.key);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}

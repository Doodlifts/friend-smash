/* ============================================================
   lib/assets.ts — DB-backed visual-asset overrides (admin ASSETS panel).

   Piece art is generated from on-chain Friend portraits (lib/rf/pieceArt.ts). A row in `assets`
   OVERRIDES the bundled version at runtime: the engine fetches the manifest
   at boot (fail-open — no DB, no override, game still works offline) and
   loads overridden images from /api/assets/[key].

   Keys are ALLOWLISTED (14 piece sprites + the logo). Piece uploads must
   follow the art convention (CLAUDE.md): the piece BODY must fill exactly
   cols*96 × rows*96 px at offset (dx,dy) inside the image — the admin panel
   renders a footprint-grid preview so alignment is verified before saving.

   Videos (intro + bonus) are NOT uploadable here: Vercel caps request bodies
   (~4.5MB) below their size. They're listed read-only in the panel with
   their specs; hooking up blob storage is the documented upgrade path.
   ============================================================ */

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { assets } from "@/db/schema";

/** Piece body footprints in grid cells (mirrors the engine's GRIDS). */
export const PIECE_GRIDS: Record<string, [number, number]> = {
  I: [4, 1], J: [3, 2], L: [3, 2], O: [2, 2], S: [3, 2], T: [3, 2], Z: [3, 2],
};
export const ART_CELL = 96; // art-space px per grid cell

const PIECES = Object.keys(PIECE_GRIDS);
/** Bonus-round sprites: swap the code-drawn vectors for uploaded art. The
 *  engine keeps all the MOTION (scurry, aim, flight, sweep) — the sprite just
 *  replaces the drawing. No override = the hand-drawn canvas look. */
export const BONUS_SPRITE_KEYS = ["bonus_rat", "bonus_banana", "bonus_arrow", "bonus_sword"] as const;
/** Effect sprites outside the bonus rounds — same plain-sprite upload path
 *  (no footprint metadata): the bone bobs on the guts meter AND tumbles out
 *  of the row-clear gore burst, so one upload re-skins both. */
export const DECOR_SPRITE_KEYS = ["guts_bone"] as const;
/** Every uploadable asset key. */
export const ASSET_KEYS: readonly string[] = [
  ...PIECES.flatMap((t) => [`${t}_clean`, `${t}_blood`]),
  "logo",
  ...BONUS_SPRITE_KEYS,
  ...DECOR_SPRITE_KEYS,
];

/** SVG is welcome (sharpest at any DPI) — served with a script-neutralizing
 *  CSP and rejected outright if it embeds <script>/event handlers. */
export const ALLOWED_MIME = ["image/webp", "image/png", "image/svg+xml"] as const;
/** Sprites are tens of KB — this cap keeps uploads far below Vercel's body limit. */
export const MAX_ASSET_BYTES = 1_500_000;

export interface AssetMeta {
  dx: number;
  dy: number;
  fw: number;
  fh: number;
}

export interface AssetSpec {
  key: string;
  kind: "piece" | "logo" | "bonus";
  /** Required body footprint in px (pieces only). */
  bodyW?: number;
  bodyH?: number;
  /** Human requirements line shown in the panel. */
  requirements: string;
}

const SPRITE_SPECS: Record<string, string> = {
  bonus_rat: "faces RIGHT · ~256×140px recommended · rendered ~1.3 cells long (tail included in your art)",
  bonus_banana: "faces RIGHT (muzzle = right tip) · ~360×220px recommended · rendered ~2.7 cells long",
  bonus_arrow: "points RIGHT · ~200×48px recommended · rendered ~1.3 cells long",
  bonus_sword: "blade TIP UP, hilt at bottom · ~140×320px recommended · rendered ~3.5 cells tall",
  guts_bone: "drawn HORIZONTAL · ~200×80px recommended · rendered ~half a cell long; replaces every BONE (goo floaters + gore tumble) — the bundled guts pieces beside them have no override slot",
};

export function assetSpec(key: string): AssetSpec | null {
  if (key === "logo") {
    return {
      key,
      kind: "logo",
      requirements: "SVG/WebP/PNG, transparent background, ≥520px wide (rendered ~110px tall), ≤1.5MB",
    };
  }
  // kind "bonus" = the generic plain-sprite path (no footprint metadata);
  // decor sprites like the guts bone ride it too.
  if ((BONUS_SPRITE_KEYS as readonly string[]).includes(key) || (DECOR_SPRITE_KEYS as readonly string[]).includes(key)) {
    return {
      key,
      kind: "bonus",
      requirements: `SVG/WebP/PNG, transparent bg · ${SPRITE_SPECS[key]} · SVG root needs explicit width+height · ≤1.5MB`,
    };
  }
  const t = key.split("_")[0];
  const grid = PIECE_GRIDS[t];
  if (!grid || !ASSET_KEYS.includes(key)) return null;
  const bodyW = grid[0] * ART_CELL;
  const bodyH = grid[1] * ART_CELL;
  return {
    key,
    kind: "piece",
    bodyW,
    bodyH,
    requirements: `SVG/WebP/PNG, transparent bg. Piece BODY must fill exactly ${bodyW}×${bodyH}px at (dx,dy). Overhang up, never down. ≤1.5MB`,
  };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function sanitizeMeta(raw: unknown): AssetMeta | null {
  const m = raw as Partial<AssetMeta> | null;
  if (!m || !isInt(m.fw) || !isInt(m.fh) || !isInt(m.dx) || !isInt(m.dy)) return null;
  if (m.fw < 8 || m.fw > 4096 || m.fh < 8 || m.fh > 4096) return null;
  if (Math.abs(m.dx) > 4096 || Math.abs(m.dy) > 4096) return null;
  return { dx: m.dx, dy: m.dy, fw: m.fw, fh: m.fh };
}

export interface AssetManifestEntry {
  key: string;
  mime: string;
  meta: AssetMeta | null;
  updatedAt: string;
}

/** Every override currently in force (no payloads — the engine's boot fetch). */
export async function getAssetManifest(db: DrizzleDb): Promise<AssetManifestEntry[]> {
  const rows = await db
    .select({ key: assets.key, mime: assets.mime, meta: assets.meta, updatedAt: assets.updatedAt })
    .from(assets);
  return rows.map((r) => ({
    key: r.key,
    mime: r.mime,
    meta: sanitizeMeta(r.meta),
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : "",
  }));
}

export async function getAsset(db: DrizzleDb, key: string) {
  if (!ASSET_KEYS.includes(key)) return null;
  const [row] = await db.select().from(assets).where(eq(assets.key, key)).limit(1);
  return row ?? null;
}

export interface PutAssetResult {
  ok: boolean;
  error?: string;
}

/** Validate + upsert an override. b64 is the raw base64 payload (no data: prefix). */
export async function putAsset(
  db: DrizzleDb,
  params: { key: string; mime: string; b64: string; meta: unknown },
): Promise<PutAssetResult> {
  const { key, mime, b64 } = params;
  if (!ASSET_KEYS.includes(key)) return { ok: false, error: "Unknown asset key." };
  if (!(ALLOWED_MIME as readonly string[]).includes(mime)) {
    return { ok: false, error: "Only WebP or PNG uploads are supported." };
  }
  if (typeof b64 !== "string" || !b64.length || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    return { ok: false, error: "Bad payload encoding." };
  }
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > MAX_ASSET_BYTES) {
    return { ok: false, error: `Too large (${Math.round(bytes / 1024)}KB — cap is ${Math.round(MAX_ASSET_BYTES / 1024)}KB).` };
  }
  // SVG safety: even though only admins upload and <img>/canvas rendering
  // never runs scripts, the file is served from our origin — reject anything
  // with executable content outright (the serving route also sends a
  // script-neutralizing CSP as a second layer).
  if (mime === "image/svg+xml") {
    let text = "";
    try {
      text = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return { ok: false, error: "Bad SVG payload." };
    }
    const head = text.slice(0, 500).trimStart().toLowerCase();
    if (!head.startsWith("<svg") && !head.startsWith("<?xml")) {
      return { ok: false, error: "That file doesn't look like an SVG." };
    }
    if (/<script|javascript:|\son\w+\s*=|<foreignobject/i.test(text)) {
      return { ok: false, error: "SVG contains scripts/handlers — export a plain graphic (no interactivity)." };
    }
    if (!/<svg[^>]*\swidth\s*=/i.test(text) || !/<svg[^>]*\sheight\s*=/i.test(text)) {
      return { ok: false, error: "SVG root needs explicit width and height attributes (not just a viewBox)." };
    }
  }
  const meta = sanitizeMeta(params.meta);
  if (!meta) return { ok: false, error: "Missing/invalid dx, dy, fw, fh metadata." };
  // pieces: the declared body must fit inside the image on the horizontal
  // axis and never overhang DOWNWARD past it (art convention)
  const spec = assetSpec(key);
  if (spec?.kind === "piece" && spec.bodyW && spec.bodyH) {
    if (meta.dy + spec.bodyH > meta.fh) {
      return { ok: false, error: "Body footprint overhangs the bottom of the image (overhang up, never down)." };
    }
  }
  await db
    .insert(assets)
    .values({ key, mime, data: b64, meta, updatedAt: new Date() })
    .onConflictDoUpdate({ target: assets.key, set: { mime, data: b64, meta, updatedAt: new Date() } });
  return { ok: true };
}

export async function deleteAsset(db: DrizzleDb, key: string): Promise<boolean> {
  if (!ASSET_KEYS.includes(key)) return false;
  await db.delete(assets).where(eq(assets.key, key));
  return true;
}

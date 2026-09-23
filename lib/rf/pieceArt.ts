/* ============================================================
   lib/rf/pieceArt.ts — Rare Friends piece art, drawn procedurally.

   Every tetromino is built from real Rare Friends: each cell is a canonical
   16×16 one-bit Generations portrait, read on-chain from the Families registry
   (FriendSDK FAMILIES_REGISTRY_ABI.portrait) and baked into portraits.json.
   One Generations family per piece shape; colors from FriendSDK GAME_PALETTE
   plus the Rare Friends signal green.

   Each cell is a Friend's bare 16×16 pixel sprite (no tile) — the player's
   own Friends when signed in, generic on-chain Friends for guests.
   Variants (the engine's "clean"/"blood" slots, names kept for replay-safety):
     clean — Friend in the piece colour with an ink halo
     blood — flash: white Friend with a colour halo (pieces in a clearing row)

   Output matches the engine's art contract exactly: an <img> whose natural
   size is GRIDS[t] × CELL, body at (0,0) — so rotation, per-cell slicing,
   previews and turf mode all work unchanged.
   ============================================================ */

import portraits from "./portraits.json";

export type PieceType = "I" | "J" | "L" | "O" | "S" | "T" | "Z";
export const ART_CELL = 96;
export const GRIDS: Record<PieceType, [number, number]> = { I: [4, 1], J: [3, 2], L: [3, 2], O: [2, 2], S: [3, 2], T: [3, 2], Z: [3, 2] };

/** Spawn-orientation cells relative to the body's top-left (mirrors lib/pieces SHAPES minus bbox). */
const CELLS: Record<PieceType, number[][]> = {
  I: [[0, 0], [1, 0], [2, 0], [3, 0]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
};

export const INK = "#111111";
export const SIGNAL = "#CCFF00";
/** FriendSDK GAME_PALETTE + signal green + paper. */
export const PIECE_STYLE: Record<PieceType, { color: string; family: number; name: string }> = {
  I: { color: SIGNAL, family: 7, name: "Sparkling" },
  O: { color: "#F2CE68", family: 6, name: "Colossus" },
  T: { color: "#B3A0D8", family: 1, name: "Mask" },
  S: { color: "#B9D984", family: 3, name: "Cellular" },
  Z: { color: "#ED927E", family: 0, name: "Skeleton" },
  J: { color: "#7DB4DB", family: 5, name: "Hoverer" },
  L: { color: "#B8B8B8", family: 2, name: "Family" },
};

type Pack = { families: { id: number; name: string; portraits: string[] }[] };
const PACK = portraits as Pack;

/** Decode a uint256 portrait (bit 0 = top-left) into 16 rows of booleans. */
export function decodePortrait(hex: string): boolean[][] {
  const v = BigInt(hex);
  return Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => ((v >> BigInt(y * 16 + x)) & 1n) === 1n));
}

const decoded = new Map<string, boolean[][]>();
export function portraitFor(family: number, index: number): boolean[][] {
  const fam = PACK.families[family] ?? PACK.families[0];
  const hex = fam.portraits[((index % fam.portraits.length) + fam.portraits.length) % fam.portraits.length];
  let rows = decoded.get(hex);
  if (!rows) decoded.set(hex, (rows = decodePortrait(hex)));
  return rows;
}

/* ---------------- the player's own Friends as piece art ----------------
   Pieces are the bare pixel sprites of Rare Friends — no tile around them.
   When a Friend is signed in, ONLY the Friends held by that wallet are used
   (set by components/FriendPieces via setPieceFriends); guests see generic
   on-chain Friends from portraits.json. */

export type SpriteRows = readonly string[]; // 16 rows of "#"/"."
export interface PieceFriend {
  id: string;
  rows: SpriteRows;
  /** 1 (light) … 5 (heaviest) — lib/rf/traits weightClass. */
  weightClass?: number;
}
const TYPE_ORDER: PieceType[] = ["T", "L", "J", "S", "Z", "O", "I"];
let walletFriends: PieceFriend[] | null = null;

export function setPieceFriends(list: PieceFriend[] | null) {
  walletFriends = list && list.length ? list.slice(0, 7) : null;
}

/** Which of the player's Friends a piece type wears (null for guests). */
export function friendFor(t: PieceType): PieceFriend | null {
  return walletFriends ? walletFriends[TYPE_ORDER.indexOf(t) % walletFriends.length] : null;
}

/** Fall-time multiplier for a piece: heavier Friend → slower (class 5 = 1.6×). */
export function gravityScaleFor(t: PieceType): number {
  const w = friendFor(t)?.weightClass ?? 1;
  return 1 + 0.15 * (Math.max(1, Math.min(5, w)) - 1);
}

export function pieceFriendList(): readonly PieceFriend[] {
  return walletFriends ?? [];
}
export function pieceFriendIds(): string[] {
  return walletFriends ? walletFriends.map((f) => f.id) : [];
}

const rowsFromBits = (b: boolean[][]): SpriteRows => b.map((r) => r.map((x) => (x ? "#" : ".")).join(""));

/** The sprite a piece type wears. */
export function spriteFor(t: PieceType): SpriteRows {
  const f = friendFor(t);
  if (f) return f.rows;
  return rowsFromBits(portraitFor(PIECE_STYLE[t].family, 2 + (t.charCodeAt(0) % 5)));
}

/**
 * Draw one Friend into a 96×96 cell in the Rare Friends house look: the
 * canonical black 1-bit sprite with a 1-pixel white halo (FriendSDK reference
 * style), over a faint wash of the piece's palette colour so the seven shapes
 * stay readable at speed. 6px pixels, edge to edge.
 * "blood" = flash variant for pieces in a clearing row: inverted (ink cell,
 * white Friend).
 */
export function drawSpriteCell(c: CanvasRenderingContext2D, x: number, y: number, rows: SpriteRows, color: string, flash: boolean) {
  const px = 6;
  const on = (r: number, q: number) => r >= 0 && r < 16 && q >= 0 && q < 16 && rows[r][q] === "#";
  // tint wash (inset 3px so neighbouring cells read as separate Friends)
  c.save();
  c.globalAlpha = flash ? 1 : 0.42;
  c.fillStyle = flash ? INK : color;
  c.fillRect(x + 3, y + 3, 90, 90);
  c.restore();
  // 1-px halo
  c.fillStyle = flash ? INK : "#ffffff";
  for (let r = -1; r <= 16; r++)
    for (let q = -1; q <= 16; q++) {
      if (on(r, q)) continue;
      if (on(r - 1, q) || on(r + 1, q) || on(r, q - 1) || on(r, q + 1) || on(r - 1, q - 1) || on(r + 1, q + 1) || on(r - 1, q + 1) || on(r + 1, q - 1))
        if (r >= 0 && r < 16 && q >= 0 && q < 16) c.fillRect(x + q * px, y + r * px, px, px);
    }
  c.fillStyle = flash ? "#ffffff" : INK;
  for (let r = 0; r < 16; r++) for (let q = 0; q < 16; q++) if (on(r, q)) c.fillRect(x + q * px, y + r * px, px, px);
}

/** A piece canvas for an explicit cell layout (used for every rotation so sprites stay upright). */
export function pieceCanvas(t: PieceType, variant: "clean" | "blood", cells: number[][], w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = w * ART_CELL;
  cv.height = h * ART_CELL;
  const c = cv.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  const rows = spriteFor(t);
  for (const [cx, cy] of cells) drawSpriteCell(c, cx * ART_CELL, cy * ART_CELL, rows, PIECE_STYLE[t].color, variant === "blood");
  return cv;
}

/** Render a whole piece body (spawn orientation) and return a PNG data URL. */
export function pieceDataUrl(t: PieceType, variant: "clean" | "blood"): { url: string; fw: number; fh: number } {
  const [gw, gh] = GRIDS[t];
  const cv = pieceCanvas(t, variant, CELLS[t], gw, gh);
  return { url: cv.toDataURL("image/png"), fw: cv.width, fh: cv.height };
}

/** Pixel wordmark for the menu/header: "FRIEND SMASH" in a 5×7 bitmap font. */
const GLYPHS: Record<string, string[]> = {
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

export function wordmarkDataUrl(lines: string[] = ["FRIEND", "SMASH!"], px = 10): string {
  // Rare Friends house wordmark: plain black pixels, wide letter spacing.
  const adv = 7; // 5px glyph + 2px tracking
  const cols = Math.max(...lines.map((l) => l.length)) * adv - 2;
  const pad = px;
  const cv = document.createElement("canvas");
  cv.width = cols * px + pad * 2;
  cv.height = (lines.length * 10 - 3) * px + pad * 2;
  const c = cv.getContext("2d")!;
  c.fillStyle = INK;
  lines.forEach((line, li) => {
    const lx = Math.floor((cols - (line.length * adv - 2)) / 2);
    [...line].forEach((ch, ci) =>
      (GLYPHS[ch] ?? GLYPHS[" "]).forEach((row, ry) =>
        [...row].forEach((bit, rx) => {
          if (bit === "#") c.fillRect(pad + (lx + ci * adv + rx) * px, pad + (li * 10 + ry) * px, px, px);
        }),
      ),
    );
  });
  return cv.toDataURL("image/png");
}

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
const TYPE_ORDER: PieceType[] = ["T", "L", "J", "S", "Z", "O", "I"];
let walletFriends: { id: string; rows: SpriteRows }[] | null = null;

export function setPieceFriends(list: { id: string; rows: SpriteRows }[] | null) {
  walletFriends = list && list.length ? list.slice(0, 7) : null;
}
export function pieceFriendIds(): string[] {
  return walletFriends ? walletFriends.map((f) => f.id) : [];
}

const rowsFromBits = (b: boolean[][]): SpriteRows => b.map((r) => r.map((x) => (x ? "#" : ".")).join(""));

/** The sprite a piece type wears. */
export function spriteFor(t: PieceType): SpriteRows {
  if (walletFriends) return walletFriends[TYPE_ORDER.indexOf(t) % walletFriends.length].rows;
  return rowsFromBits(portraitFor(PIECE_STYLE[t].family, 2 + (t.charCodeAt(0) % 5)));
}

/**
 * Draw one Friend sprite into a 96×96 cell (6px pixels, edge to edge), the
 * piece colour with a 1-pixel ink halo (the FriendSDK reference look, in
 * colour so shapes stay readable). "blood" = the flash variant for pieces in a
 * clearing row: white body, colour halo.
 */
export function drawSpriteCell(c: CanvasRenderingContext2D, x: number, y: number, rows: SpriteRows, color: string, flash: boolean) {
  // 6px pixels: the 16×16 sprite fills the whole 96px cell (sprites carry
  // their own blank margin, so neighbouring Friends still read as separate).
  const px = 6;
  const ox = x;
  const oy = y;
  const on = (r: number, q: number) => r >= 0 && r < 16 && q >= 0 && q < 16 && rows[r][q] === "#";
  c.fillStyle = flash ? color : INK;
  for (let r = -1; r <= 16; r++)
    for (let q = -1; q <= 16; q++) {
      if (on(r, q)) continue;
      if (on(r - 1, q) || on(r + 1, q) || on(r, q - 1) || on(r, q + 1) || on(r - 1, q - 1) || on(r + 1, q + 1) || on(r - 1, q + 1) || on(r + 1, q - 1))
        c.fillRect(ox + q * px, oy + r * px, px, px);
    }
  c.fillStyle = flash ? "#ffffff" : color;
  for (let r = 0; r < 16; r++) for (let q = 0; q < 16; q++) if (on(r, q)) c.fillRect(ox + q * px, oy + r * px, px, px);
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
  const cols = Math.max(...lines.map((l) => l.length)) * 6 - 1;
  const pad = px * 2;
  const cv = document.createElement("canvas");
  cv.width = cols * px + pad * 2;
  cv.height = (lines.length * 9 - 2) * px + pad * 2;
  const c = cv.getContext("2d")!;
  // Each glyph pixel -> callback(x, y, lineIndex)
  const each = (fn: (x: number, y: number, li: number) => void) =>
    lines.forEach((line, li) => {
      const lx = Math.floor((cols - (line.length * 6 - 1)) / 2);
      [...line].forEach((ch, ci) =>
        (GLYPHS[ch] ?? GLYPHS[" "]).forEach((row, ry) =>
          [...row].forEach((b, rx) => {
            if (b === "#") fn(pad + (lx + ci * 6 + rx) * px, pad + (li * 9 + ry) * px, li);
          }),
        ),
      );
    });
  c.fillStyle = INK;
  each((x, y) => c.fillRect(x - 3 + px * 0.5, y - 3 + px * 0.5, px + 6, px + 6)); // drop shadow
  each((x, y) => c.fillRect(x - 3, y - 3, px + 6, px + 6)); // outline
  each((x, y, li) => {
    c.fillStyle = li === lines.length - 1 ? SIGNAL : "#ffffff";
    c.fillRect(x, y, px, px);
  });
  return cv.toDataURL("image/png");
}

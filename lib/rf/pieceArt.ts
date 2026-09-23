/* ============================================================
   lib/rf/pieceArt.ts — Rare Friends piece art, drawn procedurally.

   Every tetromino is built from real Rare Friends: each cell is a canonical
   16×16 one-bit Generations portrait, read on-chain from the Families registry
   (FriendSDK FAMILIES_REGISTRY_ABI.portrait) and baked into portraits.json.
   One Generations family per piece shape; colors from FriendSDK GAME_PALETTE
   plus the Rare Friends signal green.

   Variants (the engine's "clean"/"blood" slots, names kept for replay-safety):
     clean — palette block, ink Friend, chunky 1px-pixel bevel
     blood — CRACKED: inverted ink block, palette Friend, pixel crack lines
             (shown on pieces caught in a line clear)

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
  L: { color: "#F4F1EA", family: 2, name: "Family" },
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

/** Draw one Friend cell (96×96) at (x,y). */
export function drawCell(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  bits: boolean[][],
  cracked: boolean,
) {
  const S = ART_CELL;
  const bg = cracked ? INK : color;
  const fg = cracked ? color : INK;
  // outer ink border (6px) + block
  c.fillStyle = INK;
  c.fillRect(x, y, S, S);
  c.fillStyle = bg;
  c.fillRect(x + 6, y + 6, S - 12, S - 12);
  if (!cracked) {
    // pixel bevel: light top/left, dark bottom/right (6px "pixels")
    c.fillStyle = "rgba(255,255,255,.55)";
    c.fillRect(x + 6, y + 6, S - 12, 6);
    c.fillRect(x + 6, y + 6, 6, S - 12);
    c.fillStyle = "rgba(0,0,0,.18)";
    c.fillRect(x + 6, y + S - 12, S - 12, 6);
    c.fillRect(x + S - 12, y + 6, 6, S - 12);
  }
  // Friend portrait: 16×16 at 4px per pixel = 64px, centered (16px margin)
  const px = 4;
  const ox = x + 16;
  const oy = y + 16;
  c.fillStyle = fg;
  for (let r = 0; r < 16; r++) for (let q = 0; q < 16; q++) if (bits[r][q]) c.fillRect(ox + q * px, oy + r * px, px, px);
  if (cracked) {
    // stair-step pixel cracks from a corner
    c.fillStyle = color;
    const steps = [
      [12, 12], [18, 18], [24, 18], [30, 24], [36, 30], [36, 36],
      [S - 18, 12], [S - 24, 18], [S - 30, 18], [S - 30, 24],
      [12, S - 24], [18, S - 30], [24, S - 30],
    ];
    for (const [sx, sy] of steps) c.fillRect(x + sx, y + sy, 6, 6);
  }
}

/** Render a whole piece body (GRIDS[t] cells wide/high) and return a PNG data URL. */
export function pieceDataUrl(t: PieceType, variant: "clean" | "blood"): { url: string; fw: number; fh: number } {
  const [gw, gh] = GRIDS[t];
  const cv = document.createElement("canvas");
  cv.width = gw * ART_CELL;
  cv.height = gh * ART_CELL;
  const c = cv.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  const style = PIECE_STYLE[t];
  CELLS[t].forEach(([cx, cy], i) => {
    // Seeds are spread per piece so the same shape shows four different Friends.
    drawCell(c, cx * ART_CELL, cy * ART_CELL, style.color, portraitFor(style.family, i * 3 + (t.charCodeAt(0) % 3)), variant === "blood");
  });
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

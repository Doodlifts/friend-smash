/* app/apple-icon.tsx — the iOS home-screen / apple-touch icon.

   A 1-bit pixel Friend face (#111 on signal green #CCFF00) built from absolutely
   positioned divs on a 16x16 grid, generated via next/og. Mirrors the SVG
   favicon in layout.tsx. */

import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// [x, y, w, h] in 16x16 grid cells
const PIXELS: [number, number, number, number][] = [
  // head outline
  [4, 2, 8, 1], [3, 3, 1, 1], [12, 3, 1, 1], [2, 4, 1, 8], [13, 4, 1, 8],
  [3, 12, 1, 1], [12, 12, 1, 1], [4, 13, 8, 1],
  // eyes
  [5, 6, 2, 2], [9, 6, 2, 2],
  // smile
  [5, 10, 1, 1], [10, 10, 1, 1], [6, 11, 4, 1],
];

const CELL = 10; // 16 cells * 10px = 160px, centered in 180px
const PAD = (180 - 16 * CELL) / 2;

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#CCFF00" }}>
        {PIXELS.map(([x, y, w, h], i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: PAD + x * CELL,
              top: PAD + y * CELL,
              width: w * CELL,
              height: h * CELL,
              background: "#111111",
            }}
          />
        ))}
      </div>
    ),
    { ...size },
  );
}

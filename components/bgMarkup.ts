/* components/bgMarkup.ts — decorative backdrop SVG for the game surface.
   Rare Friends look: light grey paper (#eee), a faint 1-bit checker dither, a
   barely-there pixel grid, and a few scattered pixel sparkles in signal green
   (plus one or two palette accents). Injected via dangerouslySetInnerHTML by
   Game.tsx; keep the export name BG_SVG. */

// 5x5 pixel "plus" sparkle, centered on (x, y), drawn at `s` px per pixel.
function sparkle(x: number, y: number, s: number, fill: string): string {
  const o = (n: number) => n * s;
  return (
    `<g fill="${fill}" stroke="#111" stroke-width="${Math.max(1, s / 3)}">` +
    `<rect x="${x - o(0.5)}" y="${y - o(2.5)}" width="${o(1)}" height="${o(5)}"/>` +
    `<rect x="${x - o(2.5)}" y="${y - o(0.5)}" width="${o(5)}" height="${o(1)}"/>` +
    `</g>` +
    `<rect x="${x - o(0.5)}" y="${y - o(0.5)}" width="${o(1)}" height="${o(1)}" fill="${fill}"/>`
  );
}

const SPARKLES: [number, number, number, string][] = [
  [70, 120, 4, "#111111"],
  [410, 90, 3, "#111111"],
  [440, 470, 4, "#111111"],
  [36, 560, 3, "#111111"],
  [250, 40, 3, "#111111"],
  [120, 780, 4, "#111111"],
  [380, 820, 3, "#111111"],
  [455, 300, 2, "#111111"],
  [22, 330, 2, "#111111"],
];

// lone ink specks, 1-bit style
const SPECKS: [number, number][] = [
  [150, 210], [350, 170], [60, 300], [430, 600], [100, 700], [300, 720], [200, 860], [470, 180],
];

export const BG_SVG = String.raw`
<svg viewBox="0 0 480 900" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="rfDither" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="2" height="2" fill="#111" opacity=".05"/>
      <rect x="2" y="2" width="2" height="2" fill="#111" opacity=".05"/>
    </pattern>
    <pattern id="rfGrid" width="24" height="24" patternUnits="userSpaceOnUse">
      <rect width="24" height="1" fill="#111" opacity=".05"/>
      <rect width="1" height="24" fill="#111" opacity=".05"/>
    </pattern>
  </defs>
  <rect width="480" height="900" fill="#eeeeee"/>
  <rect width="480" height="900" fill="url(#rfDither)"/>
  <rect width="480" height="900" fill="url(#rfGrid)"/>
  <g fill="#111" opacity=".55">
    ${SPECKS.map(([x, y]) => `<rect x="${x}" y="${y}" width="4" height="4"/>`).join("")}
  </g>
  ${SPARKLES.map(([x, y, s, f]) => sparkle(x, y, s, f)).join("\n  ")}
  <!-- palette strip footer -->
  <g>
    <rect x="0" y="881" width="480" height="3" fill="#111"/>
  </g>
</svg>
`;

/* components/icons.tsx — the one on-brand icon set.

   Feather-style stroke glyphs (round caps/joins, chunky 2.6px stroke, currentColor)
   so the chrome icons match the hand-drawn control-pad SVGs in Game.tsx instead of
   clashing with glossy OS emoji. Each takes an optional `size` (px) and inherits the
   button's text color. Keep new icons in THIS file so every surface pulls one set.

   NOTE: the in-game mute button is engine-managed (it swaps innerHTML at runtime),
   so its SVG lives as a string in engine.ts. If you change IconSound/IconMuted here,
   mirror SND_ON / SND_OFF there. */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 22, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Back / move-left arrow — mirrors the game's move-left control. */
export function IconBack(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </Svg>
  );
}

/** Forward arrow (admin next). */
export function IconForward(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </Svg>
  );
}

/** Shop — a shopping bag (cleaner than a cart at chip size). */
export function IconShop(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 2 3 6.5V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5L18 2z" />
      <line x1="3" y1="6.5" x2="21" y2="6.5" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </Svg>
  );
}

/** Stats — a bar chart. */
export function IconChart(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="18" y1="20" x2="18" y2="9" />
    </Svg>
  );
}

/** Leaderboard — an award medal (distinct from the account icon). */
export function IconTrophy(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="6" />
      <path d="M8.5 13.5 7 22l5-3 5 3-1.5-8.5" />
    </Svg>
  );
}

/** Account — a person. */
export function IconUser(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 21v-1.5a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5V21" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  );
}

/** Pause — two chunky bars. */
export function IconPause(p: IconProps) {
  return (
    <Svg strokeWidth={3.2} {...p}>
      <line x1="9" y1="5" x2="9" y2="19" />
      <line x1="15" y1="5" x2="15" y2="19" />
    </Svg>
  );
}

/** Sound on — speaker with waves. (Mirror of engine.ts SND_ON.) */
export function IconSound(p: IconProps) {
  return (
    <Svg {...p}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.8 5.5a9 9 0 0 1 0 13" />
    </Svg>
  );
}

/** Muted — speaker with an ✕. (Mirror of engine.ts SND_OFF.) */
export function IconMuted(p: IconProps) {
  return (
    <Svg {...p}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="16.5" y1="9" x2="22" y2="15" />
      <line x1="22" y1="9" x2="16.5" y2="15" />
    </Svg>
  );
}

/** Parachute — slow fall power-up. */
export function IconChute(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 10a8 8 0 0 1 16 0" />
      <path d="M4 10c2.5 1.6 13.5 1.6 16 0" />
      <path d="M5 10.8l6 7.2" />
      <path d="M19 10.8l-6 7.2" />
      <circle cx="12" cy="19.4" r="1.4" />
    </Svg>
  );
}

/** Eye — next-peek power-up. */
export function IconEye(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.7" />
    </Svg>
  );
}

/** Sparkle — clean-slate power-up (and the generic power-up fallback). */
export function IconSparkle(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.5l1.7 4.9 4.9 1.7-4.9 1.7L12 16.7l-1.7-4.9-4.9-1.7 4.9-1.7z" />
      <line x1="19" y1="17.5" x2="19" y2="21" />
      <line x1="17.2" y1="19.2" x2="20.8" y2="19.2" />
    </Svg>
  );
}

/** Bomb — chunky orb with a lit fuse. */
export function IconBomb(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="10.5" cy="14" r="6.8" />
      <path d="M14.8 8.6l2.6-2.6" />
      <path d="M19.5 3.2l.9-.9" />
      <path d="M21 6.5h1.5" />
      <path d="M18.2 1.5V0.8" />
    </Svg>
  );
}

/** Reroll — refresh loop, matching the in-game rotate controls. */
export function IconReroll(p: IconProps) {
  return (
    <Svg {...p}>
      <polyline points="21 5 21 11 15 11" />
      <path d="M20.2 11A8.2 8.2 0 1 0 21 15" />
    </Svg>
  );
}

/** Surrender flag — TURF WAR concede. */
export function IconFlag(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="6" y1="21" x2="6" y2="3" />
      <path d="M6 4.5h11.5l-2.8 3.7 2.8 3.7H6" />
    </Svg>
  );
}

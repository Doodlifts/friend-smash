"use client";

/* components/LeaderboardLink.tsx — a small fixed "Leaderboard" button shown
   while the player is idle (menu / paused / game-over). Always available
   (no auth dependency); reads game state read-only via window.__DS so it
   stays out of the way during active play. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { IconShop, IconChart, IconTrophy } from "./icons";

export default function LeaderboardLink() {
  const [state, setState] = useState("menu");

  useEffect(() => {
    const id = window.setInterval(() => {
      const s = window.__DS?.G?.state;
      if (s) setState(s);
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Hidden during any ACTIVE-RUN state. "bonus" matters as much as "play":
  // killBonusOverlay() tears the bonus overlay down before the action phase,
  // so the board and topbar are fully exposed for several seconds — and this
  // strip paints over them (z-index 30 vs #app's 1). A player reaching for
  // MUTE or PAUSE there would hit <Link href="/shop">, which unmounts Game
  // and ABANDONS the ranked run in progress.
  if (state === "play" || state === "clearing" || state === "bonus") return null;

  // One segmented pill of drawn glyphs — reads as a single intentional control
  // instead of three loose emoji floating over the board.
  const chip: React.CSSProperties = {
    width: 44,
    height: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--r-ctl)",
    border: "2.5px solid var(--ink)",
    background: "var(--panel-solid)",
    color: "var(--ink)",
    boxShadow: "var(--sh-ctl)",
    textDecoration: "none",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top,0px) + 8px)",
        right: 10,
        zIndex: 30,
        display: "flex",
        gap: 8,
      }}
    >
      <Link href="/shop" aria-label="Shop" style={chip} className="chunky">
        <IconShop size={21} />
      </Link>
      <Link href="/stats" aria-label="Your runs" style={chip} className="chunky">
        <IconChart size={21} />
      </Link>
      <Link href="/leaderboard" aria-label="Leaderboard" style={chip} className="chunky">
        <IconTrophy size={21} />
      </Link>
    </div>
  );
}

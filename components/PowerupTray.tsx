"use client";

/* components/PowerupTray.tsx — in-game power-up tray.

   Shows the power-ups the signed-in player owns, only during active play, as a
   slim strip on the left edge. Tapping one activates it via the engine
   (window.__DS.usePowerup), which applies the (replay-safe) effect and records
   a 'powerup' event in the input log. Inventory is decremented optimistically
   here; the server consumes it authoritatively on run finish. */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { IconChute, IconEye, IconSparkle, IconBomb, IconReroll } from "./icons";
import type { ComponentType } from "react";

// On-brand stroke icons (components/icons.tsx) — no OS emoji in the chrome.
const ICON: Record<string, ComponentType<{ size?: number }>> = {
  slow_fall: IconChute,
  next_peek: IconEye,
  clean_slate: IconSparkle,
  bomb: IconBomb,
  reroll: IconReroll,
};

export default function PowerupTray() {
  return <PowerupTrayInner />;
}

function PowerupTrayInner() {
  const { ready, authenticated, getAccessToken } = useAuth();
  const [inv, setInv] = useState<Record<string, number>>({});
  const [gameState, setGameState] = useState("menu");

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const d = await res.json();
        const m: Record<string, number> = {};
        for (const i of d.inventory || []) m[i.key] = i.qty;
        setInv(m);
      }
    } catch {
      /* ignore */
    }
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  // Re-pull inventory when a purchase happens, and at the start of each game.
  useEffect(() => {
    const h = () => void refresh();
    window.addEventListener("rfsmash:me-changed", h);
    return () => window.removeEventListener("rfsmash:me-changed", h);
  }, [refresh]);

  const [ranked, setRanked] = useState(true);

  useEffect(() => {
    let prev = "menu";
    const id = window.setInterval(() => {
      const ds = (window as { __DS?: { G?: { state?: string }; ranked?: () => boolean } }).__DS;
      const sNow = ds?.G?.state || "menu";
      if (sNow !== prev) {
        if (sNow === "play" && prev !== "play") void refresh(); // fresh loadout each game
        prev = sNow;
        setGameState(sNow);
        // Unranked game (no server run — offline/rate-limited): hide the tray.
        // Spends couldn't settle server-side and would "come back" later.
        // Hidden during RANKED pool runs (equal loadout) — they only make sense
        // in server-verified practice runs.
        setRanked((typeof ds?.ranked === "function" ? ds.ranked() : true) && !window.__RF_RUN_RANKED);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!authenticated || gameState !== "play" || !ranked) return null;

  const owned = Object.entries(inv).filter(([, q]) => q > 0);
  if (!owned.length) return null;

  const use = (key: string) => {
    const ds = (window as { __DS?: { usePowerup?: (k: string) => boolean } }).__DS;
    if (ds?.usePowerup?.(key)) {
      setInv((m) => ({ ...m, [key]: Math.max(0, (m[key] || 0) - 1) }));
    }
  };

  return (
    <div
      style={{
        // Placement comes from the engine's layout() via :root CSS vars: the
        // left-edge strip only when the board's left margin actually fits it
        // (landscape/desktop); on portrait phones the tray slots into the
        // rail column between NEXT and the SMASH track. The old fixed left:4
        // strip sat ON the board there — hiding column 0 and turning the
        // tap-left-to-rotate gesture into an accidental power-up spend.
        position: "fixed",
        left: "var(--tray-left, 4px)",
        top: "var(--tray-top, 42%)",
        bottom: "var(--tray-bottom, auto)",
        transform: "var(--tray-tf, translateY(-50%))",
        width: "var(--tray-w, auto)",
        zIndex: 25,
        display: "flex",
        flexFlow: "var(--tray-flow, column)",
        justifyContent: "center",
        gap: "var(--tray-gap, 8px)",
      }}
    >
      {owned.map(([key, qty]) => (
        <button
          key={key}
          onClick={() => use(key)}
          aria-label={`Use ${key}`}
          className="chunky"
          style={{
            width: 44,
            height: 44,
            borderRadius: "var(--r-ctl)",
            border: "2.5px solid var(--ink)",
            background: "var(--panel-solid)",
            boxShadow: "var(--sh-ctl)",
            fontSize: 20,
            position: "relative",
            cursor: "pointer",
          }}
        >
          {(() => { const I = ICON[key] || IconSparkle; return <I size={22} />; })()}
          <span
            className="num"
            style={{
              position: "absolute",
              right: -4,
              top: -6,
              background: "var(--pink)",
              color: "#fff",
              border: "2px solid var(--ink)",
              borderRadius: 10,
              fontSize: 10,
              fontWeight: 800,
              minWidth: 16,
              height: 16,
              lineHeight: "13px",
              padding: "0 3px",
            }}
          >
            {qty}
          </span>
        </button>
      ))}
    </div>
  );
}

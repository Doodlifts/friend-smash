"use client";

/* ============================================================
   components/PoolPanel.tsx — today's ranked RF pool (SIMULATED).

   A compact bar on the menu / game-over screens: pot, entries, countdown,
   total RF burned, and the RANKED toggle. Tapping the bar opens the standings
   (top 10 with projected prizes, your place, yesterday's winners, the exact
   economy terms). Hidden during play so it never covers the board.
   ============================================================ */

import { useCallback, useEffect, useState } from "react";
import { useAuth, ME_CHANGED } from "@/components/auth/AuthProvider";
import FriendPortrait from "@/components/auth/FriendPortrait";
import { formatRf } from "@/lib/rf/format";
import { getRankedPref, setRankedPref, RANKED_CHANGED } from "@/lib/rf/rankedPref";

interface Standing {
  rank: number;
  friendId: string | null;
  handle: string | null;
  score: number;
  projectedPrize?: number;
  prize?: number;
  you: boolean;
}
interface Pool {
  day: string;
  closesAt: string;
  settlesAt: string;
  pot: number;
  entries: number;
  entryFee: number;
  poolShare: number;
  burnPerEntry: number;
  standings: Standing[];
  me: { best: number | null; rank: number | null; entries: number } | null;
  yesterday: { day: string; winners: Standing[] } | null;
  totals: { burned: number; prizesPaid: number; faucetIssued: number };
}

function useCountdown(iso: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!iso) return "";
  const ms = Math.max(0, new Date(iso).getTime() - now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const name = (s: Standing) => s.handle || (s.friendId ? `Friend #${s.friendId}` : "Friend");

export default function PoolPanel() {
  const { authenticated, getAccessToken, login } = useAuth();
  const [pool, setPool] = useState<Pool | null>(null);
  const [gameState, setGameState] = useState("menu");
  const [open, setOpen] = useState(false);
  const [ranked, setRanked] = useState(false);
  const left = useCountdown(pool?.closesAt);

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/pool", {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.ok) setPool(await res.json());
    } catch {
      /* offline — keep the last snapshot */
    }
  }, [getAccessToken]);

  useEffect(() => {
    setRanked(getRankedPref());
    const onPref = () => setRanked(getRankedPref());
    window.addEventListener(RANKED_CHANGED, onPref);
    return () => window.removeEventListener(RANKED_CHANGED, onPref);
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    const h = () => void load();
    window.addEventListener(ME_CHANGED, h);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(ME_CHANGED, h);
    };
  }, [load, authenticated]);

  // Read engine state (read-only) — hide during play.
  useEffect(() => {
    let prev = "menu";
    const id = window.setInterval(() => {
      const s = (window as { __DS?: { G?: { state?: string } } }).__DS?.G?.state || "menu";
      if (s !== prev) {
        if (prev === "play" || prev === "clearing") void load();
        prev = s;
        setGameState(s);
      }
    }, 300);
    return () => window.clearInterval(id);
  }, [load]);

  const idle = gameState !== "play" && gameState !== "clearing" && gameState !== "paused";
  if (!idle || !pool) return null;

  const toggle = () => {
    if (!authenticated) {
      login();
      return;
    }
    setRankedPref(!ranked);
  };

  return (
    <>
      <div className="rfpool-bar" role="region" aria-label="Today's ranked RF pool">
        <button className="rfpool-info" onClick={() => setOpen(true)} aria-label="Open today's pool standings">
          <span className="rfpool-pot">
            <b>{formatRf(pool.pot)} RF</b> POOL
          </span>
          <span className="rfpool-meta">
            {pool.entries} entries · closes {left} · 🔥 {formatRf(pool.totals.burned)} burned
          </span>
        </button>
        <button
          className={`rfpool-toggle${ranked && authenticated ? " on" : ""}`}
          onClick={toggle}
          aria-pressed={ranked && authenticated}
        >
          {authenticated ? (ranked ? `RANKED ✓` : `RANKED ☐`) : "ENTER"}
          <small>{formatRf(pool.entryFee)} RF</small>
        </button>
      </div>

      {open && (
        <div className="rfp-ov" role="dialog" aria-modal="true" aria-label="Today's pool" onClick={() => setOpen(false)}>
          <div className="rfp-card-panel rfpool-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="rfp-head">
              <b>DAILY RF POOL · {pool.day}</b>
              <button className="rfp-x" aria-label="Close" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <div className="rfpool-big">
              {formatRf(pool.pot)} <span>RF</span>
            </div>
            <p className="rfp-note">
              SIMULATED — no real tokens move. Closes in {left} (00:00 UTC); pays the top 10 two hours later.
            </p>

            {pool.me && (
              <p className="rfpool-me">
                You: {pool.me.best != null ? `best ${pool.me.best.toLocaleString()} · #${pool.me.rank}` : "no ranked score yet"} ·{" "}
                {pool.me.entries} entr{pool.me.entries === 1 ? "y" : "ies"} today
              </p>
            )}

            <ol className="rfpool-list">
              {pool.standings.length === 0 && <li className="rfp-note">No ranked scores yet — first place is wide open.</li>}
              {pool.standings.map((s) => (
                <li key={s.rank} className={s.you ? "you" : ""}>
                  <span className="r">#{s.rank}</span>
                  {s.friendId ? <FriendPortrait friendId={s.friendId} size={28} /> : <span style={{ width: 28 }} />}
                  <span className="n">{name(s)}</span>
                  <span className="s">{s.score.toLocaleString()}</span>
                  <span className="p">+{formatRf(s.projectedPrize ?? 0)}</span>
                </li>
              ))}
            </ol>

            {pool.yesterday && (
              <>
                <div className="rfpool-h">YESTERDAY&apos;S WINNERS</div>
                <ol className="rfpool-list small">
                  {pool.yesterday.winners.slice(0, 3).map((w) => (
                    <li key={w.rank} className={w.you ? "you" : ""}>
                      <span className="r">#{w.rank}</span>
                      {w.friendId ? <FriendPortrait friendId={w.friendId} size={22} /> : <span style={{ width: 22 }} />}
                      <span className="n">{name(w)}</span>
                      <span className="p">+{formatRf(w.prize ?? 0)}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}

            <div className="rfpool-h">HOW IT WORKS</div>
            <ul className="rfpool-rules">
              <li>
                Each ranked run costs <b>{formatRf(pool.entryFee)} RF</b>: {formatRf(pool.poolShare)} to the pool,{" "}
                <b>{formatRf(pool.burnPerEntry)} burned</b>.
              </li>
              <li>Best ranked score per Friend counts. Every run is server-replayed (anti-cheat).</li>
              <li>Ranked = equal loadout: no power-ups. Top 10 split the pot, top-heavy.</li>
              <li>Power-ups (practice/versus) burn 100%. Versus burns 5% of each pot.</li>
            </ul>
            <p className="rfp-note">
              All-time: {formatRf(pool.totals.burned)} RF burned · {formatRf(pool.totals.prizesPaid)} RF paid to players ·{" "}
              {formatRf(pool.totals.faucetIssued)} RF from the demo faucet
            </p>
            {authenticated ? (
              <button className={`rfp-btn ${ranked ? "" : "rfp-primary"}`} onClick={() => setRankedPref(!ranked)}>
                {ranked ? "Switch to practice (free)" : `Play ranked · ${formatRf(pool.entryFee)} RF per run`}
              </button>
            ) : (
              <button className="rfp-btn rfp-primary" onClick={() => { setOpen(false); login(); }}>
                Connect a Rare Friend to enter
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

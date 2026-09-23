"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { IconBack } from "@/components/icons";
import type { Period, LeaderboardRow } from "@/lib/leaderboard";

const PERIODS: { key: Period; label: string }[] = [
  { key: "all", label: "All-time" },
  { key: "weekly", label: "Weekly" },
  { key: "daily", label: "Today" },
];

type LoadState = "loading" | "ok" | "empty" | "error" | "unconfigured";

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("all");
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async (p: Period) => {
    setState("loading");
    try {
      const res = await fetch(`/api/leaderboard?period=${p}&limit=100`);
      if (res.status === 503) {
        setState("unconfigured");
        return;
      }
      if (!res.ok) {
        setState("error");
        return;
      }
      const data = await res.json();
      const list: LeaderboardRow[] = data.rows || [];
      setRows(list);
      setState(list.length ? "ok" : "empty");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [period, load]);

  return (
    <main className="page-wrap">
      <div className="page-card">
        <div className="page-titlerow">
          <Link href="/" className="page-back chunky" aria-label="Back to game">
            <IconBack />
          </Link>
          <div className="page-title">LEADERBOARD</div>
          <span style={{ width: 40 }} />
        </div>

        <div className="page-tabs">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`page-tab chunky${period === p.key ? " active" : ""}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {state === "loading" && <div className="page-note">Loading the Friend rankings…</div>}
        {state === "error" && (
          <div className="page-note">Couldn&apos;t load the leaderboard. Give it another tap.</div>
        )}
        {state === "unconfigured" && (
          <div className="page-note">
            The leaderboard isn&apos;t live yet — check back once it&apos;s switched on.
          </div>
        )}
        {state === "empty" && (
          <div className="page-note">No smashes yet. Be the first Friend on the board!</div>
        )}

        {state === "ok" && (
          <ol style={list}>
            {rows.map((r) => (
              <li key={r.userId} className="page-row">
                <span className="num" style={rank}>
                  #{r.rank}
                </span>
                <span style={handle}>{r.handle || "anon-friend"}</span>
                <span className="num" style={score}>
                  {r.score.toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        )}

        <Link href="/" className="page-cta chunky" style={{ marginTop: 18 }}>
          BACK TO SMASHING
        </Link>
      </div>
    </main>
  );
}

const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 };
const rank: React.CSSProperties = { fontWeight: 800, width: 44, color: "var(--pink-deep)" };
const handle: React.CSSProperties = { fontWeight: 700, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const score: React.CSSProperties = { fontWeight: 800 };

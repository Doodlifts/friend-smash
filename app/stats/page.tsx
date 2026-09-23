"use client";

/* /stats — the connected Friend's recent run history (newest first). Read-only;
   pulls verified runs from /api/user-runs. Mirrors the leaderboard page's look. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { IconBack, IconTrophy } from "@/components/icons";

interface RunRow {
  id: string;
  score: number;
  lines: number;
  durationMs: number;
  finishedAt: string | null;
}

interface ModeRec { w: number; l: number }
interface MatchRow {
  id: string;
  mode: "speed" | "turf";
  opp: string;
  result: "won" | "lost" | "draw" | "void";
  myWins: number;
  oppWins: number;
  wager: number;
  endedAt: string;
}
interface VersusData {
  record: { w: number; l: number; speed: ModeRec; turf: ModeRec };
  matches: MatchRow[];
}

type LoadState = "loading" | "ok" | "empty" | "error" | "unauth";

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function StatsPage() {
  const { ready, authenticated, getAccessToken, login } = useAuth();
  const [rows, setRows] = useState<RunRow[]>([]);
  const [best, setBest] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [vs, setVs] = useState<VersusData | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const token = await getAccessToken();
      if (!token) {
        setVs(null);
        setState("unauth");
        return;
      }
      // Versus history rides alongside; if it fails the section just hides.
      fetch("/api/user-matches", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && d.record) setVs(d); })
        .catch(() => {});
      const res = await fetch("/api/user-runs", { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        setVs(null);
        setState("unauth");
        return;
      }
      if (!res.ok) {
        setState("error");
        return;
      }
      const data = await res.json();
      const list: RunRow[] = data.runs || [];
      setRows(list);
      setBest(list.reduce((m, r) => Math.max(m, r.score), 0));
      setState(list.length ? "ok" : "empty");
    } catch {
      setState("error");
    }
  }, [getAccessToken]);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      setVs(null); // never show a previous account's record on a shared device
      setState("unauth");
      return;
    }
    void load();
  }, [ready, authenticated, load]);

  return (
    <main className="page-wrap">
      <div className="page-card">
        <div className="page-titlerow">
          <Link href="/" className="page-back chunky" aria-label="Back to game">
            <IconBack />
          </Link>
          <div className="page-title">YOUR RUNS</div>
          <span style={{ width: 40 }} />
        </div>

        {state === "ok" && (
          <div style={summary}>
            <span>
              Best <b className="num">{best.toLocaleString()}</b>
            </span>
            <span>
              <b className="num">{rows.length}</b> run{rows.length === 1 ? "" : "s"}
            </span>
          </div>
        )}

        {state === "loading" && <div className="page-note">Loading your smashes…</div>}
        {state === "error" && (
          <div className="page-note">Couldn&apos;t load your runs. Give it another tap.</div>
        )}
        {state === "unauth" && (
          <div className="page-note">
            <div style={{ marginBottom: 12 }}>Connect your Rare Friend to see your run history.</div>
            <button className="page-cta chunky" style={{ maxWidth: 220, margin: "0 auto" }} onClick={() => login()}>
              CONNECT FRIEND
            </button>
          </div>
        )}
        {state === "empty" && (
          <div className="page-note">No ranked runs yet. Go smash some rows!</div>
        )}

        {state === "ok" && (
          <ol style={list}>
            {rows.map((r) => (
              <li key={r.id} className="page-row">
                <span className="num" style={score}>
                  {r.score.toLocaleString()}
                </span>
                <span style={meta}>
                  <span className="num">{r.lines}</span> line{r.lines === 1 ? "" : "s"} ·{" "}
                  <span className="num">{fmtDur(r.durationMs)}</span>
                </span>
                <span style={date}>{fmtDate(r.finishedAt)}</span>
              </li>
            ))}
          </ol>
        )}

        {vs && (vs.matches.length > 0 || vs.record.w + vs.record.l > 0) && (
          <>
            <div style={vsHead}>VERSUS <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.6, letterSpacing: 0 }}>· wagers in simulated RF</span></div>
            <div style={vsRecRow}>
              <span>
                SPEED SMASH <b className="num">{vs.record.speed.w}W&ndash;{vs.record.speed.l}L</b>
              </span>
              <span>
                TURF WAR <b className="num">{vs.record.turf.w}W&ndash;{vs.record.turf.l}L</b>
              </span>
            </div>
            <ol style={list}>
              {vs.matches.map((m) => (
                <li key={m.id} className="page-row">
                  <span style={{ ...badge, background: badgeBg[m.result] }}>{badgeLabel[m.result]}</span>
                  <span style={meta}>
                    {m.mode === "turf" ? "TURF WAR" : "SPEED SMASH"} vs {m.opp.toUpperCase()} ·{" "}
                    <span className="num">{m.myWins}&ndash;{m.oppWins}</span>
                  </span>
                  <span style={date}>
                    {m.wager > 0 && m.result === "won" && <b style={{ color: "var(--pink-deep)" }}>+{m.wager} RF </b>}
                    {m.wager > 0 && m.result === "lost" && <b>&minus;{m.wager} RF </b>}
                    {fmtDate(m.endedAt)}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}

        <div style={navRow}>
          <Link href="/leaderboard" className="page-cta ghost chunky" style={{ gap: 6 }}>
            <IconTrophy size={18} /> Leaderboard
          </Link>
          <Link href="/" className="page-cta chunky">
            BACK TO SMASHING
          </Link>
        </div>
      </div>
    </main>
  );
}

const summary: React.CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, opacity: 0.8, margin: "14px 2px 4px" };
const list: React.CSSProperties = { listStyle: "none", margin: "10px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 };
const score: React.CSSProperties = { fontWeight: 800, width: 70, color: "var(--pink-deep)" };
const meta: React.CSSProperties = { fontWeight: 600, flex: 1, fontSize: 13, opacity: 0.8 };
const date: React.CSSProperties = { fontWeight: 700, fontSize: 12, opacity: 0.6 };
const navRow: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, marginTop: 18 };
const vsHead: React.CSSProperties = { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, letterSpacing: ".06em", margin: "20px 2px 2px" };
const vsRecRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, opacity: 0.8, margin: "6px 2px 4px" };
const badge: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: "#fff", borderRadius: 8, padding: "3px 0", width: 46, textAlign: "center", flexShrink: 0 };
const badgeBg: Record<MatchRow["result"], string> = { won: "var(--pink-deep)", lost: "var(--ink)", draw: "#9a97a4", void: "#9a97a4" };
const badgeLabel: Record<MatchRow["result"], string> = { won: "WON", lost: "LOST", draw: "DRAW", void: "VOID" };

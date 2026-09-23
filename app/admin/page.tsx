"use client";

/* /admin — read-only economy ops dashboard (mock data, admin-gated).

   Shows circulation, the simulated 4-leg revenue split, and daily/weekly
   leaderboard pool previews. All numbers are MOCK (computed from the ledger);
   when the on-chain token ships, the same screen reads real data. No actions
   that move funds live here — by design. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { IconBack } from "@/components/icons";

type Period = "daily" | "weekly" | "all";
type AdminTab = "pulse" | "economy" | "ops" | "tuning" | "assets";
const ADMIN_TABS: { key: AdminTab; label: string }[] = [
  { key: "pulse", label: "PULSE" },
  { key: "economy", label: "ECONOMY" },
  { key: "ops", label: "OPS" },
  { key: "tuning", label: "TUNING" },
  { key: "assets", label: "ASSETS" },
];
interface Split { spend: number; dood: number; floor: number; leaderboard: number; team: number }
interface PoolEntry { rank: number; userId: string; handle: string | null; score: number; prize: number }
interface Metrics {
  source: string;
  circulation: { held: number; minted: number; sinks: number };
  split: Record<Period, Split>;
  pools: { daily: { pool: number; entries: PoolEntry[] }; weekly: { pool: number; entries: PoolEntry[] } };
  onchain: { chain: string; configured: boolean; settlement: string };
}

const OPS: { key: string; label: string }[] = [
  { key: "faucet", label: "Faucet: mint test RF (simulated)" },
  { key: "settlement", label: "Run period settlement" },
  { key: "buyback_burn", label: "$RAREFRIENDS buy & burn (sim)" },
  { key: "floor_buyback", label: "Friends floor buyback (sim)" },
];
type LoadState = "loading" | "ok" | "unauth" | "forbidden" | "error";

const n = (x: number) => x.toLocaleString();

export default function AdminPage() {
  const { ready, authenticated, getAccessToken, login } = useAuth();
  const [data, setData] = useState<Metrics | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [period, setPeriod] = useState<Period>("all");
  const [tab, setTab] = useState<AdminTab>("pulse");
  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [opMsg, setOpMsg] = useState<string | null>(null);

  const runOp = useCallback(
    async (action: string) => {
      setOpBusy(action);
      setOpMsg(null);
      try {
        const token = await getAccessToken();
        const res = await fetch("/api/admin/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ action }),
        });
        const d = await res.json().catch(() => ({}));
        setOpMsg(d.message || d.error || "Done.");
      } catch {
        setOpMsg("Couldn't reach the ops endpoint.");
      } finally {
        setOpBusy(null);
      }
    },
    [getAccessToken],
  );

  const [dropBusy, setDropBusy] = useState(false);
  const [dropMsg, setDropMsg] = useState<string | null>(null);
  const [dropAmt, setDropAmt] = useState(5000);
  const runAirdrop = useCallback(async () => {
    setDropBusy(true);
    setDropMsg(null);
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/admin/airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ amount: dropAmt }),
      });
      const d = await res.json().catch(() => ({}));
      setDropMsg(d.message || d.error || "Done.");
    } catch {
      setDropMsg("Couldn't reach the airdrop endpoint.");
    } finally {
      setDropBusy(false);
    }
  }, [getAccessToken, dropAmt]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const token = await getAccessToken();
      if (!token) return setState("unauth");
      const res = await fetch("/api/admin/metrics", { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) return setState("unauth");
      if (res.status === 403) return setState("forbidden");
      if (!res.ok) return setState("error");
      setData(await res.json());
      setState("ok");
    } catch {
      setState("error");
    }
  }, [getAccessToken]);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return setState("unauth");
    void load();
  }, [ready, authenticated, load]);

  const split = data?.split[period];

  return (
    <main className="page-wrap">
      <div style={s.card}>
        <div style={s.titleRow}>
          <Link href="/" className="page-back chunky" aria-label="Back to game"><IconBack /></Link>
          <div className="page-title" style={{ fontSize: 22 }}>OPS · ECONOMY</div>
          <span style={{ width: 40 }} />
        </div>
        <div style={s.badge}>
          {data ? `${data.source.toUpperCase()} DATA` : "ADMIN ONLY"} — read-only simulation
        </div>

        {state === "loading" && <div style={s.note}>Warming up the numbers…</div>}
        {state === "error" && <div style={s.note}>Couldn&apos;t load metrics. Try again.</div>}
        {state === "unauth" && (
          <div style={s.note}>
            <div style={{ marginBottom: 12 }}>Admin sign-in required.</div>
            <button className="chunky" style={s.signin} onClick={() => login()}>SIGN IN</button>
          </div>
        )}
        {state === "forbidden" && (
          <div style={s.note}>Your account isn&apos;t on the admin allowlist.</div>
        )}

        {state === "ok" && data && (
          <>
            {/* Tab bar — each tab's content mounts on demand */}
            <div style={{ ...s.tabs, marginTop: 14 }}>
              {ADMIN_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className="chunky"
                  style={{ ...s.tab, ...(tab === t.key ? s.tabActive : {}) }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* PULSE — player health at a glance */}
            {tab === "pulse" && <PlayerPulse getToken={getAccessToken} />}

            {tab === "economy" && (
            <>
            {/* Circulation */}
            <div style={s.section}>Circulation (simulated RF)</div>
            <div style={s.statRow}>
              <Stat label="Held" value={n(data.circulation.held)} />
              <Stat label="Minted" value={n(data.circulation.minted)} accent />
              <Stat label="Sinks" value={n(data.circulation.sinks)} />
            </div>
            <div style={s.hint}>
              &ldquo;Minted&rdquo; is total ever issued — the 1:1 liability if pre-token balances are ever honored.
            </div>

            {/* Revenue split (simulated) */}
            <div style={s.section}>Revenue split — simulated from store spend</div>
            <div style={s.tabs}>
              {(["daily", "weekly", "all"] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className="chunky"
                  style={{ ...s.tab, ...(period === p ? s.tabActive : {}) }}
                >
                  {p === "all" ? "All-time" : p === "daily" ? "Today" : "This week"}
                </button>
              ))}
            </div>
            {split && (
              <>
                <div className="num" style={s.spend}>{n(split.spend)} <span style={{ fontSize: 12 }}>RF spent (sim)</span></div>
                <div style={s.legs}>
                  <Leg label="$RAREFRIENDS buy & burn (sim)" pct="25%" value={n(split.dood)} />
                  <Leg label="Friends floor buyback (sim)" pct="20%" value={n(split.floor)} />
                  <Leg label="Leaderboard rewards" pct="35%" value={n(split.leaderboard)} hi />
                  <Leg label="Team" pct="20%" value={n(split.team)} />
                </div>
              </>
            )}

            {/* Pool previews */}
            <div style={s.section}>Leaderboard pool preview</div>
            <PoolBlock title="Daily" pool={data.pools.daily} />
            <PoolBlock title="Weekly" pool={data.pools.weekly} />
            </>
            )}

            {tab === "ops" && (
            <>
            {/* Mock economy — instant, idempotent, ledger-only */}
            <div style={s.section}>Mock economy</div>
            <div style={s.opsStatus}>
              Grants simulated RF on the ledger — the same rail the shop and wagers spend. One grant per user per day
              (re-clicks can&apos;t double-pay). No on-chain movement.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <input
                type="number" min={1} max={100000} value={dropAmt}
                onChange={(e) => setDropAmt(Math.max(1, Math.min(100000, Math.floor(Number(e.target.value) || 0))))}
                aria-label="Airdrop amount"
                style={{ width: 110, border: "2.5px solid var(--ink)", borderRadius: 12, padding: "8px 10px", fontWeight: 800, fontFamily: "var(--font)", fontSize: 15, textAlign: "center" }}
              />
              <button className="chunky" style={{ ...s.opBtn, flex: 1 }} disabled={dropBusy} onClick={() => void runAirdrop()}>
                {dropBusy ? "…" : "AIRDROP TO ALL USERS"}
              </button>
            </div>
            {dropMsg && <div style={s.opMsg}>{dropMsg}</div>}

            {/* Operations — devnet executes directly; mainnet → Squads proposal */}
            <div style={s.section}>Operations</div>
            <div style={s.opsStatus}>
              {data.onchain.configured
                ? `On-chain: ${data.onchain.chain} · settlement ${data.onchain.settlement}`
                : "Simulated RF — no on-chain operations in this build (see lib/rf/settlement.ts)."}
            </div>
            <div style={s.opsGrid}>
              {OPS.map((o) => (
                <button key={o.key} className="chunky" style={s.opBtn} disabled={opBusy === o.key} onClick={() => runOp(o.key)}>
                  {opBusy === o.key ? "…" : o.label}
                </button>
              ))}
            </div>
            {opMsg && <div style={s.opMsg}>{opMsg}</div>}
            <div style={s.hint}>
              On devnet these execute directly; on mainnet they create a Squads multisig proposal — never a hot-key transaction.
            </div>
            </>
            )}

            {/* TUNING — self-serve gameplay knobs (no code changes needed) */}
            {tab === "tuning" && (
            <>
            <div style={s.section}>Game tuning</div>
            <TuningPanel getToken={getAccessToken} />
            </>
            )}

            {/* ASSETS — swap visual assets without a deploy */}
            {tab === "assets" && <AssetsPanel getToken={getAccessToken} />}
          </>
        )}

        <Link href="/" className="chunky" style={s.playBtn}>BACK TO SMASHING</Link>
      </div>
    </main>
  );
}

interface TuningDoc {
  bonus: {
    enabled: boolean;
    fillGuts?: number;
    fillLines?: number;
    arrowCount: number;
    swordSlashes: number;
    ratCount?: number;
    bananaShots?: number;
    pointsPerBlock: number;
  };
  gore: { intensity: number };
  drops: { enabled: boolean; rate: number; minScore: number };
}

/** Editable gameplay knobs. Saved values are sanitized server-side into hard
 *  bounds; ranked runs snapshot the config at run start, so edits only affect
 *  NEW runs (in-flight runs still verify). */
function TuningPanel({ getToken }: { getToken: () => Promise<string | null> }) {
  const [doc, setDoc] = useState<TuningDoc | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch("/api/admin/config", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (res.ok) setDoc((await res.json()).config);
        else setMsg("Couldn't load tuning.");
      } catch {
        setMsg("Couldn't load tuning.");
      }
    })();
  }, [getToken]);

  const save = async () => {
    if (!doc) return;
    setBusy(true);
    setMsg(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ config: doc }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.config) {
        setDoc(d.config);
        setMsg("Saved ✓ — applies to new runs.");
      } else setMsg(d.error || "Save failed.");
    } catch {
      setMsg("Save failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!doc) return <div style={s.hint}>{msg || "Warming up the knobs…"}</div>;

  const Num = ({ label, value, step, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) => (
    <label style={s.tuneRow}>
      <span style={s.tuneLabel}>{label}</span>
      <input
        style={s.tuneInput}
        type="number"
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
  const Flag = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
    <label style={s.tuneRow}>
      <span style={s.tuneLabel}>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ width: 20, height: 20 }} />
    </label>
  );

  return (
    <div>
      <Flag label="Bonus rounds enabled" value={doc.bonus.enabled} onChange={(v) => setDoc({ ...doc, bonus: { ...doc.bonus, enabled: v } })} />
      <Num
        label="Meter: guts to fill (single 2 · double 5 · triple 9 · tetris 14)"
        value={doc.bonus.fillGuts ?? 20}
        onChange={(v) => setDoc({ ...doc, bonus: { ...doc.bonus, fillGuts: v, fillLines: undefined } })}
      />
      <Num label="Arrows per round" value={doc.bonus.arrowCount} onChange={(v) => setDoc({ ...doc, bonus: { ...doc.bonus, arrowCount: v } })} />
      <Num label="Sword slashes" value={doc.bonus.swordSlashes} onChange={(v) => setDoc({ ...doc, bonus: { ...doc.bonus, swordSlashes: v } })} />
      <Num label="Rats per attack" value={doc.bonus.ratCount ?? 6} onChange={(v) => setDoc({ ...doc, bonus: { ...doc.bonus, ratCount: v } })} />
      <Num label="Banana shots" value={doc.bonus.bananaShots ?? 10} onChange={(v) => setDoc({ ...doc, bonus: { ...doc.bonus, bananaShots: v } })} />
      <Num label="Bonus points / block (×level)" value={doc.bonus.pointsPerBlock} onChange={(v) => setDoc({ ...doc, bonus: { ...doc.bonus, pointsPerBlock: v } })} />
      <Num label="Effects intensity (0.25–2)" value={doc.gore.intensity} step={0.25} onChange={(v) => setDoc({ ...doc, gore: { intensity: v } })} />
      <Flag label="Item drops enabled" value={doc.drops.enabled} onChange={(v) => setDoc({ ...doc, drops: { ...doc.drops, enabled: v } })} />
      <Num label="Drop rate (0–0.5)" value={doc.drops.rate} step={0.01} onChange={(v) => setDoc({ ...doc, drops: { ...doc.drops, rate: v } })} />
      <Num label="Drop min score" value={doc.drops.minScore} step={50} onChange={(v) => setDoc({ ...doc, drops: { ...doc.drops, minScore: v } })} />
      <button className="chunky" style={{ ...s.opBtn, width: "100%", marginTop: 10 }} disabled={busy} onClick={save}>
        {busy ? "Saving…" : "SAVE TUNING"}
      </button>
      {msg && <div style={s.opMsg}>{msg}</div>}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ ...s.stat, ...(accent ? s.statAccent : {}) }}>
      <div className="num" style={s.statVal}>{value}</div>
      <div style={s.statLab}>{label}</div>
    </div>
  );
}

function Leg({ label, pct, value, hi }: { label: string; pct: string; value: string; hi?: boolean }) {
  return (
    <div style={{ ...s.leg, ...(hi ? s.legHi : {}) }}>
      <span style={s.legLabel}>{label} <span style={s.legPct}>{pct}</span></span>
      <span className="num" style={s.legVal}>{value}</span>
    </div>
  );
}

function PoolBlock({ title, pool }: { title: string; pool: { pool: number; entries: PoolEntry[] } }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={s.poolHead}>
        <span style={{ fontWeight: 800 }}>{title}</span>
        <span className="num" style={{ fontWeight: 800, color: "var(--pink-deep)" }}>{n(pool.pool)} RF (sim)</span>
      </div>
      {pool.entries.length === 0 ? (
        <div style={{ ...s.note, padding: "8px" }}>No qualifying players yet.</div>
      ) : (
        <ol style={s.list}>
          {pool.entries.map((e) => (
            <li key={e.userId} style={s.row}>
              <span className="num" style={s.rank}>#{e.rank}</span>
              <span style={s.handle}>{e.handle || "anon-friend"}</span>
              <span className="num" style={s.rowScore}>{n(e.score)}</span>
              <span className="num" style={s.prize}>+{n(e.prize)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const ink = "var(--ink)";
const s: Record<string, React.CSSProperties> = {
  card: { background: "var(--panel-solid)", border: `3px solid ${ink}`, borderRadius: "var(--r-card)", boxShadow: "var(--sh-card)", padding: "20px 20px 22px", maxWidth: 460, width: "100%" },
  titleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  badge: { textAlign: "center", fontSize: 10, fontWeight: 800, letterSpacing: 1, opacity: 0.6, margin: "8px 0 4px", textTransform: "uppercase" },
  note: { textAlign: "center", fontWeight: 600, fontSize: 13, opacity: 0.8, padding: "22px 8px" },
  section: { fontWeight: 800, fontSize: 12, letterSpacing: 1, opacity: 0.6, textTransform: "uppercase", margin: "16px 2px 8px" },
  statRow: { display: "flex", gap: 8 },
  stat: { flex: 1, textAlign: "center", padding: "10px 6px", borderRadius: 14, border: `2px solid ${ink}`, background: "var(--surface)" },
  statAccent: { background: "var(--surface-pink)", borderColor: "var(--pink)" },
  statVal: { fontWeight: 800, fontSize: 18 },
  statLab: { fontWeight: 700, fontSize: 10, opacity: 0.6, letterSpacing: 1, textTransform: "uppercase" },
  hint: { fontSize: 11, fontWeight: 600, opacity: 0.65, margin: "8px 2px 0", lineHeight: 1.5 },
  opsStatus: { fontSize: 12, fontWeight: 700, opacity: 0.75, margin: "0 2px 8px" },
  opsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  opBtn: {
    height: 44,
    borderRadius: 12,
    border: `2.5px solid ${ink}`,
    background: "var(--surface-purple)",
    fontFamily: "var(--font)",
    fontWeight: 800,
    fontSize: 12.5,
    color: ink,
    boxShadow: `0 3px 0 ${ink}`,
    cursor: "pointer",
    padding: "0 8px",
  },
  opMsg: {
    marginTop: 10,
    padding: "10px 12px",
    borderRadius: 12,
    border: `2px dashed var(--pink)`,
    background: "var(--surface-pink)",
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.5,
  },
  tuneRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "6px 2px" },
  tuneLabel: { fontWeight: 700, fontSize: 13 },
  tuneInput: { width: 90, height: 36, borderRadius: 10, border: `2.5px solid ${ink}`, padding: "0 10px", fontFamily: "var(--font)", fontWeight: 700, fontSize: 14, textAlign: "right" as const },
  tabs: { display: "flex", gap: 6, marginBottom: 10 },
  tab: { flex: 1, height: 40, borderRadius: "var(--r-row)", border: `2.5px solid ${ink}`, background: "var(--surface-purple)", fontFamily: "var(--font)", fontWeight: 800, fontSize: 12, color: ink, boxShadow: "var(--sh-ctl)", cursor: "pointer" },
  tabActive: { background: "var(--grad-pink)", color: "#fff" },
  spend: { textAlign: "center", fontWeight: 800, fontSize: 22, margin: "2px 0 10px" },
  legs: { display: "flex", flexDirection: "column", gap: 6 },
  leg: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: 12, border: `2px solid ${ink}`, background: "var(--surface)" },
  legHi: { background: "var(--surface-pink)", borderColor: "var(--pink)" },
  legLabel: { fontWeight: 700, fontSize: 13 },
  legPct: { fontWeight: 700, fontSize: 11, opacity: 0.5 },
  legVal: { fontWeight: 800 },
  poolHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 2px 4px" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5 },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 10, border: `2px solid ${ink}`, background: "var(--surface)", fontSize: 13 },
  rank: { fontWeight: 800, width: 34, color: "var(--pink-deep)" },
  handle: { fontWeight: 700, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowScore: { fontWeight: 600, opacity: 0.7, width: 60, textAlign: "right" },
  prize: { fontWeight: 800, width: 64, textAlign: "right" },
  signin: { height: 48, padding: "0 24px", borderRadius: 16, border: `3px solid ${ink}`, background: "var(--grad-pink)", color: "#fff", fontFamily: "var(--font)", fontWeight: 800, fontSize: 16, WebkitTextStroke: `1px ${ink}`, boxShadow: `0 5px 0 ${ink}`, cursor: "pointer" },
  playBtn: { display: "block", marginTop: 18, height: 52, lineHeight: "52px", textAlign: "center", borderRadius: 16, border: `3px solid ${ink}`, background: "var(--grad-purple)", color: "#fff", fontWeight: 800, fontSize: 18, WebkitTextStroke: `1px ${ink}`, boxShadow: `0 5px 0 ${ink}`, textDecoration: "none" },
};

/* ================= Player pulse (health at a glance) ================= */

interface PulseDto {
  activity: { dau: number; wau: number; mau: number; stickiness: number | null; runsToday: number; totalUsers: number; newUsers7d: number };
  daily: Array<{ day: string; actives: number; runs: number; verified: number; abandoned: number }>;
  retention: { d1: number | null; d7: number | null; cohort1: number; cohort7: number };
  quality: { medianDurationMs: number | null; medianScore: number | null; bestToday: number | null; best7d: number | null; verified7d: number; abandonRate7d: number | null; runsPerActive7d: number | null; bonusRounds7d: number };
  economy: { circulating: number; spentAll: number; spent7d: number; payers: number; payerRate: number | null; spendPerPayer: number | null; itemSales: Array<{ key: string; buys: number; smash: number }>; topSpenders: Array<{ handle: string; spent: number }>; powerupsUsed7d: Array<{ key: string; used: number }> };
  versus?: {
    activeNow: number; queuedNow: number; matches7d: number; fighters7d: number;
    modes: Array<{ mode: string; total: number; settled: number; aborted: number; draws: number }>;
    turfEndings: Array<{ reason: string; n: number }>;
    money: { escrowed: number; paidOut: number; refunded: number };
    daily: Array<{ day: string; speed: number; turf: number }>;
  };
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const dur = (ms: number | null) => {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Single-series bar chart: brand pink (validated), rounded data-ends on the
 *  baseline, hover tooltip, direct labels on max + latest only. */
function Bars({ title, data, fmt = n }: { title: string; data: Array<{ day: string; v: number }>; fmt?: (v: number) => string }) {
  const [tip, setTip] = useState<{ x: number; i: number } | null>(null);
  const W = 400, H = 96, PAD = 2, TOP = 16;
  const max = Math.max(1, ...data.map((d) => d.v));
  const bw = (W - PAD * (data.length - 1)) / data.length;
  const maxI = data.findIndex((d) => d.v === max);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={pp.chartTitle}>{title}</div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label={title}>
          <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} stroke="rgba(38,36,46,.25)" strokeWidth={1} />
          {data.map((d, i) => {
            const h = d.v > 0 ? Math.max(3, Math.round((d.v / max) * (H - TOP))) : 0;
            const x = i * (bw + PAD);
            const y = H - h;
            const r = Math.min(3, bw / 2);
            return (
              <g key={d.day}>
                {h > 0 && (
                  <path d={`M${x},${H} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H} Z`} fill="#ee5fa5" />
                )}
                <rect
                  x={x - PAD / 2} y={0} width={bw + PAD} height={H} fill="transparent"
                  onMouseEnter={() => setTip({ x: x + bw / 2, i })}
                  onMouseLeave={() => setTip(null)}
                />
                {(i === maxI || i === data.length - 1) && d.v > 0 && (
                  <text x={Math.min(W - 12, Math.max(12, x + bw / 2))} y={y - 4} textAnchor="middle" fontFamily="var(--font)" fontWeight={800} fontSize={9} fill={ink}>
                    {fmt(d.v)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <div style={{ ...pp.tip, left: `${(tip.x / W) * 100}%` }}>
            {data[tip.i].day.slice(5)} · {fmt(data[tip.i].v)}
          </div>
        )}
      </div>
      <div style={pp.axis}><span>{data[0]?.day.slice(5)}</span><span>today</span></div>
    </div>
  );
}

function MiniTable({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div style={pp.mini}>
      <div style={pp.miniTitle}>{title}</div>
      {rows.length === 0 && <div style={pp.miniEmpty}>nothing yet</div>}
      {rows.map(([k, v]) => (
        <div key={k} style={pp.miniRow}><span style={pp.miniKey}>{k}</span><span className="num" style={pp.miniVal}>{v}</span></div>
      ))}
    </div>
  );
}

function PlayerPulse({ getToken }: { getToken: () => Promise<string | null> }) {
  const [m, setM] = useState<PulseDto | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const token = await getToken();
        if (!token) return setErr(true);
        const res = await fetch("/api/admin/player-metrics", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return setErr(true);
        const data = await res.json();
        setM(data.metrics as PulseDto);
      } catch {
        setErr(true);
      }
    })();
  }, [getToken]);

  if (err) return <div style={s.hint}>Player pulse couldn&apos;t load.</div>;
  if (!m) return <div style={s.hint}>Taking the player pulse…</div>;

  const a = m.activity, r = m.retention, q = m.quality, e = m.economy;
  return (
    <>
      <div style={s.section}>Player pulse</div>
      <div style={s.statRow}>
        <Stat label="DAU" value={n(a.dau)} accent />
        <Stat label="WAU" value={n(a.wau)} />
        <Stat label="MAU" value={n(a.mau)} />
        <Stat label="Stickiness" value={pct(a.stickiness)} />
      </div>
      <div style={s.statRow}>
        <Stat label="D1 retention" value={pct(r.d1)} accent />
        <Stat label="D7 retention" value={pct(r.d7)} />
        <Stat label="New (7d)" value={n(a.newUsers7d)} />
        <Stat label="Players total" value={n(a.totalUsers)} />
      </div>
      <div style={pp.hintTight}>
        retention cohorts: {n(r.cohort1)} / {n(r.cohort7)} players old enough to measure
      </div>

      <Bars title="Active players — last 30 days" data={m.daily.map((d) => ({ day: d.day, v: d.actives }))} />
      <Bars title="Runs — last 30 days" data={m.daily.map((d) => ({ day: d.day, v: d.runs }))} />
      <details style={pp.details}>
        <summary style={pp.summary}>view daily data</summary>
        <div style={pp.tableWrap}>
          {m.daily.map((d) => (
            <div key={d.day} style={pp.miniRow}>
              <span style={pp.miniKey}>{d.day.slice(5)}</span>
              <span className="num" style={pp.miniVal}>{d.actives} players · {d.runs} runs · {d.verified} ✓ · {d.abandoned} ✕</span>
            </div>
          ))}
        </div>
      </details>

      <div style={s.section}>Session quality (7d)</div>
      <div style={s.statRow}>
        <Stat label="Median run" value={dur(q.medianDurationMs)} />
        <Stat label="Median score" value={q.medianScore === null ? "—" : n(Math.round(q.medianScore))} />
        <Stat label="Best (7d)" value={q.best7d === null ? "—" : n(q.best7d)} accent />
        <Stat label="Runs / player" value={q.runsPerActive7d === null ? "—" : q.runsPerActive7d.toFixed(1)} />
      </div>
      <div style={s.statRow}>
        <Stat label="Verified (7d)" value={n(q.verified7d)} />
        <Stat label="Abandon rate" value={pct(q.abandonRate7d)} />
        <Stat label="Bonus rounds" value={n(q.bonusRounds7d)} accent />
        <Stat label="Best today" value={q.bestToday === null ? "—" : n(q.bestToday)} />
      </div>
      <div style={pp.hintTight}>
        abandon rate counts restarts AND rage-quits — watch the trend, not the number
      </div>

      <div style={s.section}>Spending</div>
      <div style={s.statRow}>
        <Stat label="Spent (7d)" value={n(e.spent7d)} accent />
        <Stat label="Spent all-time" value={n(e.spentAll)} />
        <Stat label="Payers" value={`${n(e.payers)} (${pct(e.payerRate)})`} />
        <Stat label="Per payer" value={e.spendPerPayer === null ? "—" : n(Math.round(e.spendPerPayer))} />
      </div>
      <div style={pp.miniGrid}>
        <MiniTable title="What sells" rows={e.itemSales.map((i) => [i.key, `${n(i.buys)} buys · ${n(i.smash)}`])} />
        <MiniTable title="Top spenders" rows={e.topSpenders.map((t) => [t.handle, n(t.spent)])} />
        <MiniTable title="Power-ups used (7d)" rows={e.powerupsUsed7d.map((p) => [p.key, n(p.used)])} />
      </div>

      {m.versus && (
        <>
          <div style={s.section}>Versus</div>
          <div style={s.statRow}>
            <Stat label="Live now" value={n(m.versus.activeNow)} accent />
            <Stat label="In queue" value={n(m.versus.queuedNow)} />
            <Stat label="Matches (7d)" value={n(m.versus.matches7d)} />
            <Stat label="Fighters (7d)" value={n(m.versus.fighters7d)} />
          </div>
          <Bars
            title="Matches — last 14 days"
            data={m.versus.daily.map((d) => ({ day: d.day, v: d.speed + d.turf }))}
          />
          <div style={pp.miniGrid}>
            <MiniTable
              title="By mode"
              rows={m.versus.modes.map((md) => [
                md.mode === "turf" ? "TURF WAR" : "SPEED SMASH",
                `${n(md.settled)} settled · ${n(md.aborted)} void` + (md.draws ? ` · ${n(md.draws)} draws` : ""),
              ])}
            />
            <MiniTable title="How turf matches end" rows={m.versus.turfEndings.map((t) => [t.reason, n(t.n)])} />
            <MiniTable
              title="Wager flow (simulated RF)"
              rows={[
                ["escrowed", n(m.versus.money.escrowed)],
                ["paid out", n(m.versus.money.paidOut)],
                ["refunded", n(m.versus.money.refunded)],
              ]}
            />
          </div>
        </>
      )}
    </>
  );
}

const pp: Record<string, React.CSSProperties> = {
  chartTitle: { fontWeight: 800, fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.6, textAlign: "left", marginBottom: 4 },
  axis: { display: "flex", justifyContent: "space-between", fontSize: 10, fontWeight: 700, opacity: 0.45, marginTop: 2 },
  tip: { position: "absolute", top: -6, transform: "translate(-50%, -100%)", background: "#fff", border: `2px solid ${ink}`, borderRadius: 8, boxShadow: `0 2px 0 ${ink}`, padding: "3px 8px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 5 },
  hintTight: { fontSize: 11, fontWeight: 600, opacity: 0.5, textAlign: "left", marginTop: 6 },
  details: { marginTop: 8, textAlign: "left" },
  summary: { fontSize: 11, fontWeight: 800, opacity: 0.55, cursor: "pointer" },
  tableWrap: { maxHeight: 180, overflowY: "auto", marginTop: 6 },
  miniGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 10, marginTop: 10 },
  mini: { border: `2px solid ${ink}`, borderRadius: 12, padding: "9px 12px", textAlign: "left", background: "var(--panel-solid)", boxShadow: `0 3px 0 ${ink}` },
  miniTitle: { fontWeight: 800, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.55, marginBottom: 6 },
  miniEmpty: { fontSize: 12, fontWeight: 600, opacity: 0.45 },
  miniRow: { display: "flex", justifyContent: "space-between", gap: 10, padding: "3px 0", fontSize: 13 },
  miniKey: { fontWeight: 700 },
  miniVal: { fontWeight: 800 },
};

/* ================= ASSETS =================
   Piece art is no longer uploaded here: every block is drawn from the
   player's on-chain Rare Friends portrait (16x16 one-bit sprites). */

function AssetsPanel(_props: { getToken: () => Promise<string | null> }) {
  return (
    <>
      <div style={s.section}>Piece art</div>
      <div className="page-note" style={{ padding: "10px 4px", textAlign: "left" }}>
        Piece art is generated from on-chain Rare Friends portraits — there is nothing to upload.
      </div>
    </>
  );
}

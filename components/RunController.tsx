"use client";

/* components/RunController.tsx — bridges the engine to the run API.

   Lives in the auth tree (separate from <Game/>). It:
   - exposes window.__RFSMASH_RUN = { takeRun, finish } for the engine,
   - prefetches a server-sanctioned run (seed + signed token) while the player
     is idle and authenticated, so PLAY starts a ranked, deterministic game,
   - submits finished runs to /api/run/finish for SERVER-AUTHORITATIVE scoring,
   - shows a post-game panel with the verified score + leaderboard rank.

   RANKED (daily prize pool): when the player's ranked toggle is on, taking a
   run for a new game also pays its SIMULATED entry via /api/pool/enter
   (40 RF to today's pool, 10 RF burned). If entry fails (not enough RF,
   ownership no longer verifies) the game simply continues as practice. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getRankedPref } from "@/lib/rf/rankedPref";
import { formatRf } from "@/lib/rf/format";

export default function RunController() {
  return <RunControllerInner />;
}

interface PrefetchedRun {
  seed: number;
  runId: string;
  runToken: string;
  /** Game-config snapshot this run must be played with (replay verifies against it). */
  config?: unknown;
}

interface RankResult {
  ok: boolean;
  status: string;
  score: number;
  lines: number;
  rank: number | null;
  reason?: string;
  /** Rare power-up drop won on this verified run (server-rolled), if any. */
  drop?: { key: string; name: string } | null;
  ranked?: boolean;
  poolRank?: number | null;
}

function RunControllerInner() {
  const { ready, authenticated, getAccessToken } = useAuth();
  const pending = useRef<PrefetchedRun | null>(null);
  // Last-known access token, kept warm so page-teardown sends (pagehide
  // abandon) don't depend on an async token fetch completing in time.
  const tokenRef = useRef<string | null>(null);
  const [result, setResult] = useState<RankResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Pay the ranked entry for a run the engine just took (fire-and-forget; the
  // server refuses power-ups on a ranked run, and the tray hides immediately).
  const enterRanked = useCallback(
    async (runId: string) => {
      window.__RF_RUN_RANKED = true;
      try {
        const token = (await getAccessToken().catch(() => null)) || tokenRef.current;
        if (!token) throw new Error("Sign in again to play ranked.");
        const res = await fetch("/api/pool/enter", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ runId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Ranked entry failed.");
        setNotice(`ranked · ${formatRf(data.balance)} rf left`);
      } catch (e) {
        window.__RF_RUN_RANKED = false;
        setNotice(`${e instanceof Error ? e.message : "Ranked entry failed."} Practice run.`);
      } finally {
        window.dispatchEvent(new CustomEvent("rfsmash:me-changed"));
        window.setTimeout(() => setNotice(null), 3500);
      }
    },
    [getAccessToken],
  );

  const prefetch = useCallback(async () => {
    if (!authenticated) return;
    if (pending.current) return;
    try {
      const token = await getAccessToken();
      if (!token) return;
      tokenRef.current = token;
      const res = await fetch("/api/run/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: "{}",
      });
      if (!res.ok) return; // unconfigured (503) / unauthorized — play unranked
      const data = await res.json();
      if (data && typeof data.seed === "number" && data.runId && data.runToken) {
        pending.current = { seed: data.seed, runId: data.runId, runToken: data.runToken, config: data.config ?? null };
      }
    } catch {
      /* offline / not configured — fall back to unranked play */
    }
  }, [authenticated, getAccessToken]);

  // FINISH DELIVERY MUST NOT LOSE SCORES. The classic mobile failure: the
  // player dies, sees the score, and backgrounds/kills the tab — the plain
  // fetch dies with the page, the run stays open forever, and the verified
  // score never lands (found as long "abandoned" runs in the DB). Defenses:
  //  1. keepalive fetch when the body fits the keepalive cap (survives teardown)
  //  2. two in-page retries with backoff (network blips, transient 5xx)
  //  3. the payload is stashed in sessionStorage and re-sent on the NEXT
  //     visit if delivery never confirmed (run tokens stay valid for 2h)
  const PENDING_KEY = "rfsmashPendingFinish";
  const finish = useCallback(
    async (payload: {
      runId: string;
      runToken: string;
      seed: number;
      summary: unknown;
      log: unknown;
    }) => {
      const body = JSON.stringify(payload);
      try {
        sessionStorage.setItem(PENDING_KEY, body); // cleared on confirmed delivery
      } catch {}
      const attempt = async (): Promise<RankResult | null> => {
        const token = (await getAccessToken().catch(() => null)) || tokenRef.current;
        if (!token) return null;
        tokenRef.current = token;
        const res = await fetch("/api/run/finish", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
          keepalive: body.length < 55_000, // keepalive caps bodies (~64KB); long logs use a normal fetch
        });
        if (res.status === 429) return null; // retry after backoff
        return (await res.json().catch(() => null)) as RankResult | null;
      };
      try {
        let data: RankResult | null = null;
        for (let i = 0; i < 3 && !data; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, i === 1 ? 2000 : 6000));
          data = await attempt().catch(() => null);
        }
        if (data) {
          try {
            sessionStorage.removeItem(PENDING_KEY); // delivered (verified OR rejected)
          } catch {}
          setResult(data);
        }
        // Tell other surfaces (AuthBar) the balance may have changed.
        window.dispatchEvent(new CustomEvent("rfsmash:me-changed"));
      } catch {
        /* pending stash survives — re-sent on the next visit */
      } finally {
        // Get a fresh run ready for the next game.
        void prefetch();
      }
    },
    [getAccessToken, prefetch],
  );

  // Re-send a finish that never confirmed delivery (tab killed mid-send).
  useEffect(() => {
    if (!(ready && authenticated)) return;
    let stash: string | null = null;
    try {
      stash = sessionStorage.getItem(PENDING_KEY);
    } catch {}
    if (!stash) return;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/run/finish", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: stash,
        });
        // Any server verdict (incl. "already finished") settles the pending run.
        if (res.status !== 429) {
          try {
            sessionStorage.removeItem(PENDING_KEY);
          } catch {}
          const data = (await res.json().catch(() => null)) as RankResult | null;
          if (data && data.ok) setResult(data); // surface a rescued score
          window.dispatchEvent(new CustomEvent("rfsmash:me-changed"));
        }
      } catch {
        /* still pending — will retry next visit */
      }
    })();
  }, [ready, authenticated, getAccessToken]);

  // Quit/restart mid-run: report the abandoned run so used power-ups are
  // consumed server-side (otherwise they'd "come back" on the next refresh).
  // `beacon` = the page is going away: use the cached token synchronously and
  // a keepalive fetch (the engine sends a minimal powerup-only log — keepalive
  // bodies are size-capped).
  const abandon = useCallback(
    async (payload: { runId: string; runToken: string; log: unknown; beacon?: boolean }) => {
      try {
        const token = payload.beacon ? tokenRef.current : (tokenRef.current = await getAccessToken());
        if (!token) return;
        const { beacon, ...body } = payload;
        await fetch("/api/run/abandon", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          keepalive: beacon === true,
        });
        window.dispatchEvent(new CustomEvent("rfsmash:me-changed"));
      } catch {
        /* best-effort — use-time consumption already settled the spends */
      } finally {
        void prefetch();
      }
    },
    [getAccessToken, prefetch],
  );

  // USE-TIME power-up settlement: the engine reports each activation the
  // moment it happens ({key, n} with n = cumulative uses this run) and the
  // server decrements inventory immediately — so a reload/killed tab can
  // never "refund" a spent power-up. Idempotent on n; finish/abandon
  // reconcile whatever this misses (e.g. an offline blip).
  const consume = useCallback(
    async (payload: { runId: string; runToken: string; key: string; n: number }) => {
      try {
        // Prefer a FRESH token (the wallet session refreshes expired ones) — a cached token
        // can outlive its ~1h TTL mid-run and silently 401 every settlement.
        const token = (await getAccessToken().catch(() => null)) || tokenRef.current;
        if (!token) return;
        tokenRef.current = token;
        await fetch("/api/run/powerup", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
          keepalive: true, // tiny body; survives page teardown
        });
      } catch {
        /* best-effort — finish/abandon reconciliation covers it */
      }
    },
    [getAccessToken],
  );

  // Install the bridge for the engine to call.
  useEffect(() => {
    window.__RFSMASH_RUN = {
      takeRun: () => {
        const r = pending.current;
        pending.current = null;
        window.__RF_RUN_RANKED = false;
        if (!r) void prefetch(); // none ready — refill for next time
        else if (getRankedPref()) void enterRanked(r.runId);
        return r;
      },
      finish: (payload) => {
        void finish(payload);
      },
      abandon: (payload) => {
        void abandon(payload);
      },
      consume: (payload) => {
        void consume(payload);
      },
    };
    return () => {
      delete window.__RFSMASH_RUN;
    };
  }, [finish, prefetch, abandon, consume, enterRanked]);

  // Prefetch when the user becomes authenticated / ready.
  useEffect(() => {
    if (ready && authenticated) void prefetch();
  }, [ready, authenticated, prefetch]);

  if (!result && !notice) return null;
  if (!result)
    return (
      <div
        role="status"
        style={{
          position: "fixed",
          bottom: "calc(env(safe-area-inset-bottom,0px) + 150px)",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 35,
          background: "var(--ink)",
          color: "var(--signal, #CCFF00)",
          fontFamily: "var(--font-display, var(--font))",
          fontSize: 11,
          padding: "8px 12px",
          border: "2px solid var(--signal, #CCFF00)",
          maxWidth: "88vw",
          textAlign: "center",
          pointerEvents: "none",
        }}
      >
        {notice}
      </div>
    );

  return (
    <div
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top,0px) + 52px)",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 35,
        background: "var(--panel-solid)",
        border: "3px solid var(--ink)",
        borderRadius: "var(--r-cta)",
        boxShadow: "var(--sh-cta)",
        padding: "10px 16px",
        fontFamily: "var(--font)",
        color: "var(--ink)",
        textAlign: "center",
        maxWidth: "86vw",
      }}
      onClick={() => setResult(null)}
      role="status"
    >
      {result.ok ? (
        <>
          <div style={{ fontWeight: 800, fontSize: 15 }}>
            Score <span className="num">{result.score.toLocaleString()}</span>
          </div>
          <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.75 }}>
            {result.ranked
              ? result.poolRank
                ? `Ranked · #${result.poolRank} in today's RF pool`
                : "Ranked entry counted"
              : result.rank
                ? `Practice · #${result.rank} all-time`
                : "Submitted!"}
          </div>
          {result.drop && (
            <div
              style={{
                fontWeight: 800,
                fontSize: 15,
                color: "#fff",
                background: "var(--grad-pink)",
                border: "2.5px solid var(--ink)",
                borderRadius: 12,
                boxShadow: "var(--sh-ctl)",
                padding: "6px 12px",
                marginTop: 6,
              }}
            >
              RARE DROP! You won a {result.drop.name}!
            </div>
          )}
        </>
      ) : (
        <div style={{ fontWeight: 700, fontSize: 12, color: "var(--pink-deep)" }}>
          Run not verified{result.reason ? `: ${result.reason}` : ""}
        </div>
      )}
      <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.5, marginTop: 2 }}>tap to dismiss</div>
    </div>
  );
}

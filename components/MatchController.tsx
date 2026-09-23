"use client";

/* components/MatchController.tsx — bridges the engine to the VERSUS API.

   Same role as RunController but for matches: exposes window.__DOOPIE_MATCH,
   runs the 2s state poll while the lobby or a match is live, throttles
   heartbeats, and delivers round submissions with the keepalive + retry +
   sessionStorage-stash discipline (a killed tab must never lose a round —
   there's a wager riding on it). Renders nothing. */

import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

const POLL_MS = 2_000;
const POLL_TURF_MS = 1_000; // turn-based needs a snappier handoff
const HEARTBEAT_MS = 2_000;
const PENDING_KEY = "doopiePendingRound";

export default function MatchController() {
  return <MatchControllerInner />;
}

function MatchControllerInner() {
  const { ready, authenticated, getAccessToken } = useAuth();
  const tokenRef = useRef<string | null>(null);
  const latestRef = useRef<unknown>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBeat = useRef(0);
  const clockOffset = useRef(0); // serverNow - Date.now()

  const authedFetch = useCallback(
    async (url: string, init?: RequestInit & { keepalive?: boolean }) => {
      const doFetch = async (token: string) =>
        fetch(url, {
          ...init,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
        });
      const token = (await getAccessToken().catch(() => null)) || tokenRef.current;
      if (!token) return null;
      tokenRef.current = token;
      let res = await doFetch(token);
      // Expired session mid-match: force a FRESH token once and retry — a dead
      // token must never silently eat moves (playtest: PLACE "did nothing").
      if (res.status === 401) {
        const fresh = await getAccessToken().catch(() => null);
        if (fresh && fresh !== token) {
          tokenRef.current = fresh;
          res = await doFetch(fresh);
        }
      }
      return res;
    },
    [getAccessToken],
  );

  // Monotonic key: a view may only advance (stale in-flight polls must never
  // rewind the board — the playtest saw just-placed pieces vanish/teleport).
  const viewKey = (v: any): number => {
    if (!v) return -1;
    if (v.state === "over") return Number.MAX_SAFE_INTEGER;
    if (v.turf) return v.turf.game * 1_000_000 + v.turf.moveN * 1_000 + (v.turf.placements?.length || 0);
    if (v.match) return (v.match.round || 0) * 1_000_000 + (v.match.myWins + v.match.oppWins) * 1_000;
    return 0;
  };
  const acceptView = useCallback((view: any) => {
    if (!view) return;
    if (typeof view.serverNow === "number") clockOffset.current = view.serverNow - Date.now();
    const prev = latestRef.current as any;
    // Different phases (idle/queued/staging/active/over) always replace;
    // same-phase views must not regress.
    if (prev && prev.state === view.state && viewKey(view) < viewKey(prev)) return;
    latestRef.current = view;
  }, []);

  const pollOnce = useCallback(async () => {
    try {
      const res = await authedFetch("/api/match/state");
      if (!res?.ok) return;
      acceptView(await res.json());
    } catch {
      /* transient — next tick retries */
    }
  }, [authedFetch, acceptView]);

  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    const loop = async () => {
      if (pollTimer.current === null) return; // stopped mid-flight
      await pollOnce();
      if (pollTimer.current === null) return;
      const v = latestRef.current as any;
      const fast = v && v.state === "active" && (v.turf || v.staging);
      pollTimer.current = setTimeout(loop, fast ? POLL_TURF_MS : POLL_MS) as unknown as ReturnType<typeof setInterval>;
    };
    pollTimer.current = setTimeout(loop, 0) as unknown as ReturnType<typeof setInterval>;
  }, [pollOnce]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current as unknown as ReturnType<typeof setTimeout>);
      pollTimer.current = null;
    }
    latestRef.current = null;
  }, []);

  // Round delivery: keepalive + 3 attempts + stash (mirrors RunController.finish).
  const finishRound = useCallback(
    async (payload: { matchId: string; runId: string; runToken: string; summary: unknown; log: unknown }) => {
      const body = JSON.stringify(payload);
      try {
        sessionStorage.setItem(PENDING_KEY, body);
      } catch {}
      const attempt = async () => {
        const res = await authedFetch("/api/match/finish", {
          method: "POST",
          body,
          keepalive: body.length < 55_000,
        });
        if (!res || res.status === 429) return null;
        return await res.json().catch(() => null);
      };
      try {
        // Retry across (almost) the whole 30s server grace window — a single
        // 429 or radio blip must not forfeit a wagered round when the server
        // would still happily take it. Delays: 0 / 2s / 6s / 9s / 10s ≈ 27s.
        const delays = [0, 2000, 6000, 9000, 10000];
        let data: unknown = null;
        for (let i = 0; i < delays.length && !data; i++) {
          if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
          data = await attempt().catch(() => null);
        }
        if (data) {
          try {
            sessionStorage.removeItem(PENDING_KEY);
          } catch {}
          void pollOnce(); // pull the advanced match state right away
        }
        window.dispatchEvent(new CustomEvent("rfsmash:me-changed"));
      } catch {
        /* stash survives — re-sent next visit */
      }
    },
    [authedFetch, pollOnce],
  );

  // Re-send a round that never confirmed (tab killed mid-send). The server
  // is idempotent — "round already submitted" settles the stash too.
  useEffect(() => {
    if (!(ready && authenticated)) return;
    let stash: string | null = null;
    try {
      stash = sessionStorage.getItem(PENDING_KEY);
    } catch {}
    if (!stash) return;
    void (async () => {
      try {
        const res = await authedFetch("/api/match/finish", { method: "POST", body: stash });
        if (res && res.status !== 429) {
          try {
            sessionStorage.removeItem(PENDING_KEY);
          } catch {}
        }
      } catch {}
    })();
  }, [ready, authenticated, authedFetch]);

  // Bridge for the engine.
  useEffect(() => {
    window.__DOOPIE_MATCH = {
      authed: () => ready && authenticated,
      start: () => startPolling(),
      stop: () => stopPolling(),
      latest: () => latestRef.current,
      now: () => Date.now() + clockOffset.current,
      queue: async (wager: number, mode?: string) => {
        try {
          const res = await authedFetch("/api/match/queue", { method: "POST", body: JSON.stringify({ wager, mode }) });
          if (!res) return { state: "error", error: "Sign in to battle." };
          const data = await res.json().catch(() => null);
          if (!res.ok) return { state: "error", error: data?.error || "Couldn't join the queue." };
          void pollOnce();
          return data;
        } catch {
          return { state: "error", error: "Network hiccup — try again." };
        }
      },
      cancel: async () => {
        try {
          await authedFetch("/api/match/queue", { method: "DELETE" });
        } catch {}
        void pollOnce();
      },
      heartbeat: (matchId: string, round: number, score: number) => {
        const now = Date.now();
        if (now - lastBeat.current < HEARTBEAT_MS) return;
        lastBeat.current = now;
        void authedFetch("/api/match/heartbeat", {
          method: "POST",
          body: JSON.stringify({ matchId, round, score }),
          keepalive: true,
        }).catch(() => {});
      },
      finishRound: (payload: { matchId: string; runId: string; runToken: string; summary: unknown; log: unknown }) => {
        void finishRound(payload);
      },
      ready: async (matchId: string) => {
        try {
          const res = await authedFetch("/api/match/ready", { method: "POST", body: JSON.stringify({ matchId }) });
          const data = res ? await res.json().catch(() => null) : null;
          if (data?.view) acceptView(data.view);
          return !!data?.ok;
        } catch {
          return false;
        }
      },
      place: async (payload: { matchId: string; moveN: number; t: string; r: number; x: number; y: number; rulesV: number }) => {
        // Turn submission: one immediate retry (moveN is idempotent), then
        // fall back to the poll — the shot-clock machinery covers the rest.
        for (let i = 0; i < 2; i++) {
          try {
            const res = await authedFetch("/api/match/place", { method: "POST", body: JSON.stringify(payload) });
            if (res) {
              const data = await res.json().catch(() => null);
              if (data?.view) acceptView(data.view);
              return data;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 700));
        }
        void pollOnce();
        return null;
      },
      concede: async (matchId: string) => {
        try {
          await authedFetch("/api/match/concede", { method: "POST", body: JSON.stringify({ matchId }) });
        } catch {}
        void pollOnce();
        window.dispatchEvent(new CustomEvent("rfsmash:me-changed"));
      },
    };
    return () => {
      stopPolling();
      delete window.__DOOPIE_MATCH;
    };
  }, [ready, authenticated, authedFetch, startPolling, stopPolling, pollOnce, finishRound]);

  return null;
}

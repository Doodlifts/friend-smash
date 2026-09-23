"use client";

/* components/DailyBonus.tsx — claims the once-per-day RF bonus on load for
   a signed-in player and shows a brief streak toast. Decoupled from the canvas
   engine (lives in the Privy tree). Claiming is idempotent server-side, so the
   POST is safe to fire on every mount; we only toast when something was awarded. */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { formatRf } from "@/lib/rf/format";

export default function DailyBonus() {
  return <DailyBonusInner />;
}

function DailyBonusInner() {
  const { ready, authenticated, getAccessToken } = useAuth();
  const tried = useRef(false);
  const [toast, setToast] = useState<{ amount: number; streak: number } | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!ready || !authenticated || tried.current) return;
    tried.current = true;
    const timers: number[] = [];
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch("/api/daily", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.awarded) {
          setToast({ amount: data.amount, streak: data.streak });
          // Play the exit animation, then unmount — mirrors the pop-in so it
          // doesn't just blink out of existence.
          timers.push(window.setTimeout(() => setLeaving(true), 4600));
          timers.push(window.setTimeout(() => setToast(null), 4850));
        }
      } catch {
        /* non-fatal — daily bonus is best-effort */
      }
    })();
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [ready, authenticated, getAccessToken]);

  if (!toast) return null;
  return (
    <div id="dailyToast" className={leaving ? "leaving" : undefined} role="status" aria-live="polite">
      <span className="amt num">+{formatRf(toast.amount)} RF</span>
      <span className="strk">
        {toast.streak > 1 ? `Day ${toast.streak} streak` : "Daily RF (simulated)"}
      </span>
    </div>
  );
}

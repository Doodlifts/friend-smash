"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { IconBack } from "@/components/icons";

interface CatalogItem {
  key: string;
  name: string;
  description: string;
  price: number;
  effect: string;
  /** REAL $RAREFRIENDS the Friend's wallet must hold to unlock. */
  unlockRf?: number;
  unlocked?: boolean;
}

export default function ShopPage() {
  return (
    <main className="page-wrap">
      <div className="page-card">
        <div className="page-titlerow">
          <Link href="/" className="page-back chunky" aria-label="Back to game">
            <IconBack />
          </Link>
          <div className="page-title">POWER-UPS</div>
          <span style={{ width: 40 }} />
        </div>
        <div style={mockBadge}>SIMULATED $RAREFRIENDS — no real tokens move</div>
        <div style={modelNote}>
          Unlocked by the REAL $RAREFRIENDS your Friend&apos;s own wallet holds (read-only, never moved). Bought
          with simulated RF — 100% of every purchase is burned. Usable in practice and versus, never in ranked.
        </div>
        <ShopInner />
        <Link href="/" className="page-cta alt chunky" style={{ marginTop: 18 }}>
          BACK TO THE BOARD
        </Link>
      </div>
    </main>
  );
}

function ShopInner() {
  const { ready, authenticated, login, getAccessToken } = useAuth();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [inventory, setInventory] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heldRf, setHeldRf] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const token = authenticated ? await getAccessToken() : null;
      const res = await fetch("/api/powerups", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const d = await res.json();
      setCatalog(d.catalog || []);
      if (typeof d.balance === "number") setBalance(d.balance);
      if (d.holdings) setHeldRf(typeof d.holdings.rf === "number" ? d.holdings.rf : null);
      if (Array.isArray(d.inventory)) {
        const inv: Record<string, number> = {};
        for (const i of d.inventory) inv[i.key] = i.qty;
        setInventory(inv);
      }
    } catch {
      setError("Couldn't load the shop. Give it another tap.");
    }
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const buy = async (key: string) => {
    setError(null);
    setBusy(key);
    try {
      const token = await getAccessToken();
      const purchaseId =
        (globalThis.crypto?.randomUUID && globalThis.crypto.randomUUID()) || `${key}-${Date.now()}`;
      const res = await fetch("/api/powerups", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ key, purchaseId }),
      });
      const d = await res.json();
      if (res.ok) {
        if (typeof d.balance === "number") setBalance(d.balance);
        setInventory((inv) => ({ ...inv, [key]: d.qty ?? (inv[key] || 0) + 1 }));
        window.dispatchEvent(new CustomEvent("rfsmash:me-changed"));
      } else {
        setError(d.error || "Purchase didn't go through. Try again.");
      }
    } catch {
      setError("Couldn't reach the shop. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (!ready) return <div className="page-note">Stocking the shelves…</div>;

  if (!authenticated) {
    return (
      <>
        <div className="page-note">Sign in to spend RF on power-ups.</div>
        <button className="page-cta chunky" onClick={() => login()}>
          SIGN IN
        </button>
        <CatalogList catalog={catalog} inventory={{}} balance={null} busy={null} onBuy={() => {}} disabled />
      </>
    );
  }

  return (
    <>
      <div className="num" style={balanceStyle}>
        {balance !== null ? balance.toLocaleString() : "—"} <span style={{ fontSize: 12 }}>RF (simulated)</span>
      </div>
      <div style={modelNote}>
        Friend wallet holds <b className="num">{heldRf !== null ? heldRf.toLocaleString() : "—"}</b> real $RAREFRIENDS
      </div>
      {error && <div className="page-note" style={{ color: "var(--pink-deep)", padding: "6px 8px" }}>{error}</div>}
      <CatalogList catalog={catalog} inventory={inventory} balance={balance} busy={busy} onBuy={buy} />
    </>
  );
}

function CatalogList({
  catalog,
  inventory,
  balance,
  busy,
  onBuy,
  disabled,
}: {
  catalog: CatalogItem[];
  inventory: Record<string, number>;
  balance: number | null;
  busy: string | null;
  onBuy: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={list}>
      {catalog.map((p) => {
        const owned = inventory[p.key] || 0;
        const cantAfford = balance !== null && balance < p.price;
        const locked = p.unlocked === false;
        return (
          <div key={p.key} className="page-row">
            <div style={itemMain}>
              <div style={itemName}>
                {p.name} {owned > 0 && <span className="num" style={ownedTag}>×{owned}</span>}
              </div>
              <div style={itemDesc}>{p.description}</div>
              {(p.unlockRf ?? 0) > 0 && (
                <div style={{ ...itemDesc, opacity: 1, marginTop: 2 }}>
                  {locked ? "🔒" : "🔓"} hold {(p.unlockRf ?? 0).toLocaleString()} $RAREFRIENDS in your Friend&apos;s wallet
                </div>
              )}
            </div>
            <button
              className="chunky num"
              style={{ ...buyBtnSm, ...(disabled || cantAfford || locked ? buyDisabled : {}) }}
              disabled={disabled || busy === p.key || cantAfford || locked}
              onClick={() => onBuy(p.key)}
            >
              {busy === p.key ? "…" : locked ? "LOCKED" : `BUY · ${p.price}`}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const mockBadge: React.CSSProperties = { textAlign: "center", fontSize: 10, fontWeight: 800, letterSpacing: 1, opacity: 0.6, margin: "8px 0", textTransform: "uppercase" };
const modelNote: React.CSSProperties = { textAlign: "center", fontWeight: 600, fontSize: 11.5, opacity: 0.7, lineHeight: 1.5, margin: "0 4px 8px" };
const balanceStyle: React.CSSProperties = { textAlign: "center", fontWeight: 800, fontSize: 26, margin: "6px 0 12px" };
const list: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, marginTop: 6 };
const itemMain: React.CSSProperties = { flex: 1, minWidth: 0 };
const itemName: React.CSSProperties = { fontWeight: 800, fontSize: 15 };
const itemDesc: React.CSSProperties = { fontWeight: 600, fontSize: 11.5, opacity: 0.7 };
const ownedTag: React.CSSProperties = { color: "#16a34a", fontSize: 12 };
const priceTag: React.CSSProperties = { fontWeight: 800 };
const buyBtnSm: React.CSSProperties = {
  minWidth: 78,
  height: 40,
  borderRadius: "var(--r-row)",
  border: "2.5px solid var(--ink)",
  background: "var(--grad-pink)",
  color: "#fff",
  fontFamily: "var(--font)",
  fontWeight: 800,
  fontSize: 14,
  WebkitTextStroke: "0.5px var(--ink)",
  paintOrder: "stroke fill",
  boxShadow: "var(--sh-ctl)",
  cursor: "pointer",
  padding: "0 10px",
};
const buyDisabled: React.CSSProperties = { filter: "grayscale(0.6)", opacity: 0.6, cursor: "not-allowed" };

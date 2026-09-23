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
}

export default function ShopPage() {
  return (
    <main className="page-wrap">
      <div className="page-card">
        <div className="page-titlerow">
          <Link href="/" className="page-back chunky" aria-label="Back to game">
            <IconBack />
          </Link>
          <div className="page-title">SMASH SHOP</div>
          <span style={{ width: 40 }} />
        </div>
        <div style={mockBadge}>$SMASH — testnet / mock balance</div>
        <div style={modelNote}>
          Won from daily &amp; weekly leaderboard pools, spent here on power-ups. Pools go live with the token.
        </div>
        <ShopInner />
        <Link href="/" className="page-cta alt chunky" style={{ marginTop: 18 }}>
          BACK TO SMASHING
        </Link>
      </div>
    </main>
  );
}

function ShopCatalogOnly() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [msg, setMsg] = useState("Sign-in isn't available on this build yet.");
  useEffect(() => {
    fetch("/api/powerups")
      .then((r) => r.json())
      .then((d) => setCatalog(d.catalog || []))
      .catch(() => setMsg("Couldn't load the shop. Give it another tap."));
  }, []);
  return (
    <>
      <div className="page-note">{msg}</div>
      <div style={list}>
        {catalog.map((p) => (
          <div key={p.key} className="page-row">
            <div style={itemMain}>
              <div style={itemName}>{p.name}</div>
              <div style={itemDesc}>{p.description}</div>
            </div>
            <div className="num" style={priceTag}>
              {p.price} <span style={{ fontSize: 10, opacity: 0.6 }}>$SMASH</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ShopInner() {
  const { ready, authenticated, login, getAccessToken } = useAuth();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [inventory, setInventory] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const token = authenticated ? await getAccessToken() : null;
      const res = await fetch("/api/powerups", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const d = await res.json();
      setCatalog(d.catalog || []);
      if (typeof d.balance === "number") setBalance(d.balance);
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
        <div className="page-note">Sign in to spend $SMASH on power-ups.</div>
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
        {balance !== null ? balance.toLocaleString() : "—"} <span style={{ fontSize: 12 }}>$SMASH</span>
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
        return (
          <div key={p.key} className="page-row">
            <div style={itemMain}>
              <div style={itemName}>
                {p.name} {owned > 0 && <span className="num" style={ownedTag}>×{owned}</span>}
              </div>
              <div style={itemDesc}>{p.description}</div>
            </div>
            <button
              className="chunky num"
              style={{ ...buyBtnSm, ...(disabled || cantAfford ? buyDisabled : {}) }}
              disabled={disabled || busy === p.key || cantAfford}
              onClick={() => onBuy(p.key)}
            >
              {busy === p.key ? "…" : `BUY · ${p.price}`}
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

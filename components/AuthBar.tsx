"use client";

/* components/AuthBar.tsx — account chip + profile/handle modal.

   Rendered as a sibling of <Game/> so it lives in its OWN React tree and never
   re-renders (or reconciles) the engine-managed DOM (#menuOv etc.). It reads
   the live game state read-only via window.__DS and hides itself during active
   play, so it's only present on the menu / pause / game-over screens.

   Auth is Rare Friends wallet sign-in (components/auth/AuthProvider). */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { validateHandle } from "@/lib/handle";
import FriendPortrait from "./auth/FriendPortrait";
import { pieceFriendList, type PieceFriend } from "@/lib/rf/pieceArt";
import { PIECES_CHANGED } from "./FriendPieces";
import { IconUser } from "./icons";
import { formatRf } from "@/lib/rf/format";

export default function AuthBar() {
  return <AuthBarInner />;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const panel = {
  card: {
    background: "var(--panel-solid)",
    border: "3px solid var(--ink)",
    borderRadius: "var(--r-card)",
    boxShadow: "var(--sh-card)",
    padding: "22px 24px",
    maxWidth: 340,
    width: "100%",
    maxHeight: "calc(100dvh - 40px)",
    overflowY: "auto" as const,
    textAlign: "center" as const,
    fontFamily: "var(--font)",
    color: "var(--ink)",
  },
  overlay: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(120,160,220,.42)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    padding: 24,
  },
  btn: {
    marginTop: 14,
    width: "100%",
    height: 52,
    borderRadius: "var(--r-cta)",
    border: "3px solid var(--ink)",
    background: "var(--grad-pink)",
    color: "#fff",
    fontFamily: "var(--font)",
    fontWeight: 800,
    fontSize: 18,
    WebkitTextStroke: "1px var(--ink)",
    paintOrder: "stroke fill" as const,
    boxShadow: "var(--sh-cta)",
    cursor: "pointer",
  },
  btnAlt: {
    background: "var(--grad-purple)",
  },
  input: {
    width: "100%",
    height: 46,
    borderRadius: "var(--r-ctl)",
    border: "2.5px solid var(--ink)",
    padding: "0 12px",
    fontFamily: "var(--font)",
    fontWeight: 700,
    fontSize: 16,
    marginTop: 6,
    boxSizing: "border-box" as const,
  },
  smallBtn: {
    minWidth: 52,
    height: 40,
    borderRadius: "var(--r-row)",
    border: "2.5px solid var(--ink)",
    background: "var(--blue)",
    color: "var(--ink)",
    fontFamily: "var(--font)",
    fontWeight: 800,
    fontSize: 13,
    boxShadow: "0 2px 0 var(--ink)",
    cursor: "pointer",
    padding: "0 10px",
  } as const,
};

function AuthBarInner() {
  const { ready, authenticated, user, login, logout, getAccessToken } = useAuth();
  const [gameState, setGameState] = useState<string>("menu");
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [draft, setDraft] = useState("");
  const [handleErr, setHandleErr] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [crew, setCrew] = useState<readonly PieceFriend[]>([]);
  useEffect(() => {
    const h = () => setCrew(pieceFriendList());
    h();
    window.addEventListener(PIECES_CHANGED, h);
    return () => window.removeEventListener(PIECES_CHANGED, h);
  }, []);

  const did = user ? `friend:${user.friendId}` : null;
  const friendWallet = user?.friendWallet ?? "";

  const copyAddress = async () => {
    if (!friendWallet) return;
    try {
      await navigator.clipboard.writeText(friendWallet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the address is still shown for manual copy */
    }
  };

  // Read the engine's live state (read-only) and hide the bar during play.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = (window as any).__DS?.G?.state;
      if (s) setGameState(s);
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Load profile (handle + mock balance) from the server; fall back to a local
  // cache when the DB isn't configured (503) so the picker still feels alive.
  const refreshMe = useCallback(async () => {
    if (!authenticated) return;
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        const h = typeof data.handle === "string" ? data.handle : "";
        setHandle(h);
        setDraft((d) => (d ? d : h));
        setBalance(typeof data.rfBalance === "number" ? data.rfBalance : 0);
      } else if (did) {
        const cached = localStorage.getItem(`rfsmashHandle:${did}`) || "";
        setHandle(cached);
        setDraft((d) => (d ? d : cached));
      }
    } catch {
      /* network errors are non-fatal here */
    }
  }, [authenticated, getAccessToken, did]);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // Other surfaces (RunController) ping this when the balance may have changed.
  useEffect(() => {
    const h = () => void refreshMe();
    window.addEventListener("rfsmash:me-changed", h);
    return () => window.removeEventListener("rfsmash:me-changed", h);
  }, [refreshMe]);

  const saveHandle = async () => {
    const check = validateHandle(draft);
    if (!check.ok) {
      setHandleErr(check.error || "Invalid name.");
      return;
    }
    setHandleErr(null);
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/me", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ handle: check.value }),
      });
      if (res.ok) {
        const data = await res.json();
        setHandle(typeof data.handle === "string" ? data.handle : check.value);
      } else if (res.status === 503) {
        // DB not configured — cache locally so the UX still works.
        setHandle(check.value);
        if (did) localStorage.setItem(`rfsmashHandle:${did}`, check.value);
      } else {
        const data = await res.json().catch(() => ({}));
        setHandleErr(data.error || "Couldn't save that name.");
      }
    } catch {
      setHandleErr("Couldn't reach the server.");
    }
  };

  if (!ready) return null;

  const displayName = handle || (user ? `Friend #${user.friendId}` : "Friend");

  // Only show the chip when the player is idle (not mid-game).
  const showChip = gameState !== "play" && gameState !== "clearing";

  return (
    <>
      {showChip && (
        <button
          onClick={() => setOpen(true)}
          aria-label={authenticated ? "Account" : "Sign in"}
          className="chunky"
          style={{
            position: "fixed",
            top: "calc(env(safe-area-inset-top,0px) + 8px)",
            // Left-justified: centered chips with long handles (MrsDoodlifts)
            // crashed into the shop/stats/trophy icons pinned at the right.
            // The width cap always leaves the icon row breathing room.
            left: 10,
            zIndex: 30,
            height: 40,
            maxWidth: "calc(100vw - 186px)",
            padding: "0 14px",
            borderRadius: "var(--r-ctl)",
            border: "2.5px solid var(--ink)",
            background: authenticated ? "var(--panel-solid)" : "var(--grad-pink)",
            color: authenticated ? "var(--ink)" : "#fff",
            fontFamily: "var(--font)",
            fontWeight: 800,
            fontSize: 13,
            boxShadow: "var(--sh-ctl)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          {authenticated && user ? (
            <FriendPortrait friendId={user.friendId} size={24} />
          ) : (
            <IconUser size={17} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {authenticated ? displayName : "Pick your Friend"}
          </span>
        </button>
      )}

      {open && (
        <div style={panel.overlay} onClick={() => setOpen(false)}>
          <div style={panel.card} onClick={(e) => e.stopPropagation()}>
            {!authenticated ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 24, marginBottom: 6 }}>
                  Bring a Friend
                </div>
                <div style={{ fontWeight: 600, fontSize: 13, opacity: 0.75 }}>
                  Paste the address that holds your hardwired Rare Friend (read-only, nothing to sign) or
                  connect the wallet itself. Your pieces become your Friends.
                </div>
                <button
                  className="chunky"
                  style={panel.btn}
                  onClick={() => {
                    setOpen(false);
                    login();
                  }}
                >
                  PICK YOUR FRIEND
                </button>
                <button
                  className="chunky"
                  style={{ ...panel.btn, ...panel.btnAlt }}
                  onClick={() => setOpen(false)}
                >
                  NOT NOW
                </button>
              </>
            ) : (
              <>
                {user && (
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
                    <FriendPortrait friendId={user.friendId} size={80} animate />
                  </div>
                )}
                <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 2 }}>
                  Rare Friend #{user?.friendId}
                </div>
                <div style={{ fontWeight: 600, fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
                  {user?.verified === false ? "👁 read-only · " : "✓ wallet-verified · "}
                  {user ? short(user.owner) : "—"}
                </div>

                <div style={{ textAlign: "left", fontWeight: 800, fontSize: 12, opacity: 0.6, letterSpacing: 1 }}>
                  HANDLE
                </div>
                <input
                  style={panel.input}
                  value={draft}
                  maxLength={15}
                  placeholder="pick a name"
                  onChange={(e) => setDraft(e.target.value)}
                />
                {handleErr && (
                  <div style={{ color: "var(--pink-deep)", fontSize: 12, fontWeight: 700, marginTop: 6, textAlign: "left" }}>
                    {handleErr}
                  </div>
                )}
                <button
                  className="chunky"
                  style={{ ...panel.btn, ...panel.btnAlt, marginTop: 10 }}
                  onClick={saveHandle}
                  disabled={draft === handle}
                >
                  SAVE HANDLE
                </button>

                {/* RF balance — SIMULATED, server-tracked, belongs to the Friend */}
                <div
                  style={{
                    marginTop: 16,
                    padding: "10px 12px",
                    borderRadius: "var(--r-ctl)",
                    background: "var(--surface-purple)",
                    border: "2px solid var(--ink)",
                    fontWeight: 800,
                  }}
                >
                  <span className="num" style={{ fontSize: 18 }}>
                    {balance !== null ? formatRf(balance) : "—"} RF
                  </span>
                  <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.6 }}>SIMULATED balance · no real tokens</div>
                </div>

                {crew.length > 0 && (
                  <div style={{ marginTop: 14, textAlign: "left" }}>
                    <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.6, letterSpacing: 1 }}>
                      YOUR FRIENDS ARE THE PIECES
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                      {crew.map((f) => (
                        <div key={f.id} style={{ textAlign: "center", fontSize: 10, fontWeight: 700 }} title={`Friend #${f.id}`}>
                          <FriendPortrait friendId={f.id} size={34} />
                          <div>W{f.weightClass ?? 1}</div>
                          <div style={{ opacity: 0.6 }}>
                            {(f.weightClass ?? 1) > 1 ? `-${Math.round(15 * ((f.weightClass ?? 1) - 1))}% speed` : "normal"}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 10.5, opacity: 0.65, marginTop: 4, lineHeight: 1.4 }}>
                      Weight comes from each Friend&apos;s on-chain generation + activation tier — the inputs to its RF
                      reward weight. Heavier Friends fall slower.
                    </div>
                  </div>
                )}

                {friendWallet && (
                  <div style={{ marginTop: 14, textAlign: "left" }}>
                    <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.6, letterSpacing: 1 }}>
                      FRIEND WALLET · ROBINHOOD CHAIN
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <code
                        style={{
                          flex: 1,
                          fontFamily: "ui-monospace, SFMono-Regular, monospace",
                          fontSize: 12,
                          fontWeight: 700,
                          background: "var(--surface)",
                          border: "2px solid var(--ink)",
                          borderRadius: "var(--r-row)",
                          padding: "9px 10px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {short(friendWallet)}
                      </code>
                      <button className="chunky" style={panel.smallBtn} onClick={copyAddress}>
                        {copied ? "✓" : "Copy"}
                      </button>
                    </div>
                  </div>
                )}

                <div
                  style={{
                    marginTop: 14,
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: "var(--r-ctl)",
                    background: "var(--surface-pink)",
                    border: "2px dashed var(--pink)",
                  }}
                >
                  <div style={{ fontWeight: 800, fontSize: 13 }}>How RF works here</div>
                  <div style={{ fontWeight: 600, fontSize: 11.5, opacity: 0.8, marginTop: 4, lineHeight: 1.5 }}>
                    Power-ups <b>unlock</b> by the real $RAREFRIENDS your Friend&apos;s wallet holds and{" "}
                    <b>burn</b> simulated RF when bought. Ranked entries fill a <b>daily prize pool</b> paid to the
                    top scores, with a slice burned. Balances belong to your Friend and move with the NFT. Everything
                    is <b>simulated</b> for the vibeathon — at launch the same ledger settles in real $RAREFRIENDS
                    to the Friend wallet above.
                  </div>
                </div>

                <button className="chunky" style={panel.btn} onClick={() => setOpen(false)}>
                  BACK TO THE BOARD
                </button>
                <button
                  className="chunky"
                  style={{ ...panel.btn, ...panel.btnAlt }}
                  onClick={() => {
                    void logout();
                    setOpen(false);
                  }}
                >
                  SIGN OUT
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

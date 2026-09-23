"use client";

/* ============================================================
   components/auth/FriendPicker.tsx — connect wallet, choose Friend, sign in.

   Mirrors the FriendSDK runtime picker's states (missing wallet, disconnected,
   wrong network, discovery failure, empty, hidden gen-0) using the SDK's own
   wallet session and readOwnedFriends. Signing is a plain SIWE message: it
   proves ownership and cannot move tokens or NFTs.
   ============================================================ */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { isAddress, toHex, type Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { FriendWalletSession } from "@rarefriends/friendsdk/wallet";
import { createFriendPublicClient } from "@rarefriends/friendsdk/wallet";
import { readOwnedFriends, type OwnedFriend } from "@rarefriends/friendsdk/owned";
import FriendPortrait from "./FriendPortrait";
import { READ_ONLY_TEST } from "@/lib/rf/testMode";

const CHAIN_ID = 4663;

type Discovery =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "done"; friends: readonly OwnedFriend[]; hidden: number };

export interface SignedIn {
  token: string;
  exp: number;
  friendId: string;
  owner: string;
  friendWallet: string | null;
  generation?: number;
  verified: boolean;
}

let publicClient: ReturnType<typeof createFriendPublicClient> | null = null;
const reads = () => (publicClient ??= createFriendPublicClient());

/** Share discovery with components/FriendPieces (same session cache key). */
function rememberOwned(owner: string, friends: readonly OwnedFriend[]) {
  try {
    sessionStorage.setItem(`rfsmashOwned:${owner.toLowerCase()}`, JSON.stringify(friends.map((f) => f.id.toString())));
  } catch {
    /* storage unavailable */
  }
}

export default function FriendPicker({
  wallet,
  onClose,
  onSignedIn,
}: {
  wallet: FriendWalletSession;
  onClose: () => void;
  onSignedIn: (s: SignedIn) => void;
}) {
  const snap = useSyncExternalStore(wallet.subscribe, wallet.getSnapshot, wallet.getSnapshot);
  const [disc, setDisc] = useState<Discovery>({ state: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [signing, setSigning] = useState<string | null>(null);
  const [signError, setSignError] = useState("");
  // READ-ONLY mode: paste any address, list its Friends, play unverified.
  const [mode, setMode] = useState<"wallet" | "address">(READ_ONLY_TEST || snap.status === "unavailable" ? "address" : "wallet");
  const [pasted, setPasted] = useState("");
  const [pastedDisc, setPastedDisc] = useState<Discovery>({ state: "idle" });

  const lookUp = useCallback(async () => {
    const a = pasted.trim();
    if (!isAddress(a, { strict: false })) {
      setPastedDisc({ state: "error", error: "That isn't a valid 0x… wallet address." });
      return;
    }
    setPastedDisc({ state: "loading" });
    try {
      const r = await readOwnedFriends(reads(), a as Address);
      rememberOwned(a, r.friends);
      setPastedDisc({ state: "done", friends: r.friends, hidden: r.hiddenCount });
    } catch (e) {
      setPastedDisc({ state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [pasted]);

  const watchIn = useCallback(
    async (f: OwnedFriend) => {
      setSigning(f.id.toString());
      setSignError("");
      try {
        const res = await fetch("/api/auth/watch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: pasted.trim(), friendId: f.id.toString() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Couldn't load that Friend.");
        onSignedIn(data as SignedIn);
      } catch (e) {
        setSignError(e instanceof Error ? e.message : String(e));
      } finally {
        setSigning(null);
      }
    },
    [pasted, onSignedIn],
  );

  // Discover owned Friends whenever the identity (revision) settles on Robinhood.
  useEffect(() => {
    if (snap.status !== "connected" || !snap.account) {
      setDisc({ state: "idle" });
      return;
    }
    const ctrl = new AbortController();
    setDisc({ state: "loading" });
    readOwnedFriends(reads(), snap.account, { signal: ctrl.signal })
      .then((r) => {
        rememberOwned(snap.account!, r.friends);
        setDisc({ state: "done", friends: r.friends, hidden: r.hiddenCount });
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setDisc({ state: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [snap.status, snap.account, snap.revision, attempt]);

  const signIn = useCallback(
    async (f: OwnedFriend) => {
      const provider = wallet.getProvider();
      const account = snap.account;
      if (!provider || !account) return;
      setSigning(f.id.toString());
      setSignError("");
      try {
        const n = await fetch("/api/auth/nonce", { cache: "no-store" }).then((r) => r.json());
        if (!n?.nonce) throw new Error(n?.error || "Sign-in is unavailable right now.");
        const now = new Date();
        const message = createSiweMessage({
          domain: location.host,
          address: account,
          statement: `Play Friend Smash as Rare Friend #${f.id}. This only proves you own it — it cannot move tokens or NFTs.`,
          uri: location.origin,
          version: "1",
          chainId: CHAIN_ID,
          nonce: n.nonce,
          requestId: `friend-${f.id}`,
          issuedAt: now,
          expirationTime: new Date(now.getTime() + 5 * 60_000),
        });
        const signature = (await provider.request({
          method: "personal_sign",
          params: [toHex(message), account],
        })) as string;
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, signature, nonceToken: n.nonceToken }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Sign-in failed.");
        onSignedIn(data as SignedIn);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSignError(/reject|denied|4001/i.test(msg) ? "Signature cancelled." : msg);
      } finally {
        setSigning(null);
      }
    },
    [wallet, snap.account, onSignedIn],
  );

  let body: React.ReactNode;
  if (snap.status === "unavailable") {
    body = (
      <>
        <p>No browser wallet found. On a phone, open this page inside your wallet app&apos;s browser (MetaMask, Rainbow, Coinbase Wallet…).</p>
        <button className="rfp-btn" onClick={() => void wallet.refresh()}>Check again</button>
      </>
    );
  } else if (snap.status === "disconnected" || snap.status === "error" || snap.status === "connecting") {
    body = (
      <>
        <p>Connect the wallet that holds your hardwired Rare Friend.</p>
        {snap.error && <p className="rfp-err">{snap.error}</p>}
        <div className="rfp-row">
          {(snap.wallets.length ? snap.wallets : [{ id: "", name: "wallet" }]).map((w) => (
            <button
              key={w.id || "injected"}
              className="rfp-btn rfp-primary"
              disabled={snap.status === "connecting"}
              onClick={() => void wallet.connect(w.id || undefined)}
            >
              {snap.status === "connecting" ? "Connecting…" : snap.wallets.length > 1 ? `Connect ${w.name}` : "Connect wallet"}
            </button>
          ))}
        </div>
      </>
    );
  } else if (snap.status === "wrong-network" || snap.status === "switching-network") {
    body = (
      <>
        <p>Rare Friends live on <b>Robinhood Chain</b>.</p>
        <button className="rfp-btn rfp-primary" disabled={snap.status === "switching-network"} onClick={() => void wallet.switchNetwork()}>
          {snap.status === "switching-network" ? "Check your wallet…" : "Switch to Robinhood"}
        </button>
      </>
    );
  } else if (disc.state === "loading" || disc.state === "idle") {
    body = <p>Looking for your Friends…</p>;
  } else if (disc.state === "error") {
    body = (
      <>
        <p className="rfp-err">Couldn&apos;t load your Friends: {disc.error}</p>
        <button className="rfp-btn" onClick={() => setAttempt((a) => a + 1)}>Retry</button>
      </>
    );
  } else if (disc.friends.length === 0) {
    body = (
      <>
        <p>No hardwired Friends in this wallet.</p>
        {disc.hidden > 0 && (
          <p className="rfp-note">{disc.hidden} generation-0 Friend{disc.hidden === 1 ? " is" : "s are"} hidden — hardwire it to play.</p>
        )}
        <button className="rfp-btn" onClick={() => setAttempt((a) => a + 1)}>Refresh</button>
      </>
    );
  } else {
    body = (
      <>
        <p>Choose who&apos;s smashing today:</p>
        <div className="rfp-grid">
          {disc.friends.map((f) => (
            <button
              key={f.id.toString()}
              className="rfp-card"
              disabled={signing !== null}
              onClick={() => void signIn(f)}
            >
              <FriendPortrait friendId={f.id} size={72} animate />
              <span>#{f.id.toString()}</span>
              <small>gen {f.generation}</small>
              {signing === f.id.toString() && <em>Sign in wallet…</em>}
            </button>
          ))}
        </div>
        {disc.hidden > 0 && <p className="rfp-note">{disc.hidden} generation-0 Friend(s) hidden.</p>}
        {signError && <p className="rfp-err">{signError}</p>}
      </>
    );
  }

  if (mode === "address") {
    const d = pastedDisc;
    body = (
      <>
        <p>Paste the address holding your Rare Friends.</p>
        <div className="rfp-row">
          <input
            className="rfp-input"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void lookUp()}
            placeholder="0x…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="text"
            aria-label="Wallet address"
          />
          <button className="rfp-btn rfp-primary" disabled={d.state === "loading"} onClick={() => void lookUp()}>
            {d.state === "loading" ? "Looking…" : "Find Friends"}
          </button>
        </div>
        {d.state === "error" && <p className="rfp-err">{d.error}</p>}
        {d.state === "done" && d.friends.length === 0 && (
          <p>No hardwired Friends at that address{d.hidden > 0 ? ` (${d.hidden} generation-0 hidden)` : ""}.</p>
        )}
        {d.state === "done" && d.friends.length > 0 && (
          <div className="rfp-grid">
            {d.friends.map((f) => (
              <button key={f.id.toString()} className="rfp-card" disabled={signing !== null} onClick={() => void watchIn(f)}>
                <FriendPortrait friendId={f.id} size={72} animate />
                <span>#{f.id.toString()}</span>
                <small>gen {f.generation}</small>
                {signing === f.id.toString() && <em>…</em>}
              </button>
            ))}
          </div>
        )}
        {signError && <p className="rfp-err">{signError}</p>}
        <p className="rfp-note">Nothing to connect or sign. RF is simulated.</p>
      </>
    );
  }

  return (
    <div className="rfp-ov" role="dialog" aria-modal="true" aria-label="Choose your Rare Friend" onClick={onClose}>
      <div className="rfp-card-panel" onClick={(e) => e.stopPropagation()}>
        <div className="rfp-head">
          <b>PICK YOUR FRIEND</b>
          <button className="rfp-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {READ_ONLY_TEST && <div className="rfp-test">READ-ONLY TEST</div>}
        {!READ_ONLY_TEST && <div className="rfp-tabs" role="tablist">
          <button role="tab" aria-selected={mode === "address"} className={mode === "address" ? "on" : ""} onClick={() => setMode("address")}>
            PASTE ADDRESS
          </button>
          <button role="tab" aria-selected={mode === "wallet"} className={mode === "wallet" ? "on" : ""} onClick={() => setMode("wallet")}>
            CONNECT WALLET
          </button>
        </div>}
        {body}
        {mode === "wallet" && snap.account && (
          <div className="rfp-foot">
            <span>{snap.account.slice(0, 6)}…{snap.account.slice(-4)}</span>
            <button className="rfp-link" onClick={() => wallet.disconnect()}>Disconnect</button>
          </div>
        )}
      </div>
    </div>
  );
}

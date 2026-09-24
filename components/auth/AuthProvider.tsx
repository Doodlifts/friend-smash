"use client";

/* ============================================================
   components/auth/AuthProvider.tsx — Rare Friends sign-in (FriendSDK).

   Exposes { ready, authenticated, user, login, logout, getAccessToken } to
   the run, match, shop and power-up code; sessions are issued by
   lib/session.ts.

   Flow (all FriendSDK where the SDK provides it):
     wallet    createFriendWalletSession  — EIP-6963 discovery, connect, switch to Robinhood
     friends   readOwnedFriends           — account-filtered discovery, gen-0 hidden
     art       createFriendReader         — canonical on-chain portraits
     identity  SIWE signature + server-side readGenerationEligibility (fresh block)

   The session token lives in localStorage on this trusted page. If the wallet
   switches to a different account, the session is dropped immediately (the
   SDK's "identity change => recheck" rule); the server also re-verifies
   ownership before anything with stakes.
   ============================================================ */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createFriendWalletSession, type FriendWalletSession } from "@rarefriends/friendsdk/wallet";
import FriendPicker from "./FriendPicker";

export interface FriendUser {
  friendId: string;
  owner: string;
  friendWallet: string | null;
  generation?: number;
  /** false = read-only session from a pasted address (no signature). */
  verified: boolean;
}

interface StoredSession extends FriendUser {
  token: string;
  exp: number;
}

export interface AuthValue {
  ready: boolean;
  authenticated: boolean;
  user: FriendUser | null;
  /** Opens the Friend picker (connect wallet -> choose Friend -> sign). */
  login: () => void;
  logout: () => void;
  getAccessToken: () => Promise<string | null>;
  /** The SDK wallet session (trusted page only — never hand this to a frame). */
  wallet: FriendWalletSession | null;
}

const KEY = "rfSmashSession";
export const ME_CHANGED = "rfsmash:me-changed";

const AuthCtx = createContext<AuthValue>({
  ready: false,
  authenticated: false,
  user: null,
  login: () => {},
  logout: () => {},
  getAccessToken: async () => null,
  wallet: null,
});

export const useAuth = () => useContext(AuthCtx);

function readStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (!s?.token || typeof s.exp !== "number" || s.exp - 60_000 < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

function writeStored(s: StoredSession | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: session lasts for this page only */
  }
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [wallet, setWallet] = useState<FriendWalletSession | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  sessionRef.current = session;

  const apply = useCallback((s: StoredSession | null) => {
    writeStored(s);
    setSession(s);
    window.dispatchEvent(new Event(ME_CHANGED));
  }, []);

  useEffect(() => {
    setSession(readStored());
    const w = createFriendWalletSession();
    setWallet(w);
    // Identity change => drop the session (SDK lifecycle rule). Only acts when
    // the wallet positively reports a DIFFERENT account, so a page opened in a
    // browser without the wallet keeps its (server-rechecked) session.
    const unsub = w.subscribe(() => {
      const snap = w.getSnapshot();
      const s = sessionRef.current;
      // Read-only (pasted-address) sessions aren't tied to the connected wallet.
      if (s && s.verified !== false && snap.account && snap.account.toLowerCase() !== s.owner.toLowerCase()) apply(null);
    });
    setReady(true);
    return () => {
      unsub();
      w.dispose();
    };
  }, [apply]);

  const value = useMemo<AuthValue>(
    () => ({
      ready,
      authenticated: Boolean(session),
      user: session
        ? {
            friendId: session.friendId,
            owner: session.owner,
            friendWallet: session.friendWallet,
            generation: session.generation,
            verified: session.verified !== false,
          }
        : null,
      login: () => setPickerOpen(true),
      logout: () => {
        apply(null);
        wallet?.disconnect();
      },
      getAccessToken: async () => {
        const s = sessionRef.current;
        if (!s) return null;
        if (s.exp - 60_000 < Date.now()) {
          apply(null);
          return null;
        }
        return s.token;
      },
      wallet,
    }),
    [ready, session, apply, wallet],
  );

  return (
    <AuthCtx.Provider value={value}>
      {children}
      {pickerOpen && wallet && (
        <FriendPicker
          wallet={wallet}
          onClose={() => setPickerOpen(false)}
          onSignedIn={(s) => {
            apply(s);
            setPickerOpen(false);
          }}
        />
      )}
    </AuthCtx.Provider>
  );
}

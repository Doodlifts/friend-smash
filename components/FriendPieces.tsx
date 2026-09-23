"use client";

/* components/FriendPieces.tsx — make the pieces YOUR Friends.

   When a Friend is signed in (wallet or pasted address), read every hardwired
   Friend held by that address (FriendSDK readOwnedFriends — read-only, no
   wallet needed), fetch each one's canonical sprite (createFriendReader), and
   hand them to the piece renderer with each Friend's on-chain WEIGHT class
   (lib/rf/traits: generation + activation tier → heavier pieces fall slower).
   The chosen Friend comes first. Signed out →
   generic on-chain Friends. Renders nothing. */

import { useEffect } from "react";
import type { Address } from "viem";
import { createFriendPublicClient } from "@rarefriends/friendsdk/wallet";
import { readOwnedFriends } from "@rarefriends/friendsdk/owned";
import { spriteFrame } from "@rarefriends/friendsdk/sprites";
import { useAuth } from "@/components/auth/AuthProvider";
import { friendReader } from "@/components/auth/FriendPortrait";
import { setPieceFriends, type PieceFriend } from "@/lib/rf/pieceArt";
import { readFriendTraits } from "@/lib/rf/traits";

export const PIECES_CHANGED = "rfsmash:pieces-changed";

let client: ReturnType<typeof createFriendPublicClient> | null = null;

/** Rebuild the engine's piece art; if the engine hasn't booted yet, wait for it. */
function refresh(tries = 0) {
  const ds = (window as { __DS?: { refreshArt?: () => unknown } }).__DS;
  if (ds?.refreshArt) {
    try {
      ds.refreshArt();
    } catch {
      /* ignore */
    }
    return;
  }
  if (tries < 40) window.setTimeout(() => refresh(tries + 1), 250);
}

/**
 * The wallet's hardwired Friend ids. The public RPC's filtered Transfer-log
 * query can fail transiently for big wallets, so retry with backoff and cache
 * the answer for this browser session (ownership is still re-verified
 * server-side before anything with stakes).
 */
async function ownedIds(owner: string): Promise<string[] | null> {
  const key = `rfsmashOwned:${owner.toLowerCase()}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) return JSON.parse(hit) as string[];
  } catch {
    /* storage unavailable */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await readOwnedFriends((client ??= createFriendPublicClient()), owner as Address);
      const ids = r.friends.map((f) => f.id.toString());
      try {
        sessionStorage.setItem(key, JSON.stringify(ids));
      } catch {
        /* ignore */
      }
      return ids;
    } catch {
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
  return null; // still failing — the signed-in Friend alone
}

async function loadFriend(id: string): Promise<PieceFriend | null> {
  const key = `rfsmashFriend:${id}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) return JSON.parse(hit) as PieceFriend;
  } catch {
    /* storage unavailable */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sprites = await friendReader().read(BigInt(id));
      const traits = await readFriendTraits((client ??= createFriendPublicClient()), BigInt(id)).catch(() => null);
      const f: PieceFriend = { id, rows: spriteFrame(sprites, "down", false, 0).frame.rows, weightClass: traits?.weightClass ?? 1 };
      try {
        if (traits) sessionStorage.setItem(key, JSON.stringify(f));
      } catch {
        /* ignore */
      }
      return f;
    } catch {
      await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    }
  }
  return null;
}

export default function FriendPieces() {
  const { user } = useAuth();
  const owner = user?.owner ?? null;
  const chosen = user?.friendId ?? null;

  useEffect(() => {
    if (!owner || !chosen) {
      setPieceFriends(null);
      refresh();
      window.dispatchEvent(new Event(PIECES_CHANGED));
      return;
    }
    let alive = true;
    (async () => {
      let ids: string[] = [chosen];
      const owned = await ownedIds(owner);
      if (owned) ids = [chosen, ...owned.filter((id) => id !== chosen)].slice(0, 7);
      // One Friend at a time (the public RPC rate-limits bursts), with retries,
      // cached per Friend for the session.
      const list: PieceFriend[] = [];
      for (const id of ids) {
        if (!alive) return;
        const f = await loadFriend(id);
        if (f) list.push(f);
      }
      if (!alive) return;
      setPieceFriends(list.length ? list : null);
      refresh();
      window.dispatchEvent(new Event(PIECES_CHANGED));
    })();
    return () => {
      alive = false;
    };
  }, [owner, chosen]);

  return null;
}

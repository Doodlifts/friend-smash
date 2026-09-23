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
import { setPieceFriends } from "@/lib/rf/pieceArt";
import { readFriendTraits } from "@/lib/rf/traits";

export const PIECES_CHANGED = "rfsmash:pieces-changed";

let client: ReturnType<typeof createFriendPublicClient> | null = null;

function refresh() {
  const ds = (window as { __DS?: { refreshArt?: () => unknown } }).__DS;
  try {
    ds?.refreshArt?.();
  } catch {
    /* engine not booted yet — its first build will read the new list */
  }
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
      try {
        const r = await readOwnedFriends((client ??= createFriendPublicClient()), owner as Address);
        const owned = r.friends.map((f) => f.id.toString()).filter((id) => id !== chosen);
        ids = [chosen, ...owned].slice(0, 7);
      } catch {
        /* discovery failed — still use the signed-in Friend alone */
      }
      const list = (
        await Promise.all(
          ids.map(async (id) => {
            try {
              const [s, traits] = await Promise.all([
                friendReader().read(BigInt(id)),
                readFriendTraits((client ??= createFriendPublicClient()), BigInt(id)).catch(() => null),
              ]);
              return { id, rows: spriteFrame(s, "down", false, 0).frame.rows, weightClass: traits?.weightClass ?? 1, generation: traits?.generation };
            } catch {
              return null;
            }
          }),
        )
      ).filter((x): x is NonNullable<typeof x> => !!x);
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

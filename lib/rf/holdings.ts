/* ============================================================
   lib/rf/holdings.ts — REAL $RAREFRIENDS held by a Friend (read-only).

   Reads RF.balanceOf(friend's canonical token-bound account) on Robinhood
   chain. Nothing here moves tokens; the balance only UNLOCKS power-ups
   (lib/rf/economy-rules.ts POWERUP_UNLOCK_RF). Cached briefly per wallet.
   ============================================================ */

import { parseAbi, type Address } from "viem";
import { rfPublicClient, RF_TOKEN_ADDRESS } from "./chain";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; rf: number }>();

/** Whole RF held by the Friend's wallet (floored), or null if unknown/unreadable. */
export async function friendWalletRf(friendWallet: string | null | undefined): Promise<number | null> {
  if (!friendWallet) return null;
  const key = friendWallet.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rf;
  try {
    const wei = await rfPublicClient().readContract({
      address: RF_TOKEN_ADDRESS,
      abi: ERC20,
      functionName: "balanceOf",
      args: [friendWallet as Address],
    });
    const rf = Number(wei / 10n ** 18n);
    if (cache.size > 5_000) cache.clear();
    cache.set(key, { at: Date.now(), rf });
    return rf;
  } catch {
    return null;
  }
}

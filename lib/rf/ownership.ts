/* ============================================================
   lib/rf/ownership.ts — server-side Rare Friends eligibility (FriendSDK).

   SERVER ONLY. Wraps FriendSDK's readGenerationEligibility: a fresh-block read
   of ownerOf + generation on the canonical Generations contract. A Friend is
   eligible iff the signed-in wallet owns it AND it is hardwired (gen >= 1).

   Called at sign-in and again before anything with stakes (ranked entry, run
   start, wagers), so a Friend sold mid-session stops earning for the seller.
   A short cache keeps a burst of requests from hammering the public RPC; it
   only ever caches for SECONDS and never caches failures.
   ============================================================ */

import { BaseError, ContractFunctionRevertedError, zeroAddress, type Address } from "viem";
import { readGenerationEligibility } from "@rarefriends/friendsdk/identity";
import { rfPublicClient, GENERATIONS_ADDRESS, TOKEN_BOUND_ABI } from "./chain";

export interface Eligibility {
  eligible: boolean;
  generation: number;
  owner: Address;
  /** The Friend's canonical token-bound wallet — where real RF would live. */
  friendWallet: Address | null;
  /** false when the token id doesn't exist on Generations. */
  exists?: boolean;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Eligibility }>();

export async function checkFriendEligibility(
  friendId: bigint,
  player: Address,
  opts: { fresh?: boolean } = {},
): Promise<Eligibility> {
  const key = `${friendId}:${player.toLowerCase()}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const client = rfPublicClient();
  let r: Awaited<ReturnType<typeof readGenerationEligibility>>;
  try {
    r = await readGenerationEligibility(client, friendId, player);
  } catch (e) {
    // A contract REVERT (e.g. ERC721NonexistentToken) is a definitive answer:
    // no such Friend, so not eligible. Network/RPC failures still throw.
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) {
      return { eligible: false, generation: 0, owner: zeroAddress, friendWallet: null, exists: false };
    }
    throw e;
  }
  let friendWallet: Address | null = null;
  try {
    friendWallet = await client.readContract({
      address: GENERATIONS_ADDRESS,
      abi: TOKEN_BOUND_ABI,
      functionName: "tokenBoundAccount",
      args: [friendId],
      blockNumber: r.blockNumber,
    });
  } catch {
    // Informational only (future RF payouts); never blocks play.
  }
  const value: Eligibility = {
    eligible: r.eligible === true,
    generation: Number(r.generation),
    owner: r.owner,
    friendWallet,
  };
  if (cache.size > 5_000) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test hook. */
export function _clearEligibilityCache() {
  cache.clear();
}

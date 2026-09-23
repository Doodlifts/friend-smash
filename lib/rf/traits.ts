/* ============================================================
   lib/rf/traits.ts — a Friend's on-chain traits → gameplay WEIGHT.

   Rare Friends' reward weight is RF-denominated and set by generation (earlier
   generations cost more RF to hardwire) and activation tier (upgrades raise
   weight within a generation). FriendSDK v0.1.2 doesn't expose a weight
   reader, so we read the two inputs from the Friend's fully on-chain
   metadata (Generations.tokenURI → attributes "Generation", "Activation tier")
   and derive a WEIGHT CLASS 1–5. Heavier Friends make pieces fall slower.

   Read-only. Works in the browser and on the server (any viem client).
   ============================================================ */

import { parseAbi, type PublicClient } from "viem";

const GENERATIONS = "0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D" as const;
const ABI = parseAbi(["function tokenURI(uint256 tokenId) view returns (string)"]);

export interface FriendTraits {
  generation: number;
  activationTier: number;
  active: boolean;
  character: string | null;
  weightClass: number; // 1 (light) … 5 (heaviest)
}

/** Weight class from the reward-weight inputs. Earlier gens + higher tiers = heavier. */
export function weightClass(generation: number, activationTier: number): number {
  const genBonus = generation <= 1 ? 2 : generation <= 3 ? 1 : 0;
  return Math.max(1, Math.min(5, 1 + genBonus + Math.max(0, Math.floor(activationTier))));
}

/** Gravity multiplier for a weight class: class 1 = normal, class 5 = 60% slower. */
export function gravityScaleForWeight(w: number): number {
  return 1 + 0.15 * (Math.max(1, Math.min(5, w)) - 1);
}

function decodeJson(uri: string): Record<string, unknown> | null {
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      const b64 = uri.slice(uri.indexOf(",") + 1);
      const text = typeof atob === "function" ? new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) : Buffer.from(b64, "base64").toString("utf8");
      return JSON.parse(text);
    }
    if (uri.startsWith("data:application/json")) return JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(",") + 1)));
  } catch {
    /* fallthrough */
  }
  return null;
}

export async function readFriendTraits(client: Pick<PublicClient, "readContract">, tokenId: bigint): Promise<FriendTraits> {
  const uri = await client.readContract({ address: GENERATIONS, abi: ABI, functionName: "tokenURI", args: [tokenId] });
  const meta = decodeJson(uri);
  const attrs = (Array.isArray(meta?.attributes) ? meta!.attributes : []) as { trait_type?: string; value?: unknown }[];
  const get = (k: string) => attrs.find((a) => a.trait_type === k)?.value;
  const generation = Number(get("Generation") ?? 0) || 0;
  const activationTier = Number(get("Activation tier") ?? 0) || 0;
  return {
    generation,
    activationTier,
    active: String(get("State") ?? "") === "Active",
    character: typeof get("Character") === "string" ? (get("Character") as string) : null,
    weightClass: weightClass(generation, activationTier),
  };
}

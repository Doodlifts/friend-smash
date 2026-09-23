/* ============================================================
   lib/rf/chain.ts — Rare Friends chain constants + the server read client.

   Everything here is READ-ONLY. Addresses come from FriendSDK v0.1.2
   (GENERATION_SPRITE_MANIFEST and the fishing example's public deployment);
   the RF token address is only used by the future on-chain ledger adapter
   (lib/rf/ledger.ts) — nothing in this app moves tokens today.
   ============================================================ */

import { parseAbi, type Address, type PublicClient } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "@rarefriends/friendsdk/sprites";
import { createFriendPublicClient } from "@rarefriends/friendsdk/wallet";

export const RF_CHAIN_ID = GENERATION_SPRITE_MANIFEST.chainId; // 4663, Robinhood mainnet
export const GENERATIONS_ADDRESS = GENERATION_SPRITE_MANIFEST.generations;
/** $RAREFRIENDS ERC-20 (18 decimals) — from FriendSDK examples/fishing/deployment.json. */
export const RF_TOKEN_ADDRESS = "0x0779369854d3EcdEA927206718FFD7730C67B71f" as Address;
/** Conventional burn sink for the future on-chain adapter. */
export const RF_BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

/**
 * Ledger unit. Balances are INTEGERS in the DB (never floats): 1 unit = 0.01 RF.
 * The chain uses 18-decimal base units, so 1 unit = 10^16 wei.
 */
export { UNITS_PER_RF, formatRf } from "./format";
export const WEI_PER_UNIT = 10n ** 16n;
export const unitsToWei = (units: number): bigint => BigInt(Math.trunc(units)) * WEI_PER_UNIT;

export const TOKEN_BOUND_ABI = parseAbi([
  "function tokenBoundAccount(uint256 tokenId) view returns (address)",
]);

let _client: PublicClient | null = null;
/** Memoized public client on the SDK's default Robinhood RPC (override with RF_RPC_URL). */
export function rfPublicClient(): PublicClient {
  if (!_client) _client = createFriendPublicClient({ rpcUrl: process.env.RF_RPC_URL || undefined });
  return _client;
}

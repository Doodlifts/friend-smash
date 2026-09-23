/* ============================================================
   lib/rf/settlement.ts — where SIMULATED RF becomes real $RAREFRIENDS.

   Today the game runs on the simulated ledger (lib/rf/ledger.ts). This file is
   the swap-in seam: it maps every ledger movement (reason) to the exact
   on-chain action it becomes, and builds that call's calldata with viem. It is
   a PLAN BUILDER ONLY — it never signs, sends, or holds a key. `settlementMode`
   stays "simulated" until the pieces marked TODO(onchain) exist.

   Where RF lives: FriendSDK treats each Generations NFT's canonical
   token-bound account (ERC-6551, `Generations.tokenBoundAccount(id)`) as the
   Friend's wallet. Spending therefore means the OWNER signs an
   `execute(...)` on that account; winnings are paid TO that account, so they
   travel with the NFT — the same rule the simulated ledger already follows.

   Mapping (ledger reason → on-chain action):
     purchase:<key>, pool:burn, versus:rake
         Friend TBA.execute → RF.transfer(0x…dEaD, amount)            [burn]
     pool:entry
         Friend TBA.execute → RF.approve(POOL, amount) + POOL.enter(day, runId)
     pool:prize, pool:rollover
         POOL.settle(day, winners[], amounts[])  — posted by the game's
         settlement key after the server-side replay verifies scores
         (TODO(onchain): verifier = multisig or signed-result oracle)
     versus:escrow / versus:win / versus:refund
         same POOL-style escrow contract keyed by matchId
     starter_grant, daily_bonus, run_reward
         REMOVED on-chain — players bring RF they bought; the faucet exists only
         to make the simulation playable.

   FriendSDK v0.1.2 already ships the building blocks for the consumer side
   (exact RF approvals, canonical-wallet transfers, receipt verification in
   `createLiveGameClient` / `createChanceGameTransport`); a live version would
   run these calls through that trusted runtime's confirmations.
   ============================================================ */

import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { RF_BURN_ADDRESS, RF_CHAIN_ID, RF_TOKEN_ADDRESS, unitsToWei } from "./chain";

export const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
/** ERC-6551 account execution (the Friend's token-bound wallet). */
export const TBA_ABI = parseAbi([
  "function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
]);
/** Proposed prize-pool / escrow contract (not deployed — see TODO above). */
export const POOL_ABI = parseAbi([
  "function enter(bytes32 day, bytes32 runId)",
  "function settle(bytes32 day, address[] winners, uint256[] amounts)",
]);

export type SettlementMode = "simulated" | "onchain";

/** Always "simulated" in this build. Flip only after the pool contract ships and is reviewed. */
export function settlementMode(): SettlementMode {
  return "simulated";
}

export interface OnchainCall {
  chainId: number;
  /** Who must sign: the Friend owner (via its TBA) or the game's settlement key. */
  signer: "friend-owner" | "settlement-key";
  to: Address;
  data: Hex;
  description: string;
}

const tbaExecute = (friendWallet: Address, to: Address, data: Hex, description: string): OnchainCall => ({
  chainId: RF_CHAIN_ID,
  signer: "friend-owner",
  to: friendWallet,
  data: encodeFunctionData({ abi: TBA_ABI, functionName: "execute", args: [to, 0n, data, 0] }),
  description,
});

/**
 * Plan the on-chain call(s) for one simulated Friend-side movement.
 * `units` are ledger units (1 unit = 1 RF). Returns [] for faucet-only reasons.
 */
export function planFriendMovement(p: {
  reason: string;
  units: number;
  friendWallet: Address;
  poolContract?: Address;
}): OnchainCall[] {
  const wei = unitsToWei(p.units);
  const burnData = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [RF_BURN_ADDRESS, wei] });
  if (p.reason.startsWith("purchase:") || p.reason === "pool:burn" || p.reason === "versus:rake") {
    return [tbaExecute(p.friendWallet, RF_TOKEN_ADDRESS, burnData, `Burn ${p.units} RF (${p.reason})`)];
  }
  if (p.reason === "pool:entry" || p.reason === "versus:escrow") {
    if (!p.poolContract) throw new Error("TODO(onchain): pool/escrow contract not deployed");
    const approve = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [p.poolContract, wei] });
    return [tbaExecute(p.friendWallet, RF_TOKEN_ADDRESS, approve, `Approve exactly ${p.units} RF for ${p.reason}`)];
  }
  if (["starter_grant", "daily_bonus", "run_reward", "grant"].includes(p.reason)) return [];
  throw new Error(`No on-chain mapping for ledger reason "${p.reason}"`);
}

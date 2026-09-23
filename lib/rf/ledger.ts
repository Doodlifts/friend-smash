/* ============================================================
   lib/rf/ledger.ts — the SIMULATED $RAREFRIENDS ledger (double-entry).

   ⚠️  NO REAL TOKENS MOVE. Balances are integers in Postgres
   (1 unit = 1 RF). Every movement is a TRANSFER between two accounts, written
   as two ledger rows (−amount / +amount) with the same (reason, refId), inside
   one transaction, idempotent on the ledger's (user, reason, refId) guard.

   Accounts are rows in `users`:
     friend:<tokenId>       a player — the Rare Friend itself (FriendSDK: items
                            and rewards belong to the NFT)
     system:burn            RF destroyed (sink; only ever increases)
     system:faucet          simulated issuance — stands in for "bought RF on
                            the market" (may go negative; its balance is the
                            total simulated RF ever handed out)
     system:escrow          versus-wager stakes held until the match settles
     system:pool:<day>      one daily prize pool per UTC day

   Because everything is a transfer, the system is closed:
     Σ friend balances + burn + escrow + pools + faucet == 0  (always)
   which makes "RF burned" and "RF paid to players" exact, auditable numbers.

   SWAP-IN POINT FOR REAL RF: see lib/rf/settlement.ts. Each system account
   maps to an on-chain destination (0xdEaD burn, pool escrow contract, …) and
   each transfer reason maps to one contract call. The game code only ever
   calls transfer()/transferTx() and the typed helpers below.
   ============================================================ */

import { eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db";
import { users, ledger } from "@/db/schema";

export class InsufficientFundsError extends Error {
  constructor() {
    super("Not enough RF (simulated).");
    this.name = "InsufficientFundsError";
  }
}

export const SYSTEM = {
  burn: "system:burn",
  faucet: "system:faucet",
  escrow: "system:escrow",
  pool: (day: string) => `system:pool:${day}`,
} as const;

export const isSystemDid = (did: string) => did.startsWith("system:");

/* ---------- system account ids (created on first use) ----------
   Deliberately NOT memoized: an id cached from a transaction that later rolled
   back (or from a wiped test DB) would point at nothing. One indexed lookup. */

export async function systemAccountId(db: DrizzleDb, did: string): Promise<string> {
  const [found] = await db.select({ id: users.id }).from(users).where(eq(users.did, did)).limit(1);
  if (found) return found.id;
  // ON CONFLICT DO NOTHING (not catch-and-retry): a unique violation would
  // abort the caller's whole Postgres transaction.
  const [row] = await db.insert(users).values({ did }).onConflictDoNothing({ target: users.did }).returning({ id: users.id });
  if (row) return row.id;
  const [raced] = await db.select({ id: users.id }).from(users).where(eq(users.did, did)).limit(1);
  return raced!.id;
}

/** Kept for test harnesses written against the memoized version (no-op). */
export function _clearSystemIds() {}

/* ---------------------------------- transfers ---------------------------------- */

export interface TransferParams {
  from: string; // users.id
  to: string; // users.id
  amount: number; // integer units, > 0
  reason: string;
  refId: string;
  /** Only system:faucet may go negative. */
  allowOverdraft?: boolean;
}

export interface TransferResult {
  /** false = this (reason, refId) was already applied (idempotent no-op). */
  applied: boolean;
  fromBalance: number;
  toBalance: number;
}

/**
 * Move `amount` between two accounts INSIDE an existing transaction.
 * Locks both rows in id order (deadlock-proof), claims the idempotency key on
 * the debit row, enforces non-negative balances, then writes the credit row.
 * Throws InsufficientFundsError (caller's tx rolls back).
 */
export async function transferTx(tx: DrizzleDb, p: TransferParams): Promise<TransferResult> {
  const amount = Math.trunc(p.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("transfer amount must be a positive integer");
  if (p.from === p.to) throw new Error("transfer to self");

  const rows = await tx
    .select({ id: users.id, b: users.rfBalance })
    .from(users)
    .where(inArray(users.id, [p.from, p.to]))
    .orderBy(users.id)
    .for("update");
  const bal = (id: string) => {
    const r = rows.find((x) => x.id === id);
    if (!r) throw new Error(`ledger account not found: ${id}`);
    return Number(r.b);
  };
  const fromBal = bal(p.from);
  const toBal = bal(p.to);

  const debit = await tx
    .insert(ledger)
    .values({ userId: p.from, delta: -amount, reason: p.reason, refId: p.refId })
    .onConflictDoNothing({ target: [ledger.userId, ledger.reason, ledger.refId] })
    .returning({ id: ledger.id });
  if (!debit.length) return { applied: false, fromBalance: fromBal, toBalance: toBal };

  if (!p.allowOverdraft && fromBal < amount) throw new InsufficientFundsError();

  await tx.insert(ledger).values({ userId: p.to, delta: amount, reason: p.reason, refId: p.refId });
  await tx.update(users).set({ rfBalance: sql`${users.rfBalance} - ${amount}` }).where(eq(users.id, p.from));
  await tx.update(users).set({ rfBalance: sql`${users.rfBalance} + ${amount}` }).where(eq(users.id, p.to));
  return { applied: true, fromBalance: fromBal - amount, toBalance: toBal + amount };
}

/** transferTx in its own transaction. */
export function transfer(db: DrizzleDb, p: TransferParams): Promise<TransferResult> {
  return db.transaction((tx) => transferTx(tx as unknown as DrizzleDb, p));
}

export async function balanceOf(db: DrizzleDb, userId: string): Promise<number> {
  const [u] = await db.select({ b: users.rfBalance }).from(users).where(eq(users.id, userId)).limit(1);
  return Number(u?.b ?? 0);
}

export async function systemBalance(db: DrizzleDb, did: string): Promise<number> {
  const [u] = await db.select({ b: users.rfBalance }).from(users).where(eq(users.did, did)).limit(1);
  return Number(u?.b ?? 0);
}

/* ------------------------------ typed movements ------------------------------ */

/** Simulated issuance (stands in for buying RF). Idempotent on refId. */
export async function grantFromFaucet(
  db: DrizzleDb,
  userId: string,
  amount: number,
  reason: string,
  refId: string,
): Promise<TransferResult> {
  const faucet = await systemAccountId(db, SYSTEM.faucet);
  // refId is namespaced by recipient: the faucet's own ledger rows share one
  // account, so "daily:2026-09-22" must be distinct per Friend.
  return transfer(db, { from: faucet, to: userId, amount, reason, refId: `${userId}:${refId}`, allowOverdraft: true });
}

/** Destroy RF from an account (inside a tx). */
export async function burnTx(
  tx: DrizzleDb,
  userId: string,
  amount: number,
  reason: string,
  refId: string,
): Promise<TransferResult> {
  const burn = await systemAccountId(tx, SYSTEM.burn);
  // Namespaced by payer so the shared burn account's rows never collide.
  return transferTx(tx, { from: userId, to: burn, amount, reason, refId: `${userId}:${refId}` });
}

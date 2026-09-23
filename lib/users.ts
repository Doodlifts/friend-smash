/* lib/users.ts — user row helpers (DB). Functions take a Drizzle db so they're
   reusable from routes (real Postgres) and tests (PGlite). */

import { eq } from "drizzle-orm";
import { isUniqueViolation, type DrizzleDb } from "./db";
import { users, type User } from "@/db/schema";
import { validateHandle } from "./handle";
import { HANDLE_CHANGE_COOLDOWN_MS } from "./rateLimit";
import type { VerifiedUser } from "./session";

/** Upsert a user by DID ("friend:<tokenId>") and return the row.
 *
 *  READ-FIRST: this runs on EVERY authenticated request, and the old
 *  unconditional ON CONFLICT DO UPDATE rewrote the row every time — a WAL
 *  write, a new row version, and a row lock that serialized against the
 *  balance updates money paths take (scale audit). Steady state is now one
 *  indexed SELECT; the insert only runs for genuinely new users, and a
 *  concurrent signup is caught by the unique violation. */
export async function upsertUserByDid(db: DrizzleDb, did: string): Promise<User> {
  const existing = await getUserByDid(db, did);
  if (existing) return existing;
  try {
    const [u] = await db.insert(users).values({ did }).returning();
    return u;
  } catch (e) {
    if (isUniqueViolation(e)) {
      const raced = await getUserByDid(db, did);
      if (raced) return raced; // another request created it first
    }
    throw e;
  }
}

export async function getUserByDid(db: DrizzleDb, did: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.did, did)).limit(1);
  return u ?? null;
}

export async function getUserById(db: DrizzleDb, id: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

/**
 * Upsert the signed-in Friend's row and keep its wallet columns current.
 * owner_address follows the NFT (a sale moves it); friend_wallet is the
 * Friend's canonical token-bound account — where real RF would be paid.
 * Read-first like upsertUserByDid: the UPDATE only runs when something changed.
 */
export async function upsertFriendUser(db: DrizzleDb, v: VerifiedUser): Promise<User> {
  const u = await upsertUserByDid(db, v.did);
  const owner = v.owner.toLowerCase();
  const fw = v.friendWallet?.toLowerCase() ?? null;
  if (u.ownerAddress === owner && u.friendWallet === fw && u.friendId === v.friendId.toString()) return u;
  const [fresh] = await db
    .update(users)
    .set({ ownerAddress: owner, friendWallet: fw, friendId: v.friendId.toString() })
    .where(eq(users.id, u.id))
    .returning();
  return fresh ?? u;
}

export interface SetHandleResult {
  ok: boolean;
  user?: User;
  error?: string;
  /** True when rejected purely for changing too soon (route maps this to 429). */
  tooSoon?: boolean;
}

/**
 * Set a user's handle. Re-validates server-side (never trust the client),
 * enforces an anti-churn cooldown between changes, and surfaces a friendly
 * error if the name is taken. Pass `now` for deterministic tests.
 */
export async function setHandle(
  db: DrizzleDb,
  userId: string,
  raw: string,
  opts: { now?: Date } = {},
): Promise<SetHandleResult> {
  const check = validateHandle(raw);
  if (!check.ok) return { ok: false, error: check.error };

  const now = opts.now ?? new Date();
  // Cooldown: block rapid handle churn (the first set has no prior timestamp).
  const [cur] = await db
    .select({ at: users.handleUpdatedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (cur?.at && now.getTime() - new Date(cur.at).getTime() < HANDLE_CHANGE_COOLDOWN_MS) {
    return {
      ok: false,
      tooSoon: true,
      error: "You're changing your name too often. Try again in a moment.",
    };
  }

  try {
    const [u] = await db
      .update(users)
      .set({ handle: check.value, handleUpdatedAt: now })
      .where(eq(users.id, userId))
      .returning();
    if (!u) return { ok: false, error: "User not found." };
    return { ok: true, user: u };
  } catch (e: unknown) {
    // Handle already taken (drizzle wraps the driver error, so check the chain).
    if (isUniqueViolation(e)) return { ok: false, error: "That name is taken." };
    throw e;
  }
}

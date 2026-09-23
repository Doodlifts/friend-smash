/* ============================================================
   lib/db.ts — database client (Drizzle over postgres.js).

   SERVER ONLY. Lazy + graceful: if DATABASE_URL is unset, getDb() returns null
   and callers respond "not configured" instead of crashing — so the app builds
   and the game plays before the DB is wired up.

   Serverless note: Vercel functions are short-lived and can fan out to many
   concurrent instances, so we keep per-instance connections tiny (max: 1) and
   disable prepared statements (prepare: false) for transaction-pooler
   (pgBouncer) compatibility. Front Railway Postgres with a POOLED connection
   string. The client is memoized per warm instance.
   ============================================================ */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

let _sql: ReturnType<typeof postgres> | null = null;
let _db: DrizzleDb | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * LOCAL DEV: DATABASE_URL=pglite:<dir> runs an embedded Postgres (PGlite, WASM)
 * in the Next.js server process — no database server needed. The schema +
 * power-up catalog are applied on first open; PGlite serializes queries, so
 * anything issued meanwhile simply waits. Kept on globalThis so dev hot-reload
 * doesn't open the data dir twice. Never used in production.
 */
function getPgliteDb(dir: string): DrizzleDb {
  const g = globalThis as unknown as { __rfPglite?: DrizzleDb };
  if (g.__rfPglite) return g.__rfPglite;
  const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = require("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
  const { readFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzlePglite(client, { schema }) as unknown as DrizzleDb;
  void client
    .exec(readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8"))
    .then(() => import("./powerups").then((m) => m.seedPowerups(db)))
    .catch((e) => console.error("[db] pglite init failed", e));
  g.__rfPglite = db;
  return db;
}

export function getDb(): DrizzleDb | null {
  if (!isDbConfigured()) return null;
  const url = process.env.DATABASE_URL as string;
  if (url.startsWith("pglite:")) return getPgliteDb(url.slice("pglite:".length) || ".data/pglite");
  if (!_db) {
    _sql = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    _db = drizzle(_sql, { schema });
  }
  return _db;
}

export { schema };

/** Postgres unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * Detect a unique-constraint violation. Drizzle wraps the driver error in a
 * DrizzleQueryError, so the SQLSTATE lives on `.cause` (not the top-level
 * error) — walk the cause chain and fall back to message matching for driver
 * differences (postgres.js vs PGlite).
 */
export function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const code = (cur as { code?: string }).code;
    if (code === PG_UNIQUE_VIOLATION) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  const msg =
    (e as { message?: string })?.message ||
    (e as { cause?: { message?: string } })?.cause?.message ||
    "";
  return /duplicate key value|unique constraint/i.test(msg);
}

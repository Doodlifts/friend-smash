/* scripts/db-setup.mjs — apply db/schema.sql + seed the power-up catalog.
   Usage: DATABASE_URL=... npm run db:setup
   (Loads .env.local via `node --env-file`; run with tsx to import the catalog.)

   Pooler note: migrations run raw DDL, which a TRANSACTION-mode pooler (pgBouncer)
   can choke on. So this script prefers DATABASE_URL_UNPOOLED — the DIRECT Postgres
   connection — when set, and only falls back to DATABASE_URL. Point the app's
   DATABASE_URL at the pooler; point DATABASE_URL_UNPOOLED at the direct DB. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.ts";
import { seedPowerups } from "../lib/powerups.ts";

// Prefer the direct (unpooled) URL for DDL; fall back to DATABASE_URL when no
// pooler is in play (current single-URL setup still works unchanged).
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error(
    "No database URL set. Add DATABASE_URL (or DATABASE_URL_UNPOOLED for the " +
      "direct connection) to .env.local or the environment.",
  );
  process.exit(1);
}

const ddl = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");
const sql = postgres(url, { max: 1, prepare: false });

try {
  await sql.unsafe(ddl);
  console.log("✓ Schema applied.");
  const db = drizzle(sql, { schema });
  await seedPowerups(db);
  console.log("✓ Power-up catalog seeded.");
} catch (e) {
  console.error("✗ Failed:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}

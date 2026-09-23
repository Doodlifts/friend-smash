/* test/helpers/testDb.ts — ephemeral in-process Postgres (PGlite) with the real
   schema, so the data layer is tested against actual SQL (uuid, jsonb,
   transactions, unique constraints) without a live database. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import type { DrizzleDb } from "../../lib/db";
import { seedPowerups } from "../../lib/powerups";

export async function makeTestDb(): Promise<DrizzleDb> {
  const client = await PGlite.create(); // in-memory, ephemeral
  await client.waitReady;
  const ddl = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");
  await client.exec(ddl);
  // The query API is identical across drivers; cast to the app's db type.
  const db = drizzle(client, { schema }) as unknown as DrizzleDb;
  await seedPowerups(db); // catalog rows so inventory FKs resolve
  return db;
}

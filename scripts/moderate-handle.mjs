/* scripts/moderate-handle.mjs — operator lever to fix an abusive public handle.

   Handles render publicly on the leaderboard, so this is the manual safety net
   behind the best-effort profanity filter: force-clear or rename a live handle.

   Usage (run from the project root):
     npm run moderate:handle -- "<handle>" --clear
     npm run moderate:handle -- "<handle>" --set "<newHandle>"

   Looks the user up by handle (case-insensitive). Uses DATABASE_URL_UNPOOLED if
   set (direct connection), else DATABASE_URL. Reads .env.local via the npm
   script's --env-file. */

import postgres from "postgres";

const [handleArg, action, newHandle] = process.argv.slice(2);

function usageExit(msg) {
  if (msg) console.error(`✗ ${msg}\n`);
  console.error('Usage:\n  npm run moderate:handle -- "<handle>" --clear');
  console.error('  npm run moderate:handle -- "<handle>" --set "<newHandle>"');
  process.exit(1);
}

if (!handleArg) usageExit("Missing <handle>.");
if (action !== "--clear" && action !== "--set") usageExit("Action must be --clear or --set.");
if (action === "--set" && !newHandle) usageExit("--set requires a <newHandle>.");

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) usageExit("No DATABASE_URL_UNPOOLED or DATABASE_URL set (check .env.local).");

const sql = postgres(url, { max: 1, prepare: false });

try {
  const [user] = await sql`
    SELECT id, handle FROM users WHERE lower(handle) = lower(${handleArg}) LIMIT 1
  `;
  if (!user) {
    console.error(`✗ No user found with handle "${handleArg}".`);
    process.exitCode = 1;
  } else if (action === "--clear") {
    await sql`UPDATE users SET handle = NULL, handle_updated_at = now() WHERE id = ${user.id}`;
    console.log(`✓ Cleared handle "${user.handle}" (user ${user.id}). They'll be prompted to pick a new one.`);
  } else {
    await sql`UPDATE users SET handle = ${newHandle}, handle_updated_at = now() WHERE id = ${user.id}`;
    console.log(`✓ Renamed "${user.handle}" → "${newHandle}" (user ${user.id}).`);
  }
} catch (e) {
  if (/duplicate key|unique/i.test(e.message || "")) {
    console.error(`✗ "${newHandle}" is already taken — pick another.`);
  } else {
    console.error("✗ Failed:", e.message);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}

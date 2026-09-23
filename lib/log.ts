/* ============================================================
   lib/log.ts — minimal structured logging for server code.

   SERVER ONLY. Emits single-line JSON to stdout/stderr, which Vercel captures
   in its per-function logs — so this gives you zero-setup monitoring today
   (filter the Vercel logs by `event`). It is also Sentry-ready: when you
   install @sentry/nextjs and set SENTRY_DSN, forward errors in captureError()
   (see the TODO) and the rest of the app needs no changes.

   Silent when DOOPIE_LOG_SILENT=1 (set by the DB integration tests so expected
   anti-cheat rejections don't clutter their output).
   ============================================================ */

type Json = Record<string, unknown>;

function emit(stream: "log" | "warn" | "error", entry: Json): void {
  // Read at call time (not module load) so a test setting the flag before the
  // first log — but after this module is imported — still takes effect.
  if (process.env.DOOPIE_LOG_SILENT === "1") return;
  // One JSON object per line so log drains (Vercel/Datadog/etc.) can parse it.
  console[stream](JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

/** Informational event (e.g. a notable but expected state change). */
export function logInfo(event: string, data: Json = {}): void {
  emit("log", { level: "info", event, ...data });
}

/** A rejected run — the core anti-cheat signal you want visibility into. */
export function logAntiCheatRejection(data: {
  userId: string;
  runId: string;
  reason: string;
  score: number;
  lines: number;
  ip?: string | null;
}): void {
  emit("warn", { level: "warn", event: "anticheat_reject", ...data });
}

/** A rate-limit trip (per-user or per-IP), for spotting abuse patterns. */
export function logRateLimit(data: {
  route: string;
  userId?: string;
  ip?: string | null;
  scope: "user" | "ip";
}): void {
  emit("warn", { level: "warn", event: "rate_limited", ...data });
}

/** An unexpected error. Logs structured + (later) forwards to Sentry. */
export function captureError(err: unknown, context: Json = {}): void {
  const e = err as { message?: string; stack?: string };
  emit("error", {
    level: "error",
    event: "error",
    message: e?.message ?? String(err),
    stack: e?.stack,
    ...context,
  });
  // TODO(sentry): once @sentry/nextjs is installed and SENTRY_DSN is set, add:
  //   Sentry.captureException(err, { extra: context });
  // No other call sites change — they already route errors through here.
}

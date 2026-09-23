/* ============================================================
   lib/handle.ts — display-handle validation + light profanity filter.

   SHARED: the client uses it for instant feedback in the handle picker;
   the server re-validates on save (never trust the client). Keep this pure.
   ============================================================ */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 15;

/** Allowed: letters, digits, and single underscores between them. */
const HANDLE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9_]{1,13})[a-zA-Z0-9]$/;

/**
 * Small substring blocklist. Intentionally best-effort, NOT a complete
 * moderation system — the real safety net is the operator lever
 * (scripts/moderate-handle.mjs), which can force-clear/rename any live handle.
 * Matching folds leetspeak, strips separators, and collapses repeated letters
 * so "f_u_c_k", "fück"→(n/a), "fuuuck", and "f4ck" all trip it. Expand as needed.
 */
const BLOCKLIST = [
  "fuck", "shit", "cunt", "nigger", "nigga", "faggot", "fag", "retard",
  "bitch", "whore", "slut", "rape", "nazi", "hitler", "kike", "spic",
  "chink", "dick", "cock", "pussy", "asshole", "bastard", "wanker",
  "twat", "wank", "coon", "tranny", "dyke", "beaner", "negro",
];

/** Lowercase, fold common leetspeak, and strip non-letters (so f_u_c_k -> fuck). */
function leetFold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[1!|]/g, "i")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/[4@]/g, "a") // was /4@/ — only matched the literal pair "4@"
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z]/g, "");
}

/** Collapse runs of the same letter to one ("assss" -> "as", "fuuuck" -> "fuck"). */
const collapseRuns = (s: string): string => s.replace(/(.)\1+/g, "$1");

export function containsProfanity(handle: string): boolean {
  const base = leetFold(handle);
  const collapsed = collapseRuns(base);
  // Match FULL blocklist words against both the folded form and a run-collapsed
  // form (so "fuuuck" -> "fuck"). We deliberately do NOT collapse the blocklist
  // words themselves — that would shrink "coon" to "con" and flag innocent
  // names like "second" or "bacon".
  return BLOCKLIST.some((w) => base.includes(w) || collapsed.includes(w));
}

export interface HandleCheck {
  ok: boolean;
  /** Normalized handle to store (trimmed; canonical case preserved). */
  value: string;
  error?: string;
}

/**
 * Validate a candidate handle. Returns ok=false with a user-facing `error`
 * when invalid. Does NOT check uniqueness — that's a DB concern (Phase 2).
 */
export function validateHandle(raw: string): HandleCheck {
  const value = (raw ?? "").trim();
  if (value.length < HANDLE_MIN) {
    return { ok: false, value, error: `At least ${HANDLE_MIN} characters.` };
  }
  if (value.length > HANDLE_MAX) {
    return { ok: false, value, error: `At most ${HANDLE_MAX} characters.` };
  }
  if (!HANDLE_RE.test(value)) {
    return {
      ok: false,
      value,
      error: "Letters, numbers, and underscores only (no leading/trailing _).",
    };
  }
  if (containsProfanity(value)) {
    return { ok: false, value, error: "Please choose a friendlier name." };
  }
  return { ok: true, value };
}

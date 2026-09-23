/* lib/rf/rankedPref.ts — client-side "enter ranked pool" preference.
   Shared by the pool panel (toggle), RunController (pays entry on game start)
   and the power-up tray (hidden during ranked runs). Browser-only. */

const KEY = "rfsmashRanked";
export const RANKED_CHANGED = "rfsmash:ranked-changed";

export function getRankedPref(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setRankedPref(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode: preference lasts for this page */
  }
  window.dispatchEvent(new Event(RANKED_CHANGED));
}

declare global {
  interface Window {
    /** True while the CURRENT game is a paid ranked (daily-pool) run. */
    __RF_RUN_RANKED?: boolean;
  }
}

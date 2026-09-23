/* lib/rf/format.ts — client-safe RF unit helpers (no chain imports).
   Ledger balances are INTEGERS: 1 unit = 0.01 RF. */

export const UNITS_PER_RF = 100;

/** 150 -> "1.5", 100 -> "1", 5 -> "0.05". */
export function formatRf(units: number): string {
  const v = units / UNITS_PER_RF;
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** "1.5 RF" */
export const rf = (units: number) => `${formatRf(units)} RF`;

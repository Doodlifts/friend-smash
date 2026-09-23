/* lib/rf/format.ts — client-safe RF unit helpers (no chain imports).
   Ledger balances are INTEGERS: 1 unit = 1 whole $RAREFRIENDS (RF has ~958M
   supply, so whole-RF prices are the realistic scale). */

export const UNITS_PER_RF = 1;

/** 1500 -> "1,500". */
export function formatRf(units: number): string {
  const v = units / UNITS_PER_RF;
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** "1.5 RF" */
export const rf = (units: number) => `${formatRf(units)} RF`;

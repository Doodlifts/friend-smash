/* Testing period: read-only. Players paste an address; wallet connect/sign is
   hidden. Set NEXT_PUBLIC_WALLET_SIGNIN=1 to re-enable signing later. */
export const READ_ONLY_TEST = process.env.NEXT_PUBLIC_WALLET_SIGNIN !== "1";

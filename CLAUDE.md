# CLAUDE.md — Friend Smash

Rare Friends Vibeathon entry: a falling-block smasher where every piece is built from on-chain Rare Friends portraits, the player IS their hardwired Generations NFT, and a simulated $RAREFRIENDS economy (burns + daily prize pools) runs on a double-entry ledger.

## Ground rules
- **RF is SIMULATED.** Never write code that signs, sends or holds keys. `lib/rf/settlement.ts` is a plan builder only.
- **Identity = FriendSDK v0.1.2** (`vendor/rarefriends-friendsdk-0.1.2.tgz`): `wallet`, `owned`, `identity`, `sprites`. Never enumerate Generations token ids. Re-check ownership (`lib/rf/ownership.ts`) before anything with stakes.
- **Every RF movement goes through `lib/rf/ledger.ts` transfers** so Σ balances == 0 stays true. Prices/splits live only in `lib/rf/economy-rules.ts`.
- **Anti-cheat is server-authoritative**: scores come from the server replay (`lib/replay.ts`), never the client.
- Engine: `components/engine.ts` (imperative canvas; keep piece geometry byte-identical with `lib/pieces.ts`).

## Commands (Node 22)
```
npm run dev          # DATABASE_URL=pglite:.data/pglite works with no DB server
npm test             # unit tests
npm run verify:db    # data-layer integration on PGlite
npx next build
```

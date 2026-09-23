# Friend Smash

**A falling-block smasher starring your Rare Friend, with a simulated $RAREFRIENDS economy that burns RF on every play and pays skill, not luck.**

Built for the [Rare Friends Vibeathon](https://github.com/spokesz/rarefriends-vibeathon) · categories: **Token Activity**, **Economy Potential**, **Character Spotlight**.

- **Play:** https://friend-smash.vercel.app — **read-only test**: paste an address holding a Rare Friend; nothing to connect or sign
- **Stack:** Next.js 14 · Postgres (Neon; embedded PGlite for local dev) · **FriendSDK v0.1.2** (`wallet`, `owned`, `identity`, `sprites`) · viem

> ⚠️ **All RF is SIMULATED.** No real tokens move, nothing is signed except a sign-in message. Balances are labelled "simulated" everywhere in the UI.

## What it is

- **Your Friends ARE the pieces.** Connect (or paste) the wallet that holds your hardwired Generations NFTs: every piece is drawn from the bare 16×16 on-chain pixel sprites of the Friends **in that wallet** (up to 7, one per shape, tinted by the SDK palette), kept upright through rotations. Guests see generic on-chain Friends until they pick theirs.
- **Weight matters.** A Friend's on-chain Generation + Activation tier (the inputs to its RF reward weight) give it a weight class 1–5. **Heavier Friends fall slower** — up to 1.6× the drop time at class 5 — so long-held, upgraded Friends are easier to place.
- **Real $RAREFRIENDS unlocks power-ups.** The server reads the real RF balance of the Friend's own wallet (its ERC-6551 token-bound account) — read-only, never moved — and unlocks power-ups by tier. Buying them still costs simulated RF (100% burned).
- **Skill decides payouts.** Every run is replayed on the server from its input log (seeded 7-bag, SRS, collision, scoring) — a client can't claim a score it didn't play. (Weight changes fall *timing* only; the replay verifies placements, so it can't desync anti-cheat.)
- **Two ways in:**
  - **Paste an address (read-only):** no wallet, nothing to sign; FriendSDK's ownership read confirms the address holds a hardwired Friend. Plays as a separate `👁 read-only` account, so a pasted address can never spend or win as the real owner.
  - **Connect wallet:** one Sign-In-with-Ethereum message (plain text; no transactions, approvals or typed-data permits exist anywhere in the app) → the verified Friend account.

## Economy (simulated RF · 1 unit = 1 $RAREFRIENDS)

| Mechanic | Cost | Where the RF goes |
|---|---|---|
| **Ranked run** (daily prize pool) | 50 RF per run | 40 → today's pool · **10 burned** |
| **Daily pool payout** | — | Top 10 best ranked scores (one per Friend) split the pot, top-heavy (10,9,…,1 weights, remainder to #1). Pays after 00:00 UTC + 2h grace. A pool with no finishers rolls into the next day. |
| **Power-ups** (practice + versus only) | 40–120 RF | **100% burned** |
| **Versus wagers** (50 / 100 / 250 RF) | stake each | winner takes pot minus **5% burned**; draws/aborts refund in full |
| **Starter grant / daily claim** | — | 1,000 RF once per Friend, 100 RF per UTC day — a demo faucet standing in for buying RF |

**Power-up unlocks (REAL RF held in the Friend's wallet, read-only):**

| Power-up | Unlock | Price (simulated, burned) |
|---|---|---|
| Friend Radar — see more upcoming pieces | 1,000 RF | 40 RF |
| Nap Time — gravity slows for 15s | 10,000 RF | 60 RF |
| Swap Friend — swap the current piece | 50,000 RF | 50 RF |
| Pixel Bomb — 3×3 blast | 100,000 RF | 120 RF |

Ranked runs are **equal-loadout**: power-ups are refused server-side, so the pool pays skill, not spend. There is no chance-based payout anywhere.

**Why it's a real economy, not a slot machine:** entries are a closed loop — players fund the pool, players win the pool, a fixed 20% is removed forever. More ranked play = more burn, and the house takes nothing. Power-ups are a pure sink, gated by genuine RF holdings — a reason to hold RF in your Friend.

**Accounting:** every movement is a double-entry transfer between accounts (`friend:<id>`, `watch:<id>`, `system:burn`, `system:faucet`, `system:escrow`, `system:pool:<day>`), idempotent per (account, reason, ref). Σ of all balances is always 0, so "RF burned" and "RF paid to players" are exact (shown live in the pool panel).

## FriendSDK usage & why not the sandbox frame

FriendSDK's sandboxed game frame can only reach the Robinhood RPC and exposes six fixed actions (`read/canBuy/buy/play/settle/redeem`), so a game inside it cannot submit a score to a server — which rules out replay anti-cheat, leaderboards, prize pools and versus. Friend Smash therefore runs as a **custom build using FriendSDK's advanced modules** in a trusted page:

| Need | FriendSDK |
|---|---|
| Wallet discovery, connect, switch to Robinhood (4663) | `@rarefriends/friendsdk/wallet` `createFriendWalletSession` |
| List the player's hardwired Friends (gen-0 hidden) | `@rarefriends/friendsdk/owned` `readOwnedFriends` |
| Ownership gate (client + **server**, fresh block) | `@rarefriends/friendsdk/identity` `readGenerationEligibility` |
| Friend artwork (pieces + portraits) | `@rarefriends/friendsdk/sprites` `createFriendReader`, `spriteFrame`, `FAMILIES_REGISTRY_ABI` |
| Weight + RF holdings (read-only) | `Generations.tokenURI` traits, `tokenBoundAccount`, `RF.balanceOf` via viem |

**Capability gap / proposal:** a `submitResult(runId, inputLog)` bridge action would let this exact game run inside the official sandbox frame.

## Path to real $RAREFRIENDS

`lib/rf/settlement.ts` maps every ledger reason to its on-chain call (built with viem, never sent): burns become `RF.transfer(0x…dEaD)` executed from the Friend's ERC-6551 token-bound wallet; pool entries become an exact `approve` + `POOL.enter(day, runId)`; payouts become `POOL.settle(day, winners, amounts)` posted after server replay verification; faucet grants disappear (players bring RF). Missing pieces: an audited pool/escrow contract and a verifier for posted results.

## Run it locally

```bash
# Node 22
npm ci
cp .env.example .env.local   # set SCORE_SIGNING_SECRET; DATABASE_URL=pglite:.data/pglite needs no DB server
npm run dev                  # http://localhost:3000
```

Checks: `npm test` (unit), `npm run verify:db` (data layer on embedded Postgres), `npx tsc --noEmit`, `npx next build`.

**Requirements to play ranked:** a browser wallet on Robinhood Chain (4663) holding a hardwired Rare Friends Generations NFT (generation ≥ 1). Mobile: use the wallet app's in-app browser (WalletConnect isn't in FriendSDK v0.1.2). Or paste any address holding one (read-only mode). Guests can play unranked without either.

## Credits

- Game engine forked from the builder's own *Doopie Smash*; all Doodles/Doopies art, video and branding removed.
- Rare Friends artwork: canonical Generations portraits read on-chain, used under FriendSDK's [artwork notice](https://github.com/spokesz/friendsdk/blob/main/NOTICE.md).
- Fonts: Silkscreen, Space Mono (Google Fonts, OFL).
- FriendSDK © Rare Friends, Apache-2.0.

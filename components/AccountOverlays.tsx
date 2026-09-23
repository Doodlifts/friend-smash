"use client";

/* components/AccountOverlays.tsx — the account-dependent overlays (Friend chip,
   run lifecycle, versus, power-up tray, daily bonus). Code-split so the first
   paint of the game doesn't wait on them. */

import dynamic from "next/dynamic";

const AuthBar = dynamic(() => import("./AuthBar"), { ssr: false });
const RunController = dynamic(() => import("./RunController"), { ssr: false });
const MatchController = dynamic(() => import("./MatchController"), { ssr: false });
const PowerupTray = dynamic(() => import("./PowerupTray"), { ssr: false });
const DailyBonus = dynamic(() => import("./DailyBonus"), { ssr: false });
const PoolPanel = dynamic(() => import("./PoolPanel"), { ssr: false });
const FriendPieces = dynamic(() => import("./FriendPieces"), { ssr: false });

export default function AccountOverlays() {
  return (
    <>
      <AuthBar />
      <RunController />
      <MatchController />
      <PowerupTray />
      <DailyBonus />
      <PoolPanel />
      <FriendPieces />
    </>
  );
}

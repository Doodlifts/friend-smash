import Game from "@/components/Game";
import LeaderboardLink from "@/components/LeaderboardLink";
import AccountOverlays from "@/components/AccountOverlays";
import BootLoader from "@/components/BootLoader";

export default function Home() {
  return (
    <>
      <Game />
      <LeaderboardLink />
      {/* Account overlays (Friend chip, run lifecycle, power-up tray). */}
      <AccountOverlays />

      {/* Boot splash — server-rendered so it paints on the first frame, before the
          game bundle parses; BootLoader fades it out once the engine is ready. */}
      <div id="bootLoader" aria-hidden="true">
        <div className="bl-stage">
          <div className="bl-px p1" />
          <div className="bl-px p2" />
          <div className="bl-px p3" />
        </div>
        <div className="bl-word">FRIEND SMASH!</div>
        <div className="bl-sub">loading</div>
        <div className="bl-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
      <BootLoader />
    </>
  );
}

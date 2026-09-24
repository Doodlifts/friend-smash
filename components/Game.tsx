"use client";

/* components/Game.tsx — the Friend Smash game surface.

   Renders the exact DOM the engine expects (same ids/classes as the
   original index.html), then boots the imperative canvas engine in a
   useEffect and tears it down on unmount. The engine lives in
   ./engine.ts; this component is just the React shell + lifecycle. */

import { useEffect } from "react";
import { startEngine } from "./engine";
import { BG_SVG } from "./bgMarkup";
import { IconPause, IconSound, IconFlag } from "./icons";

// Shared props for the chunky, on-brand control icons (inherit each button's color).
const IC = {
  viewBox: "0 0 24 24",
  width: 25,
  height: 25,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export default function Game() {
  useEffect(() => {
    // startEngine grabs the mounted DOM, wires input, and starts the loop.
    // It returns a cleanup that cancels RAF, clears timers/intervals, and
    // removes window/document listeners (covers Strict Mode double-mount).
    const dispose = startEngine();
    return dispose;
  }, []);

  return (
    <>
      {/* Camera world: blurred camera passthrough behind the backdrop (opt-in).
          Sits under #bg in the same stacking layer; when on, #bg becomes a
          translucent wash over it. Stream never leaves the device. */}
      <video id="camBg" autoPlay muted playsInline aria-hidden="true" />
      <div id="bg" dangerouslySetInnerHTML={{ __html: BG_SVG }} />

      <div id="app">
        <div id="topbar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <div id="logo"><img id="logoImg" alt="Friend Smash" /></div>
          <div id="stats">
            <div className="pill"><div className="lab">Score</div><div className="val num" id="sScore">0</div></div>
            <div className="pill"><div className="lab">Lines</div><div className="val num" id="sLines">0</div></div>
            <div className="pill"><div className="lab">Lvl</div><div className="val num" id="sLevel">1</div></div>
          </div>
          {/* Grouped so PAUSE and MUTE stay side by side and right-aligned
              whether or not the logo is rendered — the row must not depend on
              space-between arithmetic. */}
          <div className="tbBtns">
            <button className="iconbtn" id="btnPause" aria-label="Pause"><IconPause /></button>
            <button className="iconbtn" id="btnMute" aria-label="Toggle sound"><IconSound /></button>
          </div>
        </div>

        {/* VERSUS in-game bar: my score · round pips + clock · opponent live */}
        <div id="vsBar" className="hidden" aria-hidden="true">
          <span className="vsSide" id="vsMe">YOU 0</span>
          <span className="vsMidCol"><span id="vsPips"></span><span className="num" id="vsClock">1:00</span></span>
          <span className="vsSide" id="vsOpp">… 0</span>
        </div>

        <div id="mid">
          <div id="boardWrap">
            <canvas id="board"></canvas>
            <div id="popups"></div>
          </div>
          <div id="side">
            <div className="sidebox"><div className="lab">HOLD</div><canvas id="holdCv" width={140} height={100}></canvas></div>
            <div className="sidebox" style={{ flex: 1 }}><div className="lab">NEXT</div><canvas id="nextCv" width={140} height={320}></canvas></div>
          </div>
        </div>

        <div id="controls">
          <div id="ctlGrid">
            <div className="crow">
              {/* Rotate LEFT is a real button again, to the LEFT of HOLD so
                  HOLD sits centred over the ↓ below it — and so assistive tech
                  has a discrete control (the tap-left-half gesture is
                  unreachable when a screen reader consumes the tap). */}
              <button className="cbtn" id="btnCCW" aria-label="Rotate left">
                <svg {...IC}><polyline points="2 5 2 11 8 11" /><path d="M4.2 16a9 9 0 1 0 1.8-9.4L2 11" /></svg>
              </button>
              <button className="cbtn" id="btnHold" aria-label="Hold">
                <svg {...IC}><polyline points="17 2 21 6 17 10" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 22 3 18 7 14" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
                <small>HOLD</small>
              </button>
              <button className="cbtn" id="btnCW" aria-label="Rotate right">
                <svg {...IC}><polyline points="22 5 22 11 16 11" /><path d="M19.8 16a9 9 0 1 1-1.8-9.4L22 11" /></svg>
              </button>
            </div>
            <div className="crow">
              <button className="cbtn" id="btnL" aria-label="Move left">
                <svg {...IC}><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
              </button>
              <button className="cbtn" id="btnD" aria-label="Soft drop">
                <svg {...IC}><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
              </button>
              <button className="cbtn" id="btnR" aria-label="Move right">
                <svg {...IC}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
              </button>
            </div>
          </div>
        </div>

        {/* SMASH slider: sits in the right gutter, spanning the board's bottom
            edge down to the bottom of the control rows (top/bottom set from
            layout() via --smash-top). Slide the knob the full travel to
            hard-drop; it springs back on release. */}
        <div id="smashSlider" aria-label="Slide down to smash">
          <div className="ss-chevrons" aria-hidden="true"><span>⌄</span><span>⌄</span></div>
          <div id="btnSmash" role="button" tabIndex={0} aria-label="Smash — hard drop the piece" className="ss-knob">
            <svg {...IC}><line x1="12" y1="3" x2="12" y2="14" /><polyline points="6 10 12 16 18 10" /><line x1="4.5" y1="20.5" x2="19.5" y2="20.5" /></svg>
            <small>SMASH</small>
          </div>
        </div>
      </div>

      <div className="overlay" id="menuOv">
        <div className="card">
          {/* Rare Friends house header (menu only), mirroring rarefriends.com */}
          <div className="rfHeader" aria-label="Rare Friends">
            <span className="rfHeader-brand">
              <svg className="rfHeader-mark" viewBox="0 0 12 8" aria-hidden="true" shapeRendering="crispEdges" fill="currentColor"
                dangerouslySetInnerHTML={{ __html: '<rect x="2" y="0" width="1" height="1"/><rect x="9" y="0" width="1" height="1"/><rect x="1" y="1" width="1" height="1"/><rect x="2" y="1" width="1" height="1"/><rect x="3" y="1" width="1" height="1"/><rect x="8" y="1" width="1" height="1"/><rect x="9" y="1" width="1" height="1"/><rect x="10" y="1" width="1" height="1"/><rect x="0" y="2" width="1" height="1"/><rect x="1" y="2" width="1" height="1"/><rect x="2" y="2" width="1" height="1"/><rect x="3" y="2" width="1" height="1"/><rect x="4" y="2" width="1" height="1"/><rect x="5" y="2" width="1" height="1"/><rect x="6" y="2" width="1" height="1"/><rect x="7" y="2" width="1" height="1"/><rect x="8" y="2" width="1" height="1"/><rect x="9" y="2" width="1" height="1"/><rect x="10" y="2" width="1" height="1"/><rect x="11" y="2" width="1" height="1"/><rect x="0" y="3" width="1" height="1"/><rect x="1" y="3" width="1" height="1"/><rect x="4" y="3" width="1" height="1"/><rect x="5" y="3" width="1" height="1"/><rect x="6" y="3" width="1" height="1"/><rect x="7" y="3" width="1" height="1"/><rect x="10" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/><rect x="0" y="4" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="3" y="4" width="1" height="1"/><rect x="4" y="4" width="1" height="1"/><rect x="5" y="4" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/><rect x="7" y="4" width="1" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="9" y="4" width="1" height="1"/><rect x="10" y="4" width="1" height="1"/><rect x="11" y="4" width="1" height="1"/><rect x="1" y="5" width="1" height="1"/><rect x="2" y="5" width="1" height="1"/><rect x="3" y="5" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="5" y="5" width="1" height="1"/><rect x="6" y="5" width="1" height="1"/><rect x="7" y="5" width="1" height="1"/><rect x="8" y="5" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="5" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="3" y="6" width="1" height="1"/><rect x="8" y="6" width="1" height="1"/><rect x="9" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="9" y="7" width="1" height="1"/>' }} />
              RARE FRIENDS
            </span>
            <span className="rfHeader-app rfHeader-test">read-only test</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="menuLogo" id="menuLogo" alt="Friend Smash" />
          <div id="menuArt"></div>
          <div className="sub">Stack your Friends. Smash the rows.</div>
          <div className="hint hint-touch">
            <span className="kbd">drag</span> move&nbsp;&nbsp;<span className="kbd">tap a side</span> spin<br />
            <span className="kbd">flick ↓</span> smash&nbsp;&nbsp;<span className="kbd">drag ↓</span> soft-drop
          </div>
          <div className="hint hint-keys">
            <span className="kbd">←</span><span className="kbd">→</span> move&nbsp;&nbsp;<span className="kbd">↑</span> spin&nbsp;&nbsp;<span className="kbd">↓</span> soft-drop<br />
            <span className="kbd">space</span> smash&nbsp;&nbsp;<span className="kbd">C</span> hold&nbsp;&nbsp;<span className="kbd">P</span> pause
          </div>
          <button className="bigbtn" id="btnStart">SMASH!</button>
          <button className="bigbtn alt" id="btnVersus">VERSUS</button>
          <div className="freeplay">
            Paste your address — your Friends become the pieces.
          </div>
          <button className="worldchip" id="btnWorldOpen">Friends in your world</button>
        </div>
      </div>

      {/* Camera-world opt-in — the branded moment BEFORE the device prompts */}
      <div className="overlay hidden" id="worldOv">
        <div className="card">
          <div className="bigtitle" style={{ fontSize: "22px" }}>FRIENDS IN<br />YOUR ROOM?</div>
          {/* the engine swaps this line for returning opt-ins (resume mode);
              keep the default text in sync with WORLD_SUB_FIRST in engine.ts */}
          <div className="sub" id="worldSub">
            Your camera becomes the backdrop.
          </div>
          <button className="bigbtn" id="btnWorldYes">YES</button>
          <button className="bigbtn ghost" id="btnWorldNo">NOT NOW</button>
          <div className="worldnote" id="worldNote">
            Stays on your device.
          </div>
        </div>
      </div>

      {/* VERSUS lobby: wager pick → matchmaking queue → opponent found */}
      <div className="overlay hidden" id="vsOv">
        <div className="card">
          <div className="bigtitle" style={{ fontSize: "28px" }}>VERSUS</div>
          {/* mode picker: two very different fights */}
          <div className="vsModeRow" id="vsModeRow">
            {/* names only — the line under the row describes the selected mode */}
            <button className="vsmode sel" id="modeSpeed" data-mode="speed">
              <span className="vsmode-name">SPEED SMASH</span>
            </button>
            <button className="vsmode" id="modeTurf" data-mode="turf">
              <span className="vsmode-name">TURF WAR</span>
            </button>
          </div>
          <div className="sub" id="vsLobbySub">
            Best of 5. Same pieces, 60 seconds a round —<br />highest score takes it. Winner takes the pot.
          </div>
          <div className="vsWagerRow" id="vsWagerRow">
            <button className="vschip sel" data-wager="0">FREE</button>
            <button className="vschip" data-wager="50">50</button>
            <button className="vschip" data-wager="100">100</button>
            <button className="vschip" data-wager="250">250</button>
          </div>
          <div className="vsBalance" id="vsBalance"></div>
          <button className="bigbtn" id="btnVsFind">FIND A RIVAL</button>
          <div className="vsStatus hidden" id="vsStatus">SEARCHING…</div>
          <button className="bigbtn ghost" id="btnVsClose">BACK</button>
          <div className="worldnote">Wagers use your simulated RF balance — no real tokens move.</div>
        </div>
      </div>

      {/* Ready-up: opponent card + rules; clocks start when BOTH tap READY */}
      <div className="overlay hidden" id="vsReadyOv">
        <div className="card">
          <div className="bigtitle" style={{ fontSize: "22px" }}>OPPONENT FOUND</div>
          <div className="vsScore num" id="readyOpp"></div>
          <div className="sub" id="readyRecord"></div>
          <div className="sub" id="readyMeta"></div>
          {/* objective diagram — the engine shows the block matching the mode */}
          <div className="readyArt hidden" id="readyArtTurf" aria-hidden="true">
            {/* two example rows — each label sits in its own clear band, never over the cells */}
            <svg viewBox="0 0 238 108" width="238" height="108">
              {/* mixed row (dead turf) */}
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <rect key={`m${i}`} x={10 + i * 31} y={4} width={27} height={24} rx={1}
                  fill={[1, 4, 5].includes(i) ? "#7DB4DB" : "#e2ff66"} stroke="#111" strokeWidth="2.5" />
              ))}
              <text x="119" y="42" textAnchor="middle" fontFamily="var(--font-display)" fontSize="10" fill="#111" opacity=".6">MIXED ROW = NOTHING</text>
              {/* pure pink row (the win) */}
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <rect key={`w${i}`} x={10 + i * 31} y={54} width={27} height={24} rx={1}
                  fill="#CCFF00" stroke="#111" strokeWidth="2.5" />
              ))}
              <text x="119" y="97" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="12" fill="#111">ALL 7 YOURS = WIN!</text>
            </svg>
          </div>
          <div className="readyArt hidden" id="readyArtSpeed" aria-hidden="true">
            <svg viewBox="0 0 238 104" width="238" height="104">
              <rect x="2" y="2" width="112" height="100" rx="4" fill="#fff" stroke="#111" strokeWidth="4" />
              <rect x="124" y="2" width="112" height="100" rx="4" fill="#fff" stroke="#111" strokeWidth="4" />
              <text x="58" y="30" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="13" fill="#4a6600">YOU</text>
              <text x="180" y="30" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="13" fill="#2f6e99">THEM</text>
              <text x="58" y="62" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="20" fill="#111">1,840</text>
              <text x="180" y="62" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="20" fill="#111">1,530</text>
              <text x="119" y="90" textAnchor="middle" fontFamily="var(--font)" fontWeight="700" fontSize="10" fill="#111" opacity=".6">same pieces · 60s · high score takes the round</text>
            </svg>
          </div>
          <div className="readyRules" id="readyRules"></div>
          <button className="bigbtn" id="btnReady">READY!</button>
          <div className="vsStatus hidden" id="readyStatus">WAITING FOR YOUR OPPONENT…</div>
          <div className="worldnote">Nobody&apos;s clock starts until you&apos;re both ready.</div>
        </div>
      </div>

      {/* TURF WAR arena: turn-based shared board (sits under the splash) */}
      <div className="overlay hidden" id="turfOv">
        <div className="turfWrap">
          <div className="turfTop">
            <span className="turfTag turfPink" id="turfMe">YOU</span>
            <span className="turfMid">
              <span className="num turfTally" id="turfTally">0 – 0</span>
              <span className="turfGameN" id="turfGameN">GAME 1</span>
            </span>
            <span className="turfTag turfBlue" id="turfOpp">THEM</span>
            <button className="turfFlag" id="turfConcede" aria-label="Forfeit the match"><IconFlag size={14} /> QUIT</button>
          </div>
          <div className="turfBanner" id="turfBanner">YOUR TURN</div>
          <canvas id="turfCv"></canvas>
          <div className="turfBottom">
            <div className="turfNextBox">
              <span className="lab">NEXT</span>
              <canvas id="turfNextCv" width={132} height={64}></canvas>
            </div>
            <div className="turfClock num" id="turfClock">10</div>
            <button className="turfBtn" id="turfRotate" aria-label="Rotate">⟳</button>
            <button className="turfBtn turfGo" id="turfPlace">PLACE</button>
          </div>
        </div>
      </div>

      {/* VERSUS round/match splash: countdowns, round results, final verdict */}
      <div className="overlay hidden" id="vsSplashOv">
        <div className="card">
          <div className="bigtitle" id="vsSplashTitle" style={{ fontSize: "24px" }}></div>
          <div className="vsScore num" id="vsSplashScore"></div>
          <div className="sub vsSub" id="vsSplashSub"></div>
          <div className="vsTally" id="vsSplashTally"></div>
          <div className="vsCount num" id="vsSplashCount"></div>
          <button className="bigbtn hidden" id="btnVsDone">DONE</button>
        </div>
      </div>

      {/* VERSUS concede confirm (replaces pause — the clock never stops) */}
      <div className="overlay hidden" id="vsQuitOv">
        <div className="card">
          <div className="bigtitle" style={{ fontSize: "22px" }}>CONCEDE THE MATCH?</div>
          <div className="sub" id="vsQuitSub">Your opponent takes the pot. Your Friend will remember.</div>
          <button className="bigbtn ghost" id="btnVsKeep">KEEP FIGHTING</button>
          <button className="bigbtn alt" id="btnVsConcede">CONCEDE</button>
        </div>
      </div>

      <div className="overlay hidden" id="pauseOv">
        <div className="card">
          <div className="bigtitle" style={{ fontSize: "30px" }}>PAUSED</div>
          <div className="sub">Your Friends are catching their breath.</div>
          <button className="bigbtn" id="btnResume">RESUME</button>
          <button className="bigbtn alt" id="btnRestart1">SMASH AGAIN</button>
          <button className="bigbtn ghost" id="btnHowTo">HOW TO PLAY</button>
          <button className="bigbtn ghost togglebtn" id="btnCamToggle">CAMERA WORLD: OFF</button>
          <button className="bigbtn ghost" id="btnQuit">QUIT</button>
        </div>
      </div>

      <div className="overlay hidden" id="overOv">
        <div className="card">
          <div className="bigtitle gameovertitle" style={{ fontSize: "30px" }}>GAME<span className="t2">OVER!</span></div>
          <div id="overQuip" className="sub"></div>
          <div className="sub">Final score</div>
          <div id="overScore">0</div>
          <div id="overBest"></div>
          <button className="bigbtn" id="btnRestart2">SMASH AGAIN</button>
        </div>
      </div>

      <div className="overlay hidden" id="controlsOv">
        <div className="card">
          <div className="bigtitle" style={{ fontSize: "24px" }}>HOW TO PLAY</div>
          <div className="howSec">Touch</div>
          <div className="howGrid">
            <span className="kbd">drag</span><span>Move left / right</span>
            <span className="kbd">tap a side</span><span>Spin toward that side</span>
            <span className="kbd">flick ↓</span><span>SMASH! (hard drop)</span>
            <span className="kbd">drag ↓</span><span>Soft-drop</span>
            <span className="kbd">slider</span><span>Slide the knob to the bottom — SMASH!</span>
            <span className="kbd">hold</span><span>Stash a piece for later</span>
          </div>
          <div className="howSec">Keyboard</div>
          <div className="howGrid">
            <span><span className="kbd">←</span> <span className="kbd">→</span></span><span>Move left / right</span>
            <span><span className="kbd">↑</span> <span className="kbd">X</span> <span className="kbd">Z</span></span><span>Spin (Z spins the other way)</span>
            <span className="kbd">↓</span><span>Soft-drop</span>
            <span className="kbd">space</span><span>SMASH! (hard drop)</span>
            <span><span className="kbd">C</span> <span className="kbd">shift</span></span><span>Stash a piece</span>
            <span><span className="kbd">P</span> <span className="kbd">esc</span></span><span>Pause</span>
          </div>
          <div className="sub" style={{ marginTop: "10px" }}>
            Clear full rows to smash them. Grab power-ups in the shop.
          </div>
          <button className="bigbtn" id="btnCloseHowTo">GOT IT</button>
        </div>
      </div>
    </>
  );
}

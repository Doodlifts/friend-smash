// @ts-nocheck
/* ============================================================
   components/engine.ts — FRIEND SMASH game engine (Rare Friends reskin of the Doopie Smash engine).

   A faithful port of the imperative engine from the original index.html.
   Behavior, art alignment, gore and audio are preserved byte-for-byte;
   the ONLY changes from the original are structural for Next.js/React:

     • Art + wordmark base64 imported from lib/artData (was inline).
     • The 7-bag piece sequence is driven by the SEEDED PRNG in lib/rng
       (was Math.random) so the server can replay a run deterministically.
       Feel is identical: each game still gets a fresh random seed locally.
     • Scoring is routed through lib/scoring (the server re-scores with the
       same functions).
     • All DOM access + listeners live inside startEngine(); it returns a
       cleanup fn that cancels the RAF loop, clears intervals/timers and
       removes window/document listeners (React mount/unmount + Strict Mode).

   This file is browser-only and must run after the DOM has mounted.
   ============================================================ */

import { pieceDataUrl, pieceCanvas, wordmarkDataUrl, PIECE_STYLE, gravityScaleFor } from "@/lib/rf/pieceArt";
import { bombBlast } from "@/lib/pieces";
import { SevenBag, randomSeed } from "@/lib/rng";
import {
  scoreClear,
  levelForLines,
  gravityMs,
  softDropPoints,
  hardDropPoints,
  smashClearPoints,
  SCORING_ALGO_V,
} from "@/lib/scoring";
import { resolveBonus, pickBonusKind, bonusRng, sanitizeBonus, DEFAULT_BONUS, gutsForClear, meterTarget, applyBonusGravity } from "@/lib/bonus";

export function startEngine(): () => void {
  "use strict";

  const CELL = 96;            // px per cell in source art space
  const COLS = 10, ROWS = 20, HIDDEN = 2, TOTAL = ROWS + HIDDEN;

  // Accessibility: honor the OS "reduce motion" setting — keep the gore stains
  // (the game's identity) but skip the violent full-screen burst + screen shake.
  let reduceMotion = false;
  try { reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){}
  // Haptics: short vibration patterns for tactile feedback on key moments.
  // Android/Chrome use navigator.vibrate. iOS SAFARI HAS NO VIBRATION API —
  // we emulate with the switch-toggle haptic (iOS 17.4+: toggling an
  // <input type="checkbox" switch> during user activation fires a physical
  // tick), one tick per vibrate segment of the pattern. Cosmetic — never
  // recorded, never affects replay.
  let hapticSwitch = null;
  try{
    hapticSwitch = document.createElement("input");
    hapticSwitch.type = "checkbox";
    hapticSwitch.setAttribute("switch", "");
    hapticSwitch.tabIndex = -1;
    hapticSwitch.setAttribute("aria-hidden", "true");
    hapticSwitch.style.cssText = "position:fixed;left:-30px;top:-30px;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(hapticSwitch);
  }catch(_){ hapticSwitch = null; }
  function haptic(p){
    try {
      if (reduceMotion || typeof navigator === "undefined") return;
      if (navigator.vibrate){ navigator.vibrate(p); return; }
      if (!hapticSwitch) return;
      // iOS: one tick per vibrate segment (even indices), spaced like the pattern
      const seq = Array.isArray(p) ? p : [p];
      let at = 0;
      for (let i = 0; i < seq.length; i += 2){
        if (seq[i] > 0){
          const d = at;
          setTimeout(()=>{ try{ hapticSwitch.click(); }catch(_){} }, d);
        }
        at += (seq[i] || 0) + (seq[i+1] || 0);
      }
    } catch(_){ }
  }

  /* ---------- game tuning (admin-tunable; see lib/gameConfig) ----------
     Ranked runs play with the SNAPSHOT returned by /api/run/start (the server
     replays against the same snapshot). Unranked play fetches the live public
     config at boot; code defaults cover the offline/unconfigured case. */
  const tuning = { bonus: { ...DEFAULT_BONUS }, gore: { intensity: 1 }, scoring: { v: SCORING_ALGO_V } };
  function applyPublicConfig(cfg){
    try{
      if (cfg && cfg.bonus) tuning.bonus = sanitizeBonus(cfg.bonus);
      if (cfg && cfg.gore && typeof cfg.gore.intensity === "number")
        tuning.gore.intensity = Math.min(2, Math.max(.25, cfg.gore.intensity));
      // Scoring version rides the run's snapshot so the HUD matches what the
      // server will certify. A snapshot without it was played under v1.
      const sv = cfg && cfg.scoring && typeof cfg.scoring.v === "number" ? Math.floor(cfg.scoring.v) : 1;
      tuning.scoring.v = Math.min(SCORING_ALGO_V, Math.max(1, sv));
    }catch(_){ }
  }
  const scoringV = ()=>tuning.scoring.v;
  // Boot-time public config for UNRANKED play only — never let a late response
  // clobber a ranked run's snapshot (startGame applies that; replay depends on it).
  try{ fetch("/api/config").then(r=>r.ok?r.json():null).then(c=>{ if(c && !activeRun) applyPublicConfig(c); }).catch(()=>{}); }catch(_){ }

  /* ---------- shapes (SRS frames, spawn orientation) ---------- */
  const SHAPES = {
    I:{n:4, c:[[0,1],[1,1],[2,1],[3,1]]},
    J:{n:3, c:[[0,0],[0,1],[1,1],[2,1]]},
    L:{n:3, c:[[2,0],[0,1],[1,1],[2,1]]},
    O:{n:2, c:[[0,0],[1,0],[0,1],[1,1]]},
    S:{n:3, c:[[1,0],[2,0],[0,1],[1,1]]},
    T:{n:3, c:[[1,0],[0,1],[1,1],[2,1]]},
    Z:{n:3, c:[[0,0],[1,0],[1,1],[2,1]]},
  };
  const TYPES = Object.keys(SHAPES);

  /* rotation states: cells in frame coords + minimal bbox, per rotation */
  const STATES = {};
  for (const t of TYPES){
    const n = SHAPES[t].n;
    let cells = SHAPES[t].c.map(c=>c.slice());
    STATES[t] = [];
    for (let r=0;r<4;r++){
      const xs = cells.map(c=>c[0]), ys = cells.map(c=>c[1]);
      const bx = Math.min(...xs), by = Math.min(...ys);
      STATES[t].push({
        cells: cells.map(c=>c.slice()),
        bx, by,
        w: Math.max(...xs)-bx+1, h: Math.max(...ys)-by+1
      });
      cells = cells.map(([x,y])=>[n-1-y, x]); // 90° CW in n-frame
    }
  }

  /* ---------- SRS wall kicks (SRS y-up; negate y when applying) ---------- */
  const KICKS_JLSTZ = {
    "0>1":[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]], "1>0":[[0,0],[1,0],[1,-1],[0,2],[1,2]],
    "1>2":[[0,0],[1,0],[1,-1],[0,2],[1,2]],     "2>1":[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    "2>3":[[0,0],[1,0],[1,1],[0,-2],[1,-2]],    "3>2":[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    "3>0":[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],  "0>3":[[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  };
  const KICKS_I = {
    "0>1":[[0,0],[-2,0],[1,0],[-2,-1],[1,2]],   "1>0":[[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    "1>2":[[0,0],[-1,0],[2,0],[-1,2],[2,-1]],   "2>1":[[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    "2>3":[[0,0],[2,0],[-1,0],[2,1],[-1,-2]],   "3>2":[[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    "3>0":[[0,0],[1,0],[-2,0],[1,-2],[-2,1]],   "0>3":[[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
  };

  /* ============================================================
     ART — original Doopie PNGs + I & Z designed in matching style
     art[type][variant] = {img, dx, dy, fw, fh}  (body top-left at dx,dy;
     body spans exactly gridW*CELL × gridH*CELL; the rest overlaps freely)
     ============================================================ */
  // Rare Friends palette: the old "blood" accents are now signal green + ink.
  const INK = "#111111", BLOOD = "#CCFF00", BLOOD_D = "#111111";

  const GRIDS = {I:[4,1], J:[3,2], L:[3,2], O:[2,2], S:[3,2], T:[3,2], Z:[3,2]};
  const art = {};            // art[type][variant] = {img,dx,dy,fw,fh}
  const rotCache = {};       // key t_v_r -> {cv,dx,dy,fw,fh}

  // Resolves on the first committed art build (boot waits on this).
  let artReadyResolve;
  const artReady = new Promise((res)=>{ artReadyResolve = res; });

  // Uploaded sprites (admin ASSETS panel). null = draw the hand-drawn canvas
  // vectors as always; an image swaps the ART only — all motion (scurry, aim,
  // flight, sweep, bobbing, tumbling) stays code-driven. The bone is not a
  // bonus-round sprite: it bobs on the guts meter and tumbles in the gore
  // burst, one upload re-skins both.
  // (no `banana` slot: the gun was cut from the round in playtest round 2 —
  // nothing draws it, so loading an override for it would be dead weight;
  // the bonus_banana DB key stays valid for storage back-compat only)
  const spriteArt = { rat: null, arrow: null, sword: null, bone: null };
  const SPRITE_ASSET_KEY = { rat: "bonus_rat", arrow: "bonus_arrow", sword: "bonus_sword", bone: "guts_bone" };

  /* Bundled ARTIST sprites (public/sprites/*.svg, cut from the artist's
     tetris-effects.ai). These are the SHIPPED DEFAULTS — versioned with the
     code, no admin upload needed. Precedence: an admin ASSETS override (the
     single-slot spriteArt above) replaces its whole family uniformly; with
     no override, families with several entries are VARIANTS and pickers use
     a stable per-entity index so each rat/bone/chunk keeps its look from
     frame to frame. `facing`: +1 art faces right, -1 faces left — flipped
     into the entity's travel direction at draw time. Code-drawn vectors
     remain the last-resort fallback until an image decodes. */
  const ART_SPRITES = {
    rat:     { files: ["rat-2-right", "rat-1-flat", "rat-3-left"], facing: [1, 1, -1] },
    arrowR:  { files: ["dart-right"] },
    arrowL:  { files: ["dart-left"] },
    sword:   { files: ["sword"] },
    bone:    { files: ["bones-crossed", "bone-pile", "bone-loop", "bone-coil", "skull"] },
    guts:    { files: ["guts-pile", "guts-braid", "stomach", "guts-coil", "heart"] },
    hole:    { files: ["bullet-hole-1", "bullet-hole-2", "bullet-hole-3"] },
    smashFx: { files: ["smash-big", "smash-small"] },
  };
  const artSprite = {}; // fam -> Image[] in fixed file order (ready = naturalWidth > 0)
  // Rare Friends ships no gore/bonus artist sprites: every family stays empty,
  // so pickSprite() returns null and callers use their code-drawn fallbacks.
  for (const fam of Object.keys(ART_SPRITES)) artSprite[fam] = [];
  // Stable variant pick; null until that entry has decoded (caller falls back).
  const pickSprite = (fam, i)=>{
    const arr = artSprite[fam];
    if (!arr || !arr.length) return null;
    const img = arr[(((i|0) % arr.length) + arr.length) % arr.length];
    return (img && img.naturalWidth > 0) ? img : null;
  };

  /* RARE FRIENDS: every piece is generated from on-chain Friend portraits
     (lib/rf/pieceArt). The old admin art-override manifest is gone, so the
     board can never regress to non-Friend art. Images are data-URL PNGs so the
     naturalWidth/.src contracts below (rotCanvas, drawMini, menu) hold. */
  let artGen = 0;
  function buildArt(){
    const gen = ++artGen;
    const jobs = [];
    const staged = {};
    for (const t of ["J","L","T","O","S","I","Z"]){
      staged[t] = {};
      for (const v of ["clean","blood"]){
        const g = pieceDataUrl(t, v);
        const img = new Image();
        jobs.push(new Promise(res=>{ img.onload = res; img.onerror = res; }));
        img.src = g.url;
        staged[t][v] = {img, dx:0, dy:0, fw:g.fw, fh:g.fh};
      }
    }
    return Promise.all(jobs).then(()=>{
      if (disposed || gen !== artGen) return;
      for (const t in staged) art[t] = staged[t];
      for (const k in rotCache) delete rotCache[k];
      try{
        for (const k in turfSil) delete turfSil[k];
        if (turfc){ turfDraw(); turfDrawNext(); }
      }catch(_){ }
      try{ buildMenuArt(); drawSide(); }catch(_){ }
      if (artReadyResolve){ artReadyResolve(); artReadyResolve = null; }
    });
  }

  // menu doopies bob from art[] — rebuilt at boot AND on every reconcile
  // (review: the menu is where players sit between games; it kept the old
  // sprites after a late manifest landed).
  function buildMenuArt(){
    const ma = document.getElementById("menuArt");
    if (!ma || !art.T || !art.T.clean) return;
    ma.innerHTML = "";
    for (const t of ["T","O","S"]){ const im = new Image(); im.src = art[t].clean.img.src; ma.appendChild(im); }
  }

  function loadArt(){
    return buildArt().then(()=>artReady);
  }

  /* Rare Friends: instead of rotating the piece IMAGE (which would lay the
     pixel Friends on their sides), draw each rotation's cell layout with the
     sprites upright. The art body always starts at (0,0) and exactly fills the
     rotated bbox, so dx/dy stay 0 — identical to what the old rotation math
     produced for this art, so slicing/turf/ghost code is unaffected. */
  function rotCanvas(t, v, r){
    const key = t+"_"+v+"_"+r;
    if (rotCache[key]) return rotCache[key];
    const st = STATES[t][r];
    const cells = st.cells.map(([x,y])=>[x - st.bx, y - st.by]);
    const cv = pieceCanvas(t, v, cells, st.w, st.h);
    return rotCache[key] = {cv, dx:0, dy:0, fw:cv.width, fh:cv.height};
  }

  /* ============================================================ AUDIO */
  const Sfx = {
    ctx:null, on:true,
    // Resume on ANY non-running state: iOS Safari reports the non-standard
    // "interrupted" after backgrounding/locking — the old ==="suspended" check
    // skipped it, leaving audio permanently silent after pause/resume.
    init(){ if (!this.ctx){ try{ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } if(this.ctx&&this.ctx.state!=="running"){ try{ this.ctx.resume(); }catch(e){} } },
    tone(f, dur=.08, type="square", vol=.12, slide=0){
      if (!this.on || !this.ctx) return;
      const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30,f+slide), t+dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t+dur);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t+dur+.02);
    },
    noise(dur=.25, vol=.25, lp=900){
      if (!this.on || !this.ctx) return;
      const t = this.ctx.currentTime, n = Math.floor(this.ctx.sampleRate*dur);
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i=0;i<n;i++) d[i] = (Math.random()*2-1)*(1-i/n);
      const s = this.ctx.createBufferSource(); s.buffer = buf;
      const f = this.ctx.createBiquadFilter(); f.type="lowpass"; f.frequency.value=lp;
      const g = this.ctx.createGain(); g.gain.value = vol;
      s.connect(f).connect(g).connect(this.ctx.destination); s.start(t);
    },
    move(){ this.tone(420,.04,"square",.06); },
    rotate(){ this.tone(560,.06,"triangle",.1,140); },
    lock(){ this.tone(170,.07,"square",.12,-60); },
    hold(){ this.tone(700,.07,"sine",.1,-200); },
    drop(n=0){ const f = 240 - Math.min(120, n*6); this.tone(f,.1+Math.min(.06,n*.004),"sawtooth",.1+Math.min(.05,n*.003),-160); this.noise(.08+Math.min(.08,n*.004),.1,2000); },
    smash(n){
      this.noise(.3+.08*n,.3,700);
      this.tone(300,.18,"sawtooth",.14,-220);
      setTimeout(()=>this.tone(150,.2,"square",.12,-100),60);
      if (n>=4){ [880,1100,1320,1760].forEach((f,i)=>setTimeout(()=>this.tone(f,.12,"triangle",.12),120+i*70)); }
    },
    level(){ [520,660,780,1040].forEach((f,i)=>setTimeout(()=>this.tone(f,.1,"triangle",.12),i*80)); },
    over(){ [400,340,260,180].forEach((f,i)=>setTimeout(()=>this.tone(f,.22,"sawtooth",.12,-40),i*180)); },
  };

  /* ============================================================ MUSIC
     Original pastel chiptune loop, scheduled with WebAudio lookahead.
     Notes are semitones relative to C5; null = rest. 8 bars of 8ths.   */
  /* Music — "Friend Loop": a mellow 1-bit loop in A minor (i–VI–III–VII:
     Am, F, C, G), 16th-note square arpeggios through a lowpass, a sparse
     pentatonic lead, triangle bass, soft kick + hat. 64 steps (4 bars).
     Tempo rises gently with level. Original composition. */
  const Music = {
    on:true, playing:false, timer:null, nextT:0, step:0, gain:null, lp:null,
    // chord tones (semitones from A3) per bar
    chords:[[0,3,7],[-4,0,3],[3,7,10],[-2,2,5]],
    // arp shape over 16 sixteenths: index into [root, 3rd, 5th, octave-root]
    arp:[0,1,2,3, 2,1,0,1, 2,3,2,1, 0,2,1,3],
    // lead: A-minor pentatonic, semitones from A4; null = rest
    lead:[
      12,null,null,null, 10,null,7,null,   null,null,null,null, 5,null,null,null,
       7,null,null,null, 5,null,3,null,    null,null,null,null, 0,null,null,null,
       3,null,null,null, 7,null,10,null,   12,null,null,null, 10,null,null,null,
       7,null,null,null, 5,null,null,null,  2,null,null,null, null,null,null,null,
    ],
    f(n, base){ return base*Math.pow(2, n/12); },
    note(freq, t, dur, type, vol, dest){
      const c = Sfx.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t+.008);
      g.gain.setTargetAtTime(0, t+dur*.55, .05);
      o.connect(g).connect(dest || this.gain); o.start(t); o.stop(t+dur+.2);
    },
    kick(t){
      const c = Sfx.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t+.12);
      g.gain.setValueAtTime(.16, t); g.gain.exponentialRampToValueAtTime(.001, t+.16);
      o.connect(g).connect(this.gain); o.start(t); o.stop(t+.2);
    },
    hat(t, vol){
      const c = Sfx.ctx, n = Math.floor(c.sampleRate*.02);
      const buf = c.createBuffer(1,n,c.sampleRate), d = buf.getChannelData(0);
      for (let i=0;i<n;i++) d[i] = (Math.random()*2-1)*(1-i/n);
      const s = c.createBufferSource(); s.buffer = buf;
      const f = c.createBiquadFilter(); f.type="highpass"; f.frequency.value=7000;
      const g = c.createGain(); g.gain.value=vol;
      s.connect(f).connect(g).connect(this.gain); s.start(t);
    },
    stepDur(){ return 60/(92 + Math.min(28,(G.level-1)*3))/4; }, // 16ths
    schedule(){
      if (!this.playing || !Sfx.ctx) return;
      const c = Sfx.ctx;
      if (this.nextT < c.currentTime) this.nextT = c.currentTime + .06;
      while (this.nextT < c.currentTime + .3){
        const i = this.step % 64, sd = this.stepDur(), bar = (i/16)|0, k = i%16;
        const ch = this.chords[bar];
        const tones = [ch[0], ch[1], ch[2], ch[0]+12];
        this.note(this.f(tones[this.arp[k]], 220), this.nextT, sd*1.4, "square", .028, this.lp);
        const L = this.lead[i];
        if (L !== null && L !== undefined) this.note(this.f(L, 440), this.nextT, sd*5, "triangle", .07);
        if (k === 0 || k === 8) this.note(this.f(ch[0], 55), this.nextT, sd*7, "triangle", .13);
        if (k === 0 || k === 10) this.kick(this.nextT);
        if (k % 4 === 2) this.hat(this.nextT, k === 14 ? .035 : .02);
        this.nextT += sd; this.step++;
      }
    },
    start(){
      Sfx.init();
      if (!Sfx.ctx || this.playing || !this.on || !Sfx.on) return;
      if (!this.gain){
        this.gain = Sfx.ctx.createGain(); this.gain.gain.value = .5; this.gain.connect(Sfx.ctx.destination);
        this.lp = Sfx.ctx.createBiquadFilter(); this.lp.type = "lowpass"; this.lp.frequency.value = 1400; this.lp.Q.value = .7;
        this.lp.connect(this.gain);
      }
      this.playing = true; this.step = 0;
      this.nextT = Sfx.ctx.currentTime + .08;
      this.timer = setInterval(()=>this.schedule(), 80);
    },
    stop(){ this.playing = false; if (this.timer){ clearInterval(this.timer); this.timer = null; } },
  };

  /* ============================================================ GAME */
  const G = {
    grid:null, inst:null, nextId:1,
    seed:0, bag:[], queue:[], hold:null, holdUsed:false,
    cur:null, ghostY:0,
    score:0, lines:0, level:1, combo:-1, b2b:false, best:0, smashArmed:false,
    state:"menu",          // menu | play | clearing | bonus | paused | over
    dropAcc:0, lockT:-1, lockResets:0, lastT:0,
    clearing:null,         // {rows:[], t}
    particles:[], shake:0,
    // guts meter (deterministic: cleared lines) + active bonus animation
    meterLines:0, bonusIdx:0, bonusAnim:null,
    // slosh is VISUAL ONLY (gyro/ambient); never touches scoring or replay
    slosh:{ angle:0, vel:0, tilt:0 },
  };
  const CLEAR_MS = 540;
  const LOCK_DELAY = 500, MAX_RESETS = 15;

  let bag = null;          // SevenBag instance (seeded per game)

  /* ---- run recorder (anti-cheat): captures the input log + per-lock outcomes
     so the server can re-score (and, in Phase 3, replay) the run. Inert unless a
     server-sanctioned run is active; gameplay is unaffected either way. ---- */
  let activeRun = null;    // { seed, runId, runToken } from window.__DOOPIE_RUN
  let puUses = {};         // cumulative power-up uses this run (use-time settlement)
  let slowUntil = 0;       // slow_fall: gravity eased until this timestamp
  let previewN = 3;        // next_peek: how many NEXT pieces to show
  let bombArmed = false;   // bomb: detonate a 3×3 blast on the next lock
  const recorder = {
    active:false, t0:0, log:[], locks:[], soft:0, hard:0,
    begin(active){ this.active=active; this.t0=performance.now(); this.log=[]; this.locks=[]; this.soft=0; this.hard=0; },
    ev(a, extra){ if(!this.active) return; this.log.push(Object.assign({t:Math.round(performance.now()-this.t0), a}, extra||{})); },
  };

  function emptyGrid(){ return Array.from({length:TOTAL},()=>Array(COLS).fill(null)); }

  function nextType(){ while (G.queue.length<5){ G.queue.push(bag.next()); } return G.queue.shift(); }

  function collides(t, r, px, py){
    for (const [fx,fy] of STATES[t][r].cells){
      const x = px+fx, y = py+fy;
      if (x<0||x>=COLS||y>=TOTAL) return true;
      if (y>=0 && G.grid[y][x]) return true;
    }
    return false;
  }

  function spawn(type){
    const t = type || nextType();
    const p = {t, r:0, x: t==="O" ? 4 : 3, y: 0};
    if (collides(p.t,p.r,p.x,p.y)){ p.y--; if (collides(p.t,p.r,p.x,p.y)) return gameOver(); }
    G.cur = p; G.holdUsed = type ? G.holdUsed : false;
    G.smashArmed = false; // a fresh piece has not been smashed (see hardDrop)
    G.dropAcc = 0; G.lockT = -1; G.lockResets = 0;
    updGhost(); drawSide();
  }

  function updGhost(){
    const p = G.cur; if (!p) return;
    let y = p.y;
    while (!collides(p.t,p.r,p.x,y+1)) y++;
    G.ghostY = y;
  }

  function tryMove(dx,dy){
    const p = G.cur; if (!p || G.state!=="play") return false;
    if (collides(p.t,p.r,p.x+dx,p.y+dy)) return false;
    p.x += dx; p.y += dy;
    if (dx){ Sfx.move(); recorder.ev("m", {dx, x:p.x}); }
    onShift(); updGhost();
    return true;
  }

  function tryRotate(dir){
    const p = G.cur; if (!p || G.state!=="play" || p.t==="O") return false;
    const nr = (p.r+dir+4)%4;
    const table = p.t==="I" ? KICKS_I : KICKS_JLSTZ;
    for (const [kx,ky] of table[p.r+">"+nr]){
      if (!collides(p.t,nr,p.x+kx,p.y-ky)){
        p.r = nr; p.x += kx; p.y -= ky;
        Sfx.rotate(); recorder.ev("rot", {dir, r:p.r, x:p.x, y:p.y}); onShift(); updGhost();
        return true;
      }
    }
    return false;
  }

  function onShift(){ // lock-delay reset on successful move/rotate while grounded
    const p = G.cur;
    if (G.lockT>=0 && G.lockResets<MAX_RESETS){ G.lockT = 0; G.lockResets++; }
    if (!collides(p.t,p.r,p.x,p.y+1) && G.lockT>=0 && G.lockResets>=MAX_RESETS){} // cap reached: timer keeps running
    if (collides(p.t,p.r,p.x,p.y+1)===false) G.lockT = -1; // airborne again
  }

  function softDrop(){ if (tryMove(0,1)){ G.score += softDropPoints(1); recorder.soft++; updHud(); return true; } return false; }

  function hardDrop(){
    const p = G.cur; if (!p || G.state!=="play") return;
    let n = 0;
    while (!collides(p.t,p.r,p.x,p.y+1)){ p.y++; n++; }
    G.score += hardDropPoints(n);
    G.smashArmed = true; // the lock this commits is a SMASH clear (scoring v2+)
    recorder.hard += n; recorder.ev("hd", {cells:n, x:p.x, r:p.r});
    updHud(); // reflect hard-drop points immediately (HUD otherwise lagged until a clear)
    Sfx.drop(n); G.shake = Math.min(16, 3 + n*.7); haptic(Math.min(60, 12 + n*2)); // heavier impact for committed drops
    lockPiece();
  }

  /* ---- power-ups (all REPLAY-SAFE: no effect on score / piece sequence /
     which placements are legal). Activations are recorded in the input log;
     the server consumes inventory and the replay ignores them for scoring. ---- */
  function usePowerup(key){
    if (G.state!=="play") return false;
    // No server run = nothing can settle the spend server-side, so the
    // "refund on refresh" bug would be unavoidable. Unranked games can't
    // spend (the tray hides itself for them — see __DS.ranked).
    if (!activeRun) return false;
    if (key==="bomb" && bombArmed) return false;   // already armed; don't waste
    if (key==="reroll" && !G.cur) return false;
    if (["slow_fall","next_peek","clean_slate","bomb","reroll"].indexOf(key)<0) return false;
    recorder.ev("powerup", {key}); // record before applying so the log order matches replay
    // Settle the spend NOW (idempotent, cumulative-count): a reload or killed
    // tab can no longer refund it. Finish/abandon reconcile the remainder.
    puUses[key] = (puUses[key]||0) + 1;
    if (window.__DOOPIE_RUN && typeof window.__DOOPIE_RUN.consume === "function"){
      try{ window.__DOOPIE_RUN.consume({ runId:activeRun.runId, runToken:activeRun.runToken, key, n:puUses[key] }); }catch(e){}
    }
    switch(key){
      case "slow_fall": slowUntil = performance.now() + 15000; break;
      case "next_peek": previewN = 5; drawSide(); break;
      case "clean_slate": Gore.reset(); break;
      case "bomb": bombArmed = true; break;
      case "reroll": spawn(); break; // new current from the bag (advances the sequence)
    }
    return true;
  }

  function holdPiece(){
    if (G.state!=="play" || G.holdUsed || !G.cur) return;
    Sfx.hold(); recorder.ev("hold", {});
    const cu = G.cur.t;
    const sw = G.hold;
    G.hold = cu; G.holdUsed = true;
    spawn(sw || undefined);
    G.holdUsed = true;
    drawSide();
  }

  function lockPiece(){
    // Whatever happens below, the NEXT piece starts un-smashed. finishClear()
    // reads G.smashArmed for this lock before spawn() runs.
    const p = G.cur;
    const st = STATES[p.t][p.r];
    const id = G.nextId++;
    G.inst[id] = {t:p.t, r:p.r, v:"clean"};
    let top = TOTAL;
    for (const [fx,fy] of st.cells){
      const x = p.x+fx, y = p.y+fy;
      if (y<0){ return gameOver(); }
      G.grid[y][x] = {id, rsx: fx-st.bx, rsy: fy-st.by};
      top = Math.min(top,y);
    }
    G.cur = null;
    if (top < HIDDEN) return gameOver();
    Sfx.lock();
    // bomb power-up: detonate a 3×3 blast around the placement BEFORE the row
    // scan (shared geometry with the server replay).
    if (bombArmed){
      for (const [bx,by] of bombBlast(p.t, p.r, p.x, p.y)){ if (G.grid[by] && G.grid[by][bx]) G.grid[by][bx] = null; }
      bombArmed = false;
      Sfx.smash(2); G.shake = Math.max(G.shake, 10); haptic([0,30,20,50]);
      Gore.add([Math.max(HIDDEN, Math.min(TOTAL-1, p.y+1))]); goreBoom([p.y+1]);
    }
    const rows = [];
    for (let y=0;y<TOTAL;y++) if (G.grid[y].every(c=>c)) rows.push(y);
    // record this lock's outcome for server scoring (0 = no clear)
    recorder.locks.push(rows.length);
    recorder.ev("lock", {pt:p.t, r:p.r, x:p.x, y:p.y, cleared:rows.length});
    if (rows.length){
      // wound every Doopie touching the smashed rows: show bloody art
      const hurt = new Set();
      for (const y of rows) for (const c of G.grid[y]) hurt.add(c.id);
      for (const i of hurt) G.inst[i].v = "blood";
      Gore.add(rows);
      goreBoom(rows);
      // SMASH celebration fires WITH the blood, not after it (playtest: it
      // used to land in finishClear, ~0.5s late — after the gore had already
      // washed over the moment). G.smashArmed is this lock's flag; scoring
      // stays in finishClear where it always was.
      if (G.smashArmed && scoringV() >= 2){
        smashFX.push({ y: rows.reduce((a,b)=>a+b,0)/rows.length, t0: performance.now() });
      }
      G.clearing = {rows, t:0};
      G.state = "clearing";
      G.shake = 9 + rows.length*3;
      Sfx.smash(rows.length);
      haptic(rows.length===4 ? [80, 40, 120] : [50 + rows.length*20]); // beefy clear thump
    } else {
      G.combo = -1;
      spawn();
    }
  }

  function finishClear(){
    const {rows} = G.clearing;
    // splatter particles along cleared rows
    for (const y of rows) for (let x=0;x<COLS;x++) spawnSplat(x,y);
    // remove rows, collapse
    const keep = [];
    for (let y=0;y<TOTAL;y++) if (!rows.includes(y)) keep.push(G.grid[y]);
    while (keep.length<TOTAL) keep.unshift(Array(COLS).fill(null));
    G.grid = keep;
    // scoring (canonical rules in lib/scoring — the server re-scores with these)
    const n = rows.length;
    const res = scoreClear(n, {level:G.level, b2b:G.b2b, combo:G.combo});
    G.score += res.points; G.b2b = res.b2b; G.combo = res.combo;
    G.lines += n;
    const nl = levelForLines(G.lines);
    if (nl>G.level){ G.level = nl; Sfx.level(); haptic([0,25,50,25]); popup("LEVEL "+nl+"!", 22, "#d8ccff"); }
    // SMASH bonus (scoring v2+): committed with a hard drop. The server
    // re-derives this from the input log's "hd" events — this is presentation
    // + a live HUD number, never the authority.
    const smashed = G.smashArmed;
    if (smashed && scoringV() >= 2){
      const sb = smashClearPoints(G.level);
      G.score += sb;
      setTimeout(()=>popup("SMASH BONUS +"+sb, 18, "#ffd34d"), 420);
    }
    popup(["","SMASH!","DOUBLE SMASH!","TRIPLE SMASH!","FRIEND SMASH!!"][n], n===4?30:24, n===4?"#ffd34d":"#fff", rows[0]);
    if (G.combo>0) setTimeout(()=>popup("COMBO ×"+(G.combo+1), 16, "#ffc9e2"), 220);
    updHud();
    G.clearing = null;

    // ---- guts meter: multi-line clears fill FASTER (single=2 double=5
    // triple=9 tetris=14 guts; legacy snapshots count plain lines). 100%
    // triggers the bonus. DETERMINISTIC — the server replay recomputes this.
    if (tuning.bonus.enabled){
      const mc = meterTarget(tuning.bonus);
      G.meterLines += (mc.mode === "guts") ? gutsForClear(n) : n;
      if (G.meterLines >= Math.floor(mc.target*.5)) ensureBonusPreload();
      if (G.meterLines >= mc.target){
        startBonus();
        return; // spawn() resumes after the bonus completes
      }
    }
    // (the SMASH burst fires at clearing START, with the gore — see lockPiece)
    G.state = "play";
    spawn();
  }

  const OVER_QUIPS = [
    "Pour one out for the pixels.",
    "They smashed valiantly.",
    "That's… a lot of shards.",
    "Your Friend regrets nothing.",
    "Smashing work. Literally.",
    "Gone, but not forgotten.",
  ];
  const NEW_BEST_QUIP = "NEW BEST! Your Friend is so proud.";
  function gameOver(){
    // VERSUS: topping out ends MY round early (score stands, no game-over
    // card, no solo submit) — the match flow owns everything from here.
    if (G.vs) return vsToppedOut();
    G.state = "over"; G.cur = null;
    Music.stop(); Sfx.over(); haptic([0,80,50,160]);
    const isBest = G.score>G.best;
    if (isBest){ G.best = G.score; try{ localStorage.setItem("doopieBest", String(G.best)); }catch(e){} }
    document.getElementById("overScore").textContent = G.score.toLocaleString();
    document.getElementById("overBest").textContent = "Best: " + G.best.toLocaleString();
    const quip = document.getElementById("overQuip");
    if (quip) quip.textContent = (isBest && G.score>0) ? NEW_BEST_QUIP : OVER_QUIPS[(Math.random()*OVER_QUIPS.length)|0];
    show("overOv");
    // Submit a server-sanctioned run for authoritative scoring (if one is active).
    if (recorder.active && activeRun && window.__DOOPIE_RUN && typeof window.__DOOPIE_RUN.finish==="function"){
      const summary = {
        locks: recorder.locks.slice(),
        softDropCells: recorder.soft,
        hardDropCells: recorder.hard,
        durationMs: Math.round(performance.now()-recorder.t0),
      };
      try{ window.__DOOPIE_RUN.finish({ runId:activeRun.runId, runToken:activeRun.runToken, seed:activeRun.seed, summary, log:recorder.log.slice(), clientScore:G.score }); }catch(e){}
    }
    recorder.active = false; activeRun = null;
  }

  function reset(seed){
    G.grid = emptyGrid(); G.inst = {}; G.nextId = 1;
    G.seed = (seed!=null) ? (seed>>>0) : randomSeed(); bag = new SevenBag(G.seed);
    G.bag = []; G.queue = []; G.hold = null; G.holdUsed = false;
    G.score = 0; G.lines = 0; G.level = 1; G.combo = -1; G.b2b = false;
    G.particles = []; G.shake = 0; G.clearing = null;
    smashFX.length = 0; // no stale celebration bursts on a fresh board
    slowUntil = 0; previewN = 3; bombArmed = false; puUses = {};
    G.meterLines = 0; G.bonusIdx = 0; G.bonusAnim = null;
    G.slosh.angle = 0; G.slosh.vel = 0;
    killBonusOverlay();
    Gore.reset();
    G.state = "play"; G.lastT = performance.now();
    updHud(); spawn();
  }

  /* ============================================================ GORE
     Persistent splatter: stains the board floor, the side walls,
     and the backdrop behind the game. Cleans up on restart.        */
  function mulberry(seed){
    return function(){ seed|=0; seed = seed+0x6D2B79F5|0;
      let t = Math.imul(seed^seed>>>15, 1|seed);
      t = t+Math.imul(t^t>>>7, 61|t)^t;
      return ((t^t>>>14)>>>0)/4294967296; };
  }
  // Artist pieces mixed into the screen-level gore (flung with the boom,
  // stuck in wall splats) — showcase art, chosen at random per splat.
  const GORE_SPLAT_SPRITES = ["skull","guts-pile","guts-braid","guts-coil","stomach","heart","bone-pile","bones-crossed"];
  const GORE_SVGS = [
    `<svg width="110" height="110" viewBox="0 0 110 110"><g fill="${BLOOD}"><circle cx="55" cy="52" r="24"/><circle cx="26" cy="40" r="9"/><circle cx="84" cy="36" r="7"/><circle cx="82" cy="76" r="10"/><circle cx="32" cy="80" r="6"/><path d="M52 74 q5 22 -2 30 q-9 3 -9 -8 q0 -12 5 -22 z"/></g><circle cx="70" cy="22" r="5" fill="${BLOOD_D}"/></svg>`,
    `<svg width="120" height="100" viewBox="0 0 120 100"><g fill="${BLOOD_D}"><ellipse cx="60" cy="46" rx="30" ry="20" transform="rotate(-12 60 46)"/><circle cx="22" cy="60" r="8"/><circle cx="98" cy="34" r="7"/><circle cx="92" cy="68" r="5"/><path d="M44 62 q2 24 -6 30 q-8 2 -7 -9 q1 -12 7 -21 z"/></g><circle cx="34" cy="24" r="6" fill="${BLOOD}"/></svg>`,
    `<svg width="90" height="120" viewBox="0 0 90 120"><g fill="${BLOOD}"><circle cx="44" cy="40" r="20"/><circle cx="70" cy="58" r="9"/><circle cx="18" cy="52" r="7"/><path d="M40 56 q6 30 -2 44 q-10 6 -11 -8 q-1 -18 5 -36 z"/><path d="M58 60 q8 20 4 32 q-8 6 -10 -6 q-2 -12 0 -26 z"/></g></svg>`,
  ];
  // SMASH-clear celebration bursts (artist smash-big/smash-small): pushed by
  // lockPiece at clearing START (with the gore — playtest: firing from
  // finishClear landed after the blood), drawn in drawBoard, self-expiring.
  // Pure presentation — replay/scoring untouched.
  const smashFX = [];
  // Pixel "SMASH!" burst (replaces the artist sprite).
  const smashWord = new Image();
  try{ smashWord.src = wordmarkDataUrl(["SMASH!"], 8); }catch(_){ }

  const Gore = {
    globs: [],    // canvas-space LIQUID goo: viscous droplets that drizzle off the board
    bones: [],    // canvas-space doodle bones tumbling down with the goo
    chunks: [],   // canvas-space artist GUTS pieces tumbling with the bones
    drips: [],    // canvas-space blood that RUNS DOWN the board, then settles
    dripT: 0,     // last update timestamp (for frame-independent motion)
    walls: [],    // DOM splats on the frame + backdrop (now transient — they fade)
    add(rows){
      // PIXEL SHATTER (Rare Friends): each cleared cell bursts into square
      // shards in its piece's palette color (+ ink), which arc up and rain
      // off the bottom of the board. No stains, no blood. Cosmetic only.
      const I = tuning.gore.intensity;
      for (const y of rows){
        const row = (G.grid && G.grid[y]) || [];
        for (let x=0;x<COLS;x++){
          const cell = row[x];
          const ins = cell && G.inst ? G.inst[cell.id] : null;
          const col = ins && PIECE_STYLE[ins.t] ? PIECE_STYLE[ins.t].color : BLOOD;
          const n = Math.max(1, Math.round((reduceMotion ? 1 : 3) * I));
          for (let i=0;i<n;i++){
            this.globs.push({
              x: (x + .2 + Math.random()*.6)*CELL,
              y: (y + .2 + Math.random()*.6)*CELL,
              vx: (Math.random()-.5)*CELL*3,
              vy: -CELL*(1 + Math.random()*2.6),
              r: CELL*(Math.random()<.5 ? .16 : .26),       // two chunky pixel sizes
              rot: 0, vr: (Math.random()-.5)*6,
              col: Math.random()<.45 ? INK : col,
            });
          }
        }
      }
      if (this.globs.length>220) this.globs.splice(0, this.globs.length-220);
    },
    addDrips(){ /* no blood in Rare Friends */ },
    dom(){ /* no wall splats in Rare Friends */ },
    reset(){
      this.globs = []; this.bones = []; this.chunks = []; this.drips = []; this.dripT = 0;
      for (const e of this.walls) if (e.remove) e.remove();
      this.walls = [];
    },
  };

  /* full-screen gore explosion that bursts from the smashed rows,
     hangs for a beat, then slides off the play area like wet goo  */
  /* Clear "impact": a one-frame-ish 1-bit flash over the screen with a
     checker dither in signal green. Skipped under reduced motion. */
  function goreBoom(rows){
    if (reduceMotion) return;
    const root = document.body;
    if (!root || typeof root.appendChild!=="function") return;
    const n = rows.length;
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;inset:0;z-index:25;pointer-events:none;"
      + "background-image:conic-gradient(#111 25%,transparent 0 50%,#111 0 75%,transparent 0);"
      + "background-size:8px 8px;image-rendering:pixelated;opacity:"+(0.08+n*0.04).toFixed(2)+";"
      + "transition:opacity .28s steps(4)";
    root.appendChild(el);
    requestAnimationFrame(()=>{ el.style.opacity = "0"; });
    setTimeout(()=>{ if (el.remove) el.remove(); }, 400);
  }

  /* ============================================================ BONUS ROUNDS
     Guts meter full → slot-machine moment: a short video kicks it off, then
     ~10s of spectacle. ALL board deletions + points come from lib/bonus
     (deterministic, seeded per bonus index) — the server replay reproduces
     them exactly. Everything else here is presentation. */
  let preVideo = null, preVideoKind = null;
  const BONUS_TAGS = { arrows: "ARROW STORM!", swords: "SWORD SLASH!", rats: "RAT ATTACK!", banana: "BANANA BANGER!" };
  function bonusVideoSrc(kind){ return "/bonus/" + kind + ".mp4"; }
  function ensureBonusPreload(){
    try{
      // versioned pick: must match resolveBonus exactly or we warm the wrong video
      const kind = pickBonusKind(bonusRng(G.seed, G.bonusIdx), tuning.bonus.v || 2);
      if (preVideoKind === kind && preVideo) return;
      preVideo = document.createElement("video");
      preVideo.preload = "auto"; preVideo.muted = true; preVideo.src = bonusVideoSrc(kind);
      preVideoKind = kind;
    }catch(_){ preVideo = null; preVideoKind = null; }
  }

  // Slot-machine pacing: slow enough to build tension — the tally ticks up
  // with every hit and the total only lands at the reveal. Presentation only.
  const PACE = {
    arrowStagger: .22,  // s between arrow launches
    arrowFlight:  .5,   // s per arrow flight
    slashEvery:   .9,   // s between sword slashes
    slashSweep:   .45,  // s per blade sweep
    ratStagger:   .45,  // s between rat releases
    ratCross:     1.4,  // s for a rat to scurry the full board width
    shotEvery:    .42,  // s between banana shots
    shotFlight:   .22,  // s from a shot firing to its hole landing
    popSpan:      1.1,  // s for the full destruction wave
    revealMs:     1700, // ms the reveal holds before play resumes
  };

  function startBonus(){
    const res = resolveBonus(G.grid, G.seed, G.bonusIdx, G.level, tuning.bonus, COLS, TOTAL);
    recorder.ev("bonus", { kind: res.kind, i: G.bonusIdx });
    G.bonusIdx++;
    G.state = "bonus";
    Music.stop();
    G.bonusAnim = { phase: "video", res, t: 0, arrows: null, slashT: 0, stuck: 0, hitSet: new Set(), revealT: 0, tallyPop: 0 };
    showBonusVideo(res.kind);
  }

  let bonusOv = null, bonusVideoTimer = 0;
  function showBonusVideo(kind){
    killBonusOverlay();
    const ov = document.createElement("div");
    ov.id = "bonusOv";
    const v = (preVideoKind === kind && preVideo) ? preVideo : document.createElement("video");
    v.src = bonusVideoSrc(kind);
    // Play WITH audio when the game isn't muted (the session has had plenty of
    // user gestures, so unmuted play() is usually allowed). If the browser
    // still blocks it, fall back to muted so the bonus never stalls.
    v.muted = !Sfx.on; v.volume = 1;
    v.playsInline = true; v.autoplay = true;
    v.setAttribute("playsinline", "");
    ov.appendChild(v);
    const tag = document.createElement("div");
    tag.className = "bonus-tag";
    tag.textContent = BONUS_TAGS[kind] || "BONUS!";
    ov.appendChild(tag);
    document.body.appendChild(ov);
    bonusOv = ov;
    Sfx.level(); haptic([0,30,40,30,40,60]);
    const done = ()=>{ if (G.bonusAnim && G.bonusAnim.phase === "video") beginBonusAction(); };
    v.addEventListener("ended", done);
    v.addEventListener("error", done);
    try{
      const p = v.play();
      if (p && p.catch) p.catch(()=>{
        // autoplay-with-sound blocked → retry muted; only skip if THAT fails too
        try{ v.muted = true; const p2 = v.play(); if (p2 && p2.catch) p2.catch(done); }catch(_){ done(); }
      });
    }catch(_){ done(); }
    bonusVideoTimer = setTimeout(done, 9000); // hard cap — never stuck on a video
  }
  function killBonusOverlay(){
    if (bonusVideoTimer){ clearTimeout(bonusVideoTimer); bonusVideoTimer = 0; }
    if (bonusOv){ try{ bonusOv.remove(); }catch(_){ } bonusOv = null; }
  }

  function beginBonusAction(){
    killBonusOverlay();
    const A = G.bonusAnim; if (!A) return;
    A.phase = "action"; A.t = 0; A.flash = 0;
    if (A.res.kind === "arrows"){
      // one arrow object per strike, staggered. Playtest rework: darts fly
      // from the PLAYER's point of view — they launch from below the board
      // (the screen edge nearest the thumb), start big like they just left
      // your hand, and shrink to board scale as they close on the target.
      // Alternating sides keeps both artist darts on show.
      A.arrows = A.res.hits.map(([tx,ty],i)=>({
        tx, ty, delay: i*PACE.arrowStagger, prog: 0,
        // Launch tip JUST INSIDE the canvas bottom edge — the board canvas
        // clips at its own bounds, so anything below it simply never renders
        // (gate review: the previous 1.5-3.5-cells-below start meant the big
        // "hand-launch" frames were 100% invisible).
        // X clamped to [-0.4, COLS+0.4] cells: a wider spawn range clipped
        // the 1-2 biggest frames on far-corner launches (gate verifier's
        // model: this exact clamp = 100% of >=3x frames on-canvas).
        fromX: (i%2 ? -.4 + Math.random()*.8 : COLS - .4 + Math.random()*.8)*CELL,
        fromY: (ROWS + HIDDEN - .35 - Math.random()*.4)*CELL,
        arc: (.6 + Math.random()*1.2) * (Math.random()<.5?-1:1), // curve of the flight
        landed: false, ring: 0,
      }));
    } else if (A.res.kind === "rats"){
      // one scurrier per rat run — staggered, each crossing the full board
      // width along its row; cells get "gnawed" as the rat passes them
      A.rats = (A.res.ratRuns || []).map((r,i)=>({
        y: r.y, dir: r.dir, cells: r.cells, delay: i*PACE.ratStagger,
        prog: 0, eaten: 0, wig: Math.random()*7, done: false,
        vi: i, // stable artist-variant identity (presentation only)
      }));
    } else if (A.res.kind === "banana"){
      // banana: holes appear on the targeted blocks, one per beat (no gun,
      // no bullets — playtest round 2)
      A.shots = A.res.hits.map(([tx,ty],i)=>({
        tx, ty, delay: i*PACE.shotEvery, fired: false, prog: 0, ring: 0, landed: false,
      }));
    }
    Sfx.smash(1);
  }

  function advanceBonus(dtMs){
    const A = G.bonusAnim; if (!A) return;
    const dt = dtMs/1000;
    if (A.flash > 0) A.flash = Math.max(0, A.flash - dt*3.2);
    if (A.tallyPop > 0) A.tallyPop = Math.max(0, A.tallyPop - dt*3.4); // punch decay

    // final reveal: the total counts up on the canvas, then endBonus resumes
    if (A.phase === "reveal"){ A.revealT += dt; return; }

    // staged destruction: cells pop in a wave AFTER the volley/slashes finish
    if (A.phase === "pop"){
      A.popT += dt;
      const interval = Math.max(.03, PACE.popSpan/Math.max(1, A.popQueue.length));
      while (A.popIdx < A.popQueue.length && A.popT >= interval){
        A.popT -= interval;
        const [bx,by] = A.popQueue[A.popIdx++];
        if (G.grid[by] && G.grid[by][bx]){
          G.grid[by][bx] = null;
          spawnSplat(bx, by);
        }
        A.tallyPop = Math.max(A.tallyPop, .6); // keep the counter jittering
        Sfx.move(); G.shake = Math.max(G.shake, 4); haptic(6);
      }
      if (A.popIdx >= A.popQueue.length && !A.finished){
        A.finished = true;
        finishBonusPop();
      }
      return;
    }

    if (A.phase !== "action") return;
    A.t += dt;
    const res = A.res;
    if (res.kind === "arrows"){
      let allLanded = true;
      for (const ar of A.arrows){
        if (A.t < ar.delay){ allLanded = false; continue; }
        if (!ar.landed){
          ar.prog = Math.min(1, ar.prog + dt/PACE.arrowFlight);
          if (ar.prog >= 1){
            ar.landed = true; ar.ring = 1; A.stuck++;
            A.hitSet.add(ar.tx+","+ar.ty); // live tally: unique blocks skewered
            A.tallyPop = 1; // punch the counter
            Sfx.move(); G.shake = Math.max(G.shake, 3); haptic(8);
          }
          else allLanded = false;
        } else if (ar.ring > 0) ar.ring = Math.max(0, ar.ring - dt*3);
      }
      if (allLanded && !A.done){ A.done = true; A.doneAt = A.t; }
      if (A.done && A.t > A.doneAt + .5) startBonusPop();
    } else if (res.kind === "rats" && A.rats){
      // rats: each scurries its row; a cell is "gnawed" (tally + squeak) the
      // moment the rat's nose passes it
      let allDone = true;
      for (const rat of A.rats){
        if (A.t < rat.delay){ allDone = false; continue; }
        if (!rat.done){
          rat.prog = Math.min(1, rat.prog + dt/PACE.ratCross);
          // nose position in cell units (runs offscreen edge → offscreen edge)
          const span = COLS + 4;
          const nose = rat.dir === 1 ? rat.prog*span - 2 : COLS + 2 - rat.prog*span;
          while (rat.eaten < rat.cells.length){
            const [cx2, cy2] = rat.cells[rat.eaten];
            const passed = rat.dir === 1 ? nose >= cx2 + .5 : nose <= cx2 + .5;
            if (!passed) break;
            rat.eaten++;
            A.hitSet.add(cx2+","+cy2);
            A.tallyPop = 1;
            Sfx.tone(1100 + Math.random()*500, .05, "square", .07, 400); // squeak
            G.shake = Math.max(G.shake, 3); haptic(7);
          }
          if (rat.prog >= 1){ rat.done = true; } else allDone = false;
        }
      }
      if (allDone && !A.done){ A.done = true; A.doneAt = A.t; }
      if (A.done && A.t > A.doneAt + .4) startBonusPop();
    } else if (res.kind === "banana" && A.shots){
      // banana: each shot's hole lands sh.delay + shotFlight after the round
      // starts — sh.delay/sh.prog are the ONLY pacing (the old gun-glide
      // state was pure decoration and is gone with the gun)
      let allLanded = true;
      for (const sh of A.shots){
        if (A.t < sh.delay){ allLanded = false; continue; }
        if (!sh.fired){
          sh.fired = true;
          Sfx.tone(330, .09, "square", .12, -180); Sfx.noise(.06, .08, 2500); // pew
        }
        if (!sh.landed){
          sh.prog = Math.min(1, sh.prog + dt/PACE.shotFlight);
          if (sh.prog >= 1){
            sh.landed = true; sh.ring = 1;
            A.hitSet.add(sh.tx+","+sh.ty);
            A.tallyPop = 1;
            Sfx.move(); G.shake = Math.max(G.shake, 4); haptic(8);
          } else { allLanded = false; }
        } else if (sh.ring > 0) sh.ring = Math.max(0, sh.ring - dt*3);
      }
      if (allLanded && !A.done){ A.done = true; A.doneAt = A.t; }
      if (A.done && A.t > A.doneAt + .5) startBonusPop();
    } else {
      // swords: one slash impact per beat, each blade sweeps across the band
      const k = (res.slashLines || res.slashGroups || []).length || tuning.bonus.swordSlashes;
      const slashI = Math.min(k-1, Math.floor(A.t/PACE.slashEvery));
      if (slashI !== A.lastSlash){
        A.lastSlash = slashI; A.flash = 1;
        // live tally: this slash's victims join the count on impact
        const grp = (res.slashGroups && res.slashGroups[slashI]) || [];
        for (const [cx2,cy2] of grp) A.hitSet.add(cx2+","+cy2);
        A.tallyPop = 1; // punch the counter
        Sfx.smash(2); G.shake = Math.max(G.shake, 10); haptic([0,25,15,35]);
      }
      if (A.t > k*PACE.slashEvery + .6) startBonusPop();
    }
  }

  /** Freeze the volley, then pop the deleted cells in a left→right wave. The
   *  final deletion SET is exactly resolution.deleted — presentation only. */
  function startBonusPop(){
    const A = G.bonusAnim; if (!A || A.phase === "pop") return;
    A.phase = "pop";
    A.popQueue = A.res.deleted.slice().sort((a,b)=>(a[0]-b[0]) || (a[1]-b[1]));
    A.popIdx = 0; A.popT = 0; A.finished = false;
  }
  function finishBonusPop(){
    const A = G.bonusAnim; if (!A) return;
    const res = A.res;
    if (res.deleted.length){
      Gore.add([Math.max(HIDDEN, Math.min(TOTAL-1, Math.round(res.deleted.reduce((a,c)=>a+c[1],0)/res.deleted.length)))]);
      Sfx.smash(3); G.shake = 13; haptic([0,40,30,70]);
    }
    // v2: survivors fall (same shared function + flag as the server replay —
    // the boards MUST stay identical or the next lock fails verification).
    if (res.gravity && G.grid){
      applyBonusGravity(G.grid, COLS, TOTAL);
      if (res.deleted.length){ Sfx.drop(6); G.shake = Math.max(G.shake, 8); }
    }
    G.score += res.points;
    updHud();
    // slot-machine reveal: the total counts up on the canvas (see the bonus
    // draw block), then play resumes. setTimeout (not RAF) so a backgrounded
    // tab can never stall the game in the bonus state.
    A.phase = "reveal"; A.revealT = 0;
    clearTimeout(bonusEndTimer);
    bonusEndTimer = setTimeout(endBonus, PACE.revealMs);
  }
  let bonusEndTimer = 0;
  function endBonus(){
    if (disposed || G.state !== "bonus") return;
    G.meterLines = 0;
    G.bonusAnim = null;
    ensureBonusPreload(); // start warming the NEXT bonus's video (kind is known)
    G.state = "play";
    spawn();
    // If the tab went hidden during the reveal, fold into the normal auto-pause
    // instead of blasting music from a background tab.
    if (document.hidden) togglePause(); else Music.start();
  }

  /* ============================================================ FX */
  function spawnSplat(cx,cy){
    for (let i=0;i<3;i++){
      G.particles.push({
        x:(cx+.5)*CELL + (Math.random()-.5)*CELL, y:(cy+.5)*CELL,
        vx:(Math.random()-.5)*.7, vy:-Math.random()*.9-.15,
        r: 8+Math.random()*16, life: 1,
        col: Math.random()<.6 ? INK : "#ffffff",
      });
    }
  }
  function popup(txt, size, color, row){
    if (!txt) return;
    const el = document.createElement("div");
    el.className = "pop"; el.textContent = txt;
    el.style.fontSize = size+"px"; el.style.color = color;
    const wrap = document.getElementById("popups");
    const h = wrap.clientHeight || 400;
    el.style.top = (row!==undefined ? Math.max(40, Math.min(h-80,(row-HIDDEN)/ROWS*h-20)) : h*.35) + "px";
    wrap.appendChild(el);
    setTimeout(()=>el.remove(), 1050);
  }

  /* ---- doodle bone: white capsule + lobed ends, chunky ink outline ---- */
  function drawBone(x, y, len, rot, vi){
    // Sprite replaces the ART only — position, size and spin stay code-driven,
    // and both call sites (guts-surface bobbing, gore-burst tumbling) re-skin
    // together. Precedence: admin override (uniform) > bundled artist variant
    // (stable per-entity vi) > procedural vector. 1.12: the procedural bone's
    // lobes overhang its nominal length by ~12%, so images match the footprint.
    const bimg = (spriteArt.bone && spriteArt.bone.naturalWidth > 0) ? spriteArt.bone : pickSprite("bone", vi || 0);
    if (bimg){
      const img = bimg;
      const iw = len*1.12, ih = iw*(img.naturalHeight/img.naturalWidth);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rot);
      try{ ctx.drawImage(img, -iw/2, -ih/2, iw, ih); }catch(_){ }
      ctx.restore();
      return;
    }
    const r = len*.16, half = len/2 - r*.9;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = "#fff"; ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.5, len*.07);
    ctx.beginPath();
    // shaft
    ctx.moveTo(-half, -r*.55); ctx.lineTo(half, -r*.55);
    // right lobes
    ctx.arc(half, -r*.55-0.0001, r, Math.PI*1.1, Math.PI*0.5, false);
    ctx.arc(half, r*.55, r, Math.PI*1.5, Math.PI*0.9, false);
    ctx.lineTo(-half, r*.55);
    // left lobes
    ctx.arc(-half, r*.55, r, Math.PI*0.1, Math.PI*1.5, false);
    ctx.arc(-half, -r*.55, r, Math.PI*0.5, Math.PI*1.9, false);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /* ---- guts slosh: visual-only spring toward the device tilt ---- */
  function updateSlosh(dt){
    const target = reduceMotion ? 0 : G.slosh.tilt;
    // slower spring + heavier damping = thick, viscous goo (not sloshy water)
    const k = 8, damp = 5.2;
    G.slosh.vel += (target - G.slosh.angle)*k*dt - G.slosh.vel*damp*dt;
    G.slosh.angle += G.slosh.vel*dt;
  }
  const onOrient = (e)=>{
    // gamma = left/right tilt in degrees; clamp to a gentle range.
    // NEGATED: tilting the phone right pools the goo on the RIGHT (the liquid
    // stays level while the container tips) — the original sign was backwards.
    const g = typeof e.gamma === "number" ? e.gamma : 0;
    G.slosh.tilt = -Math.max(-.4, Math.min(.4, (g/90)*.8));
  };
  /* ---------- DOOPIE WORLD: camera backdrop + gyro, one branded opt-in ----
     The "Allow the Doopies into your world?" modal is the ONLY place device
     prompts are triggered for first-timers (a tap = the gesture browsers
     require). Prefs persist: doopieWorld (asked?), doopieCam, doopieGyro.
     IMPORTANT: iOS Safari can re-show the NATIVE camera prompt every
     session (permission does not reliably persist per-site there), so the
     camera is NEVER acquired at boot — a boot-time acquire threw the iOS
     dialog over the intro video. Returning opt-ins reacquire on the SMASH!
     tap (see startGame), holding the game on the menu until the prompt
     settles; iOS motion permission is equally stingy and rides the same
     taps. Everything fails open to the pastel sky. The stream never
     leaves the device. */
  let camStream = null;
  // Set when the first-ever SMASH! tap was intercepted by the world ask —
  // answering (YES or NOT NOW) then starts the game the player asked for.
  // The action the world card intercepted (solo start OR versus queue) —
  // answering YES/NOT NOW runs it. Null = card opened informationally.
  let worldPendingFn = null;
  const pref = (k)=>{ try{ return localStorage.getItem(k); }catch(_){ return null; } };
  const setPref = (k,v)=>{ try{ localStorage.setItem(k,v); }catch(_){ } };
  function camSupported(){ return !!(typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  // Will calling getUserMedia raise a NATIVE permission prompt? "granted" =
  // no (silent), "denied" = it would instantly fail, "prompt" = yes (or we
  // can't tell — Firefox pre-131 throws, and a wedged query races to
  // "prompt" after 1.5s). Callers treat "prompt" as "front it with the
  // branded card"; the query itself never triggers a prompt.
  function queryCamPermission(){
    let q = null;
    try{
      if (navigator.permissions && navigator.permissions.query){
        q = navigator.permissions.query({ name: "camera" }).then((r)=>r.state, ()=>"prompt");
      }
    }catch(_){ }
    if (!q) return Promise.resolve("prompt");
    return Promise.race([q, new Promise((res)=>setTimeout(()=>res("prompt"), 1500))]);
  }
  let camPending = null; // in-flight acquire — overlapping calls share it
  let camLastError = null; // DOMException name from the last failed acquire
  function startCamera(){
    if (camStream) return Promise.resolve(true);
    if (!camSupported()) return Promise.resolve(false);
    if (camPending) return camPending;
    camLastError = null;
    camPending = navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((stream)=>{
        if (disposed){
          // Resolved after engine teardown (nav away mid-prompt): release the
          // tracks NOW — nothing else can, and the camera light would stay on.
          try{ for (const t of stream.getTracks()) t.stop(); }catch(_){ }
          return false;
        }
        camStream = stream;
        const v = document.getElementById("camBg");
        v.srcObject = stream;
        try{ const p = v.play(); if (p && p.catch) p.catch(()=>{}); }catch(_){ }
        v.classList.add("on");
        document.getElementById("bg").classList.add("washed");
        updateWorldUi();
        return true;
      })
      .catch((e)=>{ camLastError = (e && e.name) || "Error"; return false; })
      .then((ok)=>{ camPending = null; return ok; });
    return camPending;
  }
  function stopCamera(){
    if (camStream){ try{ for (const t of camStream.getTracks()) t.stop(); }catch(_){ } camStream = null; }
    const v = document.getElementById("camBg");
    if (v){ try{ v.srcObject = null; }catch(_){ } v.classList.remove("on"); }
    const bg = document.getElementById("bg");
    if (bg) bg.classList.remove("washed");
    updateWorldUi();
  }
  function updateWorldUi(){
    const cam = document.getElementById("btnCamToggle");
    if (cam) cam.textContent = "CAMERA WORLD: " + (camStream ? "ON" : "OFF");
    const gy = document.getElementById("btnGyroToggle");
    if (gy) gy.textContent = "GYRO TILT: " + (pref("doopieGyro") === "off" ? "OFF" : "ON");
    const chip = document.getElementById("btnWorldOpen");
    // The chip INVITES opting in — hide it for players already opted in
    // (camera live, or opted-in-but-not-yet-resumed at the menu), else the
    // re-opened ask's NOT NOW reads as a downgrade trap.
    if (chip) chip.classList.toggle("hidden", !!camStream || !camSupported() || pref("doopieCam") === "on");
  }
  // Set while a SMASH! tap is waiting on camera reacquisition (returning
  // opt-ins — iOS may be showing its native permission prompt over the menu).
  // camHoldSpent: the current in-flight acquire already spent its one
  // menu-hold (watchdog fired) — later starts must not wait on it again.
  // camCardShown: the branded card already fronted this round's re-prompt
  // (a failed YES must fall to the sky, not loop the card; reset each run).
  let camResuming = false, camWatchdog = 0, camHoldSpent = false, camCardShown = false;

  let orientBound = false;
  // MAY raise the iOS motion sheet — call this ONLY on taps where the player
  // expects an ask: the world card's YES, or the pause GYRO GUTS toggle.
  // Native sheets must never ambush a SMASH!/NOT NOW tap (that was a real
  // phone bug: the motion sheet landed on top of the branded card).
  function enableGyro(){
    if (pref("doopieGyro") === "off") return; // player said no — respect it
    if (orientBound) return;
    try{
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === "function"){
        // iOS: needs a user-gesture-driven permission request
        DOE.requestPermission().then((s)=>{
          if (s === "granted"){ window.addEventListener("deviceorientation", onOrient); orientBound = true; }
        }).catch(()=>{});
      } else if (DOE){
        window.addEventListener("deviceorientation", onOrient); orientBound = true;
      }
    }catch(_){ }
  }
  // Bind gyro WITHOUT ever raising a sheet. On iOS, requestPermission only
  // needs a user gesture when it would PROMPT; a persisted grant resolves
  // silently. So we call it ~3s after the tap — outside WebKit's transient
  // activation — where a would-prompt call rejects (sheet suppressed) and a
  // remembered grant still binds. Non-iOS has no motion sheets: bind now.
  let gyroQuietTimer = 0;
  function enableGyroQuiet(){
    if (pref("doopieGyro") === "off" || orientBound) return;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    if (typeof DOE.requestPermission !== "function"){ enableGyro(); return; }
    clearTimeout(gyroQuietTimer);
    gyroQuietTimer = setTimeout(()=>{
      if (disposed || orientBound || pref("doopieGyro") === "off") return;
      try{
        DOE.requestPermission().then((s)=>{
          if (disposed) return;
          if (s === "granted"){ window.addEventListener("deviceorientation", onOrient); orientBound = true; }
        }).catch(()=>{});
      }catch(_){ }
    }, 3000);
  }

  /* ============================================================ RENDER */
  const cv = document.getElementById("board"), ctx = cv.getContext("2d");
  const holdCv = document.getElementById("holdCv"), nextCv = document.getElementById("nextCv");
  let scale = .4, dpr = 1;

  function layout(){
    dpr = Math.min(window.devicePixelRatio||1, 2.5);
    const wrap = document.getElementById("mid");
    const sideEl = document.getElementById("side");
    // React removes the game's DOM BEFORE the passive-effect cleanup runs, so
    // a resize/settle tick landing in that gap reaches here with #mid already
    // gone — getComputedStyle(null) threw an uncaught TypeError on every
    // quick nav-away. Nothing to lay out without a DOM; bail.
    if (!wrap) return;
    // Measure the gap (CSS owns it); the RAIL width is ours — layout() sets
    // it from the surplus below, so the board budget must assume the MINIMUM
    // rail: reading the current rect would let a previously-widened rail
    // shrink the board after a rotate/resize.
    const gap = parseFloat(getComputedStyle(wrap).gap) || 0;
    const RAIL_MIN = 60;
    const railW = RAIL_MIN;
    // Derive the height budget from the APP box minus the fixed chrome, never
    // from #mid's own height: the board is a fixed-size canvas INSIDE #mid, so
    // reading #mid would let a too-tall board stretch its parent and feed the
    // next layout an even bigger budget (a 375x667 phone scrolled because of
    // exactly that loop). #controls' height is board-independent, so this is
    // non-circular.
    const appEl = document.getElementById("app");
    const topbarEl = document.getElementById("topbar");
    const ctlEl = document.getElementById("controls");
    let availH = wrap.clientHeight - 6;
    if (appEl && topbarEl && ctlEl){
      const box = (el) => {
        if (!el || el.classList.contains("hidden")) return 0;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed") return 0;
        return el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      };
      const ap = getComputedStyle(appEl);
      const inner = appEl.clientHeight - parseFloat(ap.paddingTop) - parseFloat(ap.paddingBottom);
      // EVERY in-flow sibling of #mid must be subtracted. #vsBar is the one
      // that bit us: it only appears once a SPEED round goes live, so the
      // budget silently overshot by its ~63px and — with #mid now
      // overflow:hidden — the board's bottom rows were CLIPPED AWAY mid-match
      // (up to 2 rows on a 360x640 phone) instead of visibly overflowing.
      let siblings = 0;
      for (const el of Array.from(appEl.children)) {
        if (el === wrap) continue;
        siblings += box(el);
      }
      availH = inner - siblings - 6;
      // Belt-and-braces: #mid is flex:1 1 0 / min-height:0 / overflow:hidden,
      // so its height is decided by the flex layout and can no longer be
      // stretched by the canvas — capping here is non-circular and makes any
      // future unaccounted sibling degrade to "slightly small", never clipped.
      availH = Math.min(availH, wrap.clientHeight - 6);
    }
    const availW = wrap.clientWidth - railW - gap;
    const cellCss = Math.floor(Math.min(availH/ROWS, availW/COLS));
    const w = cellCss*COLS, h = cellCss*ROWS;
    cv.style.width = w+"px"; cv.style.height = h+"px";
    cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr);
    scale = (cellCss*dpr)/CELL;
    // When the board is HEIGHT-bound (tall phones, landscape) the aspect lock
    // caps its width and #mid's centering turned the leftover into dead
    // margins — ~40px a side on an iPhone 16 Pro Max ("tons of padding",
    // real report). Give that surplus to the RAIL instead: bigger HOLD/NEXT
    // previews and a fatter SMASH target are useful; empty margins are not.
    // Capped at 112px and at 40% of the board's width so the rail never
    // dwarfs the board (a landscape board is ~90px wide — its rail stays 60).
    // The SMASH track needs no code of its own here: its left/width vars are
    // measured off the rail's box below, AFTER this write.
    if (sideEl){
      const surplus = wrap.clientWidth - w - gap - RAIL_MIN;
      const railTarget = Math.max(RAIL_MIN, Math.min(RAIL_MIN + surplus, 112, Math.round(w*0.4)));
      sideEl.style.width = railTarget + "px";
      sideEl.style.flexBasis = railTarget + "px";
    }
    // Publish the board's bottom edge so the SMASH track starts exactly there
    // (CSS can't know the board height — the engine computes it).
    writeSmashVars();
    // The sync pass above measures mid-layout, and the settled frame can land
    // a half-pixel elsewhere (flex re-centres around the writes we just made;
    // on iOS, Safari's chrome settles without firing resize). Re-derive the
    // vars from the SETTLED rects one frame later — same math, fresh truth.
    if (smashVarsRaf) cancelAnimationFrame(smashVarsRaf);
    smashVarsRaf = requestAnimationFrame(()=>{ smashVarsRaf = 0; writeSmashVars(); });
  }

  let smashVarsRaf = 0;
  function writeSmashVars(){
    const app = document.getElementById("app");
    const sideEl = document.getElementById("side");
    if (!app) return;
    const ar = app.getBoundingClientRect();
    // The board's "bottom" to a HUMAN is the bottom of its 5px ink-slab
    // shadow, not its border box — a track anchored to the box starts a
    // visible sliver above the board's apparent edge (real report, 3x
    // phone). Measure the canvas rect (truth, regardless of borders or
    // box-sizing) and add the slab. Same for the rail's 3px slab.
    const BOARD_SLAB = 5, RAIL_SLAB = 3;
    // Start below whichever is LOWER: the board or the HOLD/NEXT rail. The
    // board height is floor()'d to whole cells, so in landscape the rail can
    // outrun it — and the positioned track then painted over the NEXT
    // panel's bottom border.
    let smashTop = cv.getBoundingClientRect().bottom - ar.top + BOARD_SLAB;
    if (sideEl){
      const sb = sideEl.getBoundingClientRect().bottom - ar.top + RAIL_SLAB;
      if (sb > smashTop) smashTop = sb;
    }
    // Publish EXACT values — rounding each var independently drifted the
    // track a visible 1px off the rail's edges.
    app.style.setProperty("--smash-top", smashTop.toFixed(2) + "px");
    // Align the SMASH track to the HOLD/NEXT rail's ACTUAL box, not to the
    // app edge: #mid centres its children, so when the floor()'d board
    // leaves a few px of slack the rail sits inboard and a right-pinned
    // track no longer lines up with it. Measuring keeps the right-hand
    // column a single clean line on every device.
    if (sideEl){
      const sr = sideEl.getBoundingClientRect();
      app.style.setProperty("--smash-left", (sr.left - ar.left).toFixed(2) + "px");
      app.style.setProperty("--smash-w", sr.width.toFixed(2) + "px");
      // The control row's gutter MUST be derived from the same measurement
      // as the track, not from the app edge: #mid centres its children, so
      // a height-bound board (every landscape phone, any window shorter
      // than ~843px) pushes the rail inboard and an edge-anchored gutter
      // let the track sit ON TOP of Rotate-right / Move-right and eat
      // their taps. One anchor, no drift.
      const ap2 = getComputedStyle(app);
      const padR = parseFloat(ap2.paddingRight) || 0;
      app.style.setProperty("--smash-gutter", Math.max(0, ar.right - padR - (sr.left - 6)).toFixed(2) + "px");
      // POWER-UP TRAY placement (PowerupTray.tsx reads these off :root — it
      // renders outside #app). Its old home was a fixed strip at left:4 — on
      // any portrait phone that strip sits ON the board (fully covering
      // column 0 at 393px, and worse once the rail absorbs the margins),
      // where its opaque z-25 buttons both hide the stack and turn the
      // tap-left-half-to-rotate gesture into an accidental power-up SPEND.
      // Ride the left margin only when the tray genuinely fits there
      // (landscape/desktop); otherwise slot into the RAIL COLUMN between the
      // NEXT panel and the SMASH track — dead space on every portrait phone.
      // The tray is width-capped to the rail and wraps, so a wide rail packs
      // 2 buttons per row and even a 5-power-up loadout never reaches the
      // track above it.
      const cvL = cv.getBoundingClientRect().left - ar.left;
      const root = document.documentElement.style;
      if (cvL >= 56){
        root.setProperty("--tray-left", "4px");
        root.setProperty("--tray-top", "42%");
        root.setProperty("--tray-bottom", "auto");
        root.setProperty("--tray-tf", "translateY(-50%)");
        root.setProperty("--tray-w", "auto");
        root.setProperty("--tray-flow", "column");
        root.setProperty("--tray-gap", "8px");
      } else {
        // BOTTOM-anchored to the track top, growing UPWARD: if a big
        // loadout overfills the column it spills over the NEXT panel
        // (display only — nothing to mis-tap) instead of the SMASH track
        // (a control). The 4px gap matters: it is what lets two 44px
        // buttons share a row once the rail is >= 92px, which is exactly
        // the height-bound class where vertical space is tightest.
        const trayBottom = window.innerHeight - (ar.top + smashTop) + 8;
        // VIEWPORT coords, not app-relative: the tray is position:fixed and
        // renders OUTSIDE #app, and #app is centred at max-width:520px — an
        // app-relative left drifts the tray onto the BOARD on anything wider
        // (tablet/desktop). sr is already a viewport rect; use it directly.
        // (--smash-left legitimately subtracts ar.left — that element lives
        // INSIDE #app.)
        root.setProperty("--tray-left", sr.left.toFixed(2) + "px");
        root.setProperty("--tray-top", "auto");
        root.setProperty("--tray-bottom", trayBottom.toFixed(2) + "px");
        root.setProperty("--tray-tf", "none");
        root.setProperty("--tray-w", sr.width.toFixed(2) + "px");
        root.setProperty("--tray-flow", "row wrap");
        root.setProperty("--tray-gap", "4px");
      }
    }
  }

  function drawBoard(){
    const S = CELL*scale;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,cv.width,cv.height);
    // shake
    let ox=0, oy=0;
    if (G.shake>0){ if(!reduceMotion){ ox=(Math.random()-.5)*G.shake*dpr; oy=(Math.random()-.5)*G.shake*dpr; } G.shake*=.86; if(G.shake<.4)G.shake=0; }
    ctx.setTransform(1,0,0,1,ox,oy);
    // grid dots
    ctx.fillStyle = "rgba(38,36,46,.10)";
    for (let y=1;y<ROWS;y++) for (let x=1;x<COLS;x++){ ctx.beginPath(); ctx.arc(x*S,y*S,1.6*dpr,0,7); ctx.fill(); }

    // ----- GUTS METER: liquid layer BEHIND the pieces that fills per smash -----
    // Fill level = meter/target (deterministic). The slosh (gyro tilt + slow
    // ambient wave), thickness and bubbles are pure presentation: THICK, slow,
    // viscous goo at low opacity so the pieces stay readable.
    {
      const mcfg = meterTarget(tuning.bonus);
      const fill = Math.min(1, G.meterLines / Math.max(1, mcfg.target));
      if (fill > 0.005 && tuning.bonus.enabled){
        const W = COLS*S, Hh = ROWS*S;
        const surf = Hh*(1 - fill*.96);
        const tilt = G.slosh.angle;                    // radians-ish, small
        const t = performance.now()/1000;
        // slower, fatter waves = viscous (was t*2.1 / 8 straight segments)
        const amp = (reduceMotion ? 0 : S*.2) * (0.4 + fill*.8);
        const surfY = (px)=> surf + tilt*(px - W/2) + Math.sin(t*1.15 + (px/W)*4.6)*amp
                          + Math.sin(t*.6 + (px/W)*9.5)*amp*.35;
        const STEPS = 10;
        const tracePath = (yOff)=>{
          ctx.moveTo(0, surfY(0)+yOff);
          for (let i=1;i<=STEPS;i++){
            const px0 = (W*(i-1))/STEPS, px1 = (W*i)/STEPS;
            const mx = (px0+px1)/2;
            // quadratic through midpoints = smooth, blobby surface
            ctx.quadraticCurveTo(mx, surfY(mx)+yOff, px1, surfY(px1)+yOff);
          }
        };
        ctx.save();
        // body fill (dim — pieces stay readable through it)
        ctx.beginPath();
        tracePath(0);
        ctx.lineTo(W, Hh+4); ctx.lineTo(0, Hh+4); ctx.closePath();
        ctx.fillStyle = BLOOD; ctx.globalAlpha = .16; ctx.fill();
        // THICK surface band: a fat darker lip that reads as dense goo
        ctx.globalAlpha = .30; ctx.strokeStyle = BLOOD_D;
        ctx.lineWidth = Math.max(4, S*.22); ctx.lineCap = "round";
        ctx.beginPath(); tracePath(S*.08); ctx.stroke();
        // thin bright meniscus on top of the lip
        ctx.globalAlpha = .35; ctx.strokeStyle = BLOOD; ctx.lineWidth = Math.max(2, S*.08);
        ctx.beginPath(); tracePath(-S*.06); ctx.stroke();
        // lazy bubbles rising through the goo (stateless: derived from time)
        if (!reduceMotion){
          ctx.fillStyle = "#fff";
          const depth = Math.max(S, Hh - surf - S*.4);
          for (let i=0;i<5;i++){
            const bx = W*((i*.19 + .08) % 1) + Math.sin(t*.5+i*2.2)*S*.25;
            const rise = ((t*(6+i*2.4) + i*53) % depth);
            const by = Hh - rise;
            if (by < surfY(bx) + S*.35) continue; // popped at the surface
            ctx.globalAlpha = .18;
            ctx.beginPath(); ctx.arc(bx, by, S*(.05+.03*((i*7)%3)), 0, 7); ctx.fill();
          }
        }
        // bones AND guts chunks bobbing on the surface (artist set; the odd
        // slots carry organs so the goop reads as a proper stew)
        ctx.globalAlpha = .85;
        for (let i=0;i<2+Math.floor(fill*3);i++){
          const bx = W*(.15 + i*.22) + Math.sin(t*.7+i*2)*S*.3;
          const by = surfY(bx) - S*.14;
          const g = (i % 2 === 1) ? pickSprite("guts", i >> 1) : null;
          if (g){
            // HERO scale (~1.5 cells): these are showcase art, not debris —
            // second playtest round still read them as too small at 0.95.
            const iw = S*1.45, ih = iw*(g.naturalHeight/g.naturalWidth);
            ctx.save(); ctx.translate(bx, by); ctx.rotate(Math.sin(t*.5+i)*.25);
            ctx.drawImage(g, -iw/2, -ih/2, iw, ih); ctx.restore();
          } else {
            // .85 × the sprite path's 1.12 overhang ≈ .95 cells — the same
            // piece scale as the organs beside it (user call: at .5 the
            // bones read small next to the resized guts)
            drawBone(bx, by, S*1.3, Math.sin(t*.5+i)*.4, i >> 1); // hero scale, matches the guts
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    // ----- PIXEL SHATTER: square shards arcing up and raining off the board -----
    if (Gore.globs.length){
      const tnow = performance.now();
      const gdt = Math.min(40, tnow - (Gore.dripT || tnow)) / 1000;
      Gore.dripT = tnow;
      const GRAV = CELL*9;
      const EXIT = (TOTAL+1)*CELL;
      for (let i=Gore.globs.length-1;i>=0;i--){
        const g = Gore.globs[i];
        g.vy += GRAV*gdt; g.x += g.vx*gdt; g.y += g.vy*gdt; g.vx *= .99;
        g.rot += g.vr*gdt;
        if (g.y > EXIT){ Gore.globs.splice(i,1); continue; }
        const cx = g.x*scale, cy = (g.y-HIDDEN*CELL)*scale, R = Math.max(2, g.r*scale);
        // quantize rotation to 0/90° steps so shards stay crisp pixels
        const q = (Math.round(g.rot/(Math.PI/2))&1) ? .8 : 1;
        ctx.globalAlpha = 1;
        ctx.fillStyle = INK;
        ctx.fillRect(Math.round(cx-R*q/2)-2, Math.round(cy-R/2)-2, Math.round(R*q)+4, Math.round(R)+4);
        ctx.fillStyle = g.col;
        ctx.fillRect(Math.round(cx-R*q/2), Math.round(cy-R/2), Math.round(R*q), Math.round(R));
      }
      ctx.globalAlpha = 1;
    }

    // ----- fresh blood running down the board, then settling into streaks -----
    if (Gore.drips.length){
      const tnow = performance.now();
      const ddt = (Gore.dripT ? Math.min(40, tnow - Gore.dripT) : 16) / 1000;
      Gore.dripT = tnow;
      const GRAV = CELL*8;
      for (const d of Gore.drips){
        if (!d.done){
          d.vy = Math.min(d.vy + GRAV*ddt, CELL*10);
          d.head += d.vy*ddt;
          if (d.head >= d.maxY){ d.head = d.maxY; d.done = true; }
        } else {
          d.settle += ddt;
          if (d.settle > .35) d.alpha -= ddt*1.6;  // linger briefly, then fade out (~0.6s)
        }
        if (d.alpha <= 0) continue;
        const cx = d.x*scale;
        const top = (d.yTop - HIDDEN*CELL)*scale;
        const bot = (d.head - HIDDEN*CELL)*scale;
        const w = d.w*scale;
        // tapering trail (thin at the top, fattening toward the running head)
        ctx.fillStyle = d.col; ctx.globalAlpha = .85*d.alpha;
        ctx.beginPath();
        ctx.moveTo(cx - w*.35, top);
        ctx.lineTo(cx + w*.35, top);
        ctx.lineTo(cx + w*.5, bot);
        ctx.lineTo(cx - w*.5, bot);
        ctx.closePath(); ctx.fill();
        // bulbous drip head
        ctx.beginPath(); ctx.arc(cx, bot, w*.72, 0, 7); ctx.fill();
        // wet gloss highlight down the trail
        ctx.globalAlpha = .25*d.alpha; ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.ellipse(cx - w*.16, (top+bot)/2, Math.max(.8*dpr, w*.1), Math.max(0,(bot-top)*.42), 0, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      Gore.drips = Gore.drips.filter((d) => d.alpha > 0);  // drop fully-faded drips
    }

    if (!G.grid) return;
    // ----- locked pieces: whole art when intact, slices when crunched -----
    const groups = {};
    for (let y=0;y<TOTAL;y++) for (let x=0;x<COLS;x++){
      const c = G.grid[y][x];
      if (c){ (groups[c.id] = groups[c.id]||[]).push({x,y,rsx:c.rsx,rsy:c.rsy}); }
    }
    const ids = Object.keys(groups).sort((a,b)=>a-b);
    for (const id of ids){
      const cells = groups[id], ins = G.inst[id];
      const rc = rotCanvas(ins.t, ins.v, ins.r);
      let intact = cells.length===4;
      if (intact){
        const ox0 = cells[0].x-cells[0].rsx, oy0 = cells[0].y-cells[0].rsy;
        for (const c of cells) if (c.x-c.rsx!==ox0 || c.y-c.rsy!==oy0){ intact = false; break; }
        if (intact){
          ctx.drawImage(rc.cv, ox0*S - rc.dx*scale, (oy0-HIDDEN)*S - rc.dy*scale, rc.fw*scale, rc.fh*scale);
          continue;
        }
      }
      for (const c of cells){
        ctx.drawImage(rc.cv, rc.dx + c.rsx*CELL, rc.dy + c.rsy*CELL, CELL, CELL,
          c.x*S, (c.y-HIDDEN)*S, S, S);
      }
    }
    // ----- clearing flash -----
    if (G.state==="clearing" && G.clearing){
      const k = G.clearing.t/CLEAR_MS;
      const a = .25 + .45*Math.abs(Math.sin(k*Math.PI*4));
      ctx.fillStyle = "rgba(255,255,255,"+a.toFixed(3)+")";
      for (const y of G.clearing.rows) ctx.fillRect(0,(y-HIDDEN)*S, COLS*S, S);
    }
    // ----- ghost + falling piece -----
    if (G.cur && G.state==="play"){
      const p = G.cur, st = STATES[p.t][p.r];
      const rc = rotCanvas(p.t,"clean",p.r);
      if (G.ghostY>p.y){
        ctx.globalAlpha = .22;
        ctx.drawImage(rc.cv,(p.x+st.bx)*S - rc.dx*scale,(G.ghostY+st.by-HIDDEN)*S - rc.dy*scale, rc.fw*scale, rc.fh*scale);
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(rc.cv,(p.x+st.bx)*S - rc.dx*scale,(p.y+st.by-HIDDEN)*S - rc.dy*scale, rc.fw*scale, rc.fh*scale);
    }
    // ----- bonus round: arrows / sword slashes (+ pop wave + reveal) -----
    if (G.state==="bonus" && G.bonusAnim && (G.bonusAnim.phase==="action" || G.bonusAnim.phase==="pop" || G.bonusAnim.phase==="reveal")){
      const A = G.bonusAnim, res = A.res;
      const ease = (p)=>1-Math.pow(1-p,3);
      // ----- BIG bouncy brand lettering (slot-machine juice) ---------------
      // Per-letter bob + wiggle + squash, gold gradient (or white→pastel-pink)
      // fill, thick ink outline and a hard offset slab — the canvas twin of
      // the CSS `-webkit-text-stroke + text-shadow: 0 4px 0 var(--ink)` look.
      // Words auto-shrink to fit the board width (mobile-first). Presentation
      // only; under reduce-motion the words stay BIG but hold still.
      const now = performance.now()/1000;
      const bonusWord = (txt, cy, px, o)=>{
        o = o || {};
        const chars = Array.from(txt);
        ctx.save();
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.lineCap = "round";
        const fontFor = (p)=>"400 " + Math.round(p) + "px 'Silkscreen', monospace";
        ctx.font = fontFor(px);
        // measure + clamp to 94% of the board width (long numbers/words)
        let track = px*.04, total = 0;
        let widths = chars.map(c=>{ const w = ctx.measureText(c).width; total += w; return w; });
        total += track*(chars.length-1);
        const maxW = COLS*S*.94;
        if (total > maxW){
          px *= maxW/total; track = px*.04; ctx.font = fontFor(px);
          total = 0;
          widths = chars.map(c=>{ const w = ctx.measureText(c).width; total += w; return w; });
          total += track*(chars.length-1);
        }
        const amp = reduceMotion ? 0 : (o.bounce == null ? 1 : o.bounce);
        // whole-word: brand tilt + gentle sway + pop/pulse scale
        ctx.translate(COLS*S/2, cy);
        ctx.rotate(-.035 + amp*Math.sin(now*.9 + cy*.01)*.015);
        const sc = o.scale || 1;
        ctx.scale(sc, sc);
        const grad = ctx.createLinearGradient(0, -px*.55, 0, px*.5);
        if (o.gold === false){ grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#ffe3f1"); }
        else { grad.addColorStop(0, "#ffec9e"); grad.addColorStop(.45, "#ffd34d"); grad.addColorStop(1, "#f0a92e"); }
        const off = Math.max(2, px*.09);     // hard slab offset (the "0 4px 0")
        const stroke = Math.max(3, px*.13);  // chunky ink outline
        ctx.lineWidth = stroke;
        let x = -total/2;
        for (let i=0;i<chars.length;i++){
          const w = widths[i];
          // staggered drop-in with overshoot (reveal), else already landed
          const in_ = o.appear == null ? 1 : Math.min(1, Math.max(0, (o.appear - i*.045)/.3));
          if (in_ <= 0){ x += w + track; continue; }
          const q = in_ - 1, back = 1.7;
          const entrance = reduceMotion ? 1 : 1 + q*q*((back+1)*q + back); // easeOutBack
          const bob = amp * Math.sin(now*5 + i*.65) * px*.09;
          const rot = amp * Math.sin(now*4.2 + i*.9) * .085;
          ctx.save();
          ctx.translate(x + w/2, bob - (1-entrance)*px*1.4);
          ctx.rotate(rot);
          ctx.scale(1, 1 + amp*Math.sin(now*5 + i*.65 + Math.PI/2)*.045); // juggle squash
          ctx.globalAlpha = Math.min(1, in_*1.6);
          ctx.strokeStyle = INK; ctx.fillStyle = INK;                     // slab
          ctx.strokeText(chars[i], 0, off); ctx.fillText(chars[i], 0, off);
          ctx.strokeText(chars[i], 0, 0);                                // outline
          ctx.fillStyle = grad; ctx.fillText(chars[i], 0, 0);            // face
          ctx.restore();
          x += w + track;
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      };
      // arrow flight position with a curved arc (matches the draw + trail)
      const arrowPos = (ar, p)=>{
        const x0 = ar.fromX*scale, y0 = (ar.fromY-HIDDEN*CELL)*scale;
        const x1 = (ar.tx+.5)*S, y1 = (ar.ty+.5-HIDDEN)*S;
        const arc = Math.sin(p*Math.PI)*S*ar.arc;
        return [x0+(x1-x0)*p + arc*.4, y0+(y1-y0)*p - Math.abs(arc)*.6, x1, y1, x0, y0];
      };
      if (res.kind==="arrows" && A.arrows && A.phase!=="reveal"){
        // struck cells pulse while waiting for the volley to finish
        ctx.fillStyle = "#fff";
        for (const ar of A.arrows){
          if (!ar.landed) continue;
          ctx.globalAlpha = .28 + .2*Math.sin(A.t*10);
          ctx.fillRect(ar.tx*S, (ar.ty-HIDDEN)*S, S, S);
        }
        ctx.globalAlpha = 1;
        for (const ar of A.arrows){
          if (A.t < ar.delay) continue;
          const p = ease(ar.prog);
          const [x, y, x1, y1] = arrowPos(ar, p);
          const [px2, py2] = arrowPos(ar, Math.max(0, p-.06));
          const ang = ar.landed ? Math.atan2(y1-py2, x1-px2) : Math.atan2(y-py2, x-px2);
          // motion trail while flying
          if (!ar.landed && p > .05){
            const [tx2, ty2] = arrowPos(ar, Math.max(0, p-.18));
            ctx.globalAlpha = .25; ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(3, S*.14); ctx.lineCap = "round";
            ctx.beginPath(); ctx.moveTo(tx2, ty2); ctx.lineTo(x, y); ctx.stroke();
            ctx.globalAlpha = 1;
          }
          ctx.save();
          ctx.translate(x,y); ctx.rotate(ang);
          // Directional artist darts: rotating one right-facing sprite to a
          // leftward flight renders it UPSIDE-DOWN, so left flights use the
          // mirrored left-facing art un-rotated by pi (art stays upright,
          // tip still at the strike point). An admin override is a single
          // right-facing sprite and keeps today's rotate-only behavior.
          const goingLeft = Math.cos(ang) < -0.05;
          const aimg = spriteArt.arrow
            || (goingLeft ? pickSprite("arrowL", 0) : pickSprite("arrowR", 0))
            || pickSprite("arrowR", 0);
          if (aimg){
            // Depth illusion: the dart leaves the player's hand LARGE and
            // shrinks to board scale as it approaches — landed size is the
            // playtest-approved 1.3 cells. Size follows LINEAR flight time
            // (ar.prog), NOT the eased p: ease-out burns through the early
            // range in the first frame or two, which made the big frames
            // effectively unrenderable (gate review measured zero visible
            // frames above 3x). Position keeps the eased snap.
            const depth = ar.landed ? 1 : 1 + 2.2*(1 - ar.prog);
            const iw = S*1.3*depth, ih = iw*(aimg.naturalHeight/aimg.naturalWidth);
            if (!spriteArt.arrow && goingLeft && pickSprite("arrowL", 0)){
              ctx.rotate(Math.PI); // left art points along -x; tip at its left edge
              ctx.drawImage(aimg, 0, -ih/2, iw, ih);
            } else {
              // right-facing art: tip at origin, shaft back along -x
              ctx.drawImage(aimg, -iw, -ih/2, iw, ih);
            }
          } else {
            const L = S*1.1;
            ctx.strokeStyle = INK; ctx.lineWidth = Math.max(2, S*.09); ctx.lineCap = "round";
            ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-S*.22,0); ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-S*.34,-S*.16); ctx.lineTo(-S*.34,S*.16); ctx.closePath();
            ctx.fill(); ctx.stroke();
            // fletching
            ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-L-S*.2,-S*.14); ctx.moveTo(-L,0); ctx.lineTo(-L-S*.2,S*.14); ctx.stroke();
          }
          ctx.restore();
          // impact ring on landing
          if (ar.ring > 0){
            ctx.globalAlpha = ar.ring*.7; ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(2, S*.1);
            ctx.beginPath(); ctx.arc(x1, y1, S*(1.2-ar.ring)*.9, 0, 7); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      } else if (res.kind==="rats" && A.rats && A.phase!=="reveal"){
        // ---- RAT ATTACK: hand-drawn mice scurry their rows, gnawing blocks ----
        // (canvas twin of the uploaded mouse still: pinkish-white body, chunky
        // ink outline, round ears, whiskers, long pink tail)
        const drawRat = (px, py, dir, wob, vi)=>{
          const L = S*1.15, H = S*.62;
          ctx.save();
          ctx.translate(px, py + Math.sin(wob)*S*.035);
          ctx.scale(dir, 1);
          ctx.rotate(Math.sin(wob*.7)*.06);
          // admin override (faces RIGHT, uniform) > bundled artist variant
          // (mixed native facings — corrected below) > code vector. Inside
          // scale(dir,1) local +x is the travel direction, so a native
          // LEFT-facing artist rat needs one extra flip to run nose-first.
          const rimg = spriteArt.rat || pickSprite("rat", vi || 0);
          if (rimg){
            if (!spriteArt.rat){
              const native = ART_SPRITES.rat.facing[(((vi|0) % 3) + 3) % 3] || 1;
              if (native === -1) ctx.scale(-1, 1);
            }
            // foreground-prop sized (playtest: 1.35 cells read too small)
            const iw = S*2.3, ih = iw*(rimg.naturalHeight/rimg.naturalWidth);
            ctx.drawImage(rimg, -iw/2, -ih/2, iw, ih);
            ctx.restore();
            return;
          }
          ctx.lineCap = "round"; ctx.lineJoin = "round";
          // tail trailing behind, waving
          ctx.strokeStyle = "#f2a5cf"; ctx.lineWidth = Math.max(3, S*.11);
          ctx.beginPath();
          ctx.moveTo(-L*.42, 0);
          ctx.quadraticCurveTo(-L*.9, -S*.05 + Math.sin(wob*1.3)*S*.14, -L*1.22, S*.06);
          ctx.stroke();
          // body
          ctx.strokeStyle = INK; ctx.lineWidth = Math.max(2, S*.07);
          ctx.fillStyle = "#f4e6ec";
          ctx.beginPath(); ctx.ellipse(0, 0, L*.5, H*.5, 0, 0, 7); ctx.fill(); ctx.stroke();
          // ears
          ctx.beginPath(); ctx.arc(L*.16, -H*.44, S*.16, 0, 7); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.arc(-L*.02, -H*.5, S*.14, 0, 7); ctx.fill(); ctx.stroke();
          // eye + nose
          ctx.fillStyle = INK;
          ctx.beginPath(); ctx.arc(L*.28, -H*.06, Math.max(1.5, S*.045), 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(L*.5, H*.04, Math.max(1.5, S*.05), 0, 7); ctx.fill();
          // whiskers
          ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, S*.028);
          ctx.beginPath();
          ctx.moveTo(L*.4, H*.06); ctx.lineTo(L*.62, -H*.04);
          ctx.moveTo(L*.4, H*.12); ctx.lineTo(L*.64, H*.14);
          ctx.stroke();
          ctx.restore();
        };
        // gnawed cells pulse until the pop wave finishes them
        ctx.fillStyle = "#fff";
        for (const rat of A.rats){
          for (let i=0;i<rat.eaten;i++){
            const [cx2,cy2] = rat.cells[i];
            ctx.globalAlpha = .28 + .2*Math.sin(A.t*10);
            ctx.fillRect(cx2*S, (cy2-HIDDEN)*S, S, S);
          }
        }
        ctx.globalAlpha = 1;
        for (const rat of A.rats){
          if (A.t < rat.delay || rat.prog >= 1) continue;
          const span = COLS + 4;
          const nose = rat.dir === 1 ? rat.prog*span - 2 : COLS + 2 - rat.prog*span;
          drawRat((nose - rat.dir*.55)*S, (rat.y - HIDDEN + .5)*S, rat.dir, A.t*22 + rat.wig, rat.vi);
        }
      } else if (res.kind==="banana" && A.shots && A.phase!=="reveal"){
        // ---- BANANA BANGER (playtest rework): no gun, no bullets — the
        // holes just APPEAR on the targeted blocks, shot by shot, with an
        // impact ring. The deterministic hit schedule (which cells, when)
        // is untouched; this is presentation only. ----
        // struck cells pulse
        ctx.fillStyle = "#fff";
        for (const sh of A.shots){
          if (!sh.landed) continue;
          ctx.globalAlpha = .28 + .2*Math.sin(A.t*10);
          ctx.fillRect(sh.tx*S, (sh.ty-HIDDEN)*S, S, S);
        }
        ctx.globalAlpha = 1;
        // artist BULLET HOLES stamp each struck block (stable variant + spin
        // per shot index) and ride the cell until the pop wave takes it —
        // literally: once the pop nulls the cell, its hole goes with it
        // (a decal floating on empty air read wrong).
        for (let hi = 0; hi < A.shots.length; hi++){
          const sh = A.shots[hi];
          if (!sh.landed) continue;
          if (!(G.grid[sh.ty] && G.grid[sh.ty][sh.tx])) continue;
          const himg = pickSprite("hole", hi);
          if (!himg) continue;
          const iw = S*.95, ih = iw*(himg.naturalHeight/himg.naturalWidth);
          ctx.save();
          ctx.translate((sh.tx+.5)*S, (sh.ty+.5-HIDDEN)*S);
          ctx.rotate((hi*2.4) % 6.28);
          ctx.globalAlpha = .92;
          ctx.drawImage(himg, -iw/2, -ih/2, iw, ih);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        // impact ring as each hole lands
        for (const sh of A.shots){
          if (sh.ring > 0){
            const x1 = (sh.tx+.5)*S, y1 = (sh.ty+.5-HIDDEN)*S;
            ctx.globalAlpha = sh.ring*.7; ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(2, S*.1);
            ctx.beginPath(); ctx.arc(x1, y1, S*(1.2-sh.ring)*.9, 0, 7); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      } else if (res.kind==="swords" && (res.slashLines || res.slashGroups) && A.phase!=="reveal"){
        // The blade + streak draw from the slash LINE geometry, not the cut
        // cells — a slash that only nicked one block (or none) still shows its
        // full sweep. This is what made the tester's "invisible" sword round.
        const lines = res.slashLines || [];
        const k = (lines.length || res.slashGroups.length);
        const cur = Math.min(k-1, Math.floor(A.t/PACE.slashEvery));
        // band-center endpoints of slash s at x=0 and x=board width
        const lineY = (s)=>{
          const ln = lines[s];
          if (ln) return [(ln.y0 - HIDDEN + 1)*S, (ln.y0 + Math.floor(COLS*ln.sl/2) - HIDDEN + 1)*S];
          const grp = res.slashGroups[s] || [];
          if (!grp.length) return null;
          return [(grp[0][1] - HIDDEN + .5)*S, (grp[grp.length-1][1] - HIDDEN + .5)*S];
        };
        for (let s=0; s<=cur; s++){
          const grp = res.slashGroups ? (res.slashGroups[s] || []) : [];
          const started = A.t - s*PACE.slashEvery;
          const sweep = Math.min(1, Math.max(0, started/PACE.slashSweep));
          const yy = lineY(s);
          // fading afterimage streak once a slash has fully swept
          if (sweep >= 1 && yy){
            const aAlpha = Math.max(0, .55 - (started-PACE.slashSweep)*1.1);
            if (aAlpha > 0){
              ctx.globalAlpha = aAlpha; ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(4, S*.5); ctx.lineCap = "round";
              ctx.beginPath(); ctx.moveTo(0, yy[0]); ctx.lineTo(COLS*S, yy[1]); ctx.stroke();
              ctx.globalAlpha = 1;
            }
          }
          // flash the cut cells behind the blade
          ctx.fillStyle = "#fff";
          for (const [cx2,cy2] of grp){
            if ((cx2+.5)/COLS <= sweep){
              ctx.globalAlpha = .3 + .2*Math.sin(A.t*12);
              ctx.fillRect(cx2*S, (cy2-HIDDEN)*S, S, S);
            }
          }
          ctx.globalAlpha = 1;
          if ((sweep < 1 || started < PACE.slashSweep + .3) && yy){
            // the giant blade: a thick white edge sweeping along the slash band
            const ang = Math.atan2(yy[1]-yy[0], COLS*S);
            ctx.save();
            ctx.translate(sweep*COLS*S, yy[0] + (yy[1]-yy[0])*sweep);
            ctx.rotate(ang + Math.PI/2);
            const simg = spriteArt.sword || pickSprite("sword", 0);
            if (simg){
              // sprite: blade tip UP, hilt at the bottom (admin override or
              // the bundled artist sword). FOREGROUND-prop sized (playtest:
              // 3.6 cells read too small); the edge stays on the slash band.
              const ih = S*6.2, iw = ih*(simg.naturalWidth/simg.naturalHeight);
              ctx.drawImage(simg, -iw/2, -ih*.62, iw, ih);
            } else {
              ctx.fillStyle = "#fff"; ctx.strokeStyle = INK; ctx.lineWidth = Math.max(2, S*.08);
              ctx.beginPath();
              ctx.moveTo(0,-S*2.2); ctx.lineTo(S*.5,-S*.4); ctx.lineTo(S*.42,S*1.4); ctx.lineTo(-S*.42,S*1.4); ctx.lineTo(-S*.5,-S*.4);
              ctx.closePath(); ctx.fill(); ctx.stroke();
              // hilt
              ctx.fillStyle = "#b9a8f0";
              ctx.fillRect(-S*.6, S*1.4, S*1.2, S*.28);
              ctx.strokeRect(-S*.6, S*1.4, S*1.2, S*.28);
            }
            ctx.restore();
          }
        }
      }
      // ----- slot-machine tally + reveal: BIG bouncy gold words -----
      const pop = A.tallyPop || 0;
      if (A.phase === "reveal"){
        const n = res.deleted.length;
        const p = Math.min(1, A.revealT/.8);
        if (n){
          const shown = Math.round(res.points * ease(p));
          const pulse = 1 + (reduceMotion ? 0 : (p >= 1 ? .07*Math.sin((A.revealT-.8)*8) : .04*Math.sin(A.revealT*22)));
          bonusWord("×"+n+" SMASHED!", ROWS*S*.25, S*1.05, { appear: A.revealT, gold: false });
          bonusWord("+"+shown.toLocaleString(), ROWS*S*.42, S*1.75, { appear: Math.max(0, A.revealT-.18), scale: pulse });
        } else {
          bonusWord("NOTHING", ROWS*S*.25, S*1.15, { appear: A.revealT, gold: false });
          bonusWord("TO SMASH!?", ROWS*S*.38, S*1.15, { appear: Math.max(0, A.revealT-.22), gold: false });
        }
      } else {
        // live tally while the volley/slashes/pops land — the reel climbs but
        // the payout stays unknown until the reveal. Each hit punches the
        // number (tallyPop) like a hammered slot counter.
        const tag = BONUS_TAGS[res.kind] || "BONUS!";
        bonusWord(tag, ROWS*S*.095, S*.58, { gold: false });
        bonusWord("×"+A.hitSet.size, ROWS*S*.235, S*1.9, { scale: 1 + (reduceMotion ? .08 : .32)*pop });
      }
      // full-board white flash on each slash impact (decays fast)
      if (A.flash > 0 && !reduceMotion){
        ctx.globalAlpha = A.flash*.35; ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, COLS*S, ROWS*S);
        ctx.globalAlpha = 1;
      }
    }

    // ----- particles -----
    for (let i=G.particles.length-1;i>=0;i--){
      const q = G.particles[i];
      q.x += q.vx*16; q.y += q.vy*16; q.vy += .06; q.life -= .025;
      if (q.life<=0){ G.particles.splice(i,1); continue; }
      ctx.globalAlpha = Math.min(1,q.life*1.4);
      ctx.fillStyle = q.col;
      { const R = Math.max(2, q.r*q.life*scale*1.4);
        ctx.fillRect(Math.round(q.x*scale - R/2), Math.round((q.y-HIDDEN*CELL)*scale - R/2), Math.round(R), Math.round(R)); }
    }
    ctx.globalAlpha = 1;

    // ----- SMASH-clear celebration: artist bursts over the cleared band -----
    // Scale-in then fade (~0.6s). Reduced motion: no scale pop, just the fade.
    if (smashFX.length){
      const S2 = CELL*scale;
      const nowT = performance.now();
      const easeOut = (p)=>1-Math.pow(1-p,3);
      for (let i=smashFX.length-1;i>=0;i--){
        const fx = smashFX[i];
        const t = (nowT - fx.t0)/1000;
        if (t > .62){ smashFX.splice(i,1); continue; }
        const big = (smashWord && smashWord.naturalWidth > 0) ? smashWord : null, small = null;
        const cy = (fx.y - HIDDEN + .5)*S2, cxm = COLS*S2/2;
        const fade = t < .38 ? 1 : Math.max(0, 1 - (t-.38)/.24);
        const sc = reduceMotion ? 1 : (.55 + .45*easeOut(Math.min(1, t/.22)));
        if (big){
          const iw = S2*4.6*sc, ih = iw*(big.naturalHeight/big.naturalWidth);
          ctx.globalAlpha = fade;
          ctx.drawImage(big, cxm - iw/2, cy - ih/2, iw, ih);
        }
        if (small && t > .08){
          const f2 = t < .44 ? 1 : Math.max(0, 1 - (t-.44)/.18);
          const sc2 = reduceMotion ? 1 : (.5 + .5*easeOut(Math.min(1, (t-.08)/.22)));
          const iw = S2*2.2*sc2, ih = iw*(small.naturalHeight/small.naturalWidth);
          ctx.globalAlpha = f2;
          ctx.drawImage(small, cxm + S2*2.6 - iw/2, cy - S2*1.4 - ih/2, iw, ih);
          ctx.drawImage(small, cxm - S2*2.6 - iw/2, cy + S2*1.1 - ih/2, iw, ih);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawMini(c2, types, single, count){
    const n = count || 3;
    const c = c2.getContext("2d");
    c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,c2.width,c2.height);
    const slot = single ? c2.height : c2.height/n;
    (types||[]).slice(0,n).forEach((t,i)=>{
      if (!t || !art[t]) return;
      const a = art[t].clean;
      const bw = GRIDS[t][0]*CELL, bh = GRIDS[t][1]*CELL;
      const s = Math.min((c2.width-16)/bw, (slot-14)/bh);
      const w = a.fw*s, h = a.fh*s;
      c.drawImage(a.img, (c2.width-bw*s)/2 - a.dx*s, i*slot + (slot-bh*s)/2 - a.dy*s, w, h);
    });
  }
  function drawSide(){
    drawMini(holdCv, G.hold?[G.hold]:[], true);
    drawMini(nextCv, G.queue, false, previewN);
  }

  function updHud(){
    document.getElementById("sScore").textContent = G.score.toLocaleString();
    document.getElementById("sLines").textContent = G.lines;
    document.getElementById("sLevel").textContent = G.level;
  }

  /* ============================================================ LOOP */
  let rafId = 0;
  let disposed = false;
  function loop(t){
    if (disposed) return;
    rafId = requestAnimationFrame(loop);
    const dt = Math.min(50, t-G.lastT); G.lastT = t;
    if (G.state==="play" && G.cur){
      // gravity
      G.dropAcc += dt * (keys.down||touch.softding ? 18 : 1);
      let gms = gravityMs(G.level);
      // Rare Friends WEIGHT: a piece wearing a heavier Friend (earlier gen /
      // higher activation tier) falls slower. Timing only — the server replay
      // verifies placements, not gravity, so this can't desync anti-cheat.
      if (G.cur) gms *= gravityScaleFor(G.cur.t);
      if (performance.now() < slowUntil) gms *= 3; // slow_fall power-up
      while (G.dropAcc>=gms){
        G.dropAcc -= gms;
        if (!collides(G.cur.t,G.cur.r,G.cur.x,G.cur.y+1)){
          G.cur.y++;
          if (keys.down||touch.softding){ G.score+=softDropPoints(1); recorder.soft++; updHud(); }
        }
      }
      // grounded → lock delay
      if (collides(G.cur.t,G.cur.r,G.cur.x,G.cur.y+1)){
        if (G.lockT<0) G.lockT = 0;
        G.lockT += dt;
        if (G.lockT>=LOCK_DELAY) lockPiece();
      } else G.lockT = -1;
      updGhost();
    } else if (G.state==="clearing" && G.clearing){
      G.clearing.t += dt;
      if (G.clearing.t>=CLEAR_MS) finishClear();
    } else if (G.state==="bonus" && G.bonusAnim){
      advanceBonus(dt);
    }
    updateSlosh(Math.min(50, dt)/1000);
    drawBoard();
  }

  /* ============================================================ INPUT */
  const keys = {down:false};
  const das = {dir:0, t:0, fired:false};
  const onKeyDown = e=>{
    if (e.repeat) return;
    Sfx.init();
    if (G.state==="menu"&&(e.key===" "||e.key==="Enter")) return startGame();
    if (e.key==="p"||e.key==="P"||e.key==="Escape") return togglePause();
    if (G.state!=="play") return;
    // A control button with KEYBOARD focus owns Space/Enter — otherwise Space
    // hard-drops the piece AND its preventDefault swallows the button's own
    // activation, so the control silently does nothing and the player loses a
    // placement. :focus-visible is false after a mouse/touch click, so
    // pointer users keep Space = SMASH.
    if (e.key === " " || e.key === "Enter" || e.key === "Spacebar"){
      const ae = document.activeElement;
      try{
        if (ae && ae.tagName === "BUTTON" && ae.matches(":focus-visible")) return;
      }catch(_){ }
    }
    switch(e.key){
      case "ArrowLeft": tryMove(-1,0); das.dir=-1; das.t=0; das.fired=false; break;
      case "ArrowRight": tryMove(1,0); das.dir=1; das.t=0; das.fired=false; break;
      case "ArrowDown": keys.down=true; break;
      case "ArrowUp": case "x": case "X": tryRotate(1); break;
      case "z": case "Z": tryRotate(-1); break;
      case "c": case "C": case "Shift": holdPiece(); break;
      case " ": hardDrop(); e.preventDefault(); break;
    }
  };
  const onKeyUp = e=>{
    if (e.key==="ArrowDown") keys.down=false;
    if ((e.key==="ArrowLeft"&&das.dir===-1)||(e.key==="ArrowRight"&&das.dir===1)) das.dir=0;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const dasTimer = setInterval(()=>{ // DAS repeat
    if (das.dir && G.state==="play"){
      das.t += 30;
      if (das.t>=170){ if(!das.fired||das.t>=170+50){ tryMove(das.dir,0); das.t=170; das.fired=true; } }
    }
  },30);

  /* --- touch: drag = move / soft drop, tap = rotate, flick down = smash --- */
  const touch = {on:false, sx:0, sy:0, st:0, accX:0, accY:0, moved:false, softding:false, lastY:0, lastT2:0, vy:0};
  cv.addEventListener("pointerdown", e=>{
    Sfx.init();
    if (G.state!=="play") return;
    touch.on = true; touch.sx = e.clientX; touch.sy = e.clientY; touch.st = performance.now();
    touch.accX = 0; touch.accY = 0; touch.moved = false; touch.softding = false;
    touch.lastY = e.clientY; touch.lastT2 = touch.st; touch.vy = 0;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", e=>{
    if (!touch.on || G.state!=="play") return;
    const cellCss = cv.clientWidth/COLS;
    const now = performance.now();
    const dyi = e.clientY - touch.lastY, dti = Math.max(1, now-touch.lastT2);
    touch.vy = .7*touch.vy + .3*(dyi/dti);
    touch.lastY = e.clientY; touch.lastT2 = now;
    const dx = e.clientX - touch.sx, dy = e.clientY - touch.sy;
    if (Math.abs(dx) >= cellCss*.72 && Math.abs(dx) > Math.abs(dy)*.8){
      const steps = Math.trunc(dx/(cellCss*.72));
      if (steps!==0){
        for (let i=0;i<Math.abs(steps);i++) tryMove(Math.sign(steps),0);
        touch.sx += steps*cellCss*.72;
        touch.moved = true;
      }
    }
    if (dy >= cellCss*.8 && Math.abs(dy) > Math.abs(dx)){
      touch.softding = true; touch.moved = true;
      const steps = Math.trunc(dy/(cellCss*.8));
      if (steps>0){
        for (let i=0;i<steps;i++) softDrop();
        touch.sy += steps*cellCss*.8;
      }
    } else touch.softding = false;
  });
  cv.addEventListener("pointerup", e=>{
    if (!touch.on) return;
    touch.on = false; touch.softding = false;
    const dt = performance.now()-touch.st;
    const dx = e.clientX-touch.sx, dy = e.clientY-touch.sy;
    // fast downward flick → hard drop
    if (touch.vy > .9 && (e.clientY-touch.sy) > 30 && G.state==="play"){ hardDrop(); return; }
    if (!touch.moved && dt<260 && Math.abs(dx)<12 && Math.abs(dy)<12 && G.state==="play"){
      // tap: right half CW, left half CCW
      const r = cv.getBoundingClientRect();
      tryRotate(e.clientX - r.left > r.width/2 ? 1 : -1);
    }
  });

  /* --- buttons --- */
  /**
   * Wire a control. `down`/`up` are the POINTER (press-and-hold) behaviour.
   * `tap` is the DISCRETE action for keyboard / assistive-tech activation,
   * which arrives as a click with detail === 0 (a real pointer click reports
   * >= 1). Every control gets that path — bindBtn used to bind pointerdown
   * only, so a screen-reader double-tap or an Enter/Space press did nothing
   * at all, and once the key handler learned to yield Space to a focused
   * button, Space became a DEAD KEY on five of the six controls.
   * The default tap is down()+up() so held-state controls (DAS, soft drop)
   * can never latch on from a keyboard press.
   */
  function bindBtn(id, down, up, tap){
    const el = document.getElementById(id);
    if (!el) return; // control not present in this layout
    el.addEventListener("pointerdown", e=>{ e.preventDefault(); Sfx.init(); down(); }, {passive:false});
    if (up){ el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up); el.addEventListener("pointerleave", up); }
    el.addEventListener("click", (e)=>{
      if (e.detail !== 0) return; // real pointer click — pointerdown already ran
      Sfx.init();
      if (tap) tap(); else { down(); if (up) up(); }
    });
  }
  bindBtn("btnL", ()=>{ tryMove(-1,0); das.dir=-1; das.t=0; }, ()=>{ if(das.dir===-1)das.dir=0; });
  bindBtn("btnR", ()=>{ tryMove(1,0); das.dir=1; das.t=0; }, ()=>{ if(das.dir===1)das.dir=0; });
  // soft drop is a HELD state for pointers; a keyboard press should step once
  bindBtn("btnD", ()=>{ keys.down=true; }, ()=>{ keys.down=false; }, ()=>{ softDrop(); });
  bindBtn("btnCW", ()=>tryRotate(1));
  bindBtn("btnCCW", ()=>tryRotate(-1));
  bindBtn("btnHold", ()=>holdPiece());

  // SMASH is a slide-to-activate control for POINTERS, but it must still be
  // operable without one. It is a div (not a button), so bindBtn's detail-0
  // path does not cover it — and once the key handler started yielding Space
  // to a focused button, a keyboard player who had tabbed into the control
  // cluster had NO way to hard-drop at all. Give the knob focus + discrete
  // activation, and stop the key at the target so the window handler cannot
  // ALSO hard-drop (which would consume the next piece too).
  {
    const knobEl = document.getElementById("btnSmash");
    if (knobEl){
      // Enter/Space ONLY. ArrowDown is soft drop everywhere else in this game
      // and is not an activation key for role="button" — binding it here would
      // silently turn a nudge into a committed placement the moment focus
      // landed on SMASH.
      const activates = (e)=> e.key === " " || e.key === "Spacebar" || e.key === "Enter";
      let lastKeyFire = 0;
      const fire = ()=>{ Sfx.init(); hardDrop(); };
      let held = false; // we own this keypress, so swallow its keyup too
      knobEl.addEventListener("keydown", (e)=>{
        if (!activates(e)) return;
        // OS auto-repeat delivers a tick every ~33ms and each one would commit
        // the piece that just spawned — a held key tops the board out in under
        // half a second. The window handler guards the same way, for the same
        // reason. (A native button doesn't repeat on Space either.)
        if (e.repeat) return;
        // Off the play state the key belongs to whatever overlay is up: Enter
        // at the menu starts a game. Swallowing it here would make the knob —
        // newly in the tab order, and immediately before SMASH! — a dead key.
        if (G.state !== "play") return;
        e.preventDefault();
        e.stopPropagation(); // else the window handler drops the NEXT piece too
        held = true;
        lastKeyFire = performance.now();
        fire();
      });
      knobEl.addEventListener("keyup", (e)=>{ if (activates(e) && held){ held = false; e.stopPropagation(); } });
      knobEl.addEventListener("blur", ()=>{ held = false; });
      // Assistive-tech activation arrives as a click with detail 0. Some AT
      // emits BOTH a real keydown and a synthetic click for one activation, so
      // ignore a click that trails a key we already acted on — otherwise a
      // single "activate" costs two placements.
      knobEl.addEventListener("click", (e)=>{
        if (e.detail !== 0) return;
        if (performance.now() - lastKeyFire < 500) return;
        e.preventDefault(); e.stopPropagation(); fire();
      });
    }
  }

  // SMASH SLIDER: the knob rests at the top of its track and must be slid
  // the full travel down to hard-drop — a deliberate ~inch of thumb motion,
  // impossible to misclick. Fires at 88% of travel (feels complete without
  // demanding pixel-perfection); early release springs the knob back.
  (function(){
    const track = document.getElementById("smashSlider");
    const knob = document.getElementById("btnSmash");
    let y0 = null, fired = false, max = 0;
    // visual only — the knob is role="button", so it carries no aria-value*
    const setSlide = (px)=>{ knob.style.setProperty("--slide", px + "px"); };
    knob.addEventListener("pointerdown", (e)=>{
      e.preventDefault(); Sfx.init();
      y0 = e.clientY; fired = false;
      max = Math.max(20, track.clientHeight - knob.offsetHeight - 10); // travel
      try{ knob.setPointerCapture(e.pointerId); }catch(_){}
      knob.classList.add("sliding");
    }, {passive:false});
    knob.addEventListener("pointermove", (e)=>{
      if (y0 === null || fired) return;
      const slide = Math.max(0, Math.min(max, e.clientY - y0));
      setSlide(slide);
      if (slide >= max - 2){ // ALL THE WAY to the bottom of the track
        fired = true;
        knob.classList.remove("sliding"); // re-arm the spring transition
        setSlide(0);
        knob.classList.remove("fired"); void knob.offsetWidth;
        knob.classList.add("fired");
        haptic([55, 40, 75]); // strong double-thump on commit
        hardDrop();
      }
    });
    const end = ()=>{
      if (y0 === null) return;
      y0 = null; fired = false;
      knob.classList.remove("sliding");
      setSlide(0); // spring back (CSS transition)
    };
    knob.addEventListener("pointerup", end);
    knob.addEventListener("pointercancel", end);
  })();

  /* --- overlays --- */
  function show(id){ for (const o of ["menuOv","pauseOv","overOv"]) document.getElementById(o).classList.toggle("hidden", o!==id); const c=document.getElementById("controlsOv"); if(c) c.classList.add("hidden"); }
  function hideAll(){ show("__none__"); }
  function startGame(){
    // Mid-match (or browsing the versus lobby): solo starts are locked out —
    // a stray Enter/Space must not boot a game underneath the lobby card.
    const vsLobby = document.getElementById("vsOv");
    if (G.vs || (vsLobby && !vsLobby.classList.contains("hidden"))) return;
    Sfx.init(); // on the tap gesture — unlocks audio even if the world ask defers the start
    // DOOPIE WORLD gate: first-timers see the branded ask only AFTER tapping
    // SMASH! — they're committed to playing before any permission talk. The
    // YES / NOT NOW tap (its own gesture, which iOS prompts require) then
    // starts the game they asked for. Answering sets the doopieWorld pref,
    // so this fires at most once ever.
    try{
      const isTouch = window.matchMedia && window.matchMedia("(pointer:coarse)").matches;
      if (false && !pref("doopieWorld") && isTouch && camSupported()){ // camera world is opt-in from the menu chip only
        worldPendingFn = startGame;
        showWorldAsk("first");
        return;
      }
    }catch(_){ }
    // NOTE: no enableGyro() here. The motion sheet must never ride the raw
    // SMASH! tap — when the branded card is coming, BOTH asks (camera +
    // motion) ride its YES tap together; every no-card path below uses the
    // sheet-free enableGyroQuiet() instead.
    // Returning opt-ins: reacquire the camera BEFORE play begins. Permission
    // usually restores silently, but iOS Safari can re-prompt every session —
    // that native dialog must land over the menu, never over a live game (and
    // never over the intro: boot no longer touches the camera at all).
    try{
      if (pref("doopieCam") === "on" && !camStream && camSupported()){
        if (camResuming) return; // start re-tapped while the prompt is up
        // This acquire already spent its one menu-hold (hung prompt/webview —
        // watchdog fired): start instantly on the sky; the backdrop attaches
        // by itself if the acquire ever lands. Never a second 8s wait.
        if (!(camHoldSpent && camPending)){
          camResuming = true;
          const sb = document.getElementById("btnStart");
          if (sb) sb.textContent = "LETTING YOUR FRIENDS IN…"; // make the wait legible
          let holdReleased = false;
          const release = ()=>{
            camResuming = false;
            const b = document.getElementById("btnStart");
            if (b) b.textContent = "SMASH!";
          };
          const holdAcquire = ()=>{
            startCamera().then((ok)=>{
              camHoldSpent = false; // settled — a future acquire gets a fresh hold
              // Only a real "Don't Allow" clears the opt-in. Transient failures
              // (camera busy in another app, backgrounded mid-prompt) keep the
              // pref so the backdrop self-heals next session.
              if (!ok && camLastError === "NotAllowedError"){ setPref("doopieCam", "off"); updateWorldUi(); }
              if (disposed || holdReleased){ release(); return; } // answered after the watchdog — wait for a fresh tap
              clearTimeout(camWatchdog);
              release();
              beginRun();
            });
            // Watchdog: still pending after 8s (player reading the sheet, or a
            // hung webview) → RELEASE the hold WITHOUT starting. A game must
            // never begin behind a permission sheet — iOS sheets block touch,
            // don't fire visibilitychange, and a run started under one burns
            // its server seed unseen. The player just taps SMASH! again.
            camWatchdog = setTimeout(()=>{
              if (disposed) return;
              holdReleased = true; camHoldSpent = true;
              release();
            }, 8000);
          };
          // The NATIVE sheet must never appear bare. If the browser says a
          // prompt is coming (iOS forgets between visits), the branded card
          // fronts it — SMASH! → "allow the Doopies into your world?" → the
          // device prompt rides that YES. Remembered grants stay silent.
          queryCamPermission().then((state)=>{
            if (disposed){ release(); return; }
            if (state === "granted"){ enableGyroQuiet(); return holdAcquire(); }
            release();
            if (state === "denied"){ enableGyroQuiet(); return beginRun(); } // browser-blocked: sky, no nagging
            if (camCardShown){ enableGyroQuiet(); return beginRun(); } // card already fronted this round — sky
            camCardShown = true;
            worldPendingFn = startGame;
            showWorldAsk("resume"); // its YES tap carries BOTH device asks
          });
          return;
        }
      }
    }catch(_){ }
    enableGyroQuiet(); // cam-off / hold-spent starts: bind if remembered, never a sheet
    beginRun();
  }
  // The actual game start — runs only after every gate above has settled.
  function beginRun(){
    camCardShown = false; // each run gets one branded fronting at most
    hideAll();
    // RESTART mid-ranked-run: report the discarded run as abandoned so used
    // power-ups get consumed (same leak as quitting otherwise).
    if (recorder.active && activeRun && window.__DOOPIE_RUN && typeof window.__DOOPIE_RUN.abandon === "function"){
      try{ window.__DOOPIE_RUN.abandon({ runId:activeRun.runId, runToken:activeRun.runToken, log:recorder.log.slice() }); }catch(e){}
    }
    // Pull a server-sanctioned run (seed + token) if one was prefetched; else
    // play a local, unranked game with a fresh random seed.
    let run = null;
    try{ run = (window.__DOOPIE_RUN && typeof window.__DOOPIE_RUN.takeRun==="function") ? window.__DOOPIE_RUN.takeRun() : null; }catch(e){ run = null; }
    activeRun = run;
    // Ranked runs play with the server's config SNAPSHOT (the replay verifies
    // against the same numbers); unranked keeps the fetched public config.
    if (run && run.config) applyPublicConfig(run.config);
    // Always record (cheap) so the log can be replayed/verified; only SUBMIT
    // when a server-sanctioned run is active (see gameOver).
    recorder.begin(true);
    reset(run ? run.seed : undefined);
    Music.stop(); Music.start();
  }
  function togglePause(){
    // VERSUS is real time — the clock never stops. An explicit pause press
    // becomes the concede sheet instead (game keeps running behind it).
    if (G.vs){ if (G.state==="play") vsToggleQuitSheet(); return; }
    if (G.state==="play"){ G.state="paused"; show("pauseOv"); Music.stop(); }
    else if (G.state==="paused"){ G.state="play"; G.lastT=performance.now(); hideAll(); Music.start(); }
  }
  // Quit the current game back to the menu. Reports the abandoned ranked run
  // (no score) so the server CONSUMES any power-ups used — otherwise a quit
  // would "refund" used bombs at the next inventory refresh.
  function quitGame(){
    if (recorder.active && activeRun && window.__DOOPIE_RUN && typeof window.__DOOPIE_RUN.abandon === "function"){
      try{ window.__DOOPIE_RUN.abandon({ runId:activeRun.runId, runToken:activeRun.runToken, log:recorder.log.slice() }); }catch(e){}
    }
    G.state = "menu"; G.cur = null;
    G.bonusAnim = null; killBonusOverlay();
    Music.stop();
    recorder.active = false; activeRun = null;
    show("menuOv");
  }
  document.getElementById("btnStart").addEventListener("click", startGame);
  document.getElementById("btnResume").addEventListener("click", togglePause);
  document.getElementById("btnRestart1").addEventListener("click", startGame);
  document.getElementById("btnRestart2").addEventListener("click", startGame);
  const _q = document.getElementById("btnQuit"); if (_q) _q.addEventListener("click", quitGame);

  /* --- DOOPIE WORLD wiring: branded ask → device prompts → easy toggles ---
     wireOnce guards against dev StrictMode double-mount: the toggle handlers
     must attach exactly once or a tap toggles twice (= visibly does nothing). */
  const wireOnce = (el, fn)=>{
    if (!el || el.dataset.doopieWired) return;
    el.dataset.doopieWired = "1";
    el.addEventListener("click", fn);
  };
  const showWorld = (show)=>{
    const ov = document.getElementById("worldOv");
    if (ov) ov.classList.toggle("hidden", !show);
  };
  // Why the card comes up changes what the buttons mean:
  //   "first"  — the one-time branded ask (SMASH! gate, or the chip before
  //              any answer): YES/NOT NOW record the opt-ins.
  //   "resume" — fronting a browser RE-prompt for a returning opt-in (iOS
  //              forgets between visits): NOT NOW = stop asking (cam off).
  //   "chip"   — reopened by hand after answering: NOT NOW just closes.
  let worldMode = "first";
  // Short, but says exactly what YES will ask for and why — the two device
  // pop-ups (camera + motion) land right after this card, so no surprises.
  const WORLD_SUB_FIRST = "Your camera becomes the backdrop.";
  const WORLD_SUB_RESUME = "Turn the camera backdrop back on?";
  const showWorldAsk = (mode)=>{
    worldMode = mode;
    const sub = document.getElementById("worldSub");
    if (sub) sub.textContent = mode === "resume" ? WORLD_SUB_RESUME : WORLD_SUB_FIRST;
    showWorld(true);
  };
  // Closes the ask, then — if it had intercepted the first SMASH! tap —
  // starts the game the player was already committed to.
  const worldDone = ()=>{
    showWorld(false);
    if (worldPendingFn){ const f = worldPendingFn; worldPendingFn = null; f(); }
  };
  wireOnce(document.getElementById("btnWorldYes"), ()=>{
    const firstAnswer = !pref("doopieWorld");
    setPref("doopieWorld", "asked");
    if (firstAnswer) setPref("doopieGyro", "on"); // a resume ask must not override a gyro opt-out
    enableGyro(); // this tap is the gesture the iOS motion prompt needs
    startCamera().then((ok)=>{
      // On a resume ask, a transient failure keeps the opt-in (self-heals
      // next visit) — only a real "Don't Allow" (or a first answer) clears it.
      if (ok) setPref("doopieCam", "on");
      else if (firstAnswer || camLastError === "NotAllowedError") setPref("doopieCam", "off");
      updateWorldUi();
      if (ok) return worldDone();
      const note = document.getElementById("worldNote");
      if (note) note.textContent = "No camera here — the pastel sky it is. Retry anytime from the pause menu.";
      setTimeout(worldDone, 1600);
    });
  });
  wireOnce(document.getElementById("btnWorldNo"), ()=>{
    // What NOT NOW means depends on why the card is up:
    //   first answer  → record both opt-outs;
    //   resume ask    → stop fronting the re-prompt every visit (cam off —
    //                   the chip / pause toggle bring it back);
    //   chip reopen   → just close; never revoke what's already granted.
    if (!pref("doopieWorld")){
      setPref("doopieCam", "off");
      setPref("doopieGyro", "off");
    } else if (worldMode === "resume"){
      setPref("doopieCam", "off");
    }
    setPref("doopieWorld", "asked");
    updateWorldUi();
    worldDone();
  });
  wireOnce(document.getElementById("btnWorldOpen"), ()=>showWorldAsk(pref("doopieWorld") ? "chip" : "first"));
  wireOnce(document.getElementById("btnCamToggle"), ()=>{
    const ct = document.getElementById("btnCamToggle");
    if (camStream){
      setPref("doopieCam", "off");
      stopCamera();
    } else {
      startCamera().then((ok)=>{
        setPref("doopieCam", ok ? "on" : "off");
        if (!ok && ct){ ct.textContent = "NO CAMERA FOUND"; setTimeout(updateWorldUi, 1600); }
      });
    }
  });
  wireOnce(document.getElementById("btnGyroToggle"), ()=>{
    if (pref("doopieGyro") === "off"){
      setPref("doopieGyro", "on");
      enableGyro(); // tap gesture — if iOS wants a prompt, it lands here
    } else {
      setPref("doopieGyro", "off");
      if (orientBound){ window.removeEventListener("deviceorientation", onOrient); orientBound = false; }
      G.slosh.tilt = 0; // let the goo settle level
    }
    updateWorldUi();
  });
  /* ---------- VERSUS: lobby → same-seed 60s rounds → wagered settlement ----
     The SERVER owns the match (lib/match.ts); this block is presentation +
     clock-keeping. All times are absolute server timestamps corrected by the
     poll's clock offset, so both phones start each round together and a laggy
     poll only shortens the countdown, never the round. G.vs is the client
     match state; null = not in versus (every solo path checks it). */
  G.vs = null;
  let vsDriver = 0;
  const MATCH = ()=> (typeof window !== "undefined" ? window.__DOOPIE_MATCH : null) || null;
  const vsNow = ()=>{ const M = MATCH(); return M && M.now ? M.now() : Date.now(); };
  const vsEl = (id)=>document.getElementById(id);

  function vsShowSplash(title, sub, tally, count, showDone, score){
    const ov = vsEl("vsSplashOv"); if (!ov) return;
    vsEl("vsSplashTitle").textContent = title || "";
    vsEl("vsSplashSub").textContent = sub || "";
    const sc = vsEl("vsSplashScore"); if (sc) sc.textContent = score || "";
    vsEl("vsSplashTally").textContent = tally || "";
    vsEl("vsSplashCount").textContent = count || "";
    vsEl("btnVsDone").classList.toggle("hidden", !showDone);
    ov.classList.remove("hidden");
  }

  // Screen wake lock for the whole match: the first couple-test lost a round
  // 0-0 because BOTH phones auto-locked during the between-round splash and
  // iOS suspended the game (prod DB showed a double forfeit). Real-time mode
  // means the screen must not sleep. Fails silently where unsupported.
  let vsLock = null;
  function vsWakeLock(on){
    try{
      if (on){
        if (!vsLock && navigator.wakeLock && navigator.wakeLock.request){
          navigator.wakeLock.request("screen").then((l)=>{
            vsLock = l;
            try{ l.addEventListener("release", ()=>{ vsLock = null; }); }catch(_){ }
            if (!G.vs){ try{ l.release(); }catch(_){ } vsLock = null; } // match ended mid-request
          }).catch(()=>{});
        }
      } else if (vsLock){
        const l = vsLock; vsLock = null;
        try{ l.release(); }catch(_){ }
      }
    }catch(_){ }
  }
  function vsHideSplash(){ const ov = vsEl("vsSplashOv"); if (ov) ov.classList.add("hidden"); }
  const vsTallyStr = (mine, theirs, needed)=>
    "●".repeat(mine) + "○".repeat(Math.max(0, needed-mine)) + "  ·  " +
    "●".repeat(theirs) + "○".repeat(Math.max(0, needed-theirs));
  // W–L record line. New views carry per-mode splits; during deploy skew an
  // old aggregate {w,l} still renders (never "undefined").
  function vsRecStr(rec, mode){
    if (!rec) return "";
    if (rec.speed || rec.turf){
      const sp = rec.speed || { w: 0, l: 0 }, tf = rec.turf || { w: 0, l: 0 };
      if (mode === "speed") return "SPEED " + sp.w + "W\u2013" + sp.l + "L";
      if (mode === "turf") return "TURF " + tf.w + "W\u2013" + tf.l + "L";
      return "SPEED " + sp.w + "W\u2013" + sp.l + "L \u00b7 TURF " + tf.w + "W\u2013" + tf.l + "L";
    }
    return rec.w + "W\u2013" + rec.l + "L";
  }

  function vsUpdateBar(m){
    const bar = vsEl("vsBar"); if (!bar) return;
    bar.classList.remove("hidden");
    vsEl("vsMe").textContent = "YOU " + G.score.toLocaleString();
    // No opponent score mid-round (tester call) — just presence: are they
    // still smashing, locked in, or gone?
    const oppIcon = m.oppState === "playing" ? "…" : m.oppState === "done" ? "✓" : "✗";
    vsEl("vsOpp").textContent = (m.oppHandle || "THEM").slice(0, 10).toUpperCase() + " " + oppIcon;
    vsEl("vsPips").textContent = m.myWins + " – " + m.oppWins + " · R" + m.round;
    const remain = Math.max(0, (G.vs && G.vs.endsAt ? G.vs.endsAt : 0) - vsNow());
    const s = Math.ceil(remain/1000);
    const clock = vsEl("vsClock");
    clock.textContent = Math.floor(s/60) + ":" + String(s%60).padStart(2, "0");
    clock.classList.toggle("vsUrgent", s <= 10 && G.vs && G.vs.phase === "live");
  }
  function vsHideBar(){ const b = vsEl("vsBar"); if (b) b.classList.add("hidden"); }

  function vsToggleQuitSheet(){
    const ov = vsEl("vsQuitOv"); if (!ov) return;
    ov.classList.toggle("hidden");
  }

  // Round submit: freeze the board, ship {summary, log} for replay verification.
  function vsSubmit(){
    if (!G.vs || G.vs.submitted) return;
    G.vs.submitted = true;
    G.state = "vswait"; G.cur = null; // loop ignores unknown states; input dies
    Music.stop();
    haptic([40, 30, 60]);
    const summary = {
      locks: recorder.locks.slice(),
      softDropCells: recorder.soft,
      hardDropCells: recorder.hard,
      durationMs: Math.min(Math.round(performance.now()-recorder.t0), G.vs.roundSecs*1000),
    };
    const M = MATCH();
    if (M) M.finishRound({ matchId: G.vs.matchId, runId: G.vs.runId, runToken: G.vs.runToken, summary, log: recorder.log.slice() });
    recorder.active = false;
    vsShowSplash("TIME!", "YOU: " + G.score.toLocaleString() + " — waiting for your opponent…", "", "", false);
  }
  function vsToppedOut(){
    // Board is full — my round is over early; the clock keeps running for them.
    Sfx.over(); haptic([0, 80, 50, 160]);
    vsSubmit();
    vsShowSplash("TOPPED OUT!", "YOU: " + G.score.toLocaleString() + " — hope it's enough. Waiting…", "", "", false);
  }

  function vsStartRound(m){
    vsHideSplash(); vsToggleQuitSheetOff();
    hideAll();
    if (m.config) applyPublicConfig(m.config); // bonus disabled in the versus snapshot
    G.vs.phase = "live";
    G.vs.submitted = false;
    G.vs.endsAt = m.startsAt + m.roundSecs*1000;
    enableGyroQuiet(); // slosh binds silently if the grant is remembered
    camCardShown = false;
    recorder.begin(true);
    reset(m.seed);
    Music.stop(); Music.start();
    haptic([30, 20, 50]);
  }
  function vsToggleQuitSheetOff(){ const ov = vsEl("vsQuitOv"); if (ov) ov.classList.add("hidden"); }

  // Solo tuning stash: versus applies a bonus-disabled snapshot; leaving the
  // match must give solo its bonuses back (otherwise unranked games silently
  // lose bonus rounds until the next reload — a real review catch).
  let vsSoloBonus = null;
  function vsEnterMatch(){
    if (G.vs) return;
    G.vs = { matchId: null, round: 0, phase: "sync", submitted: false, endsAt: 0, roundSecs: 60, runId: null, runToken: null };
    const lob = vsEl("vsOv"); if (lob) lob.classList.add("hidden");
    hideAll();
    if (vsSoloBonus === null) vsSoloBonus = JSON.parse(JSON.stringify(tuning.bonus));
    vsWakeLock(true); // phones sleeping mid-match = forfeited rounds (see above)
    // ALWAYS swap the driver in: a leftover lobby-watch interval must not
    // block vsTick (boot-resume racing an open lobby left matches driverless).
    clearInterval(vsDriver);
    vsDriver = setInterval(vsTick, 200);
  }
  function vsExit(){
    clearInterval(vsDriver); vsDriver = 0;
    G.vs = null;
    turfExitCleanup();
    vsHideReady();
    vsWakeLock(false);
    const M = MATCH(); if (M) M.stop();
    vsHideSplash(); vsHideBar(); vsToggleQuitSheetOff();
    recorder.active = false;
    if (vsSoloBonus){ tuning.bonus = vsSoloBonus; vsSoloBonus = null; }
    G.state = "menu"; G.cur = null;
    Music.stop();
    show("menuOv");
  }

  function vsTick(){
    const M = MATCH();
    if (!G.vs || !M) return;
    // The result card is terminal: once shown it stays until DONE is tapped —
    // the settled-window expiring into 'idle' must not yank it to the menu.
    if (G.vs.phase === "matchover") return;
    const L = M.latest();
    if (!L) return; // first poll still in flight

    if (L.state === "over" && L.result){
      if (turfFxActive()) return; // let the board finish bleeding first
      const r0 = L.result;
      if (r0.id && r0.id === vsAckedResult){ vsExit(); return; } // already dismissed
      // Match ended on THEIR pure row: bleed the final board (turfFinal) once
      // before the verdict card. Winners already bled it via their own place.
      if (!r0.won && r0.turfFinal && r0.turfFinal.row != null && turfc &&
          turfFx.key !== "over:" + (r0.id || "")){
        turfRunGoreFX(r0.turfFinal.placements, r0.turfFinal.row, "over:" + (r0.id || ""), null);
        return; // the card renders on the first tick after the drip
      }
      G.vs.phase = "matchover";
      G.vs.resultId = r0.id || null;
      M.stop(); // nothing left to poll — the card is static now
      Music.stop(); recorder.active = false;
      G.state = "vswait"; G.cur = null;
      const r = L.result;
      const title = r.aborted ? "MATCH SCRAPPED" : r.draw ? "DEAD EVEN" : r.won ? "WINNER!" : "DEFEATED";
      let sub;
      if (r.aborted) sub = "Nobody showed up to smash. Stakes returned.";
      else if (r.draw) sub = "Inconceivable. Stakes returned.";
      else if (r.won) sub = r.wager > 0 ? "+" + (r.wager*2 - Math.floor(r.wager*2*0.05)).toLocaleString() + " RF (simulated) — pot minus the 5% burn is yours." : "Bragging rights: acquired.";
      else sub = r.wager > 0 ? "Your " + r.wager.toLocaleString() + " RF (simulated) rides home with " + (r.oppHandle || "them").toUpperCase() + "." : "Avenge yourself immediately.";
      // How it ended — a forfeit win must SAY it was a forfeit (playtest:
      // "I was awarded a victory even though I never completed a line").
      const HOW = {
        row: r.won ? "Won on a pure row." : "They finished a pure row.",
        squeeze: r.won ? "They ran out of room for their piece." : "You ran out of room — squeezed out.",
        afk: r.won ? "Their moves stopped arriving — match forfeited to you." : "Your moves stopped arriving — forfeited.",
        concede: r.won ? "They conceded." : "You conceded.",
        score: "",
        abort: "",
      };
      if (r.how && HOW[r.how]) sub = HOW[r.how] + " " + sub;
      const tfLast = r.turfFinal && r.turfFinal.placements && r.turfFinal.placements[r.turfFinal.placements.length - 1];
      if (r.how !== "afk" && tfLast && tfLast.auto) sub = sub + " (the deciding piece was a shot-clock auto-drop)";

      turfExitCleanup(); // turf arena down before the verdict card
      vsHideReady();
      vsShowSplash(title, sub, vsTallyStr(r.myWins, r.oppWins, r.winsNeeded || 3), "", true, "");
      if (r.won){ haptic([60, 40, 60, 40, 120]); Sfx.levelup && Sfx.levelup(); }
      try{ window.dispatchEvent(new CustomEvent("rfsmash:me-changed")); }catch(_){ }
      vsHideBar();
      return;
    }
    // READY-UP staging: both players see the opponent card + rules; nothing
    // starts until both tap READY (the server holds all clocks).
    if (L.state === "active" && L.staging){
      G.vs.matchId = L.staging.id;
      vsShowReady(L);
      return;
    }
    vsHideReady();
    // TURF WAR: its own renderer + clock; the shared over/exit paths above
    // and below still apply (settlement card, concede, cleanup).
    if (L.state === "active" && L.turf){
      G.vs.matchId = L.turf.id; // concede needs it (review catch: flag was dead)
      turfSync(L); turfClockTick();
      return;
    }
    if (L.state !== "active" || !L.match){
      // Not active and no result card — the match evaporated; back to menu.
      vsExit();
      return;
    }

    const m = L.match;
    G.vs.matchId = m.id;
    G.vs.roundSecs = m.roundSecs;

    // New round arrived (first sight of round 1, or the server advanced).
    if (m.round !== G.vs.round){
      G.vs.round = m.round;
      G.vs.runId = m.runId;
      G.vs.runToken = m.runToken;
      G.vs.seed = m.seed;
      G.vs.startsAt = m.startsAt;
      G.vs.phase = "countdown";
      G.state = "vswait"; G.cur = null; recorder.active = false;
      // Resume honesty: if MY side of this round is already settled server-side
      // (reload after a top-out/submit), don't replay it as a ghost round —
      // park in the waiting state until the server advances.
      if (m.myState && m.myState !== "playing"){
        G.vs.submitted = true;
        G.vs.phase = "live";
        vsShowSplash("ROUND " + m.round, "Your score is in — waiting for your opponent…", vsTallyStr(m.myWins, m.oppWins, m.winsNeeded), "", false);
        return;
      }
      G.vs.submitted = false;
      if (m.lastRound){
        const lr = m.lastRound;
        let title, sub;
        if (lr.myForfeit && lr.oppForfeit){
          title = "ROUND " + lr.n + ": NOBODY SHOWED";
          sub = "Both phones dozed off — no point awarded. (Screens stay awake now.)";
        } else if (lr.oppForfeit){
          title = "ROUND " + lr.n + ": THEY VANISHED!";
          sub = "Your opponent never turned in a score. Free point.";
        } else if (lr.myForfeit){
          title = "ROUND " + lr.n + ": YOU VANISHED";
          sub = "Your score never arrived — that one got away.";
        } else if (lr.winner === "me"){
          title = "ROUND " + lr.n + ": YOURS!"; sub = "";
        } else if (lr.winner === "them"){
          title = "ROUND " + lr.n + ": THEIRS"; sub = "";
        } else {
          title = "ROUND " + lr.n + ": DEAD HEAT"; sub = "Identical carnage. No point.";
        }
        const scoreLine = (lr.myForfeit && lr.oppForfeit) ? "" :
          "YOU " + lr.myScore.toLocaleString() + " — " + lr.oppScore.toLocaleString() + " THEM";
        vsShowSplash(title, sub, vsTallyStr(m.myWins, m.oppWins, m.winsNeeded), "", false, scoreLine);
        if (lr.winner === "me") haptic([50, 30, 80]);
      } else {
        const rec = vsRecStr(m.oppRecord, "speed");
        vsShowSplash("OPPONENT FOUND!",
          m.wager > 0 ? m.wager.toLocaleString() + " RF each (simulated) — winner takes the pot, 5% burns" : "Friendly match — pride on the line",
          vsTallyStr(m.myWins, m.oppWins, m.winsNeeded), "", false,
          (m.oppHandle || "A MYSTERY FRIEND").toUpperCase() + (rec ? " · " + rec : ""));
      }
    }

    // Phase clock.
    if (G.vs.phase === "countdown"){
      const wait = m.startsAt - vsNow();
      if (wait <= 0){ vsStartRound(m); }
      else {
        const secs = Math.ceil(wait/1000);
        vsEl("vsSplashCount").textContent = secs <= 3 ? String(secs) : "";
        if (secs <= 3) vsEl("vsSplashSub").textContent = "ROUND " + m.round + " — get ready!";
      }
    } else if (G.vs.phase === "live"){
      vsUpdateBar(m);
      if (!G.vs.submitted){
        if (vsNow() >= G.vs.endsAt) vsSubmit();
      }
    }
    // phase 'live'+submitted or 'sync': waiting — the round-change or match-over
    // branches above pick up the next transition on a later poll.
  }

  // Boot resume: a reload mid-match must fall back INTO the match, not lose
  // it. Privy auth can resolve slowly on cold mobile loads, so retry the
  // authed() gate a few times instead of giving up at one shot.
  let vsResumeTimer = 0;
  const vsBootResume = (attempt)=>{
    vsResumeTimer = setTimeout(()=>{
      if (disposed) return;
      const M = MATCH();
      if (!M || !M.authed || !M.authed()){
        if (attempt < 3) vsBootResume(attempt + 1); // 3.5s → 9.5s → 18.5s
        return;
      }
      M.start();
      vsResumeTimer = setTimeout(()=>{
        if (disposed) return;
        const L = M.latest();
        if (L && (L.state === "active" || (L.state === "over" && L.result && L.result.id !== vsAckedResult))) vsEnterMatch();
        else if (!G.vs){ const lob = vsEl("vsOv"); if (!lob || lob.classList.contains("hidden")) M.stop(); }
      }, 2600);
    }, attempt === 0 ? 3500 : attempt * 6000 + 3000);
  };
  vsBootResume(0);

  /* ---------- TURF WAR client: renderer + placement UI --------------------
     The server referees everything (lib/turf.ts); this block renders the
     shared board with team-glow sprites, lets the player aim (tap/drag a
     column, rotate, PLACE) and keeps the 10s clock honest against the
     server's deadline. p1 = PINK, p2 = BLUE, me-vs-them derived from view. */
  const TURF_COLS = 7, TURF_ROWS = 12;
  const TURF_RULES_V = 2; // must match lib/turf.ts — mismatch = stale bundle
  function vsStaleReload(){
    try{
      if (sessionStorage.getItem("doopieStaleReload")) return; // no reload loops
      sessionStorage.setItem("doopieStaleReload", "1");
    }catch(_){ }
    location.reload();
  }
  const TURF_PINK = "#ee5fa5", TURF_BLUE = "#4f9df0";
  let turfc = null; // client turf state (null = not in a turf match)
  let turfAimHeld = false; // finger currently down on the aim canvas
  const turfEl = (id)=>document.getElementById(id);

  // Team-tinted silhouette of a rotated sprite (cached per piece/rot/team).
  const turfSil = {};
  function turfSilhouette(t, r, team){
    const key = t + r + team;
    if (turfSil[key]) return turfSil[key];
    const rc = rotCanvas(t, "clean", r);
    const c = document.createElement("canvas"); c.width = rc.cv.width; c.height = rc.cv.height;
    const x = c.getContext("2d");
    x.drawImage(rc.cv, 0, 0);
    x.globalCompositeOperation = "source-in";
    x.fillStyle = team === "pink" ? TURF_PINK : TURF_BLUE;
    x.fillRect(0, 0, c.width, c.height);
    turfSil[key] = c;
    return c;
  }
  // Client mirror of the server's zero-gravity legality (ghost preview only —
  // the server revalidates and is the only authority).
  function turfFitsAt(grid, t, r, x, y){
    return STATES[t][r].cells.every(([fx,fy])=>{
      const cx = x+fx, cy = y+fy;
      return cx >= 0 && cx < TURF_COLS && cy >= 0 && cy < TURF_ROWS && !grid[cy][cx];
    });
  }
  function turfYRange(t, r){
    const cells = STATES[t][r].cells;
    const minFy = Math.min(...cells.map(c=>c[1])), maxFy = Math.max(...cells.map(c=>c[1]));
    return { min: -minFy, max: TURF_ROWS - 1 - maxFy };
  }
  function turfXRange(t, r){
    const cells = STATES[t][r].cells;
    const minFx = Math.min(...cells.map(c=>c[0])), maxFx = Math.max(...cells.map(c=>c[0]));
    return { min: -minFx, max: TURF_COLS - 1 - maxFx };
  }
  function turfGridOf(placements){
    const g = Array.from({length:TURF_ROWS},()=>Array(TURF_COLS).fill(null));
    for (const p of placements){
      for (const [fx,fy] of STATES[p.t][p.r].cells){
        const x = p.x+fx, y = p.y+fy;
        if (y>=0 && y<TURF_ROWS && x>=0 && x<TURF_COLS) g[y][x] = p.team;
      }
    }
    return g;
  }

  let turfCell = 40, turfDpr = 1;
  function turfLayout(){
    const cv2 = turfEl("turfCv"); if (!cv2) return;
    turfDpr = Math.min(window.devicePixelRatio||1, 2.5);
    const availW = Math.min(window.innerWidth*.94, 470);
    const availH = window.innerHeight - 246; // header/banner/controls budget
    turfCell = Math.max(24, Math.floor(Math.min(availW/TURF_COLS, availH/TURF_ROWS)));
    cv2.style.width = (turfCell*TURF_COLS) + "px";
    cv2.style.height = (turfCell*TURF_ROWS) + "px";
    cv2.width = Math.round(turfCell*TURF_COLS*turfDpr);
    cv2.height = Math.round(turfCell*TURF_ROWS*turfDpr);
  }

  function turfDrawPiece(x2, t, r, cellX, cellY, team, alpha, variant){
    const rc = rotCanvas(t, variant || "clean", r);
    const st = STATES[t][r];
    const s = (turfCell*turfDpr)/CELL;
    // rotCanvas metadata is BOUNDING-BOX relative; placements are frame-space
    // (server referee's coordinates) — add st.bx/st.by exactly like the solo
    // renderer, or every offset rotation draws shifted off its true cells.
    const dx = (cellX + st.bx)*turfCell*turfDpr - rc.dx*s;
    const dy = (cellY + st.by)*turfCell*turfDpr - rc.dy*s;
    const sil = turfSilhouette(t, r, team);
    const R = Math.max(4, turfCell*turfDpr*.085);
    x2.save();
    if (alpha != null) x2.globalAlpha = alpha;
    for (let k = 0; k < 12; k++){
      const a = k/12 * Math.PI*2;
      x2.drawImage(sil, dx + Math.cos(a)*R, dy + Math.sin(a)*R, rc.cv.width*s, rc.cv.height*s);
    }
    x2.drawImage(rc.cv, dx, dy, rc.cv.width*s, rc.cv.height*s);
    x2.restore();
  }

  /* Row-win gore: the winning row's Doopies flip to their bloody variants and
     the board bleeds for ~1.6s BEFORE any splash/verdict. turfFx.until holds
     turfSync and the over-card back while the canvas is mid-drip. */
  const turfFx = { key: "", until: 0 };
  function turfFxActive(){ return Date.now() < turfFx.until; }
  function turfRunGoreFX(placements, row, key, done){
    const cv2 = turfEl("turfCv");
    if (!cv2 || row == null){ if (done) done(); return; }
    // Idempotent per key: the poll path and the place-response path can race
    // to the same game's FX — the second caller must not spawn a second loop.
    if (turfFx.key === key){ if (done && !turfFxActive()) done(); return; }
    turfFx.key = key; turfFx.until = Date.now() + 1900;
    const x2 = cv2.getContext("2d");
    const t0 = performance.now();
    const DUR = 1600;
    // Drip geometry in CELL units — cpx is re-read every frame so a mid-FX
    // rotate/resize (turfLayout reassigns turfCell/turfDpr) can't mix scales.
    const drips = [];
    for (let c = 0; c < TURF_COLS; c++){
      const cnt = 1 + (c % 2);
      for (let k = 0; k < cnt; k++){
        drips.push({
          x: c + .15 + .42*k + .22*Math.random(),
          w: .07 + .09*Math.random(),
          len: .7 + Math.random()*3.4,
          delay: Math.random()*520,
        });
      }
    }
    const inRow = (p)=>STATES[p.t][p.r].cells.some(([,fy])=>p.y+fy === row);
    Sfx.clear && Sfx.clear();
    haptic([20, 30, 70, 30, 110]);
    const step = ()=>{
      const cv3 = turfEl("turfCv");
      if (!cv3){ turfFx.until = 0; if (done) done(); return; }
      const cpx = turfCell*turfDpr; // live: survives mid-FX resize
      const el = Math.min(1, (performance.now() - t0)/DUR);
      x2.setTransform(1,0,0,1,0,0);
      x2.clearRect(0,0,cv3.width,cv3.height);
      x2.fillStyle = "rgba(38,36,46,.12)";
      for (let gx=0; gx<=TURF_COLS; gx++) for (let gy=0; gy<=TURF_ROWS; gy++){
        x2.beginPath(); x2.arc(gx*cpx, gy*cpx, Math.max(2, cpx*.045), 0, 7); x2.fill();
      }
      for (const p of placements){
        turfDrawPiece(x2, p.t, p.r, p.x, p.y, p.team, null, inRow(p) ? "blood" : "clean");
      }
      // blood wash swells over the row; drips start at its TOP edge and run
      // down OVER it (rows are usually near the bottom — drips spawned below
      // the row would fall straight off the canvas), pooling where they land.
      const wash = Math.min(1, el*3);
      x2.fillStyle = "rgba(190,22,66," + (0.26*wash).toFixed(3) + ")";
      x2.fillRect(0, row*cpx, TURF_COLS*cpx, cpx);
      const floorY = TURF_ROWS*cpx;
      for (const d of drips){
        const de = Math.max(0, Math.min(1, (performance.now() - t0 - d.delay)/(DUR - 380)));
        if (de <= 0) continue;
        const ease = 1 - Math.pow(1 - de, 2.2);
        const dx3 = d.x*cpx, dw = d.w*cpx, dlen = d.len*cpx;
        const yTop = row*cpx + cpx*.1;
        const L = Math.min(dlen*ease, floorY - yTop);
        x2.fillStyle = "rgba(190,22,66,.82)";
        x2.fillRect(dx3, yTop, dw, L);
        if (yTop + L >= floorY - 1){
          // hit the bottom: pool sideways instead of vanishing off-canvas
          const spread = dw*(1 + 3*Math.max(0, dlen*ease - (floorY - yTop))/cpx);
          x2.beginPath(); x2.ellipse(dx3 + dw/2, floorY - dw*.4, spread, dw*.55, 0, 0, 7); x2.fill();
        } else {
          x2.beginPath(); x2.arc(dx3 + dw/2, yTop + L, dw*.72, 0, 7); x2.fill();
        }
      }
      // spatter above the row, flung in the first beats
      x2.fillStyle = "rgba(190,22,66,.55)";
      for (const d of drips){
        if (el < d.delay/900) continue;
        const sy = row*cpx - ((d.len*7*cpx)%(2.2*cpx)) - cpx*.15;
        if (sy > 0) { x2.beginPath(); x2.arc(d.x*cpx, sy, d.w*.4*cpx, 0, 7); x2.fill(); }
      }
      if (el < 1){ requestAnimationFrame(step); }
      else { turfFx.until = 0; if (done) done(); }
    };
    requestAnimationFrame(step);
  }

  function turfDraw(){
    const cv2 = turfEl("turfCv"); if (!cv2 || !turfc) return;
    const x2 = cv2.getContext("2d");
    x2.setTransform(1,0,0,1,0,0);
    x2.clearRect(0,0,cv2.width,cv2.height);
    const cpx = turfCell*turfDpr;
    // grid dots
    x2.fillStyle = "rgba(38,36,46,.12)";
    for (let gx=0; gx<=TURF_COLS; gx++) for (let gy=0; gy<=TURF_ROWS; gy++){
      x2.beginPath(); x2.arc(gx*cpx, gy*cpx, Math.max(2, cpx*.045), 0, 7); x2.fill();
    }
    // settled turf
    for (const p of turfc.placements) turfDrawPiece(x2, p.t, p.r, p.x, p.y, p.team);
    // a just-auto-dropped piece gets a dashed callout so nobody thinks their
    // block teleported silently
    if (turfc.autoFlash && Date.now() < turfc.autoFlash.until){
      const p = turfc.autoFlash.p;
      const cells = STATES[p.t][p.r].cells;
      const xs = cells.map((c)=>p.x+c[0]), ys = cells.map((c)=>p.y+c[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      const w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
      x2.save();
      x2.strokeStyle = "#26242e";
      x2.lineWidth = Math.max(2, cpx*.06);
      x2.setLineDash([cpx*.22, cpx*.14]);
      x2.strokeRect(x0*cpx - cpx*.08, y0*cpx - cpx*.08, w*cpx + cpx*.16, h*cpx + cpx*.16);
      x2.restore();
    }
    // my aim (ghost) — anywhere on the board, zero gravity. Until the player
    // touches it, it pulses with a dashed outline so a freshly-spawned ghost
    // can never be mistaken for a placed piece "appearing" on the board.
    if (turfc.myTurn && turfc.piece){
      const grid = turfGridOf(turfc.placements);
      const ok = turfFitsAt(grid, turfc.piece, turfc.sel.r, turfc.sel.x, turfc.sel.y);
      if (ok){
        const touched = turfc.touchedMove === turfc.moveN;
        const alpha = touched ? .55 : .3 + .12*Math.sin(Date.now()/260);
        turfDrawPiece(x2, turfc.piece, turfc.sel.r, turfc.sel.x, turfc.sel.y, turfc.myTeam, alpha);
        if (!touched){
          const cells = STATES[turfc.piece][turfc.sel.r].cells;
          const xs = cells.map((c)=>turfc.sel.x+c[0]), ys = cells.map((c)=>turfc.sel.y+c[1]);
          const gx0 = Math.min(...xs), gy0 = Math.min(...ys);
          const gw = Math.max(...xs) - gx0 + 1, gh = Math.max(...ys) - gy0 + 1;
          x2.save();
          x2.strokeStyle = turfc.myTeam === "pink" ? TURF_PINK : TURF_BLUE;
          x2.globalAlpha = .8;
          x2.lineWidth = Math.max(2, cpx*.045);
          x2.setLineDash([cpx*.18, cpx*.12]);
          x2.strokeRect(gx0*cpx - cpx*.06, gy0*cpx - cpx*.06, gw*cpx + cpx*.12, gh*cpx + cpx*.12);
          x2.restore();
        }
      } else {
        // blocked aim: the ghost's own cells wash red — slide to an open spot
        x2.fillStyle = "rgba(224,53,107,.35)";
        for (const [fx,fy] of STATES[turfc.piece][turfc.sel.r].cells){
          const cx = turfc.sel.x+fx, cy = turfc.sel.y+fy;
          if (cx>=0 && cx<TURF_COLS && cy>=0 && cy<TURF_ROWS) x2.fillRect(cx*cpx, cy*cpx, cpx, cpx);
        }
      }
    }
  }
  function turfDrawNext(){
    const nc = turfEl("turfNextCv"); if (!nc || !turfc) return;
    const x2 = nc.getContext("2d");
    x2.clearRect(0,0,nc.width,nc.height);
    (turfc.next || []).forEach((t, i)=>{
      const rc = rotCanvas(t, "clean", 0);
      const s = Math.min(56/rc.fw, 56/rc.fh);
      x2.drawImage(rc.cv, 8 + i*64, (64 - rc.fh*s)/2, rc.fw*s, rc.fh*s);
    });
  }

  function turfShow(show){
    const ov = turfEl("turfOv"); if (ov) ov.classList.toggle("hidden", !show);
    if (show) turfLayout();
  }
  function turfSetSel(x, y, r){
    if (!turfc || !turfc.piece) return;
    const nr = ((r % 4) + 4) % 4;
    const xr = turfXRange(turfc.piece, nr), yr = turfYRange(turfc.piece, nr);
    turfc.sel = {
      r: nr,
      x: Math.max(xr.min, Math.min(xr.max, x)),
      y: Math.max(yr.min, Math.min(yr.max, y)),
    };
    turfDraw();
  }

  function turfSync(L){
    const T = L.turf; if (!T) return;
    // Stale bundle playing by old rules? Reload into the current one — the
    // match resumes via boot-resume. (Prevents the "gravity is back and my
    // places don't land" deploy-skew failure from the live playtest.)
    if (T.rulesV && T.rulesV !== TURF_RULES_V){ vsStaleReload(); return; }
    // MATCH IDENTITY — FIRST, before any guard below can consult foreign
    // state: a suspended tab, a second tab, or any missed cleanup can leave
    // turfc from a PREVIOUS match alive. Different match id = full reset,
    // exactly like a first sync ("old game pieces appeared" — playtest #8).
    // Below this line, every turfc field is same-match by construction.
    if (turfc && turfc.matchId !== T.id){ turfc = null; turfFx.key = ""; turfFx.until = 0; }
    // A PLACE is in flight: any view that hasn't RECORDED it yet is stale by
    // construction — adopting one un-paints the optimistic piece, hands the
    // turn back, and re-centers the aim ghost mid-board (the "my block shot
    // to the middle" playtest bug). Hold until the server catches up (moveN
    // advances / the game flips) or the fail-safe ages out.
    if (turfc && turfc.pending){
      const pend = turfc.pending;
      if (T.game === pend.game && T.moveN <= pend.moveN){
        if (Date.now() < pend.until) return;
      }
      turfc.pending = null;
    }
    if (turfFxActive()) return; // the board is mid-bleed — sync resumes after
    // Opponent finished a row: bleed THEIR winning board (carried in
    // lastGame — we never saw their final placement) before the splash.
    if (turfc && turfc.game !== T.game && T.lastGame && T.lastGame.reason === "row" &&
        T.lastGame.row != null && T.lastGame.placements &&
        turfc.splashedGame !== T.lastGame.n && turfFx.key !== "game:" + T.id + ":" + T.lastGame.n){
      const lg = T.lastGame;
      turfRunGoreFX(lg.placements, lg.row, "game:" + T.id + ":" + lg.n, ()=>{
        if (!turfc) return;
        turfc.splashedGame = lg.n;
        const title = lg.winner === "me" ? "GAME " + lg.n + ": YOURS!" : "GAME " + lg.n + ": THEIRS";
        let sub = lg.winner === "me" ? "PURE ROW — beautiful." : "They finished a pure row. Rude.";
        const lgLast2 = lg.placements[lg.placements.length - 1];
        if (lgLast2 && lgLast2.auto) sub += " (shot-clock auto-drop)";
        vsShowSplash(title, sub, vsTallyStr(T.myWins, T.oppWins, T.winsNeeded), "", false, "");
        haptic(lg.winner === "me" ? [50, 30, 80] : [30]);
        setTimeout(()=>{ if (turfc) vsHideSplash(); }, 3200);
        const M2 = MATCH(); const L2 = M2 && M2.latest(); if (L2) vsTickApply(L2);
      });
      return; // keep the OLD board on screen while it bleeds
    }
    const first = !turfc;
    const gameChanged = turfc && turfc.game !== T.game;
    const prevAutoN = turfc && !gameChanged ? turfc.placements.filter((p)=>p.auto).length : 0;
    const turnBecameMine = turfc && !turfc.myTurn && T.myTurn;
    turfc = {
      matchId: T.id, game: T.game, moveN: T.moveN, piece: T.piece, next: T.next,
      myTeam: T.myTeam, myTurn: T.myTurn, deadline: T.deadline, placements: T.placements,
      myWins: T.myWins, oppWins: T.oppWins, oppHandle: T.oppHandle, wager: T.wager,
      winsNeeded: T.winsNeeded,
      sel: (turfc && !gameChanged && turfc.piece === T.piece && !turnBecameMine) ? turfc.sel : { r: 0, x: 2, y: 5 },
      placedWait: turfc && !gameChanged ? turfc.placedWait : false,
      splashedGame: turfc ? turfc.splashedGame : 0,
      pending: null,
      buzzedMove: turfc && !gameChanged ? turfc.buzzedMove : -1,
      touchedMove: turfc && !gameChanged ? turfc.touchedMove : -1,
      bannerHoldUntil: turfc ? turfc.bannerHoldUntil : 0,
      autoFlash: turfc && !gameChanged ? turfc.autoFlash : null,
    };
    // A shot-clock auto-drop arrived (either side): say it LOUDLY — a silently
    // relocated piece reads as "the game moved my block" (playtest #7, and
    // it matters double when wagers ride on it).
    if (!first && !gameChanged){
      const autos = turfc.placements.filter((p)=>p.auto);
      if (autos.length > prevAutoN){
        const lastAuto = autos[autos.length - 1];
        const mine = lastAuto.team === turfc.myTeam;
        const b = turfEl("turfBanner");
        // Opponent's drop hands the turn to ME with the clock already
        // running — the cue must carry the handoff and hold briefly.
        if (b) b.textContent = mine ? "CLOCK RAN OUT — THE REFEREE DROPPED YOUR PIECE" : "THEY RAN OUT — REFEREE DROPPED THEIRS · YOUR TURN!";
        turfc.bannerHoldUntil = Date.now() + (mine ? 2600 : 1500);
        turfc.autoFlash = { p: lastAuto, until: Date.now() + 2600 };
        haptic(mine ? [60, 40, 60] : [20]);
      }
    }
    if (first){
      // A solo game may be live underneath (boot-resume race): stop it cold —
      // abandon a ranked run properly, then freeze the loop like speed does.
      if (recorder.active && activeRun && window.__DOOPIE_RUN && typeof window.__DOOPIE_RUN.abandon === "function"){
        try{ window.__DOOPIE_RUN.abandon({ runId:activeRun.runId, runToken:activeRun.runToken, log:recorder.log.slice() }); }catch(_){ }
      }
      recorder.active = false; activeRun = null;
      G.state = "vswait"; G.cur = null;
      Music.stop();
      hideAll(); vsHideSplash();
      turfShow(true);
      const me = turfEl("turfMe"), opp = turfEl("turfOpp");
      if (me){ me.textContent = "YOU"; me.className = "turfTag " + (T.myTeam === "pink" ? "turfPink" : "turfBlue"); }
      if (opp){
        opp.textContent = (T.oppHandle || "THEM").slice(0, 10).toUpperCase();
        opp.className = "turfTag " + (T.myTeam === "pink" ? "turfBlue" : "turfPink");
      }
      const rec = vsRecStr(T.oppRecord, "turf");
      vsShowSplash("TURF WAR!", T.wager > 0 ? T.wager.toLocaleString() + " RF each (simulated)" : "Pride on the line",
        "", "", false, (T.oppHandle || "A MYSTERY FRIEND").toUpperCase() + (rec ? " · " + rec : ""));
      setTimeout(()=>{ if (turfc) vsHideSplash(); }, 2600);
      Music.stop(); Music.start();
    }
    if (gameChanged && T.lastGame && turfc.splashedGame !== T.lastGame.n){
      const lg = T.lastGame;
      const title = lg.winner === "me" ? "GAME " + lg.n + ": YOURS!" : "GAME " + lg.n + ": THEIRS";
      let sub = lg.reason === "row"
        ? (lg.winner === "me" ? "PURE ROW — beautiful." : "They finished a pure row. Rude.")
        : lg.reason === "squeeze"
        ? (lg.winner === "me" ? "No room left for their piece — squeezed out." : "Nowhere to put your piece — squeezed out.")
        : (lg.winner === "me" ? "They stopped showing up to their turns." : "The clock ate your turns.");
      // If the DECIDING piece was a shot-clock drop, say so — a wagered game
      // ending on a referee placement must never be silent (review catch).
      const lgLast = lg.placements && lg.placements[lg.placements.length - 1];
      if (lg.reason !== "afk" && lgLast && lgLast.auto) sub += " (shot-clock auto-drop)";
      vsShowSplash(title, sub, vsTallyStr(turfc.myWins, turfc.oppWins, turfc.winsNeeded), "", false, "");
      haptic(lg.winner === "me" ? [50, 30, 80] : [30]);
      setTimeout(()=>{ if (turfc) vsHideSplash(); }, 3200);
    }
    if (turnBecameMine) haptic([35, 25, 45]);
    // HUD
    const tally = turfEl("turfTally"); if (tally) tally.textContent = turfc.myWins + " – " + turfc.oppWins;
    const gn = turfEl("turfGameN"); if (gn) gn.textContent = "GAME " + turfc.game + " · first to " + turfc.winsNeeded;
    const banner = turfEl("turfBanner");
    const breather = turfc.placements.length === 0 && turfc.moveN === 0 && (turfc.deadline - vsNow()) > 11_000;
    if (banner && breather){
      const secs = Math.ceil((turfc.deadline - vsNow() - 10_000)/1000);
      banner.textContent = "GAME " + turfc.game + " STARTS IN " + Math.max(1, secs) + "…";
      banner.classList.remove("theirs");
    } else if (banner){
      // The hold only freezes TEXT — turn styling must never lie (review:
      // a 2.6s hold left opponent-turn colors up while MY clock was running).
      if (!(turfc.bannerHoldUntil > Date.now())){
        banner.textContent = turfc.myTurn ? "YOUR TURN — PLACE IT" : (turfc.oppHandle || "THEM").toUpperCase() + " IS THINKING…";
      }
      banner.classList.toggle("theirs", !turfc.myTurn);
      banner.style.background = turfc.myTurn
        ? (turfc.myTeam === "pink" ? TURF_PINK : TURF_BLUE)
        : (turfc.myTeam === "pink" ? TURF_BLUE : TURF_PINK);
    }
    const pl = turfEl("turfPlace"); if (pl) pl.disabled = !turfc.myTurn;
    const ro = turfEl("turfRotate"); if (ro) ro.disabled = !turfc.myTurn;
    turfDraw(); turfDrawNext();
  }
  function turfClockTick(){
    if (!turfc) return;
    const el = turfEl("turfClock"); if (!el) return;
    const remaining = turfc.deadline - vsNow();
    const s = Math.min(10, Math.max(0, Math.ceil(remaining/1000)));
    el.textContent = String(s);
    el.classList.toggle("vsUrgent", s <= 3 && turfc.myTurn);
    // BUZZER-BEATER: at the horn, submit the player's CURRENT aim through the
    // normal PLACE path — their rushed aim beats the referee's deepest-spot
    // guess ("my piece settled somewhere I didn't place it", playtest #7).
    // Review-hardened rules:
    //  - PRESENCE required (touchedMove): an untouched turn stays with the
    //    marked, announced server referee — otherwise an AFK client would
    //    "play" default center aims forever, defeating the AFK forfeit and
    //    the dead-match refund (wager integrity).
    //  - fires at <=150ms (the server grants 3s grace — a human tap at "1"
    //    must always beat the machine), never while the finger is down
    //    (a mid-drag transient is not an aim), and re-evaluates every tick
    //    until it actually fires (a momentarily-blocked aim isn't consumed).
    if (turfc.myTurn && !turfc.placedWait && !turfc.pending && !turfAimHeld &&
        turfc.touchedMove === turfc.moveN && turfc.buzzedMove !== turfc.moveN &&
        remaining <= 150 && remaining > -2500 && turfc.piece){
      const grid = turfGridOf(turfc.placements);
      if (turfFitsAt(grid, turfc.piece, turfc.sel.r, turfc.sel.x, turfc.sel.y)){
        const pl = turfEl("turfPlace");
        if (pl && !pl.disabled){
          turfc.buzzedMove = turfc.moveN; // latch only on an actual fire
          pl.click();
          const b = turfEl("turfBanner");
          if (b) b.textContent = "BUZZER! LOCKED YOUR AIM";
          turfc.bannerHoldUntil = Date.now() + 1600;
        }
      }
    }
  }
  function vsTickApply(L){
    if (L && L.state === "active" && L.turf){ turfSync(L); turfClockTick(); }
  }
  function turfExitCleanup(){
    turfc = null;
    turfFx.key = ""; turfFx.until = 0; // never let a key outlive its match
    const cv2 = turfEl("turfCv");
    if (cv2){ const x2 = cv2.getContext("2d"); x2.setTransform(1,0,0,1,0,0); x2.clearRect(0,0,cv2.width,cv2.height); }
    turfShow(false);
  }

  /* turf input wiring */
  (function(){
    const cv2 = turfEl("turfCv");
    if (cv2 && !cv2.dataset.doopieWired){
      cv2.dataset.doopieWired = "1";
      const aim = (e)=>{
        if (!turfc || !turfc.myTurn) return;
        turfc.touchedMove = turfc.moveN; // live human aim — arms the buzzer-beater
        const rect = cv2.getBoundingClientRect();
        const col = Math.floor((e.clientX - rect.left) / turfCell);
        const row = Math.floor((e.clientY - rect.top) / turfCell);
        // center the piece's OCCUPIED cells on the finger in BOTH axes
        // (subtract the frame offsets or offset rotations aim wide).
        const cells = STATES[turfc.piece][turfc.sel.r].cells;
        const minFx = Math.min(...cells.map(c=>c[0]));
        const minFy = Math.min(...cells.map(c=>c[1]));
        const w = Math.max(...cells.map(c=>c[0])) - minFx;
        const h = Math.max(...cells.map(c=>c[1])) - minFy;
        turfSetSel(col - minFx - Math.floor(w/2), row - minFy - Math.floor(h/2), turfc.sel.r);
      };
      cv2.addEventListener("pointerdown", (e)=>{ turfAimHeld = true; aim(e); try{ cv2.setPointerCapture(e.pointerId); }catch(_){ } });
      cv2.addEventListener("pointermove", (e)=>{ if (e.buttons) aim(e); });
      window.addEventListener("pointerup", ()=>{ turfAimHeld = false; });
      window.addEventListener("pointercancel", ()=>{ turfAimHeld = false; });
    }
    wireOnce(turfEl("turfRotate"), ()=>{
      if (!turfc || !turfc.myTurn) return;
      turfc.touchedMove = turfc.moveN; // rotating counts as presence too
      Sfx.init(); Sfx.rotate && Sfx.rotate();
      turfSetSel(turfc.sel.x, turfc.sel.y, turfc.sel.r + 1);
    });
    wireOnce(turfEl("turfPlace"), ()=>{
      if (!turfc || !turfc.myTurn || turfc.placedWait) return;
      const grid = turfGridOf(turfc.placements);
      if (!turfFitsAt(grid, turfc.piece, turfc.sel.r, turfc.sel.x, turfc.sel.y)){
        haptic([20, 20, 20]);
        const banner = turfEl("turfBanner");
        if (banner) banner.textContent = "THAT SPOT IS TAKEN — SLIDE IT ANYWHERE OPEN";
        return;
      }
      const M = MATCH(); if (!M) return;
      Sfx.init(); haptic([45, 25, 60]);
      turfc.placedWait = true;
      // OPTIMISTIC: paint my piece NOW (playtest: the poll delay read as lag).
      // `pending` freezes turfSync until the server view has RECORDED this
      // move, so an in-flight stale poll can never un-paint it (see guard).
      const optim = { t: turfc.piece, r: turfc.sel.r, x: turfc.sel.x, y: turfc.sel.y, team: turfc.myTeam };
      turfc.placements = turfc.placements.concat([optim]);
      turfc.myTurn = false;
      turfc.pending = { game: turfc.game, moveN: turfc.moveN, until: Date.now() + 12_000 };
      const banner0 = turfEl("turfBanner");
      if (banner0) banner0.textContent = "LOCKED IN — THEIR MOVE";
      turfDraw();
      const pl = turfEl("turfPlace"); if (pl) pl.disabled = true;
      const ro0 = turfEl("turfRotate"); if (ro0) ro0.disabled = true;
      const sentMatch = turfc.matchId; // a stray late response for an OLD
      // match must never touch a NEW match's state (review: M.place can
      // resolve 60s+ later on a dead radio — long enough to be in match B)
      const rollback = (msg)=>{
        // The server never recorded the move: un-paint it and hand the turn
        // back so the player can just re-aim and tap again.
        if (!turfc || turfc.matchId !== sentMatch) return;
        turfc.pending = null;
        if (turfc.buzzedMove === turfc.moveN) turfc.buzzedMove = -1; // machine may retry in-window
        turfc.placements = turfc.placements.filter((q)=>q !== optim);
        turfc.myTurn = true;
        const b = turfEl("turfBanner"); if (b) b.textContent = msg;
        const pl2 = turfEl("turfPlace"); if (pl2) pl2.disabled = false;
        const ro2 = turfEl("turfRotate"); if (ro2) ro2.disabled = false;
        haptic([15, 15, 15]);
        turfDraw();
      };
      M.place({ matchId: turfc.matchId, moveN: turfc.moveN, t: optim.t, r: optim.r, x: optim.x, y: optim.y, rulesV: TURF_RULES_V })
        .then((data)=>{
          if (!turfc || turfc.matchId !== sentMatch) return; // foreign echo — drop it
          if (data && data.stale){ vsStaleReload(); return; }
          turfc.placedWait = false;
          if (!data){ rollback("CONNECTION HICCUP — TAP PLACE AGAIN"); return; }
          if (data.ok === false){
            if (/stale move|not your turn/i.test(data.error || "")){
              // Already resolved server-side: either our earlier attempt
              // landed (response lost) or the referee consumed the turn
              // first. The fresh view is the truth — never hand the turn
              // back on this error, it would invite a second, doomed tap.
              turfc.pending = null;
              turfc.placements = turfc.placements.filter((q)=>q !== optim);
              const b = turfEl("turfBanner"); if (b) b.textContent = "MOVE ALREADY RESOLVED — SYNCING…";
              turfc.bannerHoldUntil = Date.now() + 1400;
              haptic([15, 15, 15]);
            } else if (/expired/i.test(data.error || "")){
              // The clock beat us — the server already auto-placed this piece
              // somewhere else. Drop the optimistic paint; the fresh view
              // (below) shows where it really landed.
              turfc.pending = null;
              turfc.placements = turfc.placements.filter((q)=>q !== optim);
              const b = turfEl("turfBanner"); if (b) b.textContent = "TOO SLOW — THE CLOCK AUTO-PLACED YOU";
              haptic([15, 15, 15]);
            } else {
              rollback((data.error || "MOVE REFUSED — RE-AIM").toUpperCase());
            }
          }
          // Instant verdict: my placement ended the game — celebrate NOW,
          // no 2s poll wait (playtest: the winning row showed nothing).
          if (data.ok && data.gameOver && turfc){
            turfc.splashedGame = turfc.game; // the poll's game-change splash skips
            const go = data.gameOver;
            const title = go.winner === "me" ? "GAME " + turfc.game + ": YOURS!" : "GAME " + turfc.game + ": THEIRS";
            const sub = go.reason === "row"
              ? (go.winner === "me" ? "PURE ROW — beautiful." : "They finished a pure row. Rude.")
              : (go.winner === "me" ? "No room left for their piece — squeezed out." : "Nowhere to put your piece — squeezed out.");
            const showIt = ()=>{
              vsShowSplash(title, sub, "", "", false, "");
              haptic(go.winner === "me" ? [60, 40, 60, 40, 120] : [40]);
              setTimeout(()=>{ if (turfc) vsHideSplash(); }, 3200);
            };
            // My row: it's on MY board already (optimistic piece included) —
            // bleed it, then celebrate.
            let fxRow = null;
            if (go.reason === "row" && go.winner === "me"){
              const grid2 = turfGridOf(turfc.placements);
              for (let y = 0; y < TURF_ROWS; y++){
                if (grid2[y].every((c)=>c === turfc.myTeam)){ fxRow = y; break; }
              }
            }
            const wantKey = "game:" + turfc.matchId + ":" + turfc.game;
            if (turfFx.key === wantKey){
              // The poll's lastGame branch beat this response to the same
              // game's FX — it owns the drip AND the splash. Do nothing.
            } else if (fxRow != null){
              turfRunGoreFX(turfc.placements, fxRow, wantKey, showIt);
            } else {
              showIt();
            }
          }
          if (turfc) turfc.pending = null; // server answered — views are truth again
          const L = M.latest(); if (L) vsTickApply(L);
        });
    });
    wireOnce(turfEl("turfConcede"), ()=>vsToggleQuitSheet());
  })();
  const onTurfResize = ()=>{ if (turfc){ turfLayout(); if (!turfFxActive()) turfDraw(); } };
  window.addEventListener("resize", onTurfResize);

  /* --- READY-UP screen --- */
  const VS_RULES = {
    speed: [
      "Best of 5 rounds, 60 seconds each.",
      "Identical pieces for both players — pure speed and stacking.",
      "Highest verified score takes the round. First to 3 wins the pot.",
    ],
    turf: [
      "One shared board. Take turns — 10 seconds a move.",
      "Zero gravity: place your piece anywhere with open cells.",
      "Own a whole row (all 7 cells) to win a game. First to 2 takes the pot.",
      "No room left for your piece? You're squeezed out — game over.",
    ],
  };
  let vsReadySent = false;
  // The last result card the player dismissed with DONE. The server replays a
  // settled match's card for ~2 minutes (so the other player sees it); a
  // stale over-view in latest() during a requeue must not resurrect it
  // (playtest: "the same pop-up appeared again after the match").
  let vsAckedResult = "";
  function vsShowReady(L){
    const st = L.staging;
    const ov = vsEl("vsReadyOv"); if (!ov) return;
    vsHideSplash();
    const lob = vsEl("vsOv"); if (lob) lob.classList.add("hidden");
    const opp = vsEl("readyOpp");
    if (opp) opp.textContent = (st.oppHandle || "A MYSTERY FRIEND").toUpperCase();
    const rec = vsRecStr(st.oppRecord, null);
    const recEl = vsEl("readyRecord");
    if (recEl) recEl.textContent = rec ? "THEIR RECORD · " + rec : "";
    const meta = vsEl("readyMeta");
    if (meta) meta.textContent = (L.mode === "turf" ? "TURF WAR" : "SPEED SMASH") +
      (st.wager > 0 ? " · " + st.wager.toLocaleString() + " RF each (simulated)" : " · friendly match");
    const artT = vsEl("readyArtTurf"), artS = vsEl("readyArtSpeed");
    if (artT) artT.classList.toggle("hidden", L.mode !== "turf");
    if (artS) artS.classList.toggle("hidden", L.mode === "turf");
    const rules = vsEl("readyRules");
    if (rules && !rules.childElementCount){
      for (const line of VS_RULES[L.mode === "turf" ? "turf" : "speed"]){
        const li = document.createElement("div");
        li.className = "readyRule";
        li.textContent = line;
        rules.appendChild(li);
      }
    }
    const btn = vsEl("btnReady"), status = vsEl("readyStatus");
    if (st.myReady){
      if (btn) btn.classList.add("hidden");
      if (status){
        status.classList.remove("hidden");
        status.textContent = st.oppReady ? "BOTH READY — HERE WE GO" : "WAITING FOR YOUR OPPONENT…";
      }
    } else {
      if (btn) btn.classList.remove("hidden");
      if (status) status.classList.add("hidden");
    }
    ov.classList.remove("hidden");
  }
  function vsHideReady(){
    const ov = vsEl("vsReadyOv");
    if (ov && !ov.classList.contains("hidden")){
      ov.classList.add("hidden");
      // (art visibility is per-mode and re-set by the next vsShowReady)
      const rules = vsEl("readyRules"); if (rules) rules.innerHTML = "";
      vsReadySent = false;
    }
  }
  wireOnce(document.getElementById("btnReady"), ()=>{
    const M = MATCH();
    if (!M || !G.vs || !G.vs.matchId || vsReadySent) return;
    vsReadySent = true;
    Sfx.init(); haptic([30, 20, 40]);
    const btn = vsEl("btnReady"), status = vsEl("readyStatus");
    if (btn) btn.classList.add("hidden");
    if (status){ status.classList.remove("hidden"); status.textContent = "WAITING FOR YOUR OPPONENT…"; }
    M.ready(G.vs.matchId).then((ok)=>{ if (!ok) vsReadySent = false; });
  });

  /* --- VERSUS wiring --- */
  let vsWager = 0;
  let vsMode = "speed";
  const VS_SUBS = {
    speed: "Best of 5. Same pieces, 60 seconds a round —\nhighest score takes it. Winner takes the pot.",
    turf: "Turn-based on one shared board. Own a whole\nrow to win — 10 seconds a move, best of 3.",
  };
  for (const mb of Array.from(document.querySelectorAll("#vsModeRow .vsmode"))){
    wireOnce(mb, ()=>{
      vsMode = mb.dataset.mode === "turf" ? "turf" : "speed";
      for (const c of document.querySelectorAll("#vsModeRow .vsmode")) c.classList.toggle("sel", c === mb);
      const sub = vsEl("vsLobbySub"); if (sub) sub.textContent = VS_SUBS[vsMode];
    });
  }
  const vsChips = Array.from(document.querySelectorAll("#vsWagerRow .vschip"));
  for (const chip of vsChips){
    wireOnce(chip, ()=>{
      vsWager = parseInt(chip.dataset.wager || "0", 10) || 0;
      for (const c of vsChips) c.classList.toggle("sel", c === chip);
    });
  }
  wireOnce(document.getElementById("btnVersus"), ()=>{
    Sfx.init();
    const M = MATCH();
    if (!M || !M.authed()){
      const sub = vsEl("vsLobbySub");
      vsEl("vsOv").classList.remove("hidden");
      if (sub) sub.textContent = "Sign in (top right) to battle — versus needs an account so the pot has somewhere to go.";
      const f = document.getElementById("btnVsFind"); if (f) f.classList.add("hidden");
      return;
    }
    const f = document.getElementById("btnVsFind"); if (f) f.classList.remove("hidden");
    M.start();
    vsEl("vsOv").classList.remove("hidden");
  });
  function doVsQueue(){
    const M = MATCH(); if (!M) return;
    const lob = vsEl("vsOv"); if (lob) lob.classList.remove("hidden");
    const st = vsEl("vsStatus");
    st.classList.remove("hidden");
    st.textContent = "SNIFFING OUT A VICTIM…";
    M.queue(vsWager, vsMode).then((r)=>{
      if (!r) return;
      if (r.state === "error"){ st.textContent = (r.error || "Couldn't queue.").toUpperCase(); return; }
      // matched instantly or queued — the watcher below reacts to the poll
    });
    if (!vsDriver) vsDriver = setInterval(vsLobbyWatch, 500);
  }
  wireOnce(document.getElementById("btnVsFind"), ()=>{
    Sfx.init();
    // DOOPIE WORLD rides versus too (tester report: the room never showed in
    // a match). First-timers get the branded card on THIS tap — its YES
    // carries camera + motion, then queues. Returning opt-ins reacquire
    // during matchmaking, so the room is live before round 1; if the browser
    // will re-prompt, the card fronts it (never a bare sheet over the lobby).
    try{
      const isTouch = window.matchMedia && window.matchMedia("(pointer:coarse)").matches;
      if (false && !pref("doopieWorld") && isTouch && camSupported()){ // camera world is opt-in from the menu chip only
        vsEl("vsOv").classList.add("hidden"); // the card renders under vsOv otherwise
        worldPendingFn = doVsQueue;
        showWorldAsk("first");
        return;
      }
      if (pref("doopieCam") === "on" && !camStream && camSupported()){
        queryCamPermission().then((state)=>{
          if (disposed) return;
          if (state === "prompt" && !camCardShown){
            camCardShown = true;
            vsEl("vsOv").classList.add("hidden");
            worldPendingFn = doVsQueue;
            showWorldAsk("resume");
            return;
          }
          if (state === "granted") void startCamera(); // warms up during the search
          enableGyroQuiet();
          doVsQueue();
        });
        return;
      }
    }catch(_){ }
    enableGyroQuiet();
    doVsQueue();
  });
  function vsLobbyWatch(){
    const M = MATCH(); if (!M) return;
    const L = M.latest();
    if (L && L.state === "queued" && L.counts){
      // Make the wait legible: hunting animation + who's actually out there.
      const st = vsEl("vsStatus");
      if (st && !st.classList.contains("hidden")){
        const dots = ".".repeat(1 + (Math.floor(Date.now()/450) % 3));
        const w = L.counts.waiting, s = L.counts.smashing;
        st.textContent = "SNIFFING OUT A VICTIM" + dots + "  " +
          (w > 0 ? w + " waiting at this stake" : "queue's empty right now") +
          " · " + s + " smashing";
      }
      return;
    }
    if (L && (L.state === "active" || (L.state === "over" && L.result && L.result.id !== vsAckedResult))){
      clearInterval(vsDriver); vsDriver = 0;
      vsEnterMatch();
    }
  }
  wireOnce(document.getElementById("btnVsClose"), ()=>{
    const M = MATCH();
    clearInterval(vsDriver); vsDriver = 0;
    const st = vsEl("vsStatus"); if (st){ st.classList.add("hidden"); }
    vsEl("vsOv").classList.add("hidden");
    if (M && !G.vs){
      // BACK can race a pairing commit: cancel() re-polls, and if an opponent
      // was locked in during the tap, fall INTO the match instead of leaving
      // a phantom game the opponent would farm for forfeits.
      M.cancel().then(()=>{
        if (disposed || G.vs) return;
        const L = M.latest();
        if (L && L.state === "active") vsEnterMatch();
        else M.stop();
      });
    }
  });
  wireOnce(document.getElementById("btnVsKeep"), ()=>vsToggleQuitSheetOff());
  wireOnce(document.getElementById("btnVsConcede"), ()=>{
    const M = MATCH();
    const mid = (G.vs && G.vs.matchId) || (turfc && turfc.matchId);
    if (M && mid) M.concede(mid);
    vsToggleQuitSheetOff();
    // The next poll returns state 'over' → the defeat card renders the truth.
  });
  wireOnce(document.getElementById("btnVsDone"), ()=>{
    if (G.vs && G.vs.resultId) vsAckedResult = G.vs.resultId;
    vsExit();
  });

  // HOW TO modal: opens over the pause card; closes back to it.
  const _howto = document.getElementById("btnHowTo");
  if (_howto) _howto.addEventListener("click", ()=>{ const c=document.getElementById("controlsOv"); if(c) c.classList.remove("hidden"); });
  const _howClose = document.getElementById("btnCloseHowTo");
  if (_howClose) _howClose.addEventListener("click", ()=>{ const c=document.getElementById("controlsOv"); if(c) c.classList.add("hidden"); });
  document.getElementById("btnPause").addEventListener("click", ()=>{ if(G.state==="play"||G.state==="paused") togglePause(); });
  const btnMute = document.getElementById("btnMute");
  // On-brand speaker glyphs (mirror IconSound/IconMuted in components/icons.tsx).
  // Set via innerHTML on the BUTTON element (not e.target — a click can land on an
  // inner <path>, and textContent would wipe the SVG).
  const SND_ON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.8 5.5a9 9 0 0 1 0 13"></path></svg>';
  const SND_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="16.5" y1="9" x2="22" y2="15"></line><line x1="22" y1="9" x2="16.5" y2="15"></line></svg>';
  btnMute.addEventListener("click", ()=>{
    Sfx.on=!Sfx.on; btnMute.innerHTML = Sfx.on ? SND_ON : SND_OFF;
    try{ localStorage.setItem("doopieMuted", Sfx.on ? "0" : "1"); }catch(_){}
    if (!Sfx.on) Music.stop(); else if (G.state==="play") Music.start();
  });
  const onVisibility = ()=>{
    // Versus: no auto-pause — the round clock is server-absolute and keeps
    // running; hiding the tab just costs play time (the deadline forfeits a
    // vanished opponent, so nobody waits forever).
    if (document.hidden){ if (G.state==="play" && !G.vs) togglePause(); return; }
    if (G.vs) vsWakeLock(true); // the OS drops wake locks on hide — re-arm
    // Back to foreground: iOS may have suspended/interrupted the AudioContext
    // while hidden — nudge it awake so the RESUME tap gets working audio.
    // (Harmless if the browser wants a fresh gesture; Sfx.init on the next tap
    // covers that case too.)
    try{ if (Sfx.ctx && Sfx.ctx.state!=="running") Sfx.ctx.resume(); }catch(e){}
  };
  document.addEventListener("visibilitychange", onVisibility);

  const onResize = ()=>{ layout(); drawSide(); };
  window.addEventListener("resize", onResize);
  // iOS Safari settles its browser chrome (and thus #mid's height) AFTER load
  // and doesn't always fire window.resize for it — a stale measurement made
  // the board paint OVER the controls. Watch everything that can change the
  // board's box: the visual viewport, #mid itself, plus two settle timers.
  if (window.visualViewport) window.visualViewport.addEventListener("resize", onResize);
  const midRO = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(()=>onResize()) : null;
  if (midRO){ try{ midRO.observe(document.getElementById("mid")); }catch(_){} }
  const settle1 = setTimeout(onResize, 400), settle2 = setTimeout(onResize, 1400);

  // Page is going away (close / navigate / bfcache): report the active run as
  // abandoned with a MINIMAL log (just the power-up events — keepalive bodies
  // are size-capped) so the server can settle promptly. Use-time consumption
  // already covered the spends; this is belt-and-braces + table hygiene.
  const abandonActiveRun = (beacon)=>{
    if (!(recorder.active && activeRun && window.__DOOPIE_RUN && typeof window.__DOOPIE_RUN.abandon === "function")) return;
    try{
      const log = beacon ? recorder.log.filter(e=>e.a==="powerup") : recorder.log.slice();
      window.__DOOPIE_RUN.abandon({ runId:activeRun.runId, runToken:activeRun.runToken, log, beacon:!!beacon });
    }catch(e){}
    recorder.active = false; activeRun = null;
  };
  const onPageHide = ()=>{ abandonActiveRun(true); };
  window.addEventListener("pagehide", onPageHide);
  // bfcache restore after a pagehide-abandon: the run was already settled
  // server-side and the bridge disarmed — this game can't submit anymore.
  // Quit to the menu instead of letting the player finish a zombie game
  // whose score would silently vanish.
  const onPageShow = (e)=>{
    if (e && e.persisted && (G.state==="play" || G.state==="paused" || G.state==="bonus" || G.state==="clearing") && !activeRun && recorder && !recorder.active){
      quitGame();
    }
  };
  window.addEventListener("pageshow", onPageShow);

  /* ============================================================ BOOT */
  try{ G.best = parseInt(localStorage.getItem("doopieBest")||"0",10)||0; }catch(e){}
  // restore the persisted sound preference (Sfx.on gates both SFX + music start)
  try{ if (localStorage.getItem("doopieMuted")==="1"){ Sfx.on=false; } }catch(e){}
  btnMute.innerHTML = Sfx.on ? SND_ON : SND_OFF; // reflect state with the on-brand glyph
  // DOOPIE WORLD boot: deliberately NO camera call here — iOS Safari can
  // re-show the native permission prompt every session, and a boot-time
  // acquire threw that dialog over the intro video. Both the first-timer ask
  // and the returning-opt-in resume ride the SMASH! tap (see startGame).
  updateWorldUi();
  const logoSrc = wordmarkDataUrl();
  document.getElementById("logoImg").src = logoSrc;
  document.getElementById("menuLogo").src = logoSrc;

  loadArt().then(()=>{
    if (disposed) return;
    buildMenuArt();
    layout(); drawSide();
    G.lastT = performance.now();
    rafId = requestAnimationFrame(loop);
  });

  // test hook (parity with the original; handy for unit/replay checks)
  window.__DS = {G, STATES, KICKS_I, KICKS_JLSTZ, collides, spawn, tryMove, tryRotate, hardDrop, lockPiece, finishClear, reset, emptyGrid, gravityMs:()=>gravityMs(G.level), recorder, usePowerup,
    // Rebuild piece art after the signed-in wallet's Friends load (lib/rf/pieceArt).
    refreshArt: ()=>buildArt(),
    // Whether the current game is a server-sanctioned (ranked) run. The
    // power-up tray hides for unranked games — spends couldn't settle.
    ranked: ()=>!!activeRun,
    // build the same summary the client submits (for replay cross-checks)
    summary:()=>({ locks:recorder.locks.slice(), softDropCells:recorder.soft, hardDropCells:recorder.hard, durationMs:Math.round(performance.now()-recorder.t0) }) };

  /* ---------- teardown (React unmount / Strict Mode remount) ---------- */
  return function cleanup(){
    disposed = true;
    // Client-side navigation away mid-run (e.g. to /shop) unmounts the game
    // without a pagehide — settle the run so nothing is left dangling open.
    abandonActiveRun(false);
    if (rafId) cancelAnimationFrame(rafId);
    if (smashVarsRaf) cancelAnimationFrame(smashVarsRaf); // layout()'s deferred var refresh must not outlive the engine
    clearInterval(dasTimer);
    clearTimeout(bonusEndTimer); // a reveal-phase endBonus must not fire on a dead engine
    killBonusOverlay();
    stopCamera(); // release the camera fully — no lingering "in use" indicator
    Music.stop();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("resize", onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener("resize", onResize);
    if (midRO){ try{ midRO.disconnect(); }catch(_){} }
    clearTimeout(settle1); clearTimeout(settle2); clearTimeout(camWatchdog); clearTimeout(gyroQuietTimer);
    clearInterval(vsDriver); clearTimeout(vsResumeTimer); vsWakeLock(false);
    window.removeEventListener("resize", onTurfResize);
    try{ if (hapticSwitch) hapticSwitch.remove(); }catch(_){}
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    if (orientBound) window.removeEventListener("deviceorientation", onOrient);
    document.removeEventListener("visibilitychange", onVisibility);
    try{ if (Sfx.ctx && Sfx.ctx.close) Sfx.ctx.close(); Sfx.ctx = null; }catch(e){}
    try{ delete window.__DS; }catch(e){}
  };
}

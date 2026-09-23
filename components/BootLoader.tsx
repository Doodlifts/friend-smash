"use client";

/* components/BootLoader.tsx — fades out the boot splash once the game is ready.

   The splash markup itself lives in app/page.tsx so it's SERVER-RENDERED and
   paints on the very first frame (before this bundle parses). This controller
   just removes it: it waits for the engine to boot (window.__DS is set at the
   end of startEngine), keeps it up for a short minimum so it never flickers,
   and force-hides after a max timeout so it can never get stuck. */

import { useEffect } from "react";

const MIN_MS = 550; // don't flash if the engine boots instantly
const MAX_MS = 6000; // safety: never let the splash get stuck

export default function BootLoader() {
  useEffect(() => {
    const el = document.getElementById("bootLoader");
    if (!el) return;

    const start = Date.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Only toggle a CSS class — never el.remove(). The splash node is rendered
      // by React (app/page.tsx). Manually removing it makes React crash with
      // "removeChild … is not a child of this node" when the home route later
      // unmounts during a client-side navigation (opening /shop, /leaderboard,
      // etc). `.hide` is opacity:0 + pointer-events:none, so the node stays
      // React-managed, invisible, and click-through.
      el.classList.add("hide");
    };

    const ready = () => Boolean((window as { __DS?: unknown }).__DS);
    const poll = window.setInterval(() => {
      if (ready()) {
        window.clearInterval(poll);
        window.setTimeout(finish, Math.max(0, MIN_MS - (Date.now() - start)));
      }
    }, 80);
    const max = window.setTimeout(() => {
      window.clearInterval(poll);
      finish();
    }, MAX_MS);

    return () => {
      window.clearInterval(poll);
      window.clearTimeout(max);
    };
  }, []);

  return null;
}

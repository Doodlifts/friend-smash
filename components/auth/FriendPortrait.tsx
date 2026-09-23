"use client";

/* FriendPortrait — draws a Friend's canonical 16×16 one-bit sprite (read
   on-chain via FriendSDK's createFriendReader) as crisp pixels on a canvas. */

import { useEffect, useRef, useState } from "react";
import { createFriendReader, spriteFrame, type GenerationSprites } from "@rarefriends/friendsdk/sprites";

let reader: ReturnType<typeof createFriendReader> | null = null;
export function friendReader() {
  if (!reader) reader = createFriendReader();
  return reader;
}

/** Paint a 16-row "#"/"." bitmap into a 2D context. */
export function paintRows(
  ctx: CanvasRenderingContext2D,
  rows: readonly string[],
  x: number,
  y: number,
  px: number,
  ink: string,
) {
  ctx.fillStyle = ink;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) if (row[c] === "#") ctx.fillRect(x + c * px, y + r * px, px, px);
  }
}

export default function FriendPortrait({
  friendId,
  size = 64,
  ink = "#111",
  bg = "transparent",
  animate = false,
  className,
}: {
  friendId: string | bigint;
  size?: number;
  ink?: string;
  bg?: string;
  animate?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [sprites, setSprites] = useState<GenerationSprites | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSprites(null);
    setFailed(false);
    friendReader()
      .read(BigInt(friendId))
      .then((s) => alive && setSprites(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [friendId]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !sprites) return;
    const ctx = cv.getContext("2d")!;
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const draw = () => {
      ctx.clearRect(0, 0, 16, 16);
      if (bg !== "transparent") {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, 16, 16);
      }
      paintRows(ctx, spriteFrame(sprites, "down", false, frame).frame.rows, 0, 0, 1, ink);
    };
    draw();
    if (!animate || reduce) return;
    const id = window.setInterval(() => {
      frame = (frame + 1) % 8;
      draw();
    }, 180);
    return () => window.clearInterval(id);
  }, [sprites, animate, ink, bg]);

  return (
    <canvas
      ref={ref}
      width={16}
      height={16}
      className={className}
      aria-label={`Rare Friend #${friendId}`}
      role="img"
      style={{
        width: size,
        height: size,
        imageRendering: "pixelated",
        opacity: sprites ? 1 : failed ? 0.25 : 0.5,
      }}
    />
  );
}

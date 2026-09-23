/* lib/clientIp.ts — best-effort client IP from proxy headers (Vercel sets
   x-forwarded-for). Used for per-IP rate limiting; never trusted for auth. */

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

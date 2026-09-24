// Baseline security headers applied to every response. Deliberately conservative:
// - X-Frame-Options/CSP frame-ancestors stop OUR pages being framed by other
//   origins (clickjacking protection). This only governs who may frame us; it
//   does NOT restrict us from embedding child iframes.
// - We do NOT yet set a script/style CSP: the game uses many inline styles +
//   dangerouslySetInnerHTML for the SVG background and Google Fonts load
//   externally — a strict CSP needs testing first. frame-ancestors is safe now.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // camera=(self): the CAMERA WORLD backdrop calls getUserMedia from our
  // own origin — an empty allowlist here makes Chromium reject it instantly
  // (feature silently dead on Android; iOS Safari happened to be lenient).
  // Mic and geolocation stay fully blocked — the game never uses them.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  experimental: {
    // Embedded Postgres (WASM) must load from node_modules, not the bundle.
    serverComponentsExternalPackages: ["@electric-sql/pglite"],
    // Every API route may open the DB, which applies db/schema.sql on first use.
    outputFileTracingIncludes: { "/api/**/*": ["./db/schema.sql", "./node_modules/@electric-sql/pglite/dist/**/*"] },
  },
};

export default nextConfig;

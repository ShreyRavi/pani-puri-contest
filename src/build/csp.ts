// One Content-Security-Policy for every way the app is served: vite preview (the stall laptop and the
// e2e run) and Vercel (vercel.json, kept equal by test/review-fixes.test.ts). connect-src 'self' is
// what makes "no video ever leaves the laptop" a browser rule, not just a code convention.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

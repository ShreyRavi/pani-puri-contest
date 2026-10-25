// One Content-Security-Policy for every way the app is served: vite preview (the stall laptop and the
// e2e run) and Vercel (vercel.json, kept equal by test/review-fixes.test.ts). connect-src 'self' limits
// network requests (fetch, XHR, WebSocket, beacons) to this origin and form-action 'none' blocks form
// posts, so camera frames cannot be sent elsewhere by any script the page loads.
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
  "form-action 'none'",
].join('; ');

/** Every header both hosts send (vite preview on the stall laptop, vercel.json online). */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

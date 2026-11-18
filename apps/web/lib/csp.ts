/**
 * The Content-Security-Policy, applied by Clerk's middleware on every request
 * that reaches the proxy, with a fresh nonce each time.
 *
 * `strict` means `script-src 'nonce-…' 'strict-dynamic'`: only scripts the
 * server rendered with this request's nonce run, and what they load. Browsers
 * that understand `strict-dynamic` ignore host lists and `'unsafe-inline'` in
 * `script-src`, so an injected `<script>` does not run. Next.js reads the
 * nonce from the request and puts it on its own scripts; `<ClerkProvider
 * dynamic>` does the same for Clerk's.
 *
 * Clerk's defaults add its own hosts (and some for features this app does
 * not use) to connect-src, frame-src and img-src. The directives below add
 * what Clerk leaves out.
 */
export const contentSecurityPolicy = {
  strict: true,
  directives: {
    // Never framed: clickjacking.
    "frame-ancestors": ["none"],
    // A <base> tag could redirect every relative URL.
    "base-uri": ["self"],
    // No plugins.
    "object-src": ["none"],
  },
} as const;

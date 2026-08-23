import crypto from "node:crypto";
import fs from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.ts";
import { forbidden } from "./http.ts";

/**
 * Hashes of the inline <script> blocks in the built index.html, so the CSP can
 * stay free of 'unsafe-inline' while the pre-paint theme script keeps working.
 */
export function inlineScriptHashes(indexHtmlPath: string): string[] {
  try {
    const html = fs.readFileSync(indexHtmlPath, "utf8");
    const hashes: string[] = [];
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const digest = crypto.createHash("sha256").update(match[1], "utf8").digest("base64");
      hashes.push(`'sha256-${digest}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}

export function securityHeaders(scriptHashes: string[]) {
  const scriptSrc = ["'self'", ...scriptHashes].join(" ");
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // React writes style attributes and Tailwind injects a stylesheet; neither
    // can execute script, and script-src stays strict.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // 'self' covers same-origin ws:/wss: for the Socket.IO connection.
    "connect-src 'self'",
    // srcObject streams are not URL-fetched, but blob: keeps recorded or
    // object-URL audio working without loosening anything else.
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ].join("; ");

  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    // Calls need the microphone and, for video calls, the camera. `(self)` is
    // the narrowest grant that still works: our own origin only, never an
    // embedded frame. An empty allowlist blocks getUserMedia even for us.
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), interest-cohort=()");
    if (config.isProd) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOf(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Same-origin enforcement for state-changing requests.
 *
 * SameSite=Lax already stops a cross-site POST from carrying the session
 * cookie, but that is one browser-side control; this is the server-side one.
 * Browsers always attach Origin to POST/PATCH/DELETE, so a mismatch is a
 * forged request. A missing Origin means a non-browser client (curl, the test
 * suite), which cannot be induced to send a victim's cookies.
 *
 * The expected origin is derived from the request's own Host, so a rotating
 * TryCloudflare hostname needs no configuration.
 */
export function sameOriginOnly(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get("origin");
  if (!origin) return next();

  const expected = new Set<string>();
  const host = req.get("host");
  if (host) expected.add(host.toLowerCase());
  if (config.publicOrigin) expected.add(hostOf(config.publicOrigin));

  if (!expected.has(hostOf(origin))) {
    return next(forbidden("Cross-origin request blocked."));
  }
  next();
}

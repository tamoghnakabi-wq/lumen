import crypto from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.ts";
import { get, run } from "../db.ts";
import { newToken } from "./ids.ts";
import { unauthorized } from "./http.ts";
import type { UserRow } from "./shape.ts";

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
export const SESSION_COOKIE = "lumen_session";

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

/**
 * Session and reset tokens are stored as a SHA-256 digest. The token itself has
 * 256 bits of entropy, so a fast hash is appropriate here (unlike a password) —
 * the point is that a leaked database contains nothing that can be replayed.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSession(userId: string, userAgent = ""): string {
  const token = newToken();
  const now = Date.now();
  run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent)
     VALUES (?,?,?,?,?,?)`,
    hashToken(token),
    userId,
    now,
    now + config.sessionTtlMs,
    now,
    userAgent.slice(0, 200),
  );
  return token;
}

export function destroySession(token: string) {
  run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

export function destroyAllSessions(userId: string, exceptToken?: string) {
  if (exceptToken) {
    run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", userId, hashToken(exceptToken));
  } else {
    run("DELETE FROM sessions WHERE user_id = ?", userId);
  }
}

/** Rolling write of last_used_at, throttled so a busy session is not a write per request. */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export function userForToken(token: string): UserRow | undefined {
  const tokenHash = hashToken(token);
  const row = get<UserRow & { expires_at: number; last_used_at: number }>(
    `SELECT u.*, s.expires_at, s.last_used_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    tokenHash,
  );
  if (!row) return undefined;

  const now = Date.now();
  // Absolute expiry, plus an idle window so an abandoned session stops working.
  if (row.expires_at < now || (row.last_used_at > 0 && row.last_used_at < now - config.sessionIdleMs)) {
    run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
    return undefined;
  }
  if (row.last_used_at < now - LAST_USED_THROTTLE_MS) {
    run("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?", now, tokenHash);
  }
  return row;
}

/** Removes expired and long-idle sessions plus spent reset tokens. */
export function pruneSessions(): number {
  const now = Date.now();
  const sessions = run(
    "DELETE FROM sessions WHERE expires_at < ? OR (last_used_at > 0 AND last_used_at < ?)",
    now,
    now - config.sessionIdleMs,
  );
  const resets = run("DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL", now);
  return Number(sessions.changes ?? 0) + Number(resets.changes ?? 0);
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Secure whenever the request came over HTTPS, and unconditionally in production.
    secure: config.forceSecureCookies || req.secure,
    path: "/",
  };
}

export function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: config.sessionTtlMs });
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      sessionToken?: string;
    }
  }
}

/**
 * Presence writes are throttled per user. The map is bounded so a flood of
 * distinct sessions cannot grow it without limit.
 */
const lastSeenWrites = new Map<string, number>();
const LAST_SEEN_MAX_KEYS = 10_000;

function touchLastSeen(userId: string) {
  const now = Date.now();
  if ((lastSeenWrites.get(userId) ?? 0) > now - 60_000) return;
  if (lastSeenWrites.size > LAST_SEEN_MAX_KEYS) lastSeenWrites.clear();
  lastSeenWrites.set(userId, now);
  run("UPDATE users SET last_seen_at = ? WHERE id = ?", now, userId);
}

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token.length >= 20 && token.length <= 200) {
    const user = userForToken(token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
      touchLastSeen(user.id);
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

/** Non-null user accessor for handlers mounted behind requireAuth. */
export function me(req: Request): UserRow {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * A recognisable name for a session, from its user agent.
 *
 * Deliberately coarse: enough to tell "my phone" from "not my phone", without
 * keeping a fingerprint of every device that ever signed in.
 */
export function describeUserAgent(ua: string): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const platform =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return platform ? `${browser} on ${platform}` : browser;
}

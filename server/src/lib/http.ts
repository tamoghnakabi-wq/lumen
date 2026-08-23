import type { NextFunction, Request, Response } from "express";
import { ZodError, type TypeOf, type ZodTypeAny } from "zod";
import { config } from "../config.ts";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = "error", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "You need to sign in.") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "You do not have access to this.") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Not found.") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const tooLarge = (msg: string) => new HttpError(413, msg, "file_too_large");
export const tooMany = (msg = "Too many requests. Try again shortly.") => new HttpError(429, msg, "rate_limited");

/** Wraps an async handler so rejected promises reach the error middleware. */
export function h<T extends Request>(fn: (req: T, res: Response, next: NextFunction) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

/** Validate and return typed body/query, converting Zod issues into a 400. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): TypeOf<S> {
  try {
    return schema.parse(data) as TypeOf<S>;
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      if (!first) throw badRequest("Invalid input.");
      // Custom messages are already written for humans; only Zod's own terse
      // defaults ("Required", "Expected string…") need the field name attached.
      const generic = /^(required|expected|invalid|string must|number must)/i.test(first.message);
      const field = first.path.join(".");
      throw badRequest(
        generic && field ? `${field}: ${first.message}` : first.message,
        err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    throw err;
  }
}

/**
 * Fixed-window rate limiter held in memory. The process is single, so this is
 * accurate; it resets on restart, which is acceptable for abuse control.
 *
 * The map is bounded because keys include attacker-controlled values (a login
 * identifier, for instance) — without a cap, spraying unique keys would be a
 * memory-exhaustion attack in its own right.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 50_000;

function evictIfNeeded() {
  if (buckets.size <= MAX_BUCKETS) return;
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt < now) buckets.delete(key);
  // Still oversized: drop the oldest insertions (Map preserves insertion order).
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/** Consumes `cost` from a bucket, throwing 429 once the window budget is gone. */
export function rateLimit(key: string, limit: number, windowMs: number, cost = 1) {
  if (!config.rateLimitsEnabled) return;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    evictIfNeeded();
    buckets.set(key, { count: cost, resetAt: now + windowMs });
    return;
  }
  bucket.count += cost;
  if (bucket.count > limit) {
    throw new HttpError(429, "Too many requests. Try again shortly.", "rate_limited", {
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    });
  }
}

/** Checks a bucket without consuming from it. */
export function checkRateLimit(key: string, limit: number) {
  if (!config.rateLimitsEnabled) return;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < Date.now()) return;
  if (bucket.count >= limit) {
    throw new HttpError(429, "Too many attempts. Try again shortly.", "rate_limited", {
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)),
    });
  }
}

/** Forgets a bucket — used to wipe the failure count after a correct password. */
export function clearRateLimit(key: string) {
  buckets.delete(key);
}

export function resetRateLimits() {
  buckets.clear();
}

/**
 * Identifies the caller for rate limiting. Signed-in users are keyed by id so
 * that several people behind one NAT are not throttled as a group; everyone
 * else falls back to the IP, which is only trustworthy because `trust proxy`
 * is restricted to the loopback hop.
 */
export function clientKey(req: Request): string {
  return req.user ? `u:${req.user.id}` : `ip:${req.ip ?? "unknown"}`;
}

export function ipKey(req: Request): string {
  return `ip:${req.ip ?? "unknown"}`;
}

/** Route middleware wrapper: `limit({ name: "post:create", max: 20, windowMs: 3600_000 })`. */
export function limit(options: { name: string; max: number; windowMs: number; by?: "client" | "ip" }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const who = options.by === "ip" ? ipKey(req) : clientKey(req);
      rateLimit(`${options.name}:${who}`, options.max, options.windowMs);
      next();
    } catch (err) {
      next(err);
    }
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt < now) buckets.delete(key);
}, 60_000).unref();

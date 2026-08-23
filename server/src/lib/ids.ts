import crypto from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Sequence within the current millisecond, so ids stay ordered inside one tick. */
let lastMs = 0;
let seq = 0;

/**
 * Time-sortable, URL-safe id: 8 chars of base36 millisecond timestamp, 2 chars
 * of sequence, then random padding. Sorting by id is the same as sorting by
 * creation time, which keeps keyset pagination simple.
 *
 * The sequence is what makes that claim true *within* a millisecond. Without it
 * two rows written in the same tick fall back to comparing random characters, so
 * a burst of comments came back in a different order on every read.
 */
export function newId(randomLen = 6): string {
  const now = Date.now();
  if (now === lastMs) {
    // 1296 ids per millisecond before it wraps; past that the timestamp has
    // almost certainly moved on, and the random suffix still separates them.
    seq = (seq + 1) % 1296;
  } else {
    lastMs = now;
    seq = 0;
  }
  const ts = now.toString(36).padStart(8, "0");
  const counter = seq.toString(36).padStart(2, "0");
  const bytes = crypto.randomBytes(randomLen);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 36];
  return ts + counter + rand;
}

/**
 * Media files are served from static URLs, so their ids carry extra entropy:
 * an id that cannot be guessed is what keeps a private account's images private.
 */
export function newMediaId(): string {
  return newId(16);
}

/** Opaque high-entropy token for sessions and password resets. */
export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

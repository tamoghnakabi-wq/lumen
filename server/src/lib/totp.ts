import crypto from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238) over HMAC-SHA1, which is what every
 * authenticator app implements. Built on node:crypto rather than a package: the
 * algorithm is thirty lines, and a dependency in the login path is a dependency
 * that can take the login path down.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/**
 * How many steps either side of now are accepted. One covers ordinary clock
 * drift between the phone and the server; more than that widens the window an
 * attacker has to guess a code in.
 */
export const DRIFT_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The counter value for a moment in time. */
export function stepFor(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

export function codeFor(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Checks a code against the accepted window and returns the step it matched, or
 * null. The caller must record that step and refuse it again: without that, a
 * code shoulder-surfed or replayed within its 30 seconds still works.
 */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): number | null {
  const cleaned = code.replace(/\D/g, "");
  if (cleaned.length !== DIGITS) return null;
  const now = stepFor(atMs);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset++) {
    const step = now + offset;
    const expected = codeFor(secret, step);
    // Constant-time compare so a wrong code cannot be narrowed down by timing.
    if (
      expected.length === cleaned.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))
    ) {
      return step;
    }
  }
  return null;
}

/** The URI an authenticator app expects behind the QR code. */
export function otpauthUri(secret: string, account: string, issuer = "Lumen"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes for when the phone is lost. Stored hashed, like any other
 * credential, and each one works once.
 */
export function newRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(crypto.randomBytes(10)).slice(0, 10).toLowerCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}

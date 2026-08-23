import qrcode from "qrcode-generator";
import { get, run, tx } from "../db.ts";
import { unauthorized } from "./http.ts";
import { hashToken } from "./auth.ts";
import { newToken } from "./ids.ts";
import {
  hashRecoveryCode,
  newRecoveryCodes,
  otpauthUri,
  verifyTotp,
} from "./totp.ts";

/** A challenge is a half-finished login, so it expires quickly. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type TotpRow = {
  user_id: string;
  secret: string;
  created_at: number;
  confirmed_at: number | null;
  last_step: number;
};

export function totpFor(userId: string): TotpRow | undefined {
  return get<TotpRow>("SELECT * FROM user_totp WHERE user_id = ?", userId);
}

/** Only a confirmed enrolment gates a login; a half-finished one must not. */
export function twoFactorEnabled(userId: string): boolean {
  return !!get("SELECT 1 AS x FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL", userId);
}

export function recoveryCodesLeft(userId: string): number {
  return (
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL",
      userId,
    )?.n ?? 0
  );
}

/** Replaces the whole set; returns the plaintext once, which is the only time it exists. */
export function issueRecoveryCodes(userId: string): string[] {
  const codes = newRecoveryCodes();
  const now = Date.now();
  tx(() => {
    run("DELETE FROM totp_recovery_codes WHERE user_id = ?", userId);
    for (const code of codes) {
      run(
        "INSERT INTO totp_recovery_codes (user_id, code_hash, used_at, created_at) VALUES (?,?,NULL,?)",
        userId,
        hashRecoveryCode(code),
        now,
      );
    }
  });
  return codes;
}

/**
 * Accepts either a six-digit code or a recovery code, and consumes whichever it
 * was. Returns false rather than throwing so the caller owns the rate limiting.
 */
export function consumeSecondFactor(row: TotpRow, submitted: string): boolean {
  const step = verifyTotp(row.secret, submitted);
  if (step !== null) {
    // A code is valid for its whole 30-second step, so without this the same
    // digits work twice — enough for anyone who watched them being typed.
    if (step <= row.last_step) return false;
    run("UPDATE user_totp SET last_step = ? WHERE user_id = ?", step, row.user_id);
    return true;
  }

  const hash = hashRecoveryCode(submitted);
  const recovery = get<{ code_hash: string }>(
    "SELECT code_hash FROM totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    row.user_id,
    hash,
  );
  if (!recovery) return false;
  run(
    "UPDATE totp_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?",
    Date.now(),
    row.user_id,
    hash,
  );
  return true;
}

/* ------------------------------------------------------------- challenges */

export function createChallenge(userId: string, userAgent: string): string {
  const token = newToken();
  const now = Date.now();
  run("DELETE FROM totp_challenges WHERE user_id = ? OR expires_at < ?", userId, now);
  run(
    "INSERT INTO totp_challenges (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)",
    hashToken(token),
    userId,
    now,
    now + CHALLENGE_TTL_MS,
    userAgent.slice(0, 200),
  );
  return token;
}

export function takeChallenge(token: string): string {
  const hash = hashToken(token);
  const row = get<{ user_id: string; expires_at: number }>(
    "SELECT user_id, expires_at FROM totp_challenges WHERE token_hash = ?",
    hash,
  );
  if (!row || row.expires_at < Date.now()) {
    run("DELETE FROM totp_challenges WHERE token_hash = ?", hash);
    throw unauthorized("That sign-in attempt has expired. Start again.");
  }
  return row.user_id;
}

export function clearChallenge(token: string) {
  run("DELETE FROM totp_challenges WHERE token_hash = ?", hashToken(token));
}

/** Removes 2FA entirely: secret, recovery codes and any pending challenge. */
export function disableTwoFactor(userId: string) {
  tx(() => {
    run("DELETE FROM user_totp WHERE user_id = ?", userId);
    run("DELETE FROM totp_recovery_codes WHERE user_id = ?", userId);
    run("DELETE FROM totp_challenges WHERE user_id = ?", userId);
  });
}

/* ------------------------------------------------------------------- QR */

/**
 * The enrolment QR, as an inline SVG.
 *
 * Rendered here rather than shipped to the browser as a library: the secret is
 * already in this response, and a server-drawn image keeps the client bundle and
 * the CSP untouched (`img-src` already allows data:).
 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const size = count + quiet * 2;

  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Two-factor setup code">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}

export function enrolmentPayload(secret: string, account: string) {
  const uri = otpauthUri(secret, account);
  return {
    secret,
    uri,
    qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(uri), "utf8").toString("base64")}`,
  };
}


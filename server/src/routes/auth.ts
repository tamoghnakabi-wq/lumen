import { Router } from "express";
import { z } from "zod";
import { usernameSchema } from "../lib/username.ts";
import { config } from "../config.ts";
import { all, get, run, tx } from "../db.ts";
import {
  badRequest,
  checkRateLimit,
  clearRateLimit,
  conflict,
  h,
  ipKey,
  notFound,
  parse,
  rateLimit,
  unauthorized,
} from "../lib/http.ts";
import { newId, newToken } from "../lib/ids.ts";
import { newTotpSecret } from "../lib/totp.ts";
import {
  clearChallenge,
  consumeSecondFactor,
  createChallenge,
  disableTwoFactor,
  enrolmentPayload,
  issueRecoveryCodes,
  recoveryCodesLeft,
  takeChallenge,
  totpFor,
  twoFactorEnabled,
} from "../lib/twofactor.ts";
import {
  clearSessionCookie,
  createSession,
  destroyAllSessions,
  describeUserAgent,
  destroySession,
  hashPassword,
  hashToken,
  me,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from "../lib/auth.ts";
import { log } from "../lib/log.ts";
import { sendPasswordReset } from "../lib/mailer.ts";
import { userProfile, type UserRow } from "../lib/shape.ts";

export const authRouter = Router();



const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(200, "Password must be 200 characters or fewer.");

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(200);

/**
 * A short list of passwords that show up in every credential dump. Not a
 * substitute for a breach corpus, but it removes the worst choices for free.
 */
const WEAK_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwertyui", "qwerty123", "letmein1", "iloveyou", "sunshine", "princess",
  "football", "baseball", "welcome1", "admin123", "abc12345", "passw0rd",
  "trustno1", "superman", "starwars", "michael1", "monkey12", "dragon12",
]);

function rejectWeakPassword(password: string, username: string, email: string) {
  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) {
    throw badRequest("That password is too common. Please choose another.");
  }
  if (username && lower.includes(username.toLowerCase())) {
    throw badRequest("Your password cannot contain your username.");
  }
  const localPart = email.split("@")[0]?.toLowerCase();
  if (localPart && localPart.length > 3 && lower.includes(localPart)) {
    throw badRequest("Your password cannot contain your email address.");
  }
}

authRouter.post(
  "/signup",
  h(async (req, res) => {
    // Per-IP account creation ceiling; the loopback-only trust proxy setting is
    // what makes req.ip meaningful here.
    rateLimit(`signup:${ipKey(req)}`, 5, 60 * 60 * 1000);
    const body = parse(
      z.object({
        username: usernameSchema,
        email: emailSchema,
        password: passwordSchema,
        displayName: z.string().trim().max(40).optional(),
      }),
      req.body,
    );

    rejectWeakPassword(body.password, body.username, body.email);

    if (get("SELECT 1 AS x FROM users WHERE username = ?", body.username)) {
      throw conflict("That username is already taken.");
    }
    if (get("SELECT 1 AS x FROM users WHERE email = ?", body.email)) {
      throw conflict("An account with that email already exists.");
    }

    const id = newId();
    const passwordHash = await hashPassword(body.password);
    const now = Date.now();
    run(
      `INSERT INTO users (id, username, email, password_hash, display_name, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?)`,
      id,
      body.username,
      body.email,
      passwordHash,
      body.displayName?.trim() || body.username,
      now,
      now,
    );

    const token = createSession(id, req.get("user-agent") ?? "");
    setSessionCookie(req, res, token);
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", id)!;
    res.status(201).json({ user: userProfile(user, id) });
  }),
);

authRouter.post(
  "/login",
  h(async (req, res) => {
    const body = parse(
      z.object({
        identifier: z.string().trim().min(1, "Enter your username or email."),
        password: z.string().min(1, "Enter your password."),
      }),
      req.body,
    );
    const key = body.identifier.toLowerCase();
    // Two failure budgets, both counting failures only and both cleared by a
    // correct password:
    //   per source  — the everyday control; one attacker cannot spend anyone
    //                 else's allowance, so real users are never affected.
    //   per account — the backstop for a distributed attempt, where rotating
    //                 IPs (spoofed or genuine) would defeat the first.
    // The account budget can be exhausted deliberately to throttle a specific
    // login for the rest of the hour; that is the accepted cost of not having
    // a challenge step, and the user gets a clear 429 rather than a failure.
    const sourceBucket = `login-fail:${key}:${ipKey(req)}`;
    const accountBucket = `login-fail:${key}`;
    checkRateLimit(sourceBucket, 10);
    checkRateLimit(accountBucket, 20);
    rateLimit(`login-ip:${ipKey(req)}`, 50, 15 * 60 * 1000);

    const user = get<UserRow>(
      "SELECT * FROM users WHERE username = ? OR email = ?",
      key,
      key,
    );
    // Always run a hash comparison so failures take similar time either way.
    const ok = await verifyPassword(
      body.password,
      user?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
    );
    if (!user || !ok) {
      rateLimit(sourceBucket, 10, 15 * 60 * 1000);
      rateLimit(accountBucket, 20, 60 * 60 * 1000);
      log.warn("failed login", { identifier: key, ip: req.ip });
      throw unauthorized("Incorrect username or password.");
    }

    clearRateLimit(sourceBucket);
    clearRateLimit(accountBucket);

    // The password was right, but on its own it is no longer enough. No session
    // is created here: the challenge is a receipt for the first factor and
    // grants nothing until the second one is presented.
    if (twoFactorEnabled(user.id)) {
      const challenge = createChallenge(user.id, req.get("user-agent") ?? "");
      return res.json({
        twoFactorRequired: true,
        challenge,
        recoveryAvailable: recoveryCodesLeft(user.id) > 0,
      });
    }

    const token = createSession(user.id, req.get("user-agent") ?? "");
    setSessionCookie(req, res, token);
    res.json({ user: userProfile(user, user.id) });
  }),
);

authRouter.post(
  "/logout",
  h((req, res) => {
    if (req.sessionToken) destroySession(req.sessionToken);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  h((req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: userProfile(req.user, req.user.id) });
  }),
);

/**
 * Reset links are emailed when SMTP_URL is configured, and otherwise written to
 * the server log for an operator to relay. The link is never returned in the
 * HTTP response, so this endpoint cannot be used to seize an account you do not
 * control, and the response is identical whether or not the address exists.
 */
authRouter.post(
  "/forgot",
  h(async (req, res) => {
    rateLimit(`forgot-ip:${ipKey(req)}`, 8, 60 * 60 * 1000);
    const body = parse(z.object({ email: emailSchema }), req.body);
    // Per-address ceiling as well, so one mailbox cannot be flooded from many hosts.
    rateLimit(`forgot-address:${body.email}`, 4, 60 * 60 * 1000);

    const user = get<UserRow>("SELECT * FROM users WHERE email = ?", body.email);
    if (user) {
      const token = newToken();
      const now = Date.now();
      // Any earlier link for this account stops working.
      run("DELETE FROM password_resets WHERE user_id = ?", user.id);
      run(
        "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        hashToken(token),
        user.id,
        now,
        now + config.resetTtlMs,
      );
      const origin = config.publicOrigin || `${req.protocol}://${req.get("host")}`;
      await sendPasswordReset(user.email, `${origin}/reset?token=${token}`);
    } else {
      log.info("password reset requested for unknown address", { email: body.email });
    }

    res.json({
      ok: true,
      message: "If an account exists for that email, a reset link is on its way.",
    });
  }),
);

authRouter.post(
  "/reset",
  h(async (req, res) => {
    rateLimit(`reset-ip:${ipKey(req)}`, 20, 60 * 60 * 1000);
    const body = parse(z.object({ token: z.string().min(10).max(200), password: passwordSchema }), req.body);
    const reset = get<{ token_hash: string; user_id: string; expires_at: number; used_at: number | null }>(
      "SELECT * FROM password_resets WHERE token_hash = ?",
      hashToken(body.token),
    );
    if (!reset || reset.used_at || reset.expires_at < Date.now()) {
      throw badRequest("That reset link is invalid or has expired.");
    }
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", reset.user_id);
    if (!user) throw notFound("Account not found.");
    rejectWeakPassword(body.password, user.username, user.email);

    const hash = await hashPassword(body.password);
    tx(() => {
      run("UPDATE users SET password_hash = ? WHERE id = ?", hash, reset.user_id);
      run("UPDATE password_resets SET used_at = ? WHERE token_hash = ?", Date.now(), reset.token_hash);
      // Any other link issued for this account stops working at the same moment.
      run("DELETE FROM password_resets WHERE user_id = ? AND token_hash != ?", reset.user_id, reset.token_hash);
      // Signing out everywhere is the point of a reset: it evicts whoever
      // prompted it. The open sockets are dropped by the session recheck.
      run("DELETE FROM sessions WHERE user_id = ?", reset.user_id);
    });
    log.info("password reset completed", { user: user.username });

    const token = createSession(user.id, req.get("user-agent") ?? "");
    setSessionCookie(req, res, token);
    res.json({ user: userProfile(user, user.id) });
  }),
);

authRouter.post(
  "/password",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    const body = parse(
      z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }),
      req.body,
    );
    rateLimit(`password-change:${user.id}`, 10, 60 * 60 * 1000);
    if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
      throw badRequest("Your current password is not correct.");
    }
    rejectWeakPassword(body.newPassword, user.username, user.email);

    const hash = await hashPassword(body.newPassword);
    tx(() => {
      run("UPDATE users SET password_hash = ? WHERE id = ?", hash, user.id);
      // An outstanding reset link is a second key to the account. Changing the
      // password is often the reaction to noticing one was requested, so it has
      // to invalidate them — otherwise whoever asked for it can still walk in.
      run("DELETE FROM password_resets WHERE user_id = ?", user.id);
    });
    // Every other device is signed out; this one keeps working.
    destroyAllSessions(user.id, req.sessionToken);
    log.info("password changed", { user: user.username });
    res.json({ ok: true });
  }),
);

/**
 * Where this account is signed in.
 *
 * Seeing the list is half of being able to act on it: an unfamiliar device is
 * the first sign of a stolen password, and until now the only remedy was the
 * blunt "sign out everywhere".
 */
authRouter.get(
  "/sessions",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const currentHash = req.sessionToken ? hashToken(req.sessionToken) : "";
    const rows = all<{
      token_hash: string;
      created_at: number;
      last_used_at: number;
      expires_at: number;
      user_agent: string;
    }>(
      `SELECT token_hash, created_at, last_used_at, expires_at, user_agent
       FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC`,
      user.id,
      Date.now(),
    );
    res.json({
      sessions: rows.map((r) => ({
        // The hash, never the token: this list must not hand out working keys.
        id: r.token_hash.slice(0, 16),
        current: r.token_hash === currentHash,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
        device: describeUserAgent(r.user_agent),
      })),
    });
  }),
);

/** Ends one specific session, identified by the prefix the list handed out. */
authRouter.delete(
  "/sessions/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const prefix = String(req.params.id ?? "");
    if (!/^[a-f0-9]{16}$/.test(prefix)) throw badRequest("Unknown session.");
    const currentHash = req.sessionToken ? hashToken(req.sessionToken) : "";
    const row = get<{ token_hash: string }>(
      "SELECT token_hash FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?",
      user.id,
      prefix,
    );
    if (!row) throw notFound("That session has already ended.");
    if (row.token_hash === currentHash) {
      throw badRequest("That is this device. Use sign out instead.");
    }
    run("DELETE FROM sessions WHERE user_id = ? AND token_hash = ?", user.id, row.token_hash);
    log.info("session revoked", { user: user.username });
    res.json({ ok: true });
  }),
);

/**
 * Revokes every other session. The recovery step after "I left it signed in on
 * a shared machine", and the socket recheck closes those connections too.
 */
authRouter.post(
  "/logout-others",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    destroyAllSessions(user.id, req.sessionToken);
    log.info("other sessions revoked", { user: user.username });
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------ two-factor auth */

/**
 * Finishes a login that stopped at the second factor.
 *
 * The challenge is single-use and short-lived, and the attempt budget is keyed
 * to the account rather than the challenge — otherwise an attacker could simply
 * start a fresh login to get a fresh allowance of guesses at a six-digit code.
 */
authRouter.post(
  "/2fa/verify",
  h((req, res) => {
    const body = parse(
      z.object({ challenge: z.string().min(10).max(200), code: z.string().trim().min(6).max(20) }),
      req.body,
    );
    rateLimit(`2fa-ip:${ipKey(req)}`, 30, 15 * 60 * 1000);

    const userId = takeChallenge(body.challenge);
    // 10 guesses per account per 15 minutes: a six-digit code has a million
    // combinations, so this keeps a brute force far below any useful rate.
    checkRateLimit(`2fa-fail:${userId}`, 10);

    const row = totpFor(userId);
    if (!row || !row.confirmed_at) {
      clearChallenge(body.challenge);
      throw unauthorized("Two-factor authentication is not set up for this account.");
    }

    if (!consumeSecondFactor(row, body.code)) {
      rateLimit(`2fa-fail:${userId}`, 10, 15 * 60 * 1000);
      log.warn("failed second factor", { user: userId, ip: req.ip });
      throw unauthorized("That code is not right. Check your authenticator app and try again.");
    }

    clearRateLimit(`2fa-fail:${userId}`);
    clearChallenge(body.challenge);
    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", userId);
    if (!user) throw unauthorized("Account not found.");

    const token = createSession(user.id, req.get("user-agent") ?? "");
    setSessionCookie(req, res, token);
    log.info("second factor accepted", { user: user.username });
    res.json({ user: userProfile(user, user.id) });
  }),
);

/** Current state, for the settings screen. */
authRouter.get(
  "/2fa",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const row = totpFor(user.id);
    res.json({
      enabled: !!row?.confirmed_at,
      pending: !!row && !row.confirmed_at,
      recoveryCodesLeft: row?.confirmed_at ? recoveryCodesLeft(user.id) : 0,
    });
  }),
);

/**
 * Starts enrolment: generates a secret and the QR for it, but changes nothing
 * about how this account signs in. Re-entering the password is the point —
 * otherwise a borrowed, already-signed-in tab could enrol an attacker's phone.
 */
authRouter.post(
  "/2fa/setup",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    const body = parse(z.object({ password: z.string().min(1, "Enter your password.") }), req.body);
    rateLimit(`2fa-setup:${user.id}`, 10, 60 * 60 * 1000);
    if (!(await verifyPassword(body.password, user.password_hash))) {
      throw badRequest("That password is not correct.");
    }
    if (twoFactorEnabled(user.id)) throw conflict("Two-factor authentication is already on.");

    const secret = newTotpSecret();
    run("DELETE FROM user_totp WHERE user_id = ?", user.id);
    run(
      "INSERT INTO user_totp (user_id, secret, created_at, confirmed_at, last_step) VALUES (?,?,?,NULL,0)",
      user.id,
      secret,
      Date.now(),
    );
    res.json(enrolmentPayload(secret, user.username));
  }),
);

/**
 * Confirms the phone really has the secret, and only then turns 2FA on. The
 * recovery codes are returned exactly once, because they are only stored hashed.
 */
authRouter.post(
  "/2fa/enable",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const body = parse(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
    checkRateLimit(`2fa-enable:${user.id}`, 10);

    const row = totpFor(user.id);
    if (!row) throw badRequest("Start the setup again.");
    if (row.confirmed_at) throw conflict("Two-factor authentication is already on.");

    if (!consumeSecondFactor(row, body.code)) {
      rateLimit(`2fa-enable:${user.id}`, 10, 15 * 60 * 1000);
      throw badRequest("That code is not right. Check the app and try again.");
    }
    clearRateLimit(`2fa-enable:${user.id}`);

    run("UPDATE user_totp SET confirmed_at = ? WHERE user_id = ?", Date.now(), user.id);
    const codes = issueRecoveryCodes(user.id);
    // Turning on 2FA should evict anyone already signed in as you elsewhere.
    destroyAllSessions(user.id, req.sessionToken);
    log.info("two-factor enabled", { user: user.username });
    res.json({ enabled: true, recoveryCodes: codes });
  }),
);

/** Both factors are required to remove the second one. */
authRouter.post(
  "/2fa/disable",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    const body = parse(
      z.object({ password: z.string().min(1, "Enter your password."), code: z.string().trim().min(6).max(20) }),
      req.body,
    );
    checkRateLimit(`2fa-disable:${user.id}`, 10);
    if (!(await verifyPassword(body.password, user.password_hash))) {
      rateLimit(`2fa-disable:${user.id}`, 10, 15 * 60 * 1000);
      throw badRequest("That password is not correct.");
    }
    const row = totpFor(user.id);
    if (!row?.confirmed_at) throw badRequest("Two-factor authentication is not on.");
    if (!consumeSecondFactor(row, body.code)) {
      rateLimit(`2fa-disable:${user.id}`, 10, 15 * 60 * 1000);
      throw badRequest("That code is not right.");
    }
    clearRateLimit(`2fa-disable:${user.id}`);

    disableTwoFactor(user.id);
    log.info("two-factor disabled", { user: user.username });
    res.json({ enabled: false });
  }),
);

/** Replaces the recovery codes, for when the printed set is spent or lost. */
authRouter.post(
  "/2fa/recovery-codes",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    const body = parse(z.object({ password: z.string().min(1, "Enter your password.") }), req.body);
    rateLimit(`2fa-codes:${user.id}`, 10, 60 * 60 * 1000);
    if (!(await verifyPassword(body.password, user.password_hash))) {
      throw badRequest("That password is not correct.");
    }
    if (!twoFactorEnabled(user.id)) throw badRequest("Two-factor authentication is not on.");
    res.json({ recoveryCodes: issueRecoveryCodes(user.id) });
  }),
);

/** Live availability check for the signup form. */
authRouter.get(
  "/available",
  h((req, res) => {
    // Unlimited access here would be a username-enumeration oracle.
    rateLimit(`available:${ipKey(req)}`, 60, 10 * 60 * 1000);
    const raw = String(req.query.username ?? "");
    const result = usernameSchema.safeParse(raw);
    if (!result.success) {
      return res.json({ available: false, reason: result.error.issues[0]?.message ?? "Invalid username." });
    }
    const taken = !!get("SELECT 1 AS x FROM users WHERE username = ?", result.data);
    res.json({ available: !taken, reason: taken ? "That username is already taken." : null });
  }),
);

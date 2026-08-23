/**
 * Two-factor authentication, signed-in devices and the privacy switches.
 *
 * Generates real TOTP codes from the same primitives the server verifies, so
 * this exercises the whole second factor rather than mocking it.
 *
 *   node scripts/security-2fa-test.js [baseUrl]   (needs DISABLE_RATE_LIMITS=1)
 */
import { makeReporter, makeUser, cleanup, client, BASE, wait } from "./lib/harness.mjs";
import { codeFor, stepFor } from "../server/src/lib/totp.ts";

const R = makeReporter();
const users = [];

/**
 * A code the server has not already burned.
 *
 * Every accepted code consumes its 30-second step, so back-to-back use inside
 * one window is correctly refused — real users just wait for the next code, and
 * so does this suite rather than pretending the replay guard is a bug.
 */
let consumedStep = -1;
async function now(secret) {
  while (stepFor() <= consumedStep) await wait(1000);
  consumedStep = stepFor();
  return codeFor(secret, consumedStep);
}
/** Deliberately reuses the last code, to prove replay is refused. */
const lastCode = (secret) => codeFor(secret, consumedStep);

try {
  const a = await makeUser("tfa_a"); users.push(a);
  const b = await makeUser("tfa_b"); users.push(b);

  /* ------------------------------------------------------------ enrolment */
  R.heading("Turning it on");
  let r = await a.c.fetch("/api/auth/2fa");
  R.check("it starts off", r.body?.enabled === false && r.body?.pending === false, r.body);

  r = await a.c.fetch("/api/auth/2fa/setup", { method: "POST", json: { password: "wrong-password" } });
  R.check("setup needs the real password", r.status === 400, { status: r.status });

  r = await a.c.fetch("/api/auth/2fa/setup", { method: "POST", json: { password: a.person.password } });
  R.check("setup returns a secret", r.status === 200 && typeof r.body?.secret === "string", { status: r.status });
  const secret = r.body.secret;
  R.check("...a scannable otpauth URI", (r.body?.uri ?? "").startsWith("otpauth://totp/"), r.body?.uri);
  R.check("...naming the issuer and account",
    (r.body?.uri ?? "").includes("issuer=Lumen") && (r.body?.uri ?? "").includes(encodeURIComponent(a.username)),
    r.body?.uri);
  R.check("...and a QR image", (r.body?.qr ?? "").startsWith("data:image/svg+xml;base64,"), (r.body?.qr ?? "").slice(0, 40));

  r = await a.c.fetch("/api/auth/2fa");
  R.check("it is pending, not on", r.body?.pending === true && r.body?.enabled === false, r.body);

  // A pending enrolment must not gate a login.
  const midway = client();
  r = await midway.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  R.check("an unconfirmed enrolment does not lock you out", r.status === 200 && !r.body?.twoFactorRequired, r.body);

  r = await a.c.fetch("/api/auth/2fa/enable", { method: "POST", json: { code: "000000" } });
  R.check("a wrong code does not enable it", r.status === 400, { status: r.status });

  r = await a.c.fetch("/api/auth/2fa/enable", { method: "POST", json: { code: await now(secret) } });
  R.check("the right code enables it", r.status === 200 && r.body?.enabled === true, { status: r.status, body: r.body });
  const recoveryCodes = r.body?.recoveryCodes ?? [];
  R.check("...and hands over recovery codes", recoveryCodes.length === 10, { n: recoveryCodes.length });
  R.check("...that look like codes", /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(recoveryCodes[0] ?? ""), recoveryCodes[0]);

  r = await a.c.fetch("/api/auth/2fa");
  R.check("it reports as on", r.body?.enabled === true, r.body);
  R.check("...with ten codes left", r.body?.recoveryCodesLeft === 10, r.body);

  // Enabling should have evicted the other session opened a moment ago.
  r = await midway.fetch("/api/auth/me");
  R.check("turning it on signs out other devices", !r.body?.user, { user: r.body?.user?.username });

  /* --------------------------------------------------------------- login */
  R.heading("Signing in with it on");
  const fresh = client();
  r = await fresh.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  R.check("the password alone stops at a challenge", r.status === 200 && r.body?.twoFactorRequired === true, r.body);
  R.check("...and creates no session", !r.body?.user, r.body);
  const challenge = r.body.challenge;
  R.check("...handing back a challenge token", typeof challenge === "string" && challenge.length > 20);

  let check = await fresh.fetch("/api/auth/me");
  R.check("the challenge is not a session", !check.body?.user, check.body);

  r = await fresh.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge, code: "123456" } });
  R.check("a wrong code is refused", r.status === 401, { status: r.status });

  r = await fresh.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge, code: await now(secret) } });
  R.check("the right code completes the login", r.status === 200 && r.body?.user?.username === a.username,
    { status: r.status, body: r.body });

  check = await fresh.fetch("/api/auth/me");
  R.check("...and there is now a session", check.body?.user?.username === a.username, check.body?.user?.username);

  r = await fresh.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge, code: await now(secret) } });
  R.check("the challenge cannot be reused", r.status === 401, { status: r.status });

  /* ------------------------------------------------------------- replay */
  R.heading("A code cannot be replayed");
  const replay = client();
  r = await replay.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  const code = await now(secret);
  r = await replay.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge: r.body.challenge, code } });
  R.check("the first use of a code works", r.status === 200, { status: r.status });

  const replay2 = client();
  const second = await replay2.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  r = await replay2.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge: second.body.challenge, code } });
  R.check("the same code a second time is refused", r.status === 401, { status: r.status, body: r.body });

  /* ---------------------------------------------------------- recovery */
  R.heading("Recovery codes");
  const rec = client();
  r = await rec.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  R.check("the challenge says recovery is available", r.body?.recoveryAvailable === true, r.body);
  r = await rec.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge: r.body.challenge, code: recoveryCodes[0] } });
  R.check("a recovery code signs you in", r.status === 200 && r.body?.user?.username === a.username, { status: r.status });

  const rec2 = client();
  const c2 = await rec2.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  r = await rec2.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge: c2.body.challenge, code: recoveryCodes[0] } });
  R.check("the same recovery code cannot be used twice", r.status === 401, { status: r.status });

  r = await fresh.fetch("/api/auth/2fa");
  R.check("the remaining count drops", r.body?.recoveryCodesLeft === 9, r.body);

  r = await fresh.fetch("/api/auth/2fa/recovery-codes", { method: "POST", json: { password: a.person.password } });
  R.check("codes can be regenerated", (r.body?.recoveryCodes ?? []).length === 10, { n: r.body?.recoveryCodes?.length });
  const regenerated = r.body.recoveryCodes;
  R.check("...and the old ones stop working", regenerated[0] !== recoveryCodes[1]);
  const oldCode = client();
  const c3 = await oldCode.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  r = await oldCode.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge: c3.body.challenge, code: recoveryCodes[1] } });
  R.check("...verifiably", r.status === 401, { status: r.status });

  /* ----------------------------------------------------- other accounts */
  R.heading("It belongs to one account");
  const other = client();
  r = await other.fetch("/api/auth/login", { method: "POST", json: { identifier: b.username, password: b.person.password } });
  R.check("an account without 2FA signs in normally", r.status === 200 && !!r.body?.user, r.body?.user?.username);

  const stolen = client();
  const mine = await stolen.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  r = await stolen.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge: mine.body.challenge, code: await now(secret) } });
  R.check("a challenge only ever yields its own account", r.body?.user?.username === a.username, r.body?.user?.username);

  r = await b.c.fetch("/api/auth/2fa/verify", { method: "POST", json: { challenge: "madeupchallengetoken", code: "123456" } });
  R.check("an invented challenge is refused", r.status === 401, { status: r.status });

  /* --------------------------------------------------------- disabling */
  R.heading("Turning it off");
  r = await fresh.fetch("/api/auth/2fa/disable", { method: "POST", json: { password: "nope", code: await now(secret) } });
  R.check("the password is required", r.status === 400, { status: r.status });
  r = await fresh.fetch("/api/auth/2fa/disable", { method: "POST", json: { password: a.person.password, code: "000000" } });
  R.check("a code is required too", r.status === 400, { status: r.status });

  r = await fresh.fetch("/api/auth/2fa/disable", { method: "POST", json: { password: a.person.password, code: await now(secret) } });
  R.check("both together turn it off", r.status === 200 && r.body?.enabled === false, { status: r.status, body: r.body });

  const after = client();
  r = await after.fetch("/api/auth/login", { method: "POST", json: { identifier: a.username, password: a.person.password } });
  R.check("logins go straight through again", r.status === 200 && !!r.body?.user, r.body);

  /* ---------------------------------------------------------- sessions */
  R.heading("Signed-in devices");
  r = await fresh.fetch("/api/auth/sessions");
  R.check("the session list loads", r.status === 200 && Array.isArray(r.body?.sessions), r.body);
  const sessions = r.body.sessions;
  R.check("...showing more than one device", sessions.length >= 2, { n: sessions.length });
  R.check("...marking exactly one as this one", sessions.filter((s) => s.current).length === 1, sessions.map((s) => s.current));
  R.check("...naming the device", typeof sessions[0].device === "string" && sessions[0].device.length > 0, sessions[0]);
  R.check("...and never handing back a usable token",
    sessions.every((s) => s.id.length === 16 && !/^[A-Za-z0-9_-]{40,}$/.test(s.id)), sessions[0]?.id);

  const victim = sessions.find((s) => !s.current);
  r = await fresh.fetch(`/api/auth/sessions/${victim.id}`, { method: "DELETE" });
  R.check("another device can be signed out", r.status === 200, { status: r.status });
  r = await fresh.fetch("/api/auth/sessions");
  R.check("...and it leaves the list", !r.body.sessions.some((s) => s.id === victim.id));

  const self = r.body.sessions.find((s) => s.current);
  r = await fresh.fetch(`/api/auth/sessions/${self.id}`, { method: "DELETE" });
  R.check("this device cannot be revoked from the list", r.status === 400, { status: r.status });

  r = await b.c.fetch(`/api/auth/sessions/${self.id}`, { method: "DELETE" });
  R.check("someone else's session cannot be revoked", r.status === 404, { status: r.status });

  /* ----------------------------------------------------------- privacy */
  R.heading("Activity status");
  const watcher = client();
  await watcher.fetch("/api/auth/login", { method: "POST", json: { identifier: b.username, password: b.person.password } });

  r = await watcher.fetch(`/api/users/${a.username}`);
  const seenOnline = r.body?.user?.isOnline;
  R.check("a recently active account shows as online", seenOnline === true, { isOnline: seenOnline });

  await fresh.fetch("/api/me", { method: "PATCH", json: { showActivity: false } });
  r = await watcher.fetch(`/api/users/${a.username}`);
  R.check("turning activity off hides it from others", r.body?.user?.isOnline === false, r.body?.user?.isOnline);

  r = await fresh.fetch(`/api/users/${a.username}`);
  R.check("...and from yourself too, so the dot never contradicts the switch",
    r.body?.user?.isOnline === false, r.body?.user?.isOnline);
  R.check("...and the setting is reported back to you", r.body?.user?.showActivity === false, r.body?.user?.showActivity);

  r = await watcher.fetch(`/api/users/${b.username}`);
  R.check("the setting is not exposed to anyone else", r.body?.user?.showActivity === true, r.body?.user);

  // Reciprocity: someone who hides their own cannot see anyone else's.
  r = await fresh.fetch(`/api/users/${b.username}`);
  R.check("hiding yours also hides everyone else's from you", r.body?.user?.isOnline === false, r.body?.user?.isOnline);

  await fresh.fetch("/api/me", { method: "PATCH", json: { showActivity: true } });
  r = await fresh.fetch(`/api/users/${b.username}`);
  R.check("turning it back on restores both directions", r.body?.user?.isOnline === true, r.body?.user?.isOnline);

  R.heading("Read receipts");
  const convo = (await fresh.fetch("/api/conversations", { method: "POST", json: { userId: b.id } })).body.conversation.id;
  await fresh.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "hello" } });
  await watcher.fetch(`/api/conversations/${convo}/read`, { method: "POST" });

  r = await fresh.fetch(`/api/conversations/${convo}`);
  R.check("a read message reports Seen", (r.body?.conversation?.theirLastReadAt ?? 0) > 0, r.body?.conversation?.theirLastReadAt);

  await watcher.fetch("/api/me", { method: "PATCH", json: { readReceipts: false } });
  r = await fresh.fetch(`/api/conversations/${convo}`);
  R.check("the reader turning receipts off withholds it", (r.body?.conversation?.theirLastReadAt ?? 0) === 0,
    r.body?.conversation?.theirLastReadAt);

  await watcher.fetch("/api/me", { method: "PATCH", json: { readReceipts: true } });
  await fresh.fetch("/api/me", { method: "PATCH", json: { readReceipts: false } });
  r = await fresh.fetch(`/api/conversations/${convo}`);
  R.check("...and so does the reader's own switch, reciprocally",
    (r.body?.conversation?.theirLastReadAt ?? 0) === 0, r.body?.conversation?.theirLastReadAt);
  await fresh.fetch("/api/me", { method: "PATCH", json: { readReceipts: true } });

  /* ------------------------------------------------------ reset tokens */
  R.heading("An outstanding reset link dies with the password");
  await b.c.fetch("/api/auth/forgot", { method: "POST", json: { email: b.person.email } });
  r = await b.c.fetch("/api/auth/password", {
    method: "POST",
    json: { currentPassword: b.person.password, newPassword: "RotatedPass!2026" },
  });
  R.check("the password changes", r.status === 200, { status: r.status });
  b.person.password = "RotatedPass!2026";
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(new URL("../data/lumen.db", import.meta.url).pathname);
  const left = db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").get(b.id);
  db.close();
  R.check("...and the outstanding reset link is gone", left.n === 0, left);
} catch (err) {
  console.error("\nSuite crashed:", err.message, err.stack?.split("\n")[1] ?? "");
  R.check("suite ran to completion", false, err.message);
} finally {
  await cleanup(users);
}
process.exit(R.done() ? 1 : 0);

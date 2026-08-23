/**
 * Turning 2FA on in Settings, then signing in with it, through the real UI.
 *
 *   node scripts/security-2fa-ui-test.js [baseUrl] (needs DISABLE_RATE_LIMITS=1)
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { codeFor, stepFor } from "../server/src/lib/totp.ts";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-2fa-"));
const PORT = 9400 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const failures = []; let section = "";
const check = (n, ok, d) => { if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failures.push(`${section} — ${n}`); console.log(`  \x1b[31m✗ ${n}\x1b[0m${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); } };
const heading = (t) => { section = t; console.log(`\n${t}`); };

let consumedStep = -1;
async function freshCode(secret) {
  while (stepFor() <= consumedStep) await wait(1000);
  consumedStep = stepFor();
  return codeFor(secret, consumedStep);
}

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1440,900", "--no-first-run", "--mute-audio", "about:blank"], { stdio: "ignore" });
async function tgt() { for (let i=0;i<60;i++){ try { const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json()); const p=l.find(t=>t.type==="page"&&t.webSocketDebuggerUrl); if(p) return p.webSocketDebuggerUrl; } catch{} await wait(250);} throw new Error("no target"); }
const ws = new WebSocket(await tgt());
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 1; const pending = new Map(); let pageErrors = [];
ws.addEventListener("message", e => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  else if (m.method === "Runtime.exceptionThrown") pageErrors.push(String(m.params.exceptionDetails.exception?.description ?? "").split("\n")[0].slice(0, 170)); });
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(x) { const r = await send("Runtime.evaluate", { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
const goto = async (u) => { pageErrors = []; await send("Page.navigate", { url: `${BASE}${u}` }); await wait(2800); };
/** Types into a React-controlled field the way a person would. */
const type = (selector, value) => ev(`
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { missing: true };
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  return { ok: true };`);
await send("Page.enable"); await send("Runtime.enable");

const stamp = Math.random().toString(36).slice(2, 7);
const person = { username: `ui2fa${stamp}`, email: `ui2fa${stamp}@test.dev`, password: "UiTwoFa!2026" };

try {
  console.log(`\nTwo-factor through the UI → ${BASE}`);
  await goto("/");
  const signup = await ev(`
    const r = await fetch('/api/auth/signup', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(${JSON.stringify(person)}) });
    return { status: r.status };`);
  check("an account is created", signup.status === 201, signup);

  /* ------------------------------------------------------- enrolment */
  heading("Turning it on in Settings");
  await goto("/settings");
  const opened = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /^Security$/i.test(x.textContent.trim()));
    if (!b) return { missing: true, tabs: [...document.querySelectorAll('button')].map(x => x.textContent.trim()).slice(0, 8) };
    b.click();
    await new Promise(r => setTimeout(r, 1400));
    return { text: document.body.innerText.slice(0, 200) };`);
  check("the Security section exists", !opened.missing, opened);
  check("...offering two-factor setup", /Two-factor authentication/i.test(opened.text ?? ""), opened.text?.slice(0, 120));

  await type('input[type="password"]', person.password);
  const started = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /set up two-factor/i.test(x.textContent));
    if (!b || b.disabled) return { blocked: true };
    b.click();
    await new Promise(r => setTimeout(r, 2000));
    const img = document.querySelector('img[alt="Two-factor setup QR code"]');
    const secret = [...document.querySelectorAll('code')].map(c => c.textContent.trim()).find(s => /^[A-Z2-7]{16,}$/.test(s));
    return { qr: !!img, qrIsData: (img?.src ?? '').startsWith('data:image/svg+xml'), secret };`);
  check("setup shows a QR code", started.qr === true, started);
  check("...as an inline image, no external fetch", started.qrIsData === true, started);
  check("...alongside a key you can type in", !!started.secret, started.secret);
  const secret = started.secret;

  await type('input[aria-label="Six-digit code"]', "000000");
  const wrong = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /^Turn on$/i.test(x.textContent.trim()));
    b.click();
    await new Promise(r => setTimeout(r, 1800));
    return { stillEnrolling: !!document.querySelector('img[alt="Two-factor setup QR code"]'),
             toast: /not right/i.test(document.body.innerText) };`);
  check("a wrong code is rejected in the UI", wrong.stillEnrolling === true, wrong);

  await type('input[aria-label="Six-digit code"]', await freshCode(secret));
  const enabled = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /^Turn on$/i.test(x.textContent.trim()));
    b.click();
    await new Promise(r => setTimeout(r, 2200));
    const text = document.body.innerText;
    const codes = [...document.querySelectorAll('.font-mono span')].map(s => s.textContent.trim()).filter(s => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(s));
    return { showsCodes: codes.length, sample: codes[0], warns: /only time they are shown/i.test(text) };`);
  check("the right code turns it on", enabled.showsCodes === 10, enabled);
  check("...showing the recovery codes once", enabled.warns === true, enabled);
  const recovery = await ev(`return [...document.querySelectorAll('.font-mono span')].map(s => s.textContent.trim()).filter(s => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(s));`);

  const acknowledged = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /saved them/i.test(x.textContent));
    b.click();
    await new Promise(r => setTimeout(r, 1500));
    return { text: document.body.innerText };`);
  check("dismissing the codes shows the on state", /two-factor authentication is on/i.test(acknowledged.text), acknowledged.text?.slice(0, 160));
  check("...with the remaining count", /10 recovery codes left/i.test(acknowledged.text), acknowledged.text?.slice(0, 200));
  check("no page exception during enrolment", pageErrors.length === 0, pageErrors);

  /* ---------------------------------------------------------- sessions */
  heading("Signed-in devices");
  const devices = await ev(`
    const text = document.body.innerText;
    return { heading: /Where you.{0,3}re signed in/i.test(text), thisDevice: /This device/i.test(text) };`);
  check("the device list is shown", devices.heading === true, devices);
  check("...marking the current one", devices.thisDevice === true, devices);

  /* ------------------------------------------------------------- login */
  heading("Signing in with it on");
  await ev(`await fetch('/api/auth/logout', { method: 'POST' }); return 1;`);
  await goto("/auth");
  await type('input[name="identifier"], input[autocomplete="username"], form input[type="text"]', person.username);
  await type('input[type="password"]', person.password);
  const challenged = await ev(`
    const b = [...document.querySelectorAll('button[type=submit]')].find(x => !x.disabled);
    if (!b) return { noButton: true };
    b.click();
    await new Promise(r => setTimeout(r, 2500));
    return { path: location.pathname, prompt: /Enter your code/i.test(document.body.innerText),
             field: !!document.querySelector('input[aria-label="Six-digit code"]'),
             text: document.body.innerText.slice(0, 150) };`);
  check("the password alone lands on the code step", challenged.prompt === true, challenged);
  check("...with a code field", challenged.field === true, challenged);
  check("...and no session yet", challenged.path === "/auth", challenged);

  const stillOut = await ev(`const r = await fetch('/api/auth/me').then(r=>r.json()); return { user: r.user?.username ?? null };`);
  check("the browser is genuinely not signed in", stillOut.user === null, stillOut);

  await type('input[aria-label="Six-digit code"]', "111111");
  const rejected = await ev(`
    const b = [...document.querySelectorAll('button[type=submit]')].find(x => /verify/i.test(x.textContent));
    b.click();
    await new Promise(r => setTimeout(r, 2200));
    return { stillOnCode: /Enter your code/i.test(document.body.innerText), error: /not right|did not work/i.test(document.body.innerText) };`);
  check("a wrong code keeps you on the step", rejected.stillOnCode === true, rejected);
  check("...and says so", rejected.error === true, rejected);

  await type('input[aria-label="Six-digit code"]', await freshCode(secret));
  const signedIn = await ev(`
    const b = [...document.querySelectorAll('button[type=submit]')].find(x => /verify/i.test(x.textContent));
    b.click();
    await new Promise(r => setTimeout(r, 3000));
    const me = await fetch('/api/auth/me').then(r => r.json());
    return { path: location.pathname, user: me.user?.username ?? null };`);
  check("the right code signs you in", signedIn.user === person.username, signedIn);
  check("...and lands on the app", signedIn.path === "/", signedIn);
  check("no page exception during sign-in", pageErrors.length === 0, pageErrors);

  /* --------------------------------------------------------- recovery */
  heading("Signing in with a recovery code");
  await ev(`await fetch('/api/auth/logout', { method: 'POST' }); return 1;`);
  await goto("/auth");
  await type('input[name="identifier"], input[autocomplete="username"], form input[type="text"]', person.username);
  await type('input[type="password"]', person.password);
  await ev(`
    const b = [...document.querySelectorAll('button[type=submit]')].find(x => !x.disabled);
    b.click(); await new Promise(r => setTimeout(r, 2500)); return 1;`);
  const switched = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /use a recovery code/i.test(x.textContent));
    if (!b) return { missing: true };
    b.click();
    await new Promise(r => setTimeout(r, 800));
    return { field: !!document.querySelector('input[aria-label="Recovery code"]') };`);
  check("a recovery code option is offered", switched.missing !== true, switched);
  check("...switching the field", switched.field === true, switched);

  await type('input[aria-label="Recovery code"]', recovery[0]);
  const viaRecovery = await ev(`
    const b = [...document.querySelectorAll('button[type=submit]')].find(x => /verify/i.test(x.textContent));
    b.click();
    await new Promise(r => setTimeout(r, 3000));
    const me = await fetch('/api/auth/me').then(r => r.json());
    return { user: me.user?.username ?? null };`);
  check("a recovery code signs you in", viaRecovery.user === person.username, viaRecovery);

  /* -------------------------------------------------- privacy switches */
  heading("Privacy switches");
  await goto("/settings");
  const privacy = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /privacy/i.test(x.textContent.trim()));
    b.click();
    await new Promise(r => setTimeout(r, 1500));
    return { activity: !!document.querySelector('[aria-label="Activity status"]'),
             receipts: !!document.querySelector('[aria-label="Read receipts"]'),
             activityOn: document.querySelector('[aria-label="Activity status"]')?.getAttribute('aria-checked') };`);
  check("an activity status switch is present", privacy.activity === true, privacy);
  check("a read receipts switch is present", privacy.receipts === true, privacy);
  check("...both on by default", privacy.activityOn === "true", privacy);

  const toggled = await ev(`
    document.querySelector('[aria-label="Activity status"]').click();
    await new Promise(r => setTimeout(r, 1800));
    const me = await fetch('/api/auth/me').then(r => r.json());
    return { aria: document.querySelector('[aria-label="Activity status"]')?.getAttribute('aria-checked'),
             saved: me.user?.showActivity };`);
  check("turning it off persists", toggled.saved === false, toggled);
  check("...and the switch reflects it", toggled.aria === "false", toggled);
  check("no page exception in settings", pageErrors.length === 0, pageErrors);

  await ev(`
    await fetch('/api/me', { method:'DELETE', headers:{'content-type':'application/json'},
      body: JSON.stringify({ password: ${JSON.stringify(person.password)} }) });
    return 1;`);
} catch (err) {
  console.error("\nSuite crashed:", err.message);
  check("suite ran to completion", false, err.message);
} finally {
  ws.close(); chrome.kill("SIGKILL");
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) { console.log("Failed:"); for (const f of failures) console.log(`  - ${f}`); console.log(); }
process.exit(failures.length ? 1 : 0);

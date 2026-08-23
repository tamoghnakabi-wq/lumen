/**
 * Renaming and muting, driven through the real Settings and profile UI rather
 * than the API — the menus, the availability check and the Muted list.
 *
 *   node scripts/features-ui-test.js [baseUrl]     (needs DISABLE_RATE_LIMITS=1)
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const BASE = process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-newui-"));
const PORT = 9700 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const failures = []; let section = "";
const check = (n, ok, d) => { if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failures.push(`${section} — ${n}`); console.log(`  \x1b[31m✗ ${n}\x1b[0m${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); } };
const heading = (t) => { section = t; console.log(`\n${t}`); };

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1440,900", "--no-first-run", "--mute-audio", "about:blank"], { stdio: "ignore" });
async function tgt() { for (let i=0;i<60;i++){ try { const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json()); const p=l.find(t=>t.type==="page"&&t.webSocketDebuggerUrl); if(p) return p.webSocketDebuggerUrl; } catch{} await wait(250);} throw new Error("no target"); }
const ws = new WebSocket(await tgt());
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 1; const pending = new Map(); let pageErrors = [];
ws.addEventListener("message", e => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  else if (m.method === "Runtime.exceptionThrown") pageErrors.push(String(m.params.exceptionDetails.exception?.description ?? "").split("\n")[0].slice(0, 160)); });
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(x) { const r = await send("Runtime.evaluate", { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
const goto = async (u) => { pageErrors = []; await send("Page.navigate", { url: `${BASE}${u}` }); await wait(2600); };
async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await wait(600);
}
await send("Page.enable"); await send("Runtime.enable");

try {
  console.log(`\nNew features in real Chrome → ${BASE}`);
  const stamp = Math.random().toString(36).slice(2, 7);

  await goto("/");
  const setup = await ev(`
    const mk = async (u) => (await fetch('/api/auth/signup', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ username: u, email: u + '@bughunt.dev', password: 'BugHunt!2026' }) })).json();
    const other = await mk('other${stamp}');
    await fetch('/api/auth/logout', { method: 'POST' });
    const meUser = await mk('me${stamp}');
    await fetch('/api/users/' + other.user.id + '/follow', { method: 'POST' });
    return { otherId: other.user.id, otherName: other.user.username, meName: meUser.user.username };
  `);
  check("two accounts exist and one follows the other", !!setup.otherId, setup);

  /* ------------------------------------------------ username change */
  heading("Changing your username in Settings");
  await goto("/settings");
  const field = await ev(`
    const inputs = [...document.querySelectorAll('input')];
    const u = inputs.find(i => i.getAttribute('aria-label') === 'Username');
    if (!u) return { missing: true, labels: inputs.map(i => i.getAttribute('aria-label')) };
    const r = u.getBoundingClientRect();
    return { value: u.value, disabled: u.disabled, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  `);
  check("the username field is present and editable", !field.missing && !field.disabled, field);
  check("...prefilled with the current handle", field.value === setup.meName, field);

  const renamed = `renamed${stamp}`;
  const typed = await ev(`
    const u = [...document.querySelectorAll('input')].find(i => i.getAttribute('aria-label') === 'Username');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(u, '${renamed}');
    u.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1400));
    return { text: document.body.innerText.match(/is available|already taken|Checking/)?.[0] ?? null };
  `);
  check("availability is checked while typing", typed.text === "is available", typed);

  const saved = await ev(`
    const btn = [...document.querySelectorAll('button')].find(b => /save changes/i.test(b.textContent) && !b.disabled);
    if (!btn) return { noButton: true };
    btn.click();
    await new Promise(r => setTimeout(r, 2200));
    const who = await fetch('/api/auth/me').then(r => r.json());
    return { username: who.user?.username, toast: /You are now/.test(document.body.innerText) };
  `);
  check("saving renames the account", saved.username === renamed, saved);
  check("...and confirms it to the user", saved.toast === true, saved);
  check("no page exception during the rename", pageErrors.length === 0, pageErrors);

  const cooldown = await ev(`
    const u = [...document.querySelectorAll('input')].find(i => i.getAttribute('aria-label') === 'Username');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(u, 'third${stamp}');
    u.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1400));
    const btn = [...document.querySelectorAll('button')].find(b => /save changes/i.test(b.textContent) && !b.disabled);
    if (!btn) return { noButton: true };
    btn.click();
    await new Promise(r => setTimeout(r, 2000));
    return { message: document.body.innerText.match(/change your username again in \\d+ days?/i)?.[0] ?? null };
  `);
  check("a second rename is refused with a clear message", !!cooldown.message, cooldown);

  await goto(`/${renamed}`);
  const prof = await ev(`return { text: document.body.innerText.slice(0, 80), notFound: /not found|isn.t available/i.test(document.body.innerText) };`);
  check("the profile loads on the new handle", !prof.notFound, prof);

  /* ------------------------------------------------------------ mute */
  heading("Muting from a profile");
  await goto(`/${setup.otherName}`);
  const menuBtn = await ev(`
    const b = [...document.querySelectorAll('button')].find(b => /more options/i.test(b.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  `);
  check("the profile overflow menu exists", !!menuBtn, menuBtn);
  await clickAt(menuBtn.x, menuBtn.y);
  const items = await ev(`return [...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim());`);
  check("the menu offers Mute", items.some((i) => /^Mute account$/i.test(i)), items);

  const muteSpot = await ev(`
    const b = [...document.querySelectorAll('[role=menuitem]')].find(b => /^Mute account$/i.test(b.textContent.trim()));
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  `);
  await clickAt(muteSpot.x, muteSpot.y);
  await wait(1400);
  const afterMute = await ev(`
    const rel = await fetch('/api/users/${setup.otherName}').then(r => r.json());
    return { isMuted: rel.user?.relation?.isMuted, toast: /will not see/i.test(document.body.innerText) };
  `);
  check("muting takes effect", afterMute.isMuted === true, afterMute);
  check("...and tells you what changed", afterMute.toast === true, afterMute);

  await goto(`/${setup.otherName}`);
  const relabelled = await ev(`
    const b = [...document.querySelectorAll('button')].find(b => /more options/i.test(b.getAttribute('aria-label') || ''));
    b.click();
    await new Promise(r => setTimeout(r, 700));
    return [...document.querySelectorAll('[role=menuitem]')].map(x => x.textContent.trim());
  `);
  check("the menu now offers Unmute", relabelled.some((i) => /^Unmute account$/i.test(i)), relabelled);

  heading("The Muted list in Settings");
  await goto("/settings");
  const privacyTab = await ev(`
    const b = [...document.querySelectorAll('button, a')].find(x => /^privacy/i.test(x.textContent.trim()));
    if (!b) return { missing: true, tabs: [...document.querySelectorAll('button')].map(x => x.textContent.trim()).slice(0, 10) };
    b.click();
    await new Promise(r => setTimeout(r, 1600));
    return { text: document.body.innerText };
  `);
  check("the privacy section opens", !privacyTab.missing, privacyTab);
  check("a Muted accounts card is shown", /Muted accounts/i.test(privacyTab.text ?? ""), (privacyTab.text ?? "").slice(0, 200));
  check("...listing the muted account", (privacyTab.text ?? "").includes(setup.otherName), (privacyTab.text ?? "").slice(0, 300));

  const unmuted = await ev(`
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Unmute');
    if (!btn) return { noButton: true };
    btn.click();
    await new Promise(r => setTimeout(r, 1800));
    const rel = await fetch('/api/users/${setup.otherName}').then(r => r.json());
    return { isMuted: rel.user?.relation?.isMuted, stillListed: document.body.innerText.includes('${setup.otherName}') };
  `);
  check("unmuting from Settings works", unmuted.isMuted === false, unmuted);
  check("...and removes the row", unmuted.stillListed === false, unmuted);
  check("no page exception across the mute flow", pageErrors.length === 0, pageErrors);

  // clean up the two accounts
  await ev(`
    await fetch('/api/me', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: 'BugHunt!2026' }) });
    await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ identifier: '${setup.otherName}', password: 'BugHunt!2026' }) });
    await fetch('/api/me', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: 'BugHunt!2026' }) });
    return 1;
  `);
} catch (err) {
  console.error("\nHarness error:", err.message);
  check("harness ran to completion", false, err.message);
} finally {
  ws.close(); chrome.kill("SIGKILL");
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) { console.log("Failed:"); for (const f of failures) console.log(`  - ${f}`); console.log(); }
process.exit(failures.length ? 1 : 0);

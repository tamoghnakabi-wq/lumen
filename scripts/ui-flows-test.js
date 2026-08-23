/**
 * The surfaces that are not routes: overlays, in-place flows and keyboard use.
 *
 * A route sweep never opens the story viewer, the composer, a search box or a
 * comment form, so those are where UI faults survive longest.
 *
 *   node scripts/ui-flows-test.js [baseUrl]       (needs DISABLE_RATE_LIMITS=1)
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-flows-"));
const PORT = 9260 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const failures = []; let section = "";
const check = (n, ok, d) => { if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failures.push(`${section} — ${n}`); console.log(`  \x1b[31m✗ ${n}\x1b[0m${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 320)}` : ""}`); } };
const heading = (t) => { section = t; console.log(`\n\x1b[1m${t}\x1b[0m`); };

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--window-size=1440,900",
  "--no-first-run", "--mute-audio", "about:blank"], { stdio: "ignore" });
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
const goto = async (u, s = 2600) => { pageErrors = []; await send("Page.navigate", { url: `${BASE}${u}` }); await wait(s); };
const type = (sel, val) => ev(`
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { missing: true };
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  return { ok: true };`);
async function key(k) {
  const code = k === "Escape" ? 27 : k === "Tab" ? 9 : 0;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
  await wait(300);
}
await send("Page.enable"); await send("Runtime.enable");

try {
  console.log(`\nInteractive flows → ${BASE}`);
  await goto("/");
  await ev(`await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:'mara',password:'lumen123'})}); return 1;`);

  /* ------------------------------------------------------ story viewer */
  heading("Story viewer");
  // Post a story from another account so one is guaranteed on the rail.
  await ev(`
    const jar = await fetch('/api/auth/logout', { method:'POST' });
    await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:'juno',password:'lumen123'})});
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 700;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4488ff'; ctx.fillRect(0,0,400,700);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const fd = new FormData(); fd.append('image', blob, 's.png'); fd.append('caption', 'sweep story');
    await fetch('/api/stories', { method:'POST', body: fd });
    await fetch('/api/auth/logout', { method:'POST' });
    await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:'mara',password:'lumen123'})});
    return 1;`);
  await goto("/");
  const opened = await ev(`
    await new Promise(r => setTimeout(r, 1200));
    const btns = [...document.querySelectorAll('button')].filter(b => b.className.includes('w-[68px]'));
    const other = btns.find(b => !/Your story/i.test(b.textContent));
    if (!other) return { missing: true, n: btns.length };
    other.click();
    await new Promise(r => setTimeout(r, 1600));
    const viewer = document.querySelector('.z-\\\\[180\\\\]');
    return { open: !!viewer, hasClose: !!document.querySelector('[aria-label="Close stories"]'),
             progress: document.querySelectorAll('.z-\\\\[180\\\\] .h-0\\\\.5').length };`);
  check("a story opens", opened.open === true, opened);
  check("...with a close control", opened.hasClose === true, opened);
  check("...and a progress bar", (opened.progress ?? 0) > 0, opened);

  const storyAudit = await ev(`
    const vw = innerWidth, vh = innerHeight;
    const viewer = document.querySelector('.z-\\\\[180\\\\]');
    const spill = [...viewer.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || r.width < 4) return false;
      return r.right > vw + 2 || r.left < -2;
    }).length;
    return { spill, sideways: document.documentElement.scrollWidth > vw + 1 };`);
  check("the story viewer fits the screen", storyAudit.spill === 0 && !storyAudit.sideways, storyAudit);

  await key("Escape");
  check("Escape closes the story viewer", (await ev(`return !document.querySelector('.z-\\\\[180\\\\]');`)) === true);
  check("no exception from the story viewer", pageErrors.length === 0, pageErrors.slice(0, 2));

  /* ---------------------------------------------------------- composer */
  heading("Composer");
  await goto("/");
  const composer = await ev(`
    [...document.querySelectorAll('button')].find(b => /create/i.test(b.getAttribute('aria-label')||'') || /^Create$/.test(b.textContent.trim())).click();
    await new Promise(r => setTimeout(r, 1200));
    const d = document.querySelector('[role=dialog]');
    if (!d) return { missing: true };
    const share = [...d.querySelectorAll('button')].find(b => /share|post/i.test(b.textContent));
    return { open: true, shareDisabled: share ? share.disabled : null, hasFileInput: !!d.querySelector('input[type=file]') };`);
  check("the composer opens", composer.open === true, composer);
  check("...with a file picker", composer.hasFileInput === true, composer);
  check("...and cannot post an empty draft", composer.shareDisabled === true, composer);

  const typed = await type('[role=dialog] textarea', "a caption with no image");
  const stillBlocked = await ev(`
    const d = document.querySelector('[role=dialog]');
    const share = [...d.querySelectorAll('button')].find(b => /share|post/i.test(b.textContent));
    return { disabled: share?.disabled };`);
  check("a caption alone still cannot be posted", stillBlocked.disabled === true, { typed, stillBlocked });

  await key("Escape");
  const composerClosed = await ev(`
    await new Promise(r => setTimeout(r, 800));
    return { open: !!document.querySelector('[role=dialog]'), locked: getComputedStyle(document.body).overflow === 'hidden' };`);
  check("the composer closes and releases the page", !composerClosed.open && !composerClosed.locked, composerClosed);

  /* ----------------------------------------------------------- search */
  heading("Search");
  await goto("/explore");
  // Search never returns you to yourself, so look for somebody else.
  await type('input[aria-label="Search"]', "juno");
  const results = await ev(`
    await new Promise(r => setTimeout(r, 1600));
    const text = document.body.innerText;
    return { found: /juno/i.test(text), len: text.length, sample: text.slice(0, 120) };`);
  check("typing a query finds the account", results.found === true, results);

  await type('input[aria-label="Search"]', "zzzzznotarealuser");
  const empty = await ev(`
    await new Promise(r => setTimeout(r, 1600));
    return { text: document.body.innerText.slice(0, 400) };`);
  check("a query with no matches says so rather than going blank",
    /nothing|no results|no matches|couldn.t find|try another/i.test(empty.text), empty.text.slice(0, 160));
  check("no exception from search", pageErrors.length === 0, pageErrors.slice(0, 2));

  /* -------------------------------------------------------- commenting */
  heading("Commenting");
  const postId = await ev(`const r = await fetch('/api/feed').then(r=>r.json()); return r.posts?.[0]?.id;`);
  await goto(`/p/${postId}`);
  const commentBox = await ev(`
    const box = document.querySelector('textarea, input:not([type=hidden]):not([type=file])');
    return { found: !!box, placeholder: box?.getAttribute('placeholder') };`);
  check("a comment box is present", commentBox.found === true, commentBox);

  const commentText = "sweep comment " + Math.random().toString(36).slice(2, 6);
  // The comment composer is a single-line input, not a textarea.
  await type('form input[placeholder*="comment" i], form textarea', commentText);
  const posted = await ev(`
    await new Promise(r => setTimeout(r, 500));
    // The Post button only renders once there is something to post.
    const btn = [...document.querySelectorAll('form button[type=submit]')].find(b => !b.disabled)
      ?? [...document.querySelectorAll('button')].find(b => /^post$/i.test(b.textContent.trim()) && !b.disabled);
    if (!btn) return { noButton: true,
                       fields: [...document.querySelectorAll('form input, form textarea')]
                         .map(f => ({ tag: f.tagName, ph: f.getAttribute('placeholder'), v: (f.value||'').slice(0,16) })) };
    btn.click();
    await new Promise(r => setTimeout(r, 1800));
    const box = document.querySelector('form input[placeholder*="comment" i], form textarea');
    return { cleared: (box?.value ?? '') === '',
             text: document.body.innerText.includes(${JSON.stringify(commentText)}) };`);
  check("a comment posts", posted.text === true, posted);
  check("...and clears the box", posted.cleared === true, posted);

  /* --------------------------------------------------- keyboard access */
  heading("Keyboard");
  await goto("/");
  const focusRing = await ev(`
    const first = document.querySelector('a[href], button');
    first.focus();
    const s = getComputedStyle(first, ':focus-visible');
    return { focused: document.activeElement === first, outline: s.outlineWidth };`);
  check("elements can take focus", focusRing.focused === true, focusRing);

  const tabbing = await ev(`
    // Walk the tab order and make sure focus lands on real controls.
    const focusables = [...document.querySelectorAll('a[href], button, input, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
    const trapped = focusables.filter(el => el.tabIndex < 0).length;
    return { count: focusables.length, trapped };`);
  check("the page has a reachable tab order", tabbing.count > 5, tabbing);
  check("...with nothing removed from it", tabbing.trapped === 0, tabbing);

  await goto(`/p/${postId}`);
  await key("Escape");
  check("Escape on a plain page does nothing harmful", (await ev(`return location.pathname.startsWith('/p/');`)) === true);

  /* --------------------------------------------------- an empty account */
  heading("A brand-new account sees guidance, not blank panels");
  const stamp = Math.random().toString(36).slice(2, 6);
  await ev(`
    await fetch('/api/auth/logout', { method: 'POST' });
    await fetch('/api/auth/signup', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ username: 'flows' + '${stamp}', email: 'flows${stamp}@t.dev', password: 'FlowsPass!2026' }) });
    return 1;`);
  for (const route of ["/", "/notifications", "/messages", "/saved", "/explore", "/reels"]) {
    await goto(route, 2400);
    const state = await ev(`
      const text = document.body.innerText.replace(/\\s+/g, ' ').trim();
      return { len: text.length, sample: text.slice(0, 120),
               hasAction: !!document.querySelector('button, a[href]') };`);
    check(`${route}: says something useful when empty`, state.len > 40 && state.hasAction, state);
  }
  await ev(`await fetch('/api/me', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: 'FlowsPass!2026' }) }); return 1;`);
} catch (err) {
  console.error("\nSweep crashed:", err.message);
  check("sweep ran to completion", false, err.message);
} finally {
  ws.close(); chrome.kill("SIGKILL");
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) { console.log("Failed:"); for (const f of failures) console.log(`  - ${f}`); console.log(); }
process.exit(failures.length ? 1 : 0);

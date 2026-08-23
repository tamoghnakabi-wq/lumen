/**
 * Opening a post from the app, and getting back out of it again.
 *
 * A post opened from inside the app layers over the page you were on, so it can
 * offer a backdrop, a close button and Escape. Opened by URL it is an ordinary
 * page with a visible back control. This walks both, at desktop and phone width.
 *
 *   node scripts/post-overlay-test.js [baseUrl]    (needs DISABLE_RATE_LIMITS=1)
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-dismiss-"));
const PORT = 9300 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const failures = []; let section = "";
const check = (n, ok, d) => { if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failures.push(`${section} — ${n}`); console.log(`  \x1b[31m✗ ${n}\x1b[0m${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); } };
const heading = (t) => { section = t; console.log(`\n${t}`); };

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--autoplay-policy=no-user-gesture-required", "--window-size=1440,900", "--no-first-run", "--mute-audio", "about:blank"], { stdio: "ignore" });
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
async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await wait(700);
}
async function key(k) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 });
  await wait(800);
}
await send("Page.enable"); await send("Runtime.enable");

const state = () => ev(`
  return {
    path: location.pathname,
    dialog: !!document.querySelector('[role=dialog][aria-label="Post"]'),
    closeBtn: !!document.querySelector('[aria-label="Close post"]'),
    bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
  };`);

/** Opens the first post in the Explore grid and returns the resulting state. */
async function openFromGrid() {
  const spot = await ev(`
    await new Promise(r => setTimeout(r, 900));
    const a = document.querySelector('a[href^="/p/"]');
    if (!a) return null;
    a.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 500));
    const r = a.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), href: a.getAttribute('href') };`);
  if (!spot) return null;
  await clickAt(spot.x, spot.y);
  await wait(900);
  return spot;
}

try {
  console.log(`\nOpening and closing a post → ${BASE}`);
  await goto("/");
  await ev(`await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:'mara',password:'lumen123'})}); return 1;`);

  /* ------------------------------------------------------ the overlay opens */
  heading("A post opened from the grid becomes an overlay");
  await goto("/explore");
  const opened = await openFromGrid();
  check("a post link was found and clicked", !!opened, opened);
  let s = await state();
  check("the URL is the post's own", /^\/p\//.test(s.path), s);
  check("it renders as a dialog, not a bare page", s.dialog, s);
  check("...with a close button", s.closeBtn, s);
  check("...and the page behind cannot scroll", s.bodyLocked, s);
  check("no page exception", pageErrors.length === 0, pageErrors);

  const behind = await ev(`
    // The explore grid should still be mounted underneath the overlay.
    return { gridStillThere: document.querySelectorAll('a[href^="/p/"]').length > 0 };`);
  check("the page you came from is still underneath", behind.gridStillThere, behind);

  /* ------------------------------------------------------- the close button */
  heading("The close button");
  const btn = await ev(`
    const b = document.querySelector('[aria-label="Close post"]');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
  await clickAt(btn.x, btn.y);
  s = await state();
  check("closes the overlay", !s.dialog, s);
  check("...and returns you to where you were", s.path === "/explore", s);
  check("...and unlocks the page", !s.bodyLocked, s);

  /* ---------------------------------------------------------- outside click */
  heading("Clicking outside the post");
  await openFromGrid();
  s = await state();
  check("the overlay is open again", s.dialog, s);
  // Far left of the viewport, well clear of the centred card.
  await clickAt(12, Math.round(450));
  s = await state();
  check("clicking the backdrop closes it", !s.dialog, s);
  check("...and returns you to where you were", s.path === "/explore", s);

  /* ---------------------------------------------------------------- Escape */
  heading("Escape");
  await openFromGrid();
  check("the overlay is open again", (await state()).dialog);
  await key("Escape");
  s = await state();
  check("Escape closes it", !s.dialog, s);
  check("...and returns you to where you were", s.path === "/explore", s);

  /* ------------------------------------------------- clicking inside is safe */
  heading("Clicking inside the post does not dismiss it");
  await openFromGrid();
  const card = await ev(`
    // The picture itself: unmistakably inside the post, and inert on one click.
    const media = document.querySelector('[role=dialog][aria-label="Post"] [style*="aspect-ratio"]');
    const r = media.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             el: document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2))?.tagName };`);
  await clickAt(card.x, card.y);
  s = await state();
  check("the overlay stays open", s.dialog, s);

  const stillWorks = await ev(`
    const like = [...document.querySelectorAll('[role=dialog] button')].find(b => /^(Like|Unlike)$/.test(b.getAttribute('aria-label') || ''));
    if (!like) return { noLike: true };
    const before = like.getAttribute('aria-label');
    like.click();
    await new Promise(r => setTimeout(r, 1400));
    const after = [...document.querySelectorAll('[role=dialog] button')].find(b => /^(Like|Unlike)$/.test(b.getAttribute('aria-label') || ''))?.getAttribute('aria-label');
    return { before, after };`);
  check("the post is fully interactive inside the overlay", stillWorks.before !== stillWorks.after, stillWorks);

  await key("Escape");

  /* ---------------------------------------------------------- from the feed */
  heading("From the feed");
  await goto("/");
  const feedOpen = await ev(`
    await new Promise(r => setTimeout(r, 1200));
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Comments');
    if (!b) return { missing: true };
    b.click();
    await new Promise(r => setTimeout(r, 1500));
    return { ok: true };`);
  check("the comment button opens a post", !feedOpen.missing, feedOpen);
  s = await state();
  check("...as an overlay with a close button", s.dialog && s.closeBtn, s);
  await key("Escape");
  s = await state();
  check("...that closes back to the feed", !s.dialog && s.path === "/", s);

  /* --------------------------------------------------------- a direct link */
  heading("A post opened directly by URL is still a page you can leave");
  const postId = await ev(`const r = await fetch('/api/explore').then(r => r.json()); return r.posts?.[0]?.id ?? null;`);
  await goto(`/p/${postId}`);
  s = await state();
  check("it renders as a page, not an overlay", !s.dialog, s);
  const back = await ev(`
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Go back');
    if (!b) return { missing: true };
    const r = b.getBoundingClientRect();
    return { visible: r.width > 0 && r.height > 0, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };`);
  check("a back control is present on a wide screen too", back.visible === true, back);
  check("...and the page does not lock scrolling", !s.bodyLocked, s);

  /* ------------------------------------------------------------ on a phone */
  heading("On a phone");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto("/explore");
  await openFromGrid();
  s = await state();
  check("the overlay opens on mobile", s.dialog, s);
  check("...with a close button", s.closeBtn, s);
  const noSideways = await ev(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`);
  check("...and no sideways scroll", noSideways, noSideways);
  const mobileBtn = await ev(`
    const b = document.querySelector('[aria-label="Close post"]');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), onScreen: r.right <= innerWidth && r.top >= 0 };`);
  check("...positioned on screen", mobileBtn.onScreen, mobileBtn);
  await clickAt(mobileBtn.x, mobileBtn.y);
  s = await state();
  check("...and it closes", !s.dialog, s);
  check("no page exception on mobile", pageErrors.length === 0, pageErrors);
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

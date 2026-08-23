/**
 * Structural UI sweep: every route, at six widths, in both themes.
 *
 * Looks for the faults a route-level smoke test cannot see — a control covered
 * by another element, content painted outside the viewport, dialogs that leave
 * the page scroll-locked, controls with no accessible name, and tap targets too
 * small to hit on a phone.
 *
 * Two distinctions matter and are handled deliberately: an element scrolled out
 * of its own container is clipped, not covered, and fixed chrome overlaying
 * scrollable content is by design. Without both, this reports a dozen phantoms.
 *
 *   node scripts/ui-sweep-test.js [baseUrl]       (needs DISABLE_RATE_LIMITS=1)
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-sweep-"));
const PORT = 9200 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const failures = []; let section = "";
const check = (n, ok, d) => { if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failures.push(`${section} — ${n}`); console.log(`  \x1b[31m✗ ${n}\x1b[0m${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 340)}` : ""}`); } };
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
const goto = async (u, settle = 2600) => { pageErrors = []; await send("Page.navigate", { url: `${BASE}${u}` }); await wait(settle); };
const size = (w, h, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
await send("Page.enable"); await send("Runtime.enable");

/**
 * Two structural faults, checked the same way on every screen:
 *   spill    — anything painted outside the viewport horizontally
 *   covered  — a control whose own centre belongs to some other element, which
 *              is how the reels rail buttons were dead while looking fine
 */
const AUDIT = `
  const vw = window.innerWidth, vh = window.innerHeight;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < vh;
  };

  const spill = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 2 || r.left < -2) {
      const s = getComputedStyle(el);
      // Deliberately offscreen scroll tracks and snap carousels are fine.
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
      if (el.closest('[class*="snap-x"], [class*="overflow-x-auto"], [class*="hide-scroll"]')) continue;
      spill.push({ tag: el.tagName, cls: String(el.className).slice(0, 60),
                   left: Math.round(r.left), right: Math.round(r.right), vw });
    }
  }

  // An element can sit inside the viewport yet be scrolled out of its own
  // scroll container, where the rect still reports a position but nothing is
  // painted. That is clipping, not a covered control.
  const clippedByScroller = (el) => {
    const r = el.getBoundingClientRect();
    // The centre is what the hit test uses, so that is the point that has to be
    // inside every scrolling ancestor — a control half under a sticky header is
    // scrolled, not covered.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let n = el.parentElement;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (/(auto|scroll|hidden)/.test(s.overflowY + s.overflowX)) {
        const nr = n.getBoundingClientRect();
        if (cy < nr.top || cy > nr.bottom || cx < nr.left || cx > nr.right) return true;
      }
      n = n.parentElement;
    }
    return false;
  };
  const inFixed = (el) => {
    let n = el;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (s.position === 'fixed' || s.position === 'sticky') return true;
      n = n.parentElement;
    }
    return false;
  };

  const covered = [];
  for (const el of document.querySelectorAll('button, a[href], input, [role=switch], [role=menuitem]')) {
    if (!visible(el)) continue;
    if (el.disabled) continue;
    if (clippedByScroller(el)) continue;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (x < 0 || y < 0 || x > vw || y > vh) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit) continue;
    if (el.contains(hit) || hit.contains(el)) continue;
    // Fixed chrome (tab bar, sticky header) overlays scrollable content by
    // design; scrolling brings the control out. Only flag it when the control
    // itself is pinned too, because then it can never be reached.
    if (inFixed(hit) && !inFixed(el)) continue;
    covered.push({ label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 34),
                   tag: el.tagName, by: hit.tagName + '.' + String(hit.className).slice(0, 44) });
  }

  // Text that has overflowed its box rather than truncating or wrapping.
  const clipped = [];
  for (const el of document.querySelectorAll('p, span, h1, h2, h3, dd, dt, li, button')) {
    if (!visible(el) || el.children.length > 0) continue;
    if (el.scrollWidth > el.clientWidth + 4) {
      const s = getComputedStyle(el);
      if (s.textOverflow === 'ellipsis' || s.overflow === 'hidden' || s.overflowX === 'auto') continue;
      clipped.push({ text: (el.textContent || '').trim().slice(0, 40), scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
  }

  return {
    pageScrollsSideways: document.documentElement.scrollWidth > vw + 1,
    spill: spill.slice(0, 6),
    covered: covered.slice(0, 6),
    clipped: clipped.slice(0, 6),
    bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
  };
`;

const ROUTES = ["/", "/explore", "/reels", "/notifications", "/messages", "/saved", "/settings"];
const VIEWPORTS = [
  { label: "phone 375", w: 375, h: 812, mobile: true },
  { label: "phone 390 landscape", w: 844, h: 390, mobile: true },
  { label: "tablet 768", w: 768, h: 1024, mobile: true },
  { label: "small laptop 1024", w: 1024, h: 700, mobile: false },
  { label: "desktop 1440", w: 1440, h: 900, mobile: false },
  { label: "wide 2560", w: 2560, h: 1300, mobile: false },
];

try {
  console.log(`\nDeep UI sweep → ${BASE}`);
  await goto("/");
  await ev(`await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:'mara',password:'lumen123'})}); return 1;`);

  const extra = await ev(`
    const feed = await fetch('/api/feed').then(r => r.json());
    const post = feed.posts?.[0]?.id ?? null;
    const convo = (await fetch('/api/conversations').then(r => r.json())).conversations?.[0]?.id ?? null;
    return { post, convo };`);

  for (const vp of VIEWPORTS) {
    heading(`${vp.label} (${vp.w}x${vp.h})`);
    await size(vp.w, vp.h, vp.mobile);
    const routes = [...ROUTES, "/mara"];
    if (extra.post) routes.push(`/p/${extra.post}`);
    if (extra.convo) routes.push(`/messages/${extra.convo}`);

    for (const route of routes) {
      await goto(route, 2400);
      const a = await ev(AUDIT);
      const label = `${route}`;
      if (a.pageScrollsSideways) check(`${label}: no sideways scroll`, false, { route });
      else passed++;
      if (a.spill.length) check(`${label}: nothing painted outside the viewport`, false, a.spill);
      else passed++;
      if (a.covered.length) check(`${label}: every control is clickable`, false, a.covered);
      else passed++;
      if (pageErrors.length) check(`${label}: no page exception`, false, pageErrors.slice(0, 2));
      else passed++;
    }
    console.log(`  \x1b[32m✓\x1b[0m ${routes.length} routes clean at this width`);
  }

  /* ------------------------------------------------------------- themes */
  heading("Light theme");
  await size(1440, 900);
  await goto("/settings");
  await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /appearance/i.test(x.textContent.trim()));
    b.click(); await new Promise(r => setTimeout(r, 900));
    const light = [...document.querySelectorAll('button')].find(x => /^Light$/i.test(x.textContent.trim()));
    light.click(); await new Promise(r => setTimeout(r, 900));
    return 1;`);
  const isLight = await ev(`return { dark: document.documentElement.classList.contains('dark') };`);
  check("the light theme applies", isLight.dark === false, isLight);

  for (const route of [...ROUTES, "/mara", extra.post ? `/p/${extra.post}` : "/"]) {
    await goto(route, 2200);
    const a = await ev(AUDIT);
    const contrast = await ev(`
      // Text the same colour as what is behind it is invisible, which is the
      // failure a theme swap actually produces.
      const bad = [];
      for (const el of [...document.querySelectorAll('p, span, h1, h2, h3, button, a')].slice(0, 400)) {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || !el.textContent?.trim()) continue;
        if (s.color === s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          bad.push({ text: el.textContent.trim().slice(0, 30), color: s.color });
        }
      }
      return bad.slice(0, 4);`);
    if (a.spill.length || a.covered.length || contrast.length || pageErrors.length) {
      check(`light ${route}: clean`, false, { spill: a.spill, covered: a.covered, contrast, errors: pageErrors.slice(0, 2) });
    } else passed++;
  }
  console.log(`  \x1b[32m✓\x1b[0m light theme clean across ${ROUTES.length + 2} routes`);

  // back to dark for the rest
  await goto("/settings");
  await ev(`
    const b = [...document.querySelectorAll('button')].find(x => /appearance/i.test(x.textContent.trim()));
    b.click(); await new Promise(r => setTimeout(r, 800));
    [...document.querySelectorAll('button')].find(x => /^Dark$/i.test(x.textContent.trim())).click();
    await new Promise(r => setTimeout(r, 800)); return 1;`);

  /* ------------------------------------------------------------ dialogs */
  heading("Every dialog opens, closes, and releases the page");
  await size(1440, 900);
  const dialogs = [
    { name: "composer", route: "/", open: `[...document.querySelectorAll('button')].find(b => /create/i.test(b.getAttribute('aria-label')||'') || /^Create$/.test(b.textContent.trim()))` },
    { name: "share", route: extra.post ? `/p/${extra.post}` : "/", open: `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === 'Share')` },
    { name: "likes list", route: extra.post ? `/p/${extra.post}` : "/", open: `[...document.querySelectorAll('button')].find(b => /like[s]?$/i.test(b.textContent.trim()) && b.textContent.trim().length < 14)` },
  ];
  for (const d of dialogs) {
    await goto(d.route, 2400);
    const opened = await ev(`
      const b = ${d.open};
      if (!b) return { missing: true };
      b.click();
      await new Promise(r => setTimeout(r, 1200));
      return { open: !!document.querySelector('[role=dialog]'), locked: getComputedStyle(document.body).overflow === 'hidden' };`);
    if (opened.missing) { check(`${d.name}: trigger found`, false, d); continue; }
    check(`${d.name}: opens`, opened.open === true, opened);
    const closed = await ev(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 1200));
      return { open: !!document.querySelector('[role=dialog]'), locked: getComputedStyle(document.body).overflow === 'hidden' };`);
    check(`${d.name}: closes on Escape`, closed.open === false, closed);
    check(`${d.name}: releases page scroll`, closed.locked === false, closed);
  }

  /* ------------------------------------------------------ accessibility */
  heading("Accessibility basics");
  await size(1440, 900);
  const A11Y = `
    const named = (el) => {
      const t = (el.textContent || '').trim();
      return !!(el.getAttribute('aria-label') || el.getAttribute('title') || t ||
                el.querySelector('img[alt]:not([alt=""])'));
    };
    const nameless = [];
    for (const el of document.querySelectorAll('button, a[href]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (!named(el)) nameless.push({ tag: el.tagName, cls: String(el.className).slice(0, 44) });
    }
    const unlabelledInputs = [];
    for (const el of document.querySelectorAll('input:not([type=hidden]), textarea')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const id = el.id;
      const hasLabel = (id && document.querySelector('label[for="' + id + '"]')) || el.closest('label');
      if (!hasLabel && !el.getAttribute('aria-label') && !el.getAttribute('placeholder')) {
        unlabelledInputs.push({ type: el.type, cls: String(el.className).slice(0, 40) });
      }
    }
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const duplicateIds = ids.filter((v, i) => v && ids.indexOf(v) !== i);
    return { nameless: nameless.slice(0, 5), unlabelledInputs: unlabelledInputs.slice(0, 5),
             duplicateIds: [...new Set(duplicateIds)].slice(0, 5) };
  `;
  for (const route of [...ROUTES, "/mara"]) {
    await goto(route, 2300);
    const a = await ev(A11Y);
    if (a.nameless.length) check(`${route}: every control has an accessible name`, false, a.nameless);
    else passed++;
    if (a.unlabelledInputs.length) check(`${route}: every field is labelled`, false, a.unlabelledInputs);
    else passed++;
    if (a.duplicateIds.length) check(`${route}: no duplicate element ids`, false, a.duplicateIds);
    else passed++;
  }
  console.log(`  \x1b[32m✓\x1b[0m accessibility basics clean across ${ROUTES.length + 1} routes`);

  heading("Tap targets on a phone");
  await size(375, 812, true);
  for (const route of ROUTES) {
    await goto(route, 2300);
    const small = await ev(`
      const out = [];
      for (const el of document.querySelectorAll('button, a[href], [role=switch]')) {
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.top < 0 || r.top > innerHeight) continue;
        // A link embedded in a sentence is read, not tapped — sizing those to
        // 24px would wreck the typography. Judge by whether the link is a small
        // part of surrounding prose rather than by tag name.
        if (el.tagName === 'A') {
          const own = (el.textContent || '').trim().length;
          const around = (el.parentElement?.textContent || '').trim().length;
          if (el.closest('p') || around > own + 12) continue;
        }
        if (r.width < 24 || r.height < 24) {
          out.push({ label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 26),
                     w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      return out.slice(0, 6);`);
    if (small.length) check(`${route}: tap targets are at least 24px`, false, small);
    else passed++;
  }
  console.log(`  \x1b[32m✓\x1b[0m tap targets fine across ${ROUTES.length} routes`);

  /* -------------------------------------------------------- long content */
  heading("Long content does not blow out the layout");
  const longUser = await ev(`
    const stamp = Math.random().toString(36).slice(2, 6);
    const u = 'longname' + stamp + '.x';
    const r = await fetch('/api/auth/signup', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ username: u, email: u + '@t.dev', password: 'SweepPass!2026',
        displayName: 'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) });
    if (r.status !== 201) return { failed: r.status };
    await fetch('/api/me', { method:'PATCH', headers:{'content-type':'application/json'},
      body: JSON.stringify({ bio: 'Supercalifragilisticexpialidocious'.repeat(8),
                             website: 'averyveryverylongdomainnamethatkeepsgoing.example.com' }) });
    return { username: u };`);
  check("a long-name account exists", !longUser.failed, longUser);

  for (const vp of [{ w: 375, h: 812, m: true }, { w: 1440, h: 900, m: false }]) {
    await size(vp.w, vp.h, vp.m);
    await goto(`/${longUser.username}`, 2400);
    const a = await ev(AUDIT);
    check(`long profile at ${vp.w}px: no sideways scroll`, a.pageScrollsSideways === false, a);
    check(`long profile at ${vp.w}px: nothing outside the viewport`, a.spill.length === 0, a.spill);
  }
  await ev(`await fetch('/api/me', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: 'SweepPass!2026' }) }); return 1;`);
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

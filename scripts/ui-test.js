/**
 * Walks every route in real Chrome, as a brand-new empty account and as a
 * populated one, collecting page exceptions, failing requests, broken images and
 * layout overflow.
 *
 * Real Chrome rather than a headless DOM because the app leans on
 * IntersectionObserver and autoplay, neither of which runs in a page that is
 * never rendered.
 *
 *   node scripts/ui-test.js [baseUrl]              (needs DISABLE_RATE_LIMITS=1)
 *
 * Requires Google Chrome at the path below; it speaks CDP over Node's built-in
 * WebSocket, so there is no test-runner dependency.
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const BASE = process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-ui-"));
const PORT = 9500 + Math.floor(Math.random() * 90);
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

let id = 1; const pending = new Map();
let consoleErrors = [];
let pageErrors = [];
let failedRequests = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? "").split("\n")[0].slice(0, 200));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  }
  if (m.method === "Network.responseReceived") {
    const { url, status } = m.params.response;
    if (status >= 400 && !url.includes("/favicon")) failedRequests.push(`${status} ${url.replace(BASE, "")}`);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(x) { const r = await send("Runtime.evaluate", { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

function resetLogs() { consoleErrors = []; pageErrors = []; failedRequests = []; }
async function visit(route, { settle = 2600 } = {}) {
  resetLogs();
  await send("Page.navigate", { url: `${BASE}${route}` });
  await wait(settle);
  return ev(`
    const root = document.getElementById('root');
    const text = document.body.innerText.trim();
    return {
      url: location.pathname,
      mounted: !!root && root.children.length > 0,
      textLen: text.length,
      text: text.slice(0, 160),
      hasCrashText: /something went wrong|unexpected error|cannot read|undefined is not/i.test(text),
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      brokenImages: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src.slice(-60)),
    };
  `);
}

const ROUTES = ["/", "/explore", "/reels", "/notifications", "/messages", "/saved", "/settings", "/nonexistent-page-xyz"];

try {
  console.log(`\nUI sweep → ${BASE}`);

  /* ------------------------------------------- brand-new empty account */
  heading("A brand-new account with no content at all");
  await send("Page.navigate", { url: `${BASE}/` }); await wait(2000);
  const stamp = Math.random().toString(36).slice(2, 8);
  const fresh = await ev(`
    const r = await fetch('/api/auth/signup', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ username: 'sweep${stamp}', email: 'sweep${stamp}@bughunt.dev', password: 'BugHunt!2026' }) });
    const j = await r.json();
    return { status: r.status, username: j.user?.username };
  `);
  check("a fresh account signs up", fresh.status === 201, fresh);

  for (const route of [...ROUTES, `/${fresh.username}`]) {
    const v = await visit(route);
    const label = route === "/nonexistent-page-xyz" ? "404 page" : route;
    check(`${label} renders something`, v.mounted && v.textLen > 0, v);
    check(`${label} shows no crash text`, !v.hasCrashText, v.text);
    check(`${label} logs no page exception`, pageErrors.length === 0, pageErrors.slice(0, 2));
    check(`${label} has no broken images`, v.brokenImages.length === 0, v.brokenImages);
    // 401/403/404 are legitimate answers here: signed-out probes, private
    // content, and /nonexistent-page-xyz resolving as an unknown username.
    const unexpected = failedRequests.filter((f) => !/^40[134] /.test(f));
    check(`${label} makes no failing requests`, unexpected.length === 0, unexpected.slice(0, 4));
  }

  /* ------------------------------------------------ empty-state copy */
  heading("Empty states actually say something useful");
  for (const [route, label] of [["/", "feed"], ["/notifications", "notifications"], ["/messages", "messages"], ["/saved", "saved"]]) {
    const v = await visit(route);
    check(`${label} offers guidance rather than a blank panel`, v.textLen > 40, { len: v.textLen, text: v.text });
  }

  /* ---------------------------------------------- populated account */
  heading("A populated account");
  await ev(`await fetch('/api/auth/logout', { method: 'POST' }); return 1;`);
  await send("Page.navigate", { url: `${BASE}/` }); await wait(1500);
  const login = await ev(`
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ identifier: 'mara', password: 'lumen123' }) });
    return { status: r.status };
  `);
  check("the demo account signs in", login.status === 200, login);

  const firstPost = await ev(`const r = await fetch('/api/feed').then(r=>r.json()); return r.posts?.[0]?.id ?? null;`);
  const routes2 = [...ROUTES, "/mara", "/tags/reels"];
  if (firstPost) routes2.push(`/p/${firstPost}`);
  for (const route of routes2) {
    const v = await visit(route);
    const label = route === "/nonexistent-page-xyz" ? "404 page" : route;
    check(`${label} renders`, v.mounted && v.textLen > 0, v);
    check(`${label} shows no crash text`, !v.hasCrashText, v.text);
    check(`${label} logs no page exception`, pageErrors.length === 0, pageErrors.slice(0, 2));
    check(`${label} does not scroll sideways`, !v.horizontalScroll, v);
    const unexpected = failedRequests.filter((f) => !/^40[134] /.test(f));
    check(`${label} makes no failing requests`, unexpected.length === 0, unexpected.slice(0, 4));
  }

  /* ------------------------------------------------- mobile widths */
  heading("Mobile (390x844) has no layout overflow");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const route of ["/", "/explore", "/reels", "/notifications", "/messages", "/saved", "/settings", "/mara"]) {
    const v = await visit(route);
    check(`${route} fits the phone width`, !v.horizontalScroll, { route, scroll: v.horizontalScroll });
  }
  await send("Emulation.clearDeviceMetricsOverride");

  /* --------------------------------------------------- signed out */
  heading("Signed out");
  await ev(`await fetch('/api/auth/logout', { method: 'POST' }); return 1;`);
  for (const route of ["/", "/explore", "/reels", "/settings", "/messages"]) {
    const v = await visit(route);
    check(`${route} redirects to sign-in rather than breaking`,
      v.url.startsWith("/auth") || /sign in|log in|welcome/i.test(v.text), { url: v.url, text: v.text.slice(0, 80) });
  }
  const authPage = await visit("/auth");
  check("the sign-in page renders", authPage.mounted && authPage.textLen > 20, authPage);
  check("the sign-in page logs no exception", pageErrors.length === 0, pageErrors.slice(0, 2));
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

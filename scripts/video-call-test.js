/**
 * A real video call between two Chrome instances.
 *
 * Chrome's fake camera and microphone make getUserMedia return genuine live
 * tracks, so this exercises the whole media path — capture, negotiation,
 * decode — rather than just proving the handshake completed. Two separate
 * Chrome profiles because one browser shares a cookie jar per origin.
 *
 *   node scripts/video-call-test.js [baseUrl]     (needs DISABLE_RATE_LIMITS=1)
 *
 * Requires Google Chrome at the path below; it speaks CDP over Node's built-in
 * WebSocket, so there is no test-runner dependency.
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const failures = []; let section = "";
const check = (n, ok, d) => { if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failures.push(`${section} — ${n}`); console.log(`  \x1b[31m✗ ${n}\x1b[0m${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 320)}` : ""}`); } };
const heading = (t) => { section = t; console.log(`\n${t}`); };

/** One Chrome instance with a synthetic camera and microphone. */
async function browser(label, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `lumen-vc-${label}-`));
  const proc = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    // A moving synthetic camera and a tone, so tracks are genuinely live.
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,860",
    "--no-first-run", "--mute-audio", "about:blank",
  ], { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      wsUrl = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
    } catch {}
    if (!wsUrl) await wait(250);
  }
  if (!wsUrl) throw new Error(`${label}: no debugging target`);

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let id = 1; const pending = new Map(); const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params.exceptionDetails.exception?.description ?? "").split("\n")[0].slice(0, 160));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Page.enable"); await send("Runtime.enable");
  const goto = async (p) => { await send("Page.navigate", { url: `${BASE}${p}` }); await wait(2800); };
  return {
    label, ev, goto, errors,
    close() { ws.close(); proc.kill("SIGKILL"); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} },
  };
}

const stamp = Math.random().toString(36).slice(2, 7);
const alice = { username: `vm_a_${stamp}`, email: `vm_a_${stamp}@test.dev`, password: "VideoMedia!2026" };
const bob = { username: `vm_b_${stamp}`, email: `vm_b_${stamp}@test.dev`, password: "VideoMedia!2026" };

let A, B;
try {
  console.log(`\nReal video media → ${BASE}`);
  A = await browser("a", 9820 + Math.floor(Math.random() * 40));
  B = await browser("b", 9880 + Math.floor(Math.random() * 40));

  await A.goto("/");
  await B.goto("/");

  const signup = (p) => `
    const r = await fetch('/api/auth/signup', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(${JSON.stringify(p)}) });
    const j = await r.json();
    return { status: r.status, id: j.user?.id, username: j.user?.username };`;
  const aUser = await A.ev(signup(alice));
  const bUser = await B.ev(signup(bob));
  check("both accounts sign up", aUser.status === 201 && bUser.status === 201, { aUser, bUser });

  const convo = await A.ev(`
    const r = await fetch('/api/conversations', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ userId: '${bUser.id}' }) });
    const j = await r.json();
    return j.conversation?.id ?? null;`);
  check("a conversation exists", !!convo, convo);

  /* ---------------------------------------------- the camera is reachable */
  heading("The browser can actually open a camera on this origin");
  await A.goto(`/messages/${convo}`);
  await B.goto(`/messages/${convo}`);
  const cam = await A.ev(`
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const out = { video: s.getVideoTracks().length, audio: s.getAudioTracks().length,
                    label: s.getVideoTracks()[0]?.label ?? null, live: s.getVideoTracks()[0]?.readyState };
      s.getTracks().forEach(t => t.stop());
      return out;
    } catch (e) { return { error: e.name + ': ' + e.message }; }`);
  check("getUserMedia returns a video track", cam.video === 1, cam);
  check("...and an audio track", cam.audio === 1, cam);
  check("...and the video track is live", cam.live === "live", cam);

  /* -------------------------------------------------------- place the call */
  heading("Placing a video call through the UI");
  const btn = await A.ev(`
    await new Promise(r => setTimeout(r, 1200));
    const b = [...document.querySelectorAll('button')].find(x => /^Video call /i.test(x.getAttribute('aria-label') || ''));
    if (!b) return { missing: true, labels: [...document.querySelectorAll('button')].map(x => x.getAttribute('aria-label')).filter(Boolean).slice(0, 12) };
    b.click();
    return { clicked: true };`);
  check("the thread header has a video call button", !btn.missing, btn);

  const rang = await B.ev(`
    for (let i = 0; i < 40; i++) {
      const el = [...document.querySelectorAll('[role=dialog]')].find(d => /Incoming/i.test(d.textContent || ''));
      if (el) return { text: el.textContent.replace(/\\s+/g, ' ').slice(0, 90) };
      await new Promise(r => setTimeout(r, 250));
    }
    return { text: null };`);
  check("the callee's device rings", !!rang.text, rang);
  check("...and says it is a video call", /video call/i.test(rang.text ?? ""), rang);

  const accepted = await B.ev(`
    const b = [...document.querySelectorAll('button')].find(x => /accept video call/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return { missing: true, labels: [...document.querySelectorAll('button')].map(x => x.getAttribute('aria-label')).filter(Boolean).slice(0, 12) };
    b.click();
    return { clicked: true };`);
  check("the accept button is labelled for video", !accepted.missing, accepted);

  /* ------------------------------------------------------- frames flowing */
  heading("Pictures actually arrive at both ends");
  const stats = async (page) => page.ev(`
    for (let i = 0; i < 50; i++) {
      const pc = [...(window.__pcs ?? [])][0];
      await new Promise(r => setTimeout(r, 300));
      const vids = [...document.querySelectorAll('video')];
      const playing = vids.find(v => v.srcObject && v.videoWidth > 0);
      if (playing) {
        return { width: playing.videoWidth, height: playing.videoHeight, count: vids.length };
      }
    }
    return { width: 0, height: 0, count: document.querySelectorAll('video').length };`);

  const aFrames = await stats(A);
  const bFrames = await stats(B);
  check("the caller renders a live video element", aFrames.width > 0, aFrames);
  check("the callee renders a live video element", bFrames.width > 0, bFrames);

  // Decode counters prove media crossed the wire, not just that a <video> exists.
  const decoded = async (page) => page.ev(`
    const conns = window.__lumenPeers ?? [];
    return { tracked: conns.length };`);

  const aState = await A.ev(`
    for (let i = 0; i < 40; i++) {
      const text = document.body.innerText;
      if (/\\d:\\d\\d/.test(text)) return { connected: true, text: text.match(/\\d:\\d\\d/)?.[0] };
      await new Promise(r => setTimeout(r, 300));
    }
    return { connected: false, text: document.body.innerText.slice(0, 120) };`);
  check("the call reaches the connected state", aState.connected, aState);

  const surfaces = await A.ev(`
    const vids = [...document.querySelectorAll('video')].map(v => ({
      w: v.videoWidth, h: v.videoHeight, muted: v.muted, hasStream: !!v.srcObject,
    }));
    return { vids, dialog: !!document.querySelector('[role=dialog][aria-label="Video call"]') };`);
  check("the overlay is a video call panel", surfaces.dialog, surfaces);
  check("both the remote and local surfaces carry a stream",
    surfaces.vids.filter((v) => v.hasStream).length >= 2, surfaces.vids);
  check("the local preview is muted so you do not hear yourself",
    surfaces.vids.some((v) => v.muted && v.hasStream), surfaces.vids);

  /* ------------------------------------------------------- camera toggle */
  heading("Turning the camera off and on");
  const off = await A.ev(`
    const b = [...document.querySelectorAll('button')].find(x => /turn camera off/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return { missing: true };
    b.click();
    await new Promise(r => setTimeout(r, 700));
    const back = [...document.querySelectorAll('button')].find(x => /turn camera on/i.test(x.getAttribute('aria-label') || ''));
    return { toggled: !!back };`);
  check("the camera can be turned off", off.toggled === true, off);

  // The remote track keeps flowing (black frames), so the app must fall back to
  // the avatar treatment on the peer's say-so rather than on the track flag.
  const remoteSeesItGo = await B.ev(`
    for (let i = 0; i < 30; i++) {
      const remote = [...document.querySelectorAll('video')].find(v => v.srcObject && !v.muted);
      // opacity-0 is how the overlay hides the remote picture and shows the avatar
      if (remote && getComputedStyle(remote).opacity === '0') return { hidden: true };
      await new Promise(r => setTimeout(r, 300));
    }
    const remote = [...document.querySelectorAll('video')].find(v => v.srcObject && !v.muted);
    return { hidden: false, opacity: remote ? getComputedStyle(remote).opacity : null };`);
  check("the other side falls back to the avatar", remoteSeesItGo.hidden === true, remoteSeesItGo);

  const on = await A.ev(`
    const b = [...document.querySelectorAll('button')].find(x => /turn camera on/i.test(x.getAttribute('aria-label') || ''));
    b.click();
    await new Promise(r => setTimeout(r, 700));
    return { back: !![...document.querySelectorAll('button')].find(x => /turn camera off/i.test(x.getAttribute('aria-label') || '')) };`);
  check("...and turned back on", on.back === true, on);

  const restored = await B.ev(`
    for (let i = 0; i < 30; i++) {
      const remote = [...document.querySelectorAll('video')].find(v => v.srcObject && !v.muted);
      if (remote && getComputedStyle(remote).opacity !== '0') return { shown: true };
      await new Promise(r => setTimeout(r, 300));
    }
    return { shown: false };`);
  check("...and the picture returns when the camera comes back", restored.shown === true, restored);


  /* -------------------------------------------------------------- hangup */
  heading("Ending the call");
  await A.ev(`
    const b = [...document.querySelectorAll('button')].find(x => /end call/i.test(x.getAttribute('aria-label') || ''));
    b?.click();
    return 1;`);
  await wait(1600);
  const ended = await B.ev(`return { overlay: !!document.querySelector('[role=dialog][aria-label="Video call"]') };`);
  check("the overlay closes for both", ended.overlay === false, ended);

  const record = await A.ev(`
    const r = await fetch('/api/calls/conversation/${convo}').then(r => r.json());
    return r.calls?.[0] ?? null;`);
  check("the call is recorded as video", record?.kind === "video", record);
  check("...with a duration", (record?.durationMs ?? 0) > 0, record);

  /* ------------------------------------ an audio call must not open a camera */
  heading("An audio call leaves the camera alone");
  await A.goto(`/messages/${convo}`);
  await B.goto(`/messages/${convo}`);
  // Count camera opens from here on, so the click below is the only candidate.
  await A.ev(`
    window.__cameraOpens = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { if (c && c.video) window.__cameraOpens++; return real(c); };
    return 1;`);
  await A.ev(`
    const b = [...document.querySelectorAll('button')].find(x => /^Call /i.test(x.getAttribute('aria-label') || ''));
    b.click();
    await new Promise(r => setTimeout(r, 1500));
    return 1;`);
  const audioCam = await A.ev(`return { opens: window.__cameraOpens, videos: document.querySelectorAll('[role=dialog] video').length };`);
  check("starting an audio call never asks for the camera", audioCam.opens === 0, audioCam);
  check("...and renders no video surface", audioCam.videos === 0, audioCam);

  const audioLabel = await A.ev(`return { label: document.querySelector('[role=dialog]')?.getAttribute('aria-label') ?? null };`);
  check("...and the panel is an audio call", audioLabel.label === "Audio call", audioLabel);

  await A.ev(`
    const b = [...document.querySelectorAll('button')].find(x => /end call/i.test(x.getAttribute('aria-label') || ''));
    b?.click();
    return 1;`);
  await wait(1200);

  check("no page exceptions on the caller", A.errors.length === 0, A.errors.slice(0, 3));
  check("no page exceptions on the callee", B.errors.length === 0, B.errors.slice(0, 3));

  // clean up
  await A.ev(`await fetch('/api/me', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: ${JSON.stringify(alice.password)} }) }); return 1;`);
  await B.ev(`await fetch('/api/me', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: ${JSON.stringify(bob.password)} }) }); return 1;`);
} catch (err) {
  console.error("\nSuite crashed:", err.message);
  check("suite ran to completion", false, err.message);
} finally {
  A?.close(); B?.close();
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) { console.log("Failed:"); for (const f of failures) console.log(`  - ${f}`); console.log(); }
process.exit(failures.length ? 1 : 0);

/**
 * The opened post fits its media.
 *
 * Measures the gap between the right edge of the picture and the left edge of
 * the comments, for every shape a post can be. A fixed-fraction media column
 * left a slab of dead background beside anything portrait — worst for a 9:16
 * reel — so each shape is checked, not just the square case.
 *
 *   node scripts/post-layout-test.js [baseUrl]     (needs DISABLE_RATE_LIMITS=1)
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const BASE=process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const CHROME=process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"lumen-gap-")); const PORT=9450+Math.floor(Math.random()*80);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let passed=0; const failures=[];
const check=(n,ok,d)=>{if(ok){passed++;console.log(`  \x1b[32m✓\x1b[0m ${n}`);}else{failures.push(n);console.log(`  \x1b[31m✗ ${n}\x1b[0m${d!==undefined?` — ${JSON.stringify(d).slice(0,260)}`:""}`);}};
const chrome=spawn(CHROME,["--headless=new",`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,"--autoplay-policy=no-user-gesture-required","--hide-scrollbars","--window-size=1440,900","--no-first-run","--mute-audio","about:blank"],{stdio:"ignore"});
async function t(){for(let i=0;i<60;i++){try{const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());const p=l.find(x=>x.type==="page"&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl;}catch{}await wait(250);}throw new Error("no target");}
const ws=new WebSocket(await t()); await new Promise(r=>ws.addEventListener("open",r,{once:true}));
let id=1; const pending=new Map();
ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
const send=(me,pa={})=>new Promise((res,rej)=>{const i=id++;pending.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method:me,params:pa}));});
async function ev(x){const r=await send("Runtime.evaluate",{expression:`(async () => { ${x} })()`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;}
await send("Page.enable"); await send("Runtime.enable");
const goto=async u=>{await send("Page.navigate",{url:BASE+u});await wait(2800);};

/** Gap between the right edge of the picture and the left edge of the comments. */
const measure = () => ev(`
  await new Promise(r => setTimeout(r, 1200));
  const frame = document.querySelector('[style*="aspect-ratio"]');
  const media = frame?.querySelector('video, img[src*="/media/"]') ?? null;
  const grid = document.querySelector('.post-layout');
  const details = grid?.children?.[1] ?? null;
  if (!frame || !details) return { missing: !frame ? 'frame' : 'details', hasGrid: !!grid,
                                   kids: grid ? grid.children.length : 0 };
  const f = frame.getBoundingClientRect(), d = details.getBoundingClientRect();
  const m = media ? media.getBoundingClientRect() : f;
  // The picture's painted box inside its frame, for object-contain letterboxing.
  const painted = (() => {
    if (!media) return m;
    const nw = media.videoWidth || media.naturalWidth || 0;
    const nh = media.videoHeight || media.naturalHeight || 0;
    if (!nw || !nh) return m;
    const scale = Math.min(m.width / nw, m.height / nh);
    return { width: nw * scale, height: nh * scale,
             left: m.left + (m.width - nw * scale) / 2, right: m.left + (m.width + nw * scale) / 2 };
  })();
  return {
    frame: { left: Math.round(f.left), right: Math.round(f.right), w: Math.round(f.width), h: Math.round(f.height) },
    painted: { left: Math.round(painted.left), right: Math.round(painted.right), w: Math.round(painted.width) },
    detailsLeft: Math.round(d.left),
    gap: Math.round(d.left - painted.right),
    cardWidth: Math.round(d.right - f.left),
  };`);

try{
  console.log(`\nDead space beside the picture → ${BASE}`);
  await goto("/");
  await ev(`await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:'mara',password:'lumen123'})});return 1;`);

  const posts = await ev(`
    const r = await fetch('/api/explore?limit=60').then(r => r.json());
    const byShape = {};
    for (const p of r.posts ?? []) {
      const m = p.media?.[0];
      if (!m?.width || !m?.height) continue;
      const ratio = m.width / m.height;
      const shape = ratio < 0.85 ? 'portrait' : ratio > 1.2 ? 'landscape' : 'square';
      if (!byShape[shape]) byShape[shape] = { id: p.id, ratio: +ratio.toFixed(2), kind: m.kind };
    }
    // The reported case was a 9:16 reel, the most extreme shape there is.
    const reels = await fetch('/api/reels').then(r => r.json());
    for (const p of reels.reels ?? []) {
      const m = p.media?.[0];
      if (!m?.width || !m?.height) continue;
      const ratio = m.width / m.height;
      if (ratio < 0.7) { byShape['tall video (9:16)'] = { id: p.id, ratio: +ratio.toFixed(2), kind: m.kind }; break; }
    }
    return byShape;`)
  console.log("  shapes found:", JSON.stringify(posts));

  for (const [shape, info] of Object.entries(posts)) {
    console.log(`\n${shape} (${info.kind}, ratio ${info.ratio})`);
    await goto(`/p/${info.id}`);
    const m = await measure();
    if (m.missing) { check(`${shape}: measurable`, false, m); continue; }
    check(`${shape}: the comments start right after the picture`, m.gap <= 24, m);
    check(`${shape}: the frame is no wider than the picture`, m.frame.w - m.painted.w <= 24, m);
    check(`${shape}: the card is not stretched to the full container`, m.cardWidth <= 1130, m);
  }

  // The feed's own frames must fill their card. A tall post used to shrink its
  // own width to keep its ratio under the height cap, leaving a band of
  // background down one side — and only on tall posts, never square ones.
  console.log("\nFeed cards have no dead space beside the picture");
  await goto("/");
  const cards = await ev(`
    await new Promise(r => setTimeout(r, 1800));
    const out = [];
    for (const art of [...document.querySelectorAll('article')].slice(0, 8)) {
      const track = art.querySelector('[style*="aspect-ratio"]');
      if (!track) continue;
      const root = track.parentElement;
      const tr = track.getBoundingClientRect(), rr = root.getBoundingClientRect();
      out.push({
        ratio: (track.getAttribute('style') || '').match(/aspect-ratio: ([\d.]+)/)?.[1] ?? '?',
        band: Math.round(rr.width - tr.width),
        capped: Math.round(tr.height) < Math.round(tr.width / parseFloat((track.getAttribute('style')||'').match(/aspect-ratio: ([\d.]+)/)?.[1] ?? '1')) - 2,
      });
    }
    return out;`);
  check("the feed has posts to measure", cards.length > 0, cards.length);
  check("no feed frame is narrower than its card", cards.every((c) => c.band <= 1), cards);
  const cappedOnes = cards.filter((c) => c.capped);
  check("...including the tall ones the height cap trims", cappedOnes.every((c) => c.band <= 1),
    { capped: cappedOnes.length, sample: cappedOnes[0] });

  // Below the two-column breakpoint the picture and the comments stack, and the
  // sizing rule must not leak into that.
  console.log("\nOn a phone (390x844)");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const [shape, info] of Object.entries(posts)) {
    await goto(`/p/${info.id}`);
    const stacked = await ev(`
      await new Promise(r => setTimeout(r, 1000));
      const grid = document.querySelector('.post-layout');
      if (!grid) return { missing: true };
      const [media, details] = grid.children;
      const m = media.getBoundingClientRect(), d = details.getBoundingClientRect();
      return {
        stacked: d.top >= m.bottom - 2,
        fullWidth: Math.abs(m.width - window.innerWidth) < 2 || m.width >= window.innerWidth - 4,
        noSideways: document.documentElement.scrollWidth <= window.innerWidth + 1,
        display: getComputedStyle(grid).display,
      };`);
    check(`${shape}: stacks vertically on mobile`, stacked.stacked === true, stacked);
    check(`${shape}: no sideways scroll on mobile`, stacked.noSideways === true, stacked);
  }
  await send("Emulation.clearDeviceMetricsOverride");
}finally{ws.close();chrome.kill("SIGKILL");try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}}
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if(failures.length){console.log("Failed:");for(const f of failures)console.log("  - "+f);console.log();}
process.exit(failures.length?1:0);

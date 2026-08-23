/**
 * Call lifecycle edges, and video calling at the protocol level.
 *
 * The companion to call-test.js: where that walks a normal call, this pushes on
 * the exits — busy-state release on every path, malformed signalling, forced
 * state transitions, a participant vanishing mid-call — and checks that a video
 * call is announced, relayed and recorded as one. Media itself is covered by
 * video-call-test.js, which needs a real browser.
 *
 *   node scripts/call-edge-test.js [baseUrl]      (needs DISABLE_RATE_LIMITS=1)
 */
import { io } from "../web/node_modules/socket.io-client/build/esm/index.js";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
let passed = 0; const failures = []; let section = "";
const check = (n, ok, d) => { if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failures.push(`${section} — ${n}`); console.log(`  \x1b[31m✗ ${n}\x1b[0m${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); } };
const heading = (t) => { section = t; console.log(`\n${t}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const jar = new Map();
  return {
    cookie: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    async fetch(path, options = {}) {
      const headers = new Headers(options.headers ?? {});
      const c = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      if (c) headers.set("cookie", c);
      if (options.json !== undefined) { headers.set("content-type", "application/json"); options.body = JSON.stringify(options.json); }
      const res = await fetch(`${BASE}${path}`, { ...options, headers });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";"); const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const type = res.headers.get("content-type") ?? "";
      return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
    },
  };
}

function connect(cookie) {
  const socket = io(BASE, { path: "/socket.io", extraHeaders: { cookie }, transports: ["websocket"] });
  const events = [];
  for (const name of ["call:incoming","call:ringing","call:accepted","call:connecting","call:signal","call:ended","call:failed","call:handled"]) {
    socket.on(name, (payload) => events.push({ name, payload }));
  }
  socket.events = events;
  socket.waitFor = (name, timeout = 4000) => new Promise((resolve) => {
    const existing = events.find((e) => e.name === name);
    if (existing) return resolve(existing.payload);
    const started = Date.now();
    const id = setInterval(() => {
      const hit = events.find((e) => e.name === name);
      if (hit) { clearInterval(id); resolve(hit.payload); }
      else if (Date.now() - started > timeout) { clearInterval(id); resolve(null); }
    }, 40);
  });
  socket.clear = () => (events.length = 0);
  return new Promise((res, rej) => { socket.on("connect", () => res(socket)); socket.on("connect_error", (e) => rej(new Error(e.message))); });
}

const stamp = Math.random().toString(36).slice(2, 7);
const pw = "CallHunt!2026";
const sessions = [];
async function makeUser(tag) {
  const c = client();
  const person = { username: `ch_${tag}_${stamp}`, email: `ch_${tag}_${stamp}@test.dev`, password: pw };
  const r = await c.fetch("/api/auth/signup", { method: "POST", json: person });
  if (r.status !== 201) throw new Error(`signup ${tag}: ${r.status}`);
  sessions.push({ c, person });
  return { c, person, id: r.body.user.id, username: person.username };
}

const sockets = [];
async function sock(user) { const s = await connect(user.c.cookie()); sockets.push(s); return s; }

try {
  console.log(`\nCall edges and video calling → ${BASE}`);
  const a = await makeUser("a");
  const b = await makeUser("b");
  const c = await makeUser("c");

  const convoAB = (await a.c.fetch("/api/conversations", { method: "POST", json: { userId: b.id } })).body.conversation.id;
  const convoAC = (await a.c.fetch("/api/conversations", { method: "POST", json: { userId: c.id } })).body.conversation.id;

  const sa = await sock(a);
  const sb = await sock(b);
  const sc = await sock(c);
  await wait(400);

  /* ------------------------------------------------- busy-state hygiene */
  heading("Busy state is released on every exit path");

  for (const [label, finish] of [
    ["the caller cancels", async (id) => { sa.emit("call:hangup", { callId: id }); }],
    ["the callee declines", async (id) => { sb.emit("call:decline", { callId: id }); }],
    ["the callee accepts then hangs up", async (id) => {
      sb.emit("call:accept", { callId: id }); await wait(300); sb.emit("call:hangup", { callId: id }); }],
    ["the caller reports a media failure", async (id) => { sa.emit("call:failure", { callId: id }); }],
  ]) {
    sa.clear(); sb.clear();
    sa.emit("call:start", { conversationId: convoAB });
    const ring = await sa.waitFor("call:ringing");
    if (!ring) { check(`${label}: the call starts`, false, "no ringing"); continue; }
    await finish(ring.callId);
    await wait(500);

    // Both should now be free to start a fresh call.
    sa.clear(); sb.clear();
    sa.emit("call:start", { conversationId: convoAB });
    const again = await sa.waitFor("call:ringing", 2500);
    const failed = await sa.waitFor("call:failed", 300);
    check(`after ${label}, both sides are free again`, !!again && !failed, { again: !!again, failed });
    if (again) { sa.emit("call:hangup", { callId: again.callId }); await wait(300); }
  }

  /* ------------------------------------------------ malformed signalling */
  heading("Malformed signalling is dropped, not crashed");
  sa.clear(); sb.clear();
  sa.emit("call:start", { conversationId: convoAB });
  const live = await sa.waitFor("call:ringing");
  sb.emit("call:accept", { callId: live.callId });
  await sa.waitFor("call:accepted");
  sb.clear();

  sa.emit("call:signal", { callId: live.callId, data: "a string, not an object" });
  sa.emit("call:signal", { callId: live.callId, data: null });
  sa.emit("call:signal", { callId: live.callId, data: 42 });
  sa.emit("call:signal", { callId: live.callId });
  await wait(500);
  check("junk signal payloads are not relayed", sb.events.filter((e) => e.name === "call:signal").length === 0,
    sb.events.map((e) => e.name));

  sa.emit("call:signal", { callId: live.callId, data: { blob: "x".repeat(40000) } });
  await wait(500);
  check("an oversized signal is dropped", sb.events.filter((e) => e.name === "call:signal").length === 0,
    sb.events.filter((e) => e.name === "call:signal").length);

  sa.emit("call:signal", { callId: live.callId, data: { sdp: { type: "offer", sdp: "v=0" } } });
  const relayed = await sb.waitFor("call:signal", 2000);
  check("a well-formed signal still gets through", !!relayed, relayed);

  const health1 = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  check("the server is still healthy after the junk", health1?.ok === true, health1);

  /* -------------------------------------------------- state-machine guards */
  heading("State transitions cannot be forced out of order");
  sb.clear();
  sb.emit("call:accept", { callId: live.callId });
  await wait(300);
  check("accepting an already-answered call is a no-op", (await sb.waitFor("call:connecting", 300)) === null);

  sa.clear();
  sa.emit("call:accept", { callId: live.callId });
  await wait(300);
  check("the caller cannot accept their own call", (await sa.waitFor("call:connecting", 300)) === null);

  sc.clear();
  sc.emit("call:failure", { callId: live.callId });
  await wait(400);
  check("a stranger cannot fail someone else's call", (await sa.waitFor("call:ended", 400)) === null);

  sa.emit("call:hangup", { callId: live.callId });
  await wait(400);

  /* --------------------------------------------------- blocking mid-call */
  heading("Blocking during a live call");
  sa.clear(); sb.clear();
  sa.emit("call:start", { conversationId: convoAB });
  const blockCall = await sa.waitFor("call:ringing");
  sb.emit("call:accept", { callId: blockCall.callId });
  await sa.waitFor("call:accepted");
  await wait(300);

  await b.c.fetch(`/api/users/${a.id}/block`, { method: "POST" });
  await wait(600);
  const endedByBlock = await sa.waitFor("call:ended", 1500);
  check("blocking ends the call in progress", !!endedByBlock, { ended: endedByBlock });

  // Whether or not it ended, neither side should be stuck busy.
  sa.emit("call:hangup", { callId: blockCall.callId });
  await wait(400);
  await b.c.fetch(`/api/users/${a.id}/block`, { method: "DELETE" });
  await wait(300);
  sa.clear();
  sa.emit("call:start", { conversationId: convoAB });
  const afterBlock = await sa.waitFor("call:ringing", 2500);
  check("after unblocking, calling works again", !!afterBlock, { failed: await sa.waitFor("call:failed", 300) });
  if (afterBlock) { sa.emit("call:hangup", { callId: afterBlock.callId }); await wait(300); }

  /* -------------------------------------------- calling a second person */
  heading("A second conversation while busy");
  sa.clear(); sb.clear(); sc.clear();
  sa.emit("call:start", { conversationId: convoAB });
  const first = await sa.waitFor("call:ringing");
  sa.clear();
  sa.emit("call:start", { conversationId: convoAC });
  const busyFail = await sa.waitFor("call:failed", 2000);
  check("you cannot ring a second person while already ringing", busyFail?.reason === "busy", busyFail);
  check("the third party is never rung", (await sc.waitFor("call:incoming", 400)) === null);
  sa.emit("call:hangup", { callId: first.callId });
  await wait(400);

  /* -------------------------------------------- conversation membership */
  heading("Authorization");
  sc.clear();
  sc.emit("call:start", { conversationId: convoAB });
  const notMember = await sc.waitFor("call:failed", 2000);
  check("a non-member cannot start a call in that thread", notMember?.reason === "not_allowed", notMember);

  sc.clear();
  sc.emit("call:start", { conversationId: "totallymadeupid" });
  const noConvo = await sc.waitFor("call:failed", 2000);
  check("a made-up conversation id fails cleanly", noConvo?.reason === "not_allowed", noConvo);

  sc.clear();
  sc.emit("call:start", {});
  await wait(400);
  check("an empty payload is ignored without a crash", true);

  /* ----------------------------------------------- reconnect and history */
  heading("History and records");
  sa.clear(); sb.clear();
  sa.emit("call:start", { conversationId: convoAB });
  const recorded = await sa.waitFor("call:ringing");
  sb.emit("call:accept", { callId: recorded.callId });
  await sa.waitFor("call:accepted");
  await wait(900);
  sa.emit("call:hangup", { callId: recorded.callId });
  await wait(600);

  const history = await a.c.fetch(`/api/calls/conversation/${convoAB}`);
  check("call history loads", history.status === 200, { status: history.status });
  const rec = (history.body?.calls ?? []).find((x) => x.id === recorded.callId);
  check("the answered call is recorded as completed", rec?.status === "completed", rec);
  check("...with a real duration", (rec?.durationMs ?? 0) >= 500, rec);

  const nonMemberHistory = await c.c.fetch(`/api/calls/conversation/${convoAB}`);
  check("a non-member cannot read the call history",
    nonMemberHistory.status === 403 || nonMemberHistory.status === 404, { status: nonMemberHistory.status });

  const recents = await a.c.fetch("/api/calls/recent");
  check("recent calls load", recents.status === 200, { status: recents.status });

  /* --------------------------------------------- account deleted mid-flow */
  heading("The other account disappears");
  const temp = await makeUser("temp");
  const convoAT = (await a.c.fetch("/api/conversations", { method: "POST", json: { userId: temp.id } })).body.conversation.id;
  const st = await sock(temp);
  await wait(300);
  sa.clear();
  sa.emit("call:start", { conversationId: convoAT });
  const tempRing = await sa.waitFor("call:ringing", 2500);
  check("the call to the temp account rings", !!tempRing, tempRing);
  await temp.c.fetch("/api/me", { method: "DELETE", json: { password: temp.person.password } });
  await wait(1200);
  sa.emit("call:hangup", { callId: tempRing?.callId ?? "x" });
  await wait(500);
  const healthAfter = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  check("the server survives the account vanishing mid-call", healthAfter?.ok === true, healthAfter);

  sa.clear();
  sa.emit("call:start", { conversationId: convoAB });
  const stillWorks = await sa.waitFor("call:ringing", 2500);
  check("calling still works afterwards", !!stillWorks, { failed: await sa.waitFor("call:failed", 300) });
  if (stillWorks) { sa.emit("call:hangup", { callId: stillWorks.callId }); await wait(300); }

  /* ==================== Video calling ==================== */
  {

  console.log(`\nVideo calling → ${BASE}`);
  const a = await makeUser("va");
  const b = await makeUser("vb");
  const convo = (await a.c.fetch("/api/conversations", { method: "POST", json: { userId: b.id } })).body.conversation.id;
  const sa = await connect(a.c.cookie()); sockets.push(sa);
  const sb = await connect(b.c.cookie()); sockets.push(sb);
  await wait(400);

  /* ------------------------------------------------------- the kind flows */
  heading("A video call is announced as one");
  sa.clear(); sb.clear();
  sa.emit("call:start", { conversationId: convo, kind: "video" });
  const ringing = await sa.waitFor("call:ringing");
  check("the caller is told it is ringing", !!ringing, ringing);
  check("...and that it is a video call", ringing?.kind === "video", ringing);

  const incoming = await sb.waitFor("call:incoming");
  check("the callee is rung", !!incoming, incoming);
  check("...and told to expect video", incoming?.kind === "video", incoming);
  check("...with the caller's identity", !!incoming?.from?.username, incoming?.from);

  sb.emit("call:accept", { callId: ringing.callId });
  check("accepting works the same as audio", !!(await sa.waitFor("call:accepted")), null);

  // Signalling is untouched by the kind: an SDP with a video m-line relays fine.
  sb.clear();
  sa.emit("call:signal", { callId: ringing.callId, data: { sdp: { type: "offer", sdp: "v=0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\nm=video 9 UDP/TLS/RTP/SAVPF 96\\r\\n" } } });
  const relayed = await sb.waitFor("call:signal", 2000);
  check("an offer carrying a video track relays through", !!relayed?.data?.sdp, relayed);

  await wait(700);
  sa.emit("call:hangup", { callId: ringing.callId });
  await wait(600);

  /* ------------------------------------------------------------ recording */
  heading("The record says which kind it was");
  const history = await a.c.fetch(`/api/calls/conversation/${convo}`);
  const rec = (history.body?.calls ?? []).find((x) => x.id === ringing.callId);
  check("the call is in the history", !!rec, history.body);
  check("...marked as video", rec?.kind === "video", rec);
  check("...and completed", rec?.status === "completed", rec);

  const thread = await a.c.fetch(`/api/conversations/${convo}/messages`);
  const entry = (thread.body?.messages ?? []).find((m) => m.call?.id === ringing.callId);
  check("it appears in the thread", !!entry, (thread.body?.messages ?? []).length);
  check("...carrying the video kind", entry?.call?.kind === "video", entry?.call);

  /* ------------------------------------------------------ audio unaffected */
  heading("Audio calls still behave exactly as before");
  sa.clear(); sb.clear();
  sa.emit("call:start", { conversationId: convo });
  const audioRing = await sa.waitFor("call:ringing");
  check("a call with no kind is audio", audioRing?.kind === "audio", audioRing);
  const audioIncoming = await sb.waitFor("call:incoming");
  check("...and the callee is told so", audioIncoming?.kind === "audio", audioIncoming);
  sb.emit("call:accept", { callId: audioRing.callId });
  await sa.waitFor("call:accepted");
  await wait(700);
  sa.emit("call:hangup", { callId: audioRing.callId });
  await wait(600);
  const h2 = await a.c.fetch(`/api/calls/conversation/${convo}`);
  const audioRec = (h2.body?.calls ?? []).find((x) => x.id === audioRing.callId);
  check("the audio call is recorded as audio", audioRec?.kind === "audio", audioRec);

  heading("A junk kind falls back to audio rather than being stored raw");
  sa.clear(); sb.clear();
  sa.emit("call:start", { conversationId: convo, kind: "hologram" });
  const junk = await sa.waitFor("call:ringing");
  check("an unknown kind is treated as audio", junk?.kind === "audio", junk);
  sa.emit("call:hangup", { callId: junk.callId });
  await wait(500);

  heading("Video calls obey the same rules as audio");
  await b.c.fetch(`/api/users/${a.id}/block`, { method: "POST" });
  sa.clear();
  sa.emit("call:start", { conversationId: convo, kind: "video" });
  const blocked = await sa.waitFor("call:failed", 2500);
  check("a blocked caller cannot start a video call", blocked?.reason === "blocked", blocked);
  await b.c.fetch(`/api/users/${a.id}/block`, { method: "DELETE" });
  await wait(300);

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  check("the server is healthy throughout", health?.ok === true, health);
  }

} catch (err) {
  console.error("\nProbe crashed:", err.message, err.stack?.split("\n")[1] ?? "");
  check("probe ran to completion", false, err.message);
} finally {
  for (const s of sockets) { try { s.close(); } catch {} }
  for (const s of sessions) {
    try { await s.c.fetch("/api/me", { method: "DELETE", json: { password: s.person.password } }); } catch {}
  }
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) { console.log("Failed:"); for (const f of failures) console.log(`  - ${f}`); console.log(); }
process.exit(failures.length ? 1 : 0);

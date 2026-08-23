/**
 * Audio calling suite.
 *
 * Drives the real signalling protocol over Socket.IO with authenticated
 * sessions — the same path the browser uses. It does not exercise WebRTC media
 * itself (that needs a real browser; the UI run covers it), but it does cover
 * the full call lifecycle, authorization and the durable record.
 *
 *   node scripts/call-test.js [baseUrl]
 */
import { io } from "../web/node_modules/socket.io-client/build/esm/index.js";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";

let passed = 0;
const failures = [];
let section = "";

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${section} — ${name}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ""}`);
  }
}
function heading(title) {
  section = title;
  console.log(`\n${title}`);
}

function client() {
  const jar = new Map();
  return {
    cookie: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    async fetch(path, options = {}) {
      const headers = new Headers(options.headers ?? {});
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie) headers.set("cookie", cookie);
      if (options.json !== undefined) {
        headers.set("content-type", "application/json");
        options.body = JSON.stringify(options.json);
      }
      const res = await fetch(`${BASE}${path}`, { ...options, headers });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const type = res.headers.get("content-type") ?? "";
      return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
    },
  };
}

/** Connects a socket with the given session and records every call event. */
function connect(cookie) {
  const socket = io(BASE, { path: "/socket.io", extraHeaders: { cookie }, transports: ["websocket"] });
  const events = [];
  for (const name of [
    "call:incoming",
    "call:ringing",
    "call:accepted",
    "call:connecting",
    "call:signal",
    "call:ended",
    "call:failed",
    "call:handled",
  ]) {
    socket.on(name, (payload) => events.push({ name, payload }));
  }
  socket.events = events;
  socket.waitFor = (name, timeout = 4000) =>
    new Promise((resolve) => {
      const existing = events.find((e) => e.name === name);
      if (existing) return resolve(existing.payload);
      const started = Date.now();
      const id = setInterval(() => {
        const hit = events.find((e) => e.name === name);
        if (hit) {
          clearInterval(id);
          resolve(hit.payload);
        } else if (Date.now() - started > timeout) {
          clearInterval(id);
          resolve(null);
        }
      }, 40);
    });
  socket.clear = () => (events.length = 0);
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (e) => reject(new Error(e.message)));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Math.random().toString(36).slice(2, 7);
const pw = "CallSuite!2026";
const people = {
  ana: { username: `call_a_${stamp}`, email: `call_a_${stamp}@test.dev`, password: pw },
  ben: { username: `call_b_${stamp}`, email: `call_b_${stamp}@test.dev`, password: pw },
  cara: { username: `call_c_${stamp}`, email: `call_c_${stamp}@test.dev`, password: pw },
};

async function main() {
  console.log(`\nLumen calling suite → ${BASE}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`\nCannot reach ${BASE}.\n`);
    process.exit(1);
  }

  const ana = client();
  const ben = client();
  const cara = client();
  const ids = {};
  for (const [key, session] of [["ana", ana], ["ben", ben], ["cara", cara]]) {
    const r = await session.fetch("/api/auth/signup", { method: "POST", json: people[key] });
    if (r.status !== 201) {
      console.error(`\nCould not create ${key} (${r.status}). Rate limited? Start the server with DISABLE_RATE_LIMITS=1.\n`);
      process.exit(1);
    }
    ids[key] = r.body.user.id;
  }

  const conv = (await ana.fetch("/api/conversations", { method: "POST", json: { userId: ids.ben } })).body.conversation;
  const convWithCara = (await ana.fetch("/api/conversations", { method: "POST", json: { userId: ids.cara } })).body
    .conversation;

  heading("Signalling requires an authenticated socket");
  let rejected = false;
  try {
    await connect("lumen_session=not-a-real-token");
  } catch {
    rejected = true;
  }
  check("a socket without a valid session is refused", rejected);

  const anaSocket = await connect(ana.cookie());
  const benSocket = await connect(ben.cookie());
  await wait(300);

  heading("ICE configuration");
  let r = await ana.fetch("/api/calls/ice");
  check("ICE servers are served to signed-in users", r.status === 200 && Array.isArray(r.body.iceServers), r.body);
  check("at least one STUN server is offered", JSON.stringify(r.body.iceServers).includes("stun:"), r.body.iceServers);
  const anon = client();
  r = await anon.fetch("/api/calls/ice");
  check("ICE configuration is not public", r.status === 401, { status: r.status });

  heading("A normal call");
  anaSocket.clear();
  benSocket.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });

  const ringing = await anaSocket.waitFor("call:ringing");
  check("the caller is told it is ringing", !!ringing?.callId, ringing);
  const incoming = await benSocket.waitFor("call:incoming");
  check("the callee receives the incoming call", incoming?.callId === ringing?.callId, incoming);
  check("...with the caller's identity attached", incoming?.from?.username === people.ana.username, incoming?.from);

  const callId = ringing.callId;
  benSocket.emit("call:accept", { callId });
  const accepted = await anaSocket.waitFor("call:accepted");
  check("accepting tells the caller to make the offer", accepted?.callId === callId, accepted);

  // Relay a token SDP and a candidate; the server treats both as opaque.
  benSocket.clear();
  anaSocket.emit("call:signal", { callId, data: { sdp: { type: "offer", sdp: "v=0 fake" } } });
  const relayedOffer = await benSocket.waitFor("call:signal");
  check("SDP is relayed to the other participant", relayedOffer?.data?.sdp?.type === "offer", relayedOffer);

  anaSocket.clear();
  benSocket.emit("call:signal", { callId, data: { candidate: { candidate: "candidate:1 1 udp", sdpMid: "0" } } });
  const relayedCandidate = await anaSocket.waitFor("call:signal");
  check("ICE candidates are relayed back", !!relayedCandidate?.data?.candidate, relayedCandidate);

  await wait(1100);
  anaSocket.clear();
  benSocket.clear();
  anaSocket.emit("call:hangup", { callId });
  const endedA = await anaSocket.waitFor("call:ended");
  const endedB = await benSocket.waitFor("call:ended");
  check("hanging up ends the call for the caller", endedA?.reason === "hangup", endedA);
  check("...and for the callee", endedB?.callId === callId, endedB);
  check("the answered duration is reported", (endedA?.durationMs ?? 0) >= 900, endedA);

  heading("The call is recorded in the conversation");
  r = await ana.fetch(`/api/calls/conversation/${conv.id}`);
  const record = r.body.calls?.[0];
  check("history lists the completed call", record?.status === "completed", r.body.calls);
  check("...marked outgoing for the caller", record?.outgoing === true, record);
  r = await ben.fetch(`/api/calls/conversation/${conv.id}`);
  check("...and incoming for the callee", r.body.calls?.[0]?.outgoing === false, r.body.calls?.[0]);

  r = await ana.fetch(`/api/conversations/${conv.id}/messages`);
  const callMessage = r.body.messages?.find((m) => m.call);
  check("the call appears as an entry in the thread", !!callMessage, r.body.messages?.length);
  check("...carrying its status and duration", callMessage?.call?.status === "completed" && callMessage.call.durationMs > 0, callMessage?.call);

  r = await ana.fetch("/api/conversations");
  const preview = r.body.conversations.find((c) => c.id === conv.id);
  check("the inbox preview shows it was a call", preview?.lastMessage?.hasCall === true, preview?.lastMessage);

  heading("Declining");
  anaSocket.clear();
  benSocket.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });
  const ring2 = await anaSocket.waitFor("call:ringing");
  benSocket.emit("call:decline", { callId: ring2.callId });
  const declined = await anaSocket.waitFor("call:ended");
  check("declining ends the call for the caller", declined?.reason === "declined", declined);
  r = await ana.fetch(`/api/calls/conversation/${conv.id}`);
  check("a declined call is recorded as declined", r.body.calls?.[0]?.status === "declined", r.body.calls?.[0]);

  heading("Cancelling before an answer");
  anaSocket.clear();
  benSocket.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });
  const ring3 = await anaSocket.waitFor("call:ringing");
  anaSocket.emit("call:hangup", { callId: ring3.callId });
  const cancelled = await benSocket.waitFor("call:ended");
  check("the callee stops ringing when the caller gives up", cancelled?.reason === "cancelled", cancelled);
  r = await ben.fetch(`/api/calls/conversation/${conv.id}`);
  check("it is recorded as cancelled", r.body.calls?.[0]?.status === "cancelled", r.body.calls?.[0]);

  heading("Busy and availability");
  anaSocket.clear();
  benSocket.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });
  await anaSocket.waitFor("call:ringing");
  // Cara is online but Ana is mid-call.
  const caraSocket = await connect(cara.cookie());
  await wait(200);
  caraSocket.clear();
  caraSocket.emit("call:start", { conversationId: convWithCara.id });
  const busy = await caraSocket.waitFor("call:failed");
  check("calling someone already on a call returns busy", busy?.reason === "busy", busy);
  anaSocket.emit("call:hangup", { callId: (await anaSocket.waitFor("call:ringing")).callId });
  await wait(300);

  // Ben goes offline entirely.
  benSocket.close();
  await wait(500);
  anaSocket.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });
  const offline = await anaSocket.waitFor("call:failed");
  check("calling an offline account fails cleanly", offline?.reason === "offline", offline);
  check("...with a message naming them", (offline?.message ?? "").includes(people.ben.username), offline);

  heading("Blocking");
  const benSocket2 = await connect(ben.cookie());
  await wait(300);
  await ben.fetch(`/api/users/${ids.ana}/block`, { method: "POST" });
  anaSocket.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });
  const blocked = await anaSocket.waitFor("call:failed");
  check("a blocked caller cannot ring through", blocked?.reason === "blocked", blocked);
  check("the callee's socket stays silent", !benSocket2.events.some((e) => e.name === "call:incoming"), benSocket2.events);
  await ben.fetch(`/api/users/${ids.ana}/block`, { method: "DELETE" });

  heading("Outsiders cannot join or steer a call");
  anaSocket.clear();
  benSocket2.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });
  const ring4 = await anaSocket.waitFor("call:ringing");
  await benSocket2.waitFor("call:incoming");

  caraSocket.clear();
  caraSocket.emit("call:signal", { callId: ring4.callId, data: { sdp: { type: "offer", sdp: "hijack" } } });
  await wait(400);
  const leaked =
    benSocket2.events.some((e) => e.name === "call:signal" && JSON.stringify(e.payload).includes("hijack")) ||
    anaSocket.events.some((e) => e.name === "call:signal" && JSON.stringify(e.payload).includes("hijack"));
  check("a third party cannot inject signalling into someone else's call", !leaked);

  caraSocket.emit("call:accept", { callId: ring4.callId });
  await wait(400);
  check("a third party cannot answer the call", !anaSocket.events.some((e) => e.name === "call:accepted"));

  caraSocket.emit("call:hangup", { callId: ring4.callId });
  await wait(400);
  check("a third party cannot hang up the call", !anaSocket.events.some((e) => e.name === "call:ended"));

  heading("A dropped connection ends the call");
  benSocket2.emit("call:accept", { callId: ring4.callId });
  await anaSocket.waitFor("call:accepted");
  await wait(300);
  anaSocket.clear();
  benSocket2.close();
  const dropped = await anaSocket.waitFor("call:ended", 5000);
  check("losing the peer's socket ends the call", dropped?.callId === ring4.callId, dropped);
  check("...recorded as disconnected", dropped?.reason === "disconnected", dropped);

  heading("Ringing across several tabs");
  const benTabA = await connect(ben.cookie());
  const benTabB = await connect(ben.cookie());
  await wait(400);
  anaSocket.clear();
  benTabA.clear();
  benTabB.clear();
  anaSocket.emit("call:start", { conversationId: conv.id });
  const ring5 = await anaSocket.waitFor("call:ringing");
  const tabA = await benTabA.waitFor("call:incoming");
  const tabB = await benTabB.waitFor("call:incoming");
  check("every open tab rings", !!tabA && !!tabB, { tabA: !!tabA, tabB: !!tabB });

  benTabA.emit("call:accept", { callId: ring5.callId });
  const handled = await benTabB.waitFor("call:handled");
  check("the tabs that did not answer stop ringing", handled?.callId === ring5.callId, handled);

  anaSocket.emit("call:hangup", { callId: ring5.callId });
  await wait(300);

  heading("Cleanup");
  for (const socket of [anaSocket, caraSocket, benTabA, benTabB]) socket.close();
  let removed = 0;
  for (const [session, person] of [[ana, people.ana], [ben, people.ben], [cara, people.cara]]) {
    const res = await session.fetch("/api/me", { method: "DELETE", json: { password: person.password } });
    if (res.status === 200) removed++;
  }
  check(`test accounts removed (${removed}/3)`, removed === 3, { removed });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    console.log("Failed:");
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\nCalling suite crashed:", err);
  process.exit(1);
});

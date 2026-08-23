/**
 * Shared helpers for the suites that create their own accounts.
 *
 * Every user made here is deleted again in `cleanup`, so a run leaves the
 * database as it found it. The server must be started with DISABLE_RATE_LIMITS=1
 * or the per-IP signup ceiling stops the suite after a handful of accounts.
 */
export const BASE = process.env.LUMEN_URL ?? "http://localhost:4310";

export function client() {
  const jar = new Map();
  return {
    jar,
    async fetch(pathname, options = {}) {
      const headers = new Headers(options.headers ?? {});
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie) headers.set("cookie", cookie);
      if (options.json !== undefined) {
        headers.set("content-type", "application/json");
        options.body = JSON.stringify(options.json);
      }
      const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const type = res.headers.get("content-type") ?? "";
      let body;
      if (type.includes("application/json")) body = await res.json();
      else body = await res.text();
      return { status: res.status, body, headers: res.headers };
    },
  };
}

export function makeReporter() {
  let passed = 0;
  const failures = [];
  let section = "";
  return {
    heading(t) { section = t; console.log(`\n${t}`); },
    check(name, ok, detail) {
      if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
      else {
        failures.push(`${section} — ${name}`);
        console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 260)}` : ""}`);
      }
    },
    done() {
      console.log(`\n${passed} passed, ${failures.length} failed\n`);
      if (failures.length) {
        console.log("Failed:");
        for (const f of failures) console.log(`  - ${f}`);
        console.log();
      }
      return failures.length;
    },
    get failures() { return failures; },
  };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Creates a signed-in throwaway account. */
export async function makeUser(tag) {
  const c = client();
  const stamp = Math.random().toString(36).slice(2, 8);
  const person = {
    username: `${tag}_${stamp}`.slice(0, 24),
    email: `${tag}_${stamp}@bughunt.dev`,
    password: "BugHunt!2026",
  };
  const r = await c.fetch("/api/auth/signup", { method: "POST", json: person });
  if (r.status !== 201) throw new Error(`signup failed for ${tag}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { c, person, id: r.body.user.id, username: person.username };
}

export async function cleanup(users) {
  for (const u of users) {
    try { await u.c.fetch("/api/me", { method: "DELETE", json: { password: u.person.password } }); } catch {}
  }
}

import zlib from "node:zlib";
export function png(width = 80, height = 80) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) { raw[o++] = (x * 3) % 256; raw[o++] = (y * 3) % 256; raw[o++] = 140; }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, data.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function form(fields) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) fd.append(key, new Blob([v.file], { type: v.type }), v.name);
    else if (value && value.file) fd.append(key, new Blob([value.file], { type: value.type }), value.name);
    else fd.append(key, value);
  }
  return fd;
}

/** Posts a photo and returns the post payload. */
export async function makePost(user, caption = "hello") {
  const r = await user.c.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: png(), type: "image/png", name: "p.png" }, caption }),
  });
  if (r.status !== 201) throw new Error(`post failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.post;
}

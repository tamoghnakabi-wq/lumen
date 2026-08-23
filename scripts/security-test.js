/**
 * Security and abuse regression suite.
 *
 * Every check here corresponds to a specific weakness that was found in the
 * application and fixed. Run it against a server started WITH rate limiting
 * enabled (the default):
 *
 *   node scripts/security-test.js [baseUrl]
 *
 * It needs read access to the SQLite file to assert on at-rest storage, so it
 * only runs meaningfully against a local server. Accounts it creates are
 * deleted at the end.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.LUMEN_DB ?? path.join(root, "data", "lumen.db");
const UPLOADS = path.join(root, "data", "uploads");

let passed = 0;
const failures = [];
let section = "";

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${section} — ${name}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 260)}` : ""}`);
  }
}
function heading(title) {
  section = title;
  console.log(`\n${title}`);
}

function client() {
  const jar = new Map();
  return {
    jar,
    cookieHeader: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    async fetch(pathname, options = {}) {
      const headers = new Headers(options.headers ?? {});
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
      if (options.json !== undefined) {
        headers.set("content-type", "application/json");
        options.body = JSON.stringify(options.json);
      }
      const res = await fetch(`${BASE}${pathname}`, { ...options, headers, redirect: "manual" });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
      const type = res.headers.get("content-type") ?? "";
      const body = type.includes("application/json") ? await res.json() : await res.text();
      return { status: res.status, body, headers: res.headers };
    },
  };
}

/** Real PNG built in-process. */
function png(width = 64, height = 64) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 3) % 256;
      raw[o++] = (y * 3) % 256;
      raw[o++] = 140;
    }
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A decompression bomb: tiny on the wire, enormous once decoded. */
function bombPng(side = 12000) {
  const row = Buffer.alloc(side * 3 + 1);
  const raw = Buffer.concat(Array.from({ length: side }, () => row));
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, data.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function form(fields) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value && value.file) {
      fd.append(key, new Blob([value.file], { type: value.type ?? "image/png" }), value.name ?? "test.png");
    } else fd.append(key, value);
  }
  return fd;
}

const stamp = crypto.randomBytes(3).toString("hex");
const pw = "SecuritySuite!2026";
const accounts = {
  owner: { username: `sec_own_${stamp}`, email: `sec_own_${stamp}@test.dev`, password: pw },
  friend: { username: `sec_fri_${stamp}`, email: `sec_fri_${stamp}@test.dev`, password: pw },
  stranger: { username: `sec_str_${stamp}`, email: `sec_str_${stamp}@test.dev`, password: pw },
};

async function main() {
  console.log(`\nLumen security suite → ${BASE}`);

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`\nCannot reach ${BASE}. Start the server first.\n`);
    process.exit(1);
  }

  const owner = client();
  const friend = client();
  const stranger = client();
  const anon = client();

  let r = await owner.fetch("/api/auth/signup", { method: "POST", json: accounts.owner });
  if (r.status === 429) {
    console.error("\nSignup is rate limited from this IP. Wait an hour, or restart the server to clear the window.\n");
    process.exit(1);
  }
  const ownerId = r.body.user?.id;
  await friend.fetch("/api/auth/signup", { method: "POST", json: accounts.friend });
  const strangerRes = await stranger.fetch("/api/auth/signup", { method: "POST", json: accounts.stranger });
  const strangerId = strangerRes.body.user?.id;
  if (!ownerId || !strangerId) {
    console.error("\nCould not create the three test accounts (rate limited?).\n");
    process.exit(1);
  }

  /* ---------------------------------------------------------------- media */
  heading("Media authorization (private photos were world-readable)");

  await owner.fetch("/api/me", { method: "PATCH", json: { isPrivate: true } });
  r = await owner.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: png() }, caption: "private post" }),
  });
  const privatePost = r.body.post;
  const privateMedia = privatePost?.media?.[0]?.id;
  check("private post created", !!privateMedia, r.body);

  r = await anon.fetch(`/media/${privateMedia}/full.webp`);
  check("anonymous cannot fetch a private account's photo", r.status === 404, { status: r.status });

  r = await stranger.fetch(`/media/${privateMedia}/full.webp`);
  check("a stranger cannot fetch a private account's photo", r.status === 404, { status: r.status });

  // friend follows and is approved
  await friend.fetch(`/api/users/${ownerId}/follow`, { method: "POST" });
  const friendId = (await friend.fetch("/api/auth/me")).body.user.id;
  await owner.fetch(`/api/me/requests/${friendId}/accept`, { method: "POST" });

  r = await friend.fetch(`/media/${privateMedia}/full.webp`);
  check("an approved follower can fetch the photo", r.status === 200, { status: r.status });
  check(
    "restricted media is not cacheable by shared caches",
    (r.headers.get("cache-control") ?? "").includes("private"),
    r.headers.get("cache-control"),
  );

  // Blocking must revoke access that was previously granted.
  await owner.fetch(`/api/users/${friendId}/block`, { method: "POST" });
  r = await friend.fetch(`/media/${privateMedia}/full.webp`);
  check("blocking revokes access to already-known image URLs", r.status === 404, { status: r.status });
  await owner.fetch(`/api/users/${friendId}/block`, { method: "DELETE" });

  // DM attachments
  const conv = await owner.fetch("/api/conversations", { method: "POST", json: { userId: strangerId } });
  const convId = conv.body.conversation?.id;
  r = await owner.fetch(`/api/conversations/${convId}/messages`, {
    method: "POST",
    body: form({ image: { file: png() }, body: "attachment" }),
  });
  const dmMedia = r.body.message?.media?.id;
  check("DM attachment uploaded", !!dmMedia, r.body);

  r = await anon.fetch(`/media/${dmMedia}/full.webp`);
  check("anonymous cannot fetch a DM attachment", r.status === 404, { status: r.status });
  r = await friend.fetch(`/media/${dmMedia}/full.webp`);
  check("a third party cannot fetch a DM attachment", r.status === 404, { status: r.status });
  r = await stranger.fetch(`/media/${dmMedia}/full.webp`);
  check("the recipient can fetch the DM attachment", r.status === 200, { status: r.status });

  // Avatars stay public so lists and mentions render.
  r = await owner.fetch("/api/me/avatar", { method: "POST", body: form({ image: { file: png() } }) });
  const avatarPath = r.body.user?.avatar;
  r = await anon.fetch(avatarPath ?? "/media/none/thumb.webp");
  check("avatars remain publicly readable", r.status === 200, { status: r.status, avatarPath });

  await owner.fetch("/api/me", { method: "PATCH", json: { isPrivate: false } });

  /* ------------------------------------------------------------- uploads */
  heading("Upload hardening");

  const bomb = bombPng(12000);
  r = await owner.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: bomb, name: "bomb.png" }, caption: "bomb" }),
  });
  check(
    `decompression bomb rejected (${(bomb.length / 1024).toFixed(0)} KB → 144 megapixels)`,
    r.status === 400,
    { status: r.status, error: r.body?.error },
  );

  r = await owner.fetch("/api/posts", {
    method: "POST",
    body: form({
      images: { file: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), name: "x.svg", type: "image/svg+xml" },
    }),
  });
  check("SVG upload rejected (script-carrying image type)", r.status === 400, { status: r.status });

  r = await owner.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: Buffer.from("<html><script>alert(1)</script></html>"), name: "evil.png" } }),
  });
  check("HTML disguised as .png rejected", r.status === 400, { status: r.status });

  const beforeDirs = countMediaDirs();
  await owner.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: Buffer.from("not an image at all"), name: "broken.png" } }),
  });
  check("a failed upload leaves no files behind", countMediaDirs() === beforeDirs, {
    before: beforeDirs,
    after: countMediaDirs(),
  });

  r = await owner.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: png() }, caption: "x".repeat(9000) }),
  });
  check("oversized multipart text field rejected", r.status === 400, { status: r.status });

  /* ------------------------------------------------------- session at rest */
  heading("Session and token storage");

  const db = openDb();
  if (db) {
    const cookie = owner.jar.get("lumen_session");
    const hash = crypto.createHash("sha256").update(cookie).digest("hex");
    const plaintextHit = db.prepare("SELECT COUNT(*) c FROM sessions WHERE token_hash = ?").get(cookie);
    const hashedHit = db.prepare("SELECT COUNT(*) c FROM sessions WHERE token_hash = ?").get(hash);
    check("session tokens are not stored in plaintext", plaintextHit.c === 0, plaintextHit);
    check("session is stored as a SHA-256 digest", hashedHit.c === 1, hashedHit);

    const cols = db.prepare("PRAGMA table_info(password_resets)").all().map((c) => c.name);
    check("reset tokens are stored hashed too", cols.includes("token_hash") && !cols.includes("token"), cols);

    // Expire the session in the database; the API must reject it immediately.
    const probe = client();
    await probe.fetch("/api/auth/login", {
      method: "POST",
      json: { identifier: accounts.stranger.username, password: pw },
    });
    const probeHash = crypto.createHash("sha256").update(probe.jar.get("lumen_session")).digest("hex");
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1000, probeHash);
    const after = await probe.fetch("/api/auth/me");
    check("an expired session is rejected", after.body.user === null, after.body);
    const stillThere = db.prepare("SELECT COUNT(*) c FROM sessions WHERE token_hash = ?").get(probeHash);
    check("the expired session row is deleted on use", stillThere.c === 0, stillThere);
    db.close();
  } else {
    console.log("  (skipped at-rest checks: database not readable from here)");
  }

  const loginRes = await stranger.fetch("/api/auth/login", {
    method: "POST",
    json: { identifier: accounts.stranger.username, password: pw },
  });
  const setCookie = (loginRes.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("lumen_session="));
  check("session cookie is HttpOnly", /HttpOnly/i.test(setCookie ?? ""), setCookie);
  check("session cookie is SameSite=Lax", /SameSite=Lax/i.test(setCookie ?? ""), setCookie);
  if (BASE.startsWith("https://")) {
    check("session cookie is Secure over HTTPS", /Secure/i.test(setCookie ?? ""), setCookie);
  }

  heading("Session revocation");
  const deviceA = client();
  const deviceB = client();
  await deviceA.fetch("/api/auth/login", { method: "POST", json: { identifier: accounts.friend.username, password: pw } });
  await deviceB.fetch("/api/auth/login", { method: "POST", json: { identifier: accounts.friend.username, password: pw } });
  r = await deviceB.fetch("/api/auth/me");
  check("second device is signed in", r.body.user?.username === accounts.friend.username, r.body);

  await deviceA.fetch("/api/auth/logout-others", { method: "POST" });
  r = await deviceB.fetch("/api/auth/me");
  check("sign-out-everywhere kills the other session", r.body.user === null, r.body);
  r = await deviceA.fetch("/api/auth/me");
  check("...but keeps the current one", r.body.user?.username === accounts.friend.username, r.body);
  // That revocation also invalidated this suite's original friend session.
  await friend.fetch("/api/auth/login", { method: "POST", json: { identifier: accounts.friend.username, password: pw } });

  /* ----------------------------------------------------------------- CSRF */
  heading("Cross-site request forgery");

  r = await stranger.fetch("/api/posts", {
    method: "POST",
    headers: { origin: "https://evil.example" },
    body: form({ images: { file: png() }, caption: "csrf" }),
  });
  check("cross-origin POST is rejected", r.status === 403, { status: r.status });

  r = await stranger.fetch("/api/me", {
    method: "PATCH",
    headers: { origin: "https://evil.example" },
    json: { bio: "csrf" },
  });
  check("cross-origin PATCH is rejected", r.status === 403, { status: r.status });

  r = await stranger.fetch("/api/me", {
    method: "PATCH",
    headers: { origin: new URL(BASE).origin },
    json: { bio: "same origin ok" },
  });
  check("same-origin request still works", r.status === 200, { status: r.status });

  /* ------------------------------------------------------- rate limiting */
  heading("Rate limiting and IP spoofing");

  // Every attempt claims a different source address. The per-account failure
  // budget is keyed on the account, so spoofing the IP buys nothing.
  const spoof = client();
  let spoofBlockedAt = null;
  let retryAfter = null;
  for (let i = 1; i <= 30; i++) {
    const res = await spoof.fetch("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": `203.0.113.${i}` },
      json: { identifier: accounts.owner.username, password: "wrong-password" },
    });
    if (res.status === 429) {
      spoofBlockedAt = i;
      retryAfter = res.headers.get("retry-after");
      break;
    }
  }
  check(
    `brute force is blocked despite rotating X-Forwarded-For (stopped at attempt ${spoofBlockedAt})`,
    spoofBlockedAt !== null && spoofBlockedAt <= 22,
    { spoofBlockedAt },
  );
  check("429 carries a Retry-After header", !!retryAfter, retryAfter);

  // A different account is unaffected: budgets are per account, not global.
  r = await client().fetch("/api/auth/login", {
    method: "POST",
    json: { identifier: accounts.friend.username, password: pw },
  });
  check("throttling one account does not affect another", r.status === 200, { status: r.status });

  let enumBlocked = false;
  for (let i = 0; i < 70; i++) {
    const res = await anon.fetch(`/api/auth/available?username=probe${stamp}x${i}`);
    if (res.status === 429) {
      enumBlocked = true;
      break;
    }
  }
  check("username enumeration is rate limited", enumBlocked);

  /* ------------------------------------------------------- authorization */
  heading("Authorization / IDOR");

  const victimPost = (
    await stranger.fetch("/api/posts", { method: "POST", body: form({ images: { file: png() }, caption: "mine" }) })
  ).body.post;

  r = await owner.fetch(`/api/posts/${victimPost.id}`, { method: "PATCH", json: { caption: "hijacked" } });
  check("cannot edit another user's post", r.status === 403, { status: r.status });

  r = await owner.fetch(`/api/me/requests/${strangerId}/accept`, { method: "POST" });
  check("cannot accept a follow request that was never made", r.status === 404, { status: r.status });

  r = await owner.fetch(`/api/conversations/${convId}/read`, { method: "POST" });
  check("a member can mark their own conversation read", r.status === 200, { status: r.status });
  r = await friend.fetch(`/api/conversations/${convId}/read`, { method: "POST" });
  check("a non-member cannot touch someone else's conversation", r.status === 404, { status: r.status });

  r = await friend.fetch(`/api/conversations/${convId}/messages`);
  check("a non-member cannot read the thread", r.status === 404, { status: r.status });

  // Notification previews must not leak private posts to a mentioned outsider.
  await owner.fetch("/api/me", { method: "PATCH", json: { isPrivate: true } });
  await owner.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: png() }, caption: `hello @${accounts.stranger.username} from a private account` }),
  });
  r = await stranger.fetch("/api/notifications");
  const mention = r.body.notifications?.find((n) => n.type === "mention");
  check("mention notification is delivered", !!mention, r.body.notifications?.map((n) => n.type));
  check("...without leaking a thumbnail of the private post", mention ? mention.postThumb === null : false, mention);
  await owner.fetch("/api/me", { method: "PATCH", json: { isPrivate: false } });

  /* ----------------------------------------------------------- injection */
  heading("Injection and stored payloads");

  const sqli = "'; DROP TABLE users; --";
  r = await stranger.fetch(`/api/explore/search?q=${encodeURIComponent(sqli)}`);
  check("SQL injection in search is handled as text", r.status === 200, { status: r.status });
  r = await anon.fetch("/api/health");
  check("...and the database is intact afterwards", r.body.ok === true, r.body);

  const xss = '<img src=x onerror="alert(1)"> <script>alert(2)</script>';
  r = await stranger.fetch("/api/me", { method: "PATCH", json: { bio: xss } });
  check("XSS payload is stored verbatim, not executed or mangled server-side", r.body.user?.bio === xss, r.body.user?.bio);
  r = await anon.fetch(`/api/users/${accounts.stranger.username}`);
  check("...and returned as JSON text, never as HTML", typeof r.body.user.bio === "string" && r.body.user.bio === xss);

  const wildcard = await stranger.fetch(`/api/explore/search?q=${encodeURIComponent("%")}`);
  check("LIKE wildcards in search do not match everything", (wildcard.body.users?.length ?? 0) === 0, {
    users: wildcard.body.users?.length,
  });

  r = await stranger.fetch("/api/me", { method: "PATCH", json: { website: "javascript:alert(1)" } });
  check("javascript: URL rejected for the profile link", r.status === 400, { status: r.status });

  /* --------------------------------------------------------- consistency */
  heading("Concurrency and data consistency");

  const target = victimPost.id;
  const likeResults = await Promise.all(
    Array.from({ length: 10 }, () => owner.fetch(`/api/posts/${target}/like`, { method: "POST" })),
  );
  const finalLike = likeResults[likeResults.length - 1];
  check("ten concurrent likes count exactly once", finalLike.body.post?.counts?.likes === 1, finalLike.body.post?.counts);

  const followResults = await Promise.all(
    Array.from({ length: 8 }, () => owner.fetch(`/api/users/${strangerId}/follow`, { method: "POST" })),
  );
  check("concurrent follows all succeed without error", followResults.every((x) => x.status === 200), followResults.map((x) => x.status));
  const profile = await owner.fetch(`/api/users/${accounts.stranger.username}`);
  check("...and produce a single follower", profile.body.user.counts.followers === 1, profile.body.user.counts);

  const convs = await Promise.all(
    Array.from({ length: 6 }, () => owner.fetch("/api/conversations", { method: "POST", json: { userId: friendId } })),
  );
  const convIds = new Set(convs.map((x) => x.body.conversation?.id));
  check("concurrent thread opens create one conversation", convIds.size === 1, [...convIds]);

  heading("Deletion removes the bytes on disk");
  const doomed = (
    await owner.fetch("/api/posts", { method: "POST", body: form({ images: { file: png() }, caption: "temp" }) })
  ).body.post;
  const doomedMedia = doomed.media[0].id;
  check("post image is on disk", mediaDirExists(doomedMedia), doomedMedia);
  await owner.fetch(`/api/posts/${doomed.id}`, { method: "DELETE" });
  check("deleting the post deletes its image files", !mediaDirExists(doomedMedia), doomedMedia);
  r = await owner.fetch(`/media/${doomedMedia}/full.webp`);
  check("...and the URL stops resolving", r.status === 404, { status: r.status });

  /* ------------------------------------------------------------- headers */
  heading("Response headers");
  r = await anon.fetch("/api/health");
  const csp = r.headers.get("content-security-policy") ?? "";
  check("Content-Security-Policy is set", csp.length > 0, csp.slice(0, 80));
  check("CSP forbids framing", csp.includes("frame-ancestors 'none'"), csp);
  check("CSP has no unsafe script sources", !/script-src[^;]*unsafe-(inline|eval)/.test(csp), csp);
  check("X-Content-Type-Options is nosniff", r.headers.get("x-content-type-options") === "nosniff");

  // Audio calling needs the microphone, but only for this origin — never "*".
  const permissions = r.headers.get("permissions-policy") ?? "";
  check("microphone is allowed for this origin only", permissions.includes("microphone=(self)"), permissions);
  check("microphone is not opened to every origin", !/microphone=\*/.test(permissions), permissions);
  // Video calling needs the camera on our own origin, and nowhere else.
  check("the camera is allowed only for this origin", permissions.includes("camera=(self)"), permissions);
  check("...and never for an embedded frame", !permissions.includes("camera=*"), permissions);
  check("X-Frame-Options is DENY", r.headers.get("x-frame-options") === "DENY");
  check("server software is not advertised", !r.headers.get("x-powered-by"), r.headers.get("x-powered-by"));

  r = await anon.fetch("/api/does-not-exist");
  check("unknown API routes return JSON, not the SPA shell", r.body?.code === "not_found", r.body);

  /* ------------------------------------------------------------- cleanup */
  heading("Cleanup");
  let removed = 0;
  for (const [session, account] of [
    [owner, accounts.owner],
    [friend, accounts.friend],
    [stranger, accounts.stranger],
  ]) {
    const res = await session.fetch("/api/me", { method: "DELETE", json: { password: account.password } });
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
}

function openDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    return new DatabaseSync(DB_PATH, { readOnly: false });
  } catch {
    return null;
  }
}

function mediaDirExists(id) {
  return fs.existsSync(path.join(UPLOADS, id.slice(0, 2), id));
}

function countMediaDirs() {
  try {
    let total = 0;
    for (const shard of fs.readdirSync(UPLOADS)) {
      const p = path.join(UPLOADS, shard);
      if (fs.statSync(p).isDirectory()) total += fs.readdirSync(p).length;
    }
    return total;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error("\nSecurity suite crashed:", err);
  process.exit(1);
});

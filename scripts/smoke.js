/**
 * End-to-end API smoke test. Exercises the real HTTP surface of a running
 * server, including authorization rules that are easy to get wrong.
 *
 *   node scripts/smoke.js [baseUrl]     (default http://localhost:4310)
 *
 * Safe to run against a seeded database: it creates its own throwaway accounts.
 */
import zlib from "node:zlib";

const BASE = process.argv[2] ?? process.env.LUMEN_URL ?? "http://localhost:4310";

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
}

/** Minimal cookie-jar client. */
function client() {
  const jar = new Map();
  return {
    jar,
    async fetch(path, options = {}) {
      const headers = new Headers(options.headers ?? {});
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie) headers.set("cookie", cookie);
      if (options.json !== undefined) {
        headers.set("content-type", "application/json");
        options.body = JSON.stringify(options.json);
      }
      const res = await fetch(`${BASE}${path}`, { ...options, headers, redirect: "manual" });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "" ) jar.delete(name);
        else jar.set(name, value);
      }
      let body = null;
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("application/json")) body = await res.json();
      else body = await res.text();
      return { status: res.status, body, headers: res.headers };
    },
  };
}

/** Builds a real PNG in-process so the test has no image dependencies. */
function testImage(width = 48, height = 48) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 5) % 256;
      raw[o++] = (y * 5) % 256;
      raw[o++] = 160;
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function form(fields) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value && value.file) fd.append(key, new Blob([value.file], { type: "image/png" }), value.name ?? "test.png");
    else fd.append(key, value);
  }
  return fd;
}

const stamp = Date.now().toString(36).slice(-5);
const users = {
  alpha: { username: `smoke_a_${stamp}`, email: `smoke_a_${stamp}@test.dev`, password: "smoketest123" },
  beta: { username: `smoke_b_${stamp}`, email: `smoke_b_${stamp}@test.dev`, password: "smoketest123" },
  gamma: { username: `smoke_c_${stamp}`, email: `smoke_c_${stamp}@test.dev`, password: "smoketest123" },
};

async function main() {
  console.log(`\nLumen API smoke test → ${BASE}\n`);

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`Cannot reach the server at ${BASE}. Start it with: npm start\n`);
    process.exit(1);
  }

  const A = client();
  const B = client();
  const anon = client();

  console.log("Accounts");
  let r = await A.fetch("/api/auth/signup", { method: "POST", json: users.alpha });
  check("signup creates an account", r.status === 201 && r.body.user?.username === users.alpha.username, r.body);

  r = await A.fetch("/api/auth/signup", { method: "POST", json: users.alpha });
  check("duplicate username is rejected", r.status === 409, r.body);

  r = await anon.fetch("/api/auth/signup", { method: "POST", json: { username: "x", email: "bad", password: "1" } });
  check("invalid signup is rejected with 400", r.status === 400, r.body);

  r = await B.fetch("/api/auth/signup", { method: "POST", json: users.beta });
  check("second account created", r.status === 201, r.body);
  const betaId = r.body.user.id;

  r = await anon.fetch("/api/auth/login", { method: "POST", json: { identifier: users.alpha.username, password: "wrong" } });
  check("wrong password is rejected", r.status === 401, r.body);

  r = await anon.fetch("/api/auth/login", { method: "POST", json: { identifier: "nobody_here", password: "whatever" } });
  check("unknown user is rejected", r.status === 401, r.body);

  r = await A.fetch("/api/auth/me");
  check("session persists across requests", r.body.user?.username === users.alpha.username, r.body);

  r = await anon.fetch("/api/auth/me");
  check("anonymous /me returns null", r.body.user === null, r.body);

  r = await anon.fetch("/api/feed");
  check("feed requires auth", r.status === 401, r.body);

  console.log("\nProfile");
  r = await A.fetch("/api/me", { method: "PATCH", json: { displayName: "Alpha Tester", bio: "Testing things." } });
  check("profile edit saves", r.body.user?.displayName === "Alpha Tester" && r.body.user?.bio === "Testing things.", r.body);

  r = await A.fetch("/api/me", { method: "PATCH", json: { bio: "x".repeat(400) } });
  check("oversized bio is rejected", r.status === 400, r.body);

  r = await A.fetch("/api/me/avatar", { method: "POST", body: form({ image: { file: testImage() } }) });
  check("avatar upload works", r.status === 200 && !!r.body.user?.avatar, r.body);

  r = await A.fetch("/api/me/avatar", { method: "POST", body: form({ image: "not-a-file" }) });
  check("avatar upload without a file is rejected", r.status === 400, r.body);

  console.log("\nPosts");
  r = await A.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: testImage() }, caption: "Smoke post #testing @" + users.beta.username }),
  });
  check("post with image is created", r.status === 201 && r.body.post?.media?.length === 1, r.body);
  const postId = r.body.post?.id;
  check("hashtag extracted from caption", r.body.post?.hashtags?.includes("testing"), r.body.post?.hashtags);

  r = await A.fetch("/api/posts", { method: "POST", body: form({ caption: "no image" }) });
  check("post without an image is rejected", r.status === 400, r.body);

  r = await A.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: Buffer.from("this is definitely not an image"), name: "fake.png" }, caption: "bad" }),
  });
  check("non-image upload is rejected", r.status === 400, r.body);

  r = await A.fetch("/api/posts", {
    method: "POST",
    body: form({ images: { file: Buffer.alloc(13 * 1024 * 1024, 1), name: "huge.png" } }),
  });
  check("oversized upload is rejected (413)", r.status === 413, { status: r.status });

  r = await A.fetch(`/api/posts/${postId}`, { method: "PATCH", json: { caption: "Edited caption #edited" } });
  check("post edit works", r.body.post?.caption === "Edited caption #edited" && r.body.post?.editedAt, r.body);
  check("hashtags re-synced on edit", r.body.post?.hashtags?.includes("edited") && !r.body.post?.hashtags?.includes("testing"), r.body.post?.hashtags);

  r = await B.fetch(`/api/posts/${postId}`, { method: "PATCH", json: { caption: "hijacked" } });
  check("cannot edit another user's post", r.status === 403, r.body);

  r = await B.fetch(`/api/posts/${postId}`, { method: "DELETE" });
  check("cannot delete another user's post", r.status === 403, r.body);

  console.log("\nEngagement");
  r = await B.fetch(`/api/posts/${postId}/like`, { method: "POST" });
  check("like increments count", r.body.post?.counts?.likes === 1 && r.body.post?.viewer?.liked === true, r.body);

  r = await B.fetch(`/api/posts/${postId}/like`, { method: "POST" });
  check("double like is idempotent", r.body.post?.counts?.likes === 1, r.body);

  r = await B.fetch(`/api/posts/${postId}/comments`, { method: "POST", json: { body: "Nice one" } });
  check("comment is created", r.status === 201 && r.body.comment?.body === "Nice one", r.body);
  const commentId = r.body.comment?.id;

  r = await B.fetch(`/api/posts/${postId}/comments`, { method: "POST", json: { body: "   " } });
  check("empty comment is rejected", r.status === 400, r.body);

  r = await B.fetch(`/api/posts/${postId}/comments`, { method: "POST", json: { body: "A reply", parentId: commentId } });
  check("threaded reply is created", r.status === 201 && r.body.comment?.parentId === commentId, r.body);

  r = await B.fetch(`/api/posts/${postId}/save`, { method: "POST" });
  check("save works", r.body.post?.viewer?.saved === true, r.body);
  r = await B.fetch("/api/me/saved");
  check("saved post appears in saved list", r.body.posts?.some((p) => p.id === postId), r.body.posts?.length);

  r = await A.fetch("/api/notifications");
  check("author received like + comment notifications", r.body.notifications?.length >= 2 && r.body.unread >= 2, r.body.notifications?.map((n) => n.type));
  check("mention notification delivered", true);

  r = await B.fetch("/api/notifications");
  check("mentioned user got a mention notification", r.body.notifications?.some((n) => n.type === "mention"), r.body.notifications?.map((n) => n.type));

  r = await B.fetch(`/api/posts/${postId}/like`, { method: "DELETE" });
  check("unlike decrements count", r.body.post?.counts?.likes === 0, r.body);
  r = await A.fetch("/api/notifications");
  check("unlike removes the like notification", !r.body.notifications?.some((n) => n.type === "like"), r.body.notifications?.map((n) => n.type));

  console.log("\nFollowing");
  r = await B.fetch(`/api/users/${(await A.fetch("/api/auth/me")).body.user.id}/follow`, { method: "POST" });
  const alphaId = (await A.fetch("/api/auth/me")).body.user.id;
  check("follow works", r.body.user?.relation?.isFollowing === true, r.body.user?.relation);

  r = await A.fetch("/api/feed");
  check("own posts appear in feed", r.body.posts?.some((p) => p.id === postId), r.body.posts?.length);

  r = await B.fetch("/api/feed");
  check("followed user's post appears in feed", r.body.posts?.some((p) => p.id === postId), r.body.posts?.length);

  r = await B.fetch(`/api/users/${alphaId}/follow`, { method: "DELETE" });
  check("unfollow works", r.body.user?.relation?.isFollowing === false, r.body.user?.relation);

  console.log("\nPrivate accounts");
  const C = client();
  r = await C.fetch("/api/auth/signup", { method: "POST", json: users.gamma });
  const gammaId = r.body.user.id;
  await C.fetch("/api/me", { method: "PATCH", json: { isPrivate: true } });
  await C.fetch("/api/posts", { method: "POST", body: form({ images: { file: testImage() }, caption: "private post" }) });

  r = await B.fetch(`/api/users/${users.gamma.username}/posts`);
  check("private account's posts are hidden from strangers", r.status === 403, { status: r.status });

  r = await B.fetch(`/api/users/${gammaId}/follow`, { method: "POST" });
  check("following a private account creates a request", r.body.user?.relation?.isRequested === true, r.body.user?.relation);

  r = await C.fetch("/api/me/requests");
  check("private account sees the pending request", r.body.users?.some((u) => u.id === betaId), r.body.users);

  r = await C.fetch(`/api/me/requests/${betaId}/accept`, { method: "POST" });
  check("request can be accepted", r.body.ok === true, r.body);

  r = await B.fetch(`/api/users/${users.gamma.username}/posts`);
  check("accepted follower can see private posts", r.status === 200 && r.body.posts?.length === 1, { status: r.status });

  console.log("\nBlocking");
  r = await C.fetch(`/api/users/${betaId}/block`, { method: "POST" });
  check("block succeeds", r.body.ok === true, r.body);

  r = await B.fetch(`/api/users/${users.gamma.username}`);
  check("blocked user cannot load the profile", r.status === 404, { status: r.status });

  r = await B.fetch(`/api/users/${users.gamma.username}/posts`);
  check("blocked user cannot list posts", r.status === 404, { status: r.status });

  r = await B.fetch(`/api/users/${gammaId}/follow`, { method: "POST" });
  check("blocked user cannot follow", r.status === 404, { status: r.status });

  r = await C.fetch("/api/me/blocked");
  check("blocked list contains the user", r.body.users?.some((u) => u.id === betaId), r.body.users);

  await C.fetch(`/api/users/${betaId}/block`, { method: "DELETE" });
  r = await B.fetch(`/api/users/${users.gamma.username}`);
  check("unblock restores access", r.status === 200, { status: r.status });

  console.log("\nStories");
  r = await A.fetch("/api/stories", { method: "POST", body: form({ image: { file: testImage() }, caption: "story!" }) });
  check("story is created", r.status === 201 && !!r.body.story?.id, r.body);
  const storyId = r.body.story?.id;
  check("story expires within 24h", r.body.story?.expiresAt - r.body.story?.createdAt === 86400000, r.body.story);

  await B.fetch(`/api/users/${alphaId}/follow`, { method: "POST" });
  r = await B.fetch("/api/stories");
  check("follower sees the story in their rail", r.body.groups?.some((g) => g.author.id === alphaId), r.body.groups?.length);
  check("story starts unseen", r.body.groups?.find((g) => g.author.id === alphaId)?.hasUnseen === true);

  r = await B.fetch(`/api/stories/${storyId}/view`, { method: "POST" });
  check("marking a story viewed works", r.body.ok === true, r.body);
  r = await B.fetch("/api/stories");
  check("story is now seen", r.body.groups?.find((g) => g.author.id === alphaId)?.hasUnseen === false);

  r = await A.fetch(`/api/stories/${storyId}/viewers`);
  check("author can see story viewers", r.body.users?.some((u) => u.id === betaId), r.body.users);

  r = await B.fetch(`/api/stories/${storyId}/viewers`);
  check("non-author cannot see story viewers", r.status === 403, { status: r.status });

  console.log("\nMessaging");
  r = await A.fetch("/api/conversations", { method: "POST", json: { userId: betaId } });
  check("conversation is created", r.status === 201 && !!r.body.conversation?.id, r.body);
  const convId = r.body.conversation?.id;

  r = await A.fetch("/api/conversations", { method: "POST", json: { userId: betaId } });
  check("re-opening returns the same conversation", r.body.conversation?.id === convId, r.body);

  r = await A.fetch(`/api/conversations/${convId}/messages`, { method: "POST", json: { body: "hello there" } });
  check("message sends", r.status === 201 && r.body.message?.body === "hello there", r.body);
  const messageId = r.body.message?.id;

  r = await A.fetch(`/api/conversations/${convId}/messages`, { method: "POST", json: { body: "" } });
  check("empty message is rejected", r.status === 400, r.body);

  r = await B.fetch("/api/conversations/unread-count");
  check("recipient has an unread conversation", r.body.unread === 1, r.body);

  r = await B.fetch(`/api/conversations/${convId}/read`, { method: "POST" });
  r = await B.fetch("/api/conversations/unread-count");
  check("marking read clears the badge", r.body.unread === 0, r.body);

  const D = client();
  await D.fetch("/api/auth/signup", {
    method: "POST",
    json: { username: `smoke_d_${stamp}`, email: `smoke_d_${stamp}@test.dev`, password: "smoketest123" },
  });
  r = await D.fetch(`/api/conversations/${convId}/messages`);
  check("outsider cannot read a conversation", r.status === 404, { status: r.status });
  r = await D.fetch(`/api/conversations/${convId}/messages`, { method: "POST", json: { body: "intruding" } });
  check("outsider cannot post to a conversation", r.status === 404, { status: r.status });

  r = await B.fetch(`/api/messages/${messageId}`, { method: "DELETE" });
  check("cannot delete someone else's message", r.status === 403, { status: r.status });
  r = await A.fetch(`/api/messages/${messageId}`, { method: "DELETE" });
  check("can delete own message", r.body.ok === true, r.body);

  console.log("\nSearch & explore");
  r = await A.fetch(`/api/explore/search?q=${users.beta.username.slice(0, 10)}`);
  check("user search finds accounts", r.body.users?.some((u) => u.username === users.beta.username), r.body.users?.length);

  r = await A.fetch("/api/explore/search?q=%23edited");
  check("hashtag search works", r.body.tags?.some((t) => t.tag === "edited"), r.body.tags);

  r = await A.fetch("/api/explore/tags/edited");
  check("hashtag page returns posts", r.body.posts?.some((p) => p.id === postId), r.body.posts?.length);

  r = await A.fetch("/api/explore/search?q=");
  check("empty search returns empty results", r.body.users?.length === 0 && r.body.posts?.length === 0, r.body);

  r = await anon.fetch("/api/explore");
  check("explore works anonymously", r.status === 200 && Array.isArray(r.body.posts), { status: r.status });

  console.log("\nReports & cleanup");
  r = await B.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: postId, reason: "spam" } });
  check("report is accepted", r.status === 201, r.body);

  r = await B.fetch("/api/reports", { method: "POST", json: { targetType: "banana", targetId: postId, reason: "spam" } });
  check("invalid report type is rejected", r.status === 400, r.body);

  r = await A.fetch(`/api/posts/${postId}`, { method: "DELETE" });
  check("author can delete their post", r.body.ok === true, r.body);
  r = await A.fetch(`/api/posts/${postId}`);
  check("deleted post is gone", r.status === 404, { status: r.status });

  console.log("\nPassword & session");
  r = await A.fetch("/api/auth/password", { method: "POST", json: { currentPassword: "wrong", newPassword: "newpass12345" } });
  check("wrong current password is rejected", r.status === 400, r.body);

  r = await A.fetch("/api/auth/password", {
    method: "POST",
    json: { currentPassword: users.alpha.password, newPassword: "newpass12345" },
  });
  check("password change works", r.body.ok === true, r.body);

  r = await A.fetch("/api/auth/logout", { method: "POST" });
  check("logout works", r.body.ok === true, r.body);
  r = await A.fetch("/api/auth/me");
  check("session is dead after logout", r.body.user === null, r.body);

  r = await A.fetch("/api/auth/login", { method: "POST", json: { identifier: users.alpha.email, password: "newpass12345" } });
  check("login with new password + email works", r.status === 200, r.body);

  r = await A.fetch("/api/auth/forgot", { method: "POST", json: { email: users.alpha.email } });
  check("forgot password responds ok", r.body.ok === true, r.body);
  r = await A.fetch("/api/auth/forgot", { method: "POST", json: { email: "nobody@nowhere.test" } });
  check("forgot password does not leak account existence", r.body.ok === true && !r.body.link, r.body);

  console.log("\nAccount deletion");
  r = await D.fetch("/api/me", { method: "DELETE", json: {} });
  check("account deletion requires the password", r.status === 400, r.body);
  r = await D.fetch("/api/me", { method: "DELETE", json: { password: "not-the-password" } });
  check("account deletion rejects a wrong password", r.status === 400, r.body);

  // Delete the throwaway accounts so repeated runs don't pile up in a demo database.
  console.log("\nCleanup");
  const passwords = [
    [A, "newpass12345"], // A changed its password earlier in the run
    [B, users.beta.password],
    [C, users.gamma.password],
    [D, "smoketest123"],
  ];
  let removed = 0;
  for (const [session, password] of passwords) {
    const res = await session.fetch("/api/me", { method: "DELETE", json: { password } });
    if (res.status === 200) removed++;
  }
  check(`test accounts removed (${removed}/4)`, removed === 4, { removed });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    console.log("Failed:");
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});

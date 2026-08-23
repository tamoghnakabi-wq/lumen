/**
 * Feature suite for reposts, quote reposts, bookmark collections, mentions,
 * comment threading and link previews.
 *
 *   node scripts/social-test.js [baseUrl]
 *
 * Run against a server started with DISABLE_RATE_LIMITS=1 (development only) —
 * it creates several accounts and posts, which the production ceilings stop.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";

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
        const value = pair.slice(eq + 1).trim();
        if (value === "") jar.delete(pair.slice(0, eq).trim());
        else jar.set(pair.slice(0, eq).trim(), value);
      }
      const type = res.headers.get("content-type") ?? "";
      return { status: res.status, body: type.includes("application/json") ? await res.json() : await res.text() };
    },
  };
}

function png(width = 48, height = 48) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 4) % 256;
      raw[o++] = (y * 4) % 256;
      raw[o++] = 180;
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

function form(fields) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value && value.file) fd.append(key, new Blob([value.file], { type: "image/png" }), "test.png");
    else fd.append(key, value);
  }
  return fd;
}

const stamp = crypto.randomBytes(3).toString("hex");
const pw = "SocialSuite!2026";
const people = {
  author: { username: `soc_aut_${stamp}`, email: `soc_aut_${stamp}@test.dev`, password: pw },
  fan: { username: `soc_fan_${stamp}`, email: `soc_fan_${stamp}@test.dev`, password: pw },
  watcher: { username: `soc_wat_${stamp}`, email: `soc_wat_${stamp}@test.dev`, password: pw },
  hermit: { username: `soc_her_${stamp}`, email: `soc_her_${stamp}@test.dev`, password: pw },
};

async function main() {
  console.log(`\nLumen social feature suite → ${BASE}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`\nCannot reach ${BASE}.\n`);
    process.exit(1);
  }

  const author = client();
  const fan = client();
  const watcher = client();
  const hermit = client();
  const anon = client();

  const ids = {};
  for (const [key, account] of Object.entries(people)) {
    const session = { author, fan, watcher, hermit }[key];
    const r = await session.fetch("/api/auth/signup", { method: "POST", json: account });
    if (r.status !== 201) {
      console.error(`\nCould not create ${key} (${r.status}). Start the server with DISABLE_RATE_LIMITS=1.\n`);
      process.exit(1);
    }
    ids[key] = r.body.user.id;
  }

  // fan follows author and watcher follows fan, so reposts can travel.
  await fan.fetch(`/api/users/${ids.author}/follow`, { method: "POST" });
  await watcher.fetch(`/api/users/${ids.fan}/follow`, { method: "POST" });

  const original = (
    await author.fetch("/api/posts", {
      method: "POST",
      body: form({ images: { file: png() }, caption: "the original photograph #repostme" }),
    })
  ).body.post;

  /* --------------------------------------------------------------- reposts */
  heading("Reposts");

  let r = await fan.fetch(`/api/posts/${original.id}/repost`, { method: "POST" });
  check("repost succeeds", r.status === 200 && r.body.post.counts.reposts === 1, r.body.post?.counts);
  check("viewer state reflects the repost", r.body.post.viewer.reposted === true, r.body.post?.viewer);

  r = await fan.fetch(`/api/posts/${original.id}/repost`, { method: "POST" });
  check("reposting twice counts once", r.body.post.counts.reposts === 1, r.body.post?.counts);

  r = await author.fetch(`/api/posts/${original.id}/repost`, { method: "POST" });
  check("cannot repost your own post", r.status === 400, { status: r.status });

  r = await watcher.fetch("/api/feed");
  const carried = r.body.posts.find((p) => p.id === original.id);
  check("a repost carries the post into a follower's feed", !!carried, r.body.posts?.length);
  check("...attributed to the person who reposted", carried?.repostedBy?.username === people.fan.username, carried?.repostedBy);
  check("...while the author stays the author", carried?.author?.username === people.author.username, carried?.author);

  r = await author.fetch("/api/notifications");
  check("the author is notified of the repost", r.body.notifications.some((n) => n.type === "repost"), r.body.notifications?.map((n) => n.type));

  r = await fan.fetch(`/api/users/${people.fan.username}/reposts`);
  check("the repost appears on the reposter's tab", r.body.posts?.some((p) => p.id === original.id), r.body.posts?.length);

  r = await anon.fetch(`/api/users/${people.fan.username}/reposts`);
  check("the reposts tab is readable for a public account", r.status === 200, { status: r.status });

  r = await fan.fetch(`/api/posts/${original.id}/reposts`);
  check("the repost list names the reposter", r.body.users?.some((u) => u.username === people.fan.username), r.body.users);

  r = await fan.fetch(`/api/posts/${original.id}/repost`, { method: "DELETE" });
  check("undoing a repost drops the count", r.body.post.counts.reposts === 0, r.body.post?.counts);
  r = await author.fetch("/api/notifications");
  check("...and withdraws the notification", !r.body.notifications.some((n) => n.type === "repost"), r.body.notifications?.map((n) => n.type));
  r = await watcher.fetch("/api/feed");
  check("...and removes it from the follower's feed", !r.body.posts.some((p) => p.id === original.id));

  /* ------------------------------------------------------- repost privacy */
  heading("Repost privacy");

  await hermit.fetch("/api/me", { method: "PATCH", json: { isPrivate: true } });
  const secret = (
    await hermit.fetch("/api/posts", { method: "POST", body: form({ images: { file: png() }, caption: "behind the wall" }) })
  ).body.post;
  await fan.fetch(`/api/users/${ids.hermit}/follow`, { method: "POST" });
  await hermit.fetch(`/api/me/requests/${ids.fan}/accept`, { method: "POST" });

  r = await fan.fetch(`/api/posts/${secret.id}`);
  check("an approved follower can read the private post", r.status === 200, { status: r.status });
  r = await fan.fetch(`/api/posts/${secret.id}/repost`, { method: "POST" });
  check("...but cannot repost it", r.status === 403, { status: r.status, error: r.body?.error });
  r = await fan.fetch("/api/posts", { method: "POST", body: form({ quotedPostId: secret.id, caption: "look at this" }) });
  check("...and cannot quote it either", r.status === 403, { status: r.status });

  r = await watcher.fetch(`/api/posts/${secret.id}/repost`, { method: "POST" });
  check("a stranger cannot repost a private post", r.status === 403 || r.status === 404, { status: r.status });

  /* ---------------------------------------------------------------- quotes */
  heading("Quote reposts");

  r = await fan.fetch("/api/posts", { method: "POST", body: form({ quotedPostId: original.id }) });
  check("an empty quote is rejected", r.status === 400, { status: r.status });

  r = await fan.fetch("/api/posts", {
    method: "POST",
    body: form({ quotedPostId: original.id, caption: `this is great, @${people.author.username}` }),
  });
  const quote = r.body.post;
  check("a quote with no image of its own is allowed", r.status === 201, { status: r.status, error: r.body?.error });
  check("the quoted post is embedded", quote?.quotedPost?.id === original.id, quote?.quotedPost?.id);
  check("the quote carries no media of its own", quote?.media?.length === 0, quote?.media?.length);

  r = await author.fetch(`/api/posts/${original.id}`);
  check("the original's quote count rises", r.body.post.counts.quotes === 1, r.body.post?.counts);
  r = await author.fetch("/api/notifications");
  check("the author is notified of the quote", r.body.notifications.some((n) => n.type === "quote"), r.body.notifications?.map((n) => n.type));
  check("the mention inside the quote also notified", r.body.notifications.some((n) => n.type === "mention"), true);

  r = await fan.fetch("/api/posts", {
    method: "POST",
    body: form({ quotedPostId: original.id, caption: "quote with my own picture", images: { file: png() } }),
  });
  check("a quote may also carry its own image", r.status === 201 && r.body.post.media.length === 1, r.body.post?.media?.length);

  // A quote survives its original being deleted, as a tombstone.
  const doomed = (
    await author.fetch("/api/posts", { method: "POST", body: form({ images: { file: png() }, caption: "short lived" }) })
  ).body.post;
  const quoteOfDoomed = (
    await fan.fetch("/api/posts", { method: "POST", body: form({ quotedPostId: doomed.id, caption: "quoting this" }) })
  ).body.post;
  await author.fetch(`/api/posts/${doomed.id}`, { method: "DELETE" });
  r = await fan.fetch(`/api/posts/${quoteOfDoomed.id}`);
  check("a quote outlives the post it quoted", r.status === 200, { status: r.status });
  check("...and reports it as unavailable", r.body.post.quotedPost === null && r.body.post.quotedUnavailable === true, {
    quotedPost: r.body.post?.quotedPost,
    unavailable: r.body.post?.quotedUnavailable,
  });

  // Blocking hides the embedded original from that viewer only.
  await author.fetch(`/api/users/${ids.watcher}/block`, { method: "POST" });
  r = await watcher.fetch(`/api/posts/${quote.id}`);
  check("a blocked viewer sees the quote but not its contents", r.status === 200 && r.body.post.quotedPost === null, {
    status: r.status,
    quoted: r.body.post?.quotedPost,
  });
  check("...marked unavailable rather than silently blank", r.body.post?.quotedUnavailable === true);
  await author.fetch(`/api/users/${ids.watcher}/block`, { method: "DELETE" });
  r = await watcher.fetch(`/api/posts/${quote.id}`);
  check("unblocking restores the embedded post", r.body.post?.quotedPost?.id === original.id);

  /* ----------------------------------------------------------- collections */
  heading("Bookmark collections");

  r = await fan.fetch("/api/collections", { method: "POST", json: { name: "Inspiration" } });
  const collection = r.body.collection;
  check("collection created", r.status === 201 && !!collection?.id, r.body);

  r = await fan.fetch("/api/collections", { method: "POST", json: { name: "inspiration" } });
  check("duplicate names are rejected regardless of case", r.status === 409, { status: r.status });

  r = await fan.fetch(`/api/collections/${collection.id}/posts/${original.id}`, { method: "PUT" });
  check("a post can be filed into a collection", r.status === 200, r.body);

  r = await fan.fetch("/api/me/saved");
  check("filing a post also bookmarks it", r.body.posts.some((p) => p.id === original.id), r.body.posts?.length);

  r = await fan.fetch(`/api/collections/${collection.id}/posts`);
  check("the collection lists its post", r.body.posts?.some((p) => p.id === original.id), r.body.posts?.length);

  r = await fan.fetch(`/api/collections/-/for-post/${original.id}`);
  check("the picker knows which collections hold the post", r.body.collections?.[0]?.contains === true, r.body.collections);

  r = await watcher.fetch(`/api/collections/${collection.id}/posts`);
  check("another user cannot read someone else's collection", r.status === 404, { status: r.status });
  r = await watcher.fetch(`/api/collections/${collection.id}`, { method: "DELETE" });
  check("...nor delete it", r.status === 404, { status: r.status });

  // Un-bookmarking must not leave the post filed in a collection.
  await fan.fetch(`/api/posts/${original.id}/save`, { method: "DELETE" });
  r = await fan.fetch(`/api/collections/${collection.id}/posts`);
  check("un-saving removes the post from its collections", r.body.posts?.length === 0, r.body.posts?.length);

  r = await fan.fetch(`/api/collections/${collection.id}`, { method: "PATCH", json: { name: "Renamed" } });
  check("collection can be renamed", r.status === 200, r.body);
  r = await fan.fetch("/api/collections");
  check("...and the new name is listed", r.body.collections.some((c) => c.name === "Renamed"), r.body.collections);

  await fan.fetch(`/api/collections/${collection.id}/posts/${original.id}`, { method: "PUT" });
  await fan.fetch(`/api/collections/${collection.id}`, { method: "DELETE" });
  r = await fan.fetch("/api/me/saved");
  check("deleting a collection keeps the posts bookmarked", r.body.posts.some((p) => p.id === original.id), r.body.posts?.length);

  /* -------------------------------------------------------------- comments */
  heading("Comments and replies");

  for (let i = 0; i < 23; i++) {
    await watcher.fetch(`/api/posts/${original.id}/comments`, { method: "POST", json: { body: `comment number ${i}` } });
  }
  r = await watcher.fetch(`/api/posts/${original.id}/comments`);
  check("top-level comments are paged", r.body.comments.length === 20 && r.body.nextCursor === 20, {
    got: r.body.comments?.length,
    next: r.body.nextCursor,
  });
  const rootId = r.body.comments[0].id;

  r = await watcher.fetch(`/api/posts/${original.id}/comments?cursor=20`);
  check("the next page returns the remainder", r.body.comments.length === 3 && r.body.nextCursor === null, {
    got: r.body.comments?.length,
  });

  r = await watcher.fetch(`/api/posts/${original.id}/comments?sort=new`);
  check("sort=new puts the newest first", r.body.comments[0].body === "comment number 22", r.body.comments?.[0]?.body);

  await author.fetch(`/api/comments/${rootId}/like`, { method: "POST" });
  r = await watcher.fetch(`/api/posts/${original.id}/comments?sort=top`);
  check("sort=top floats the liked comment", r.body.comments[0].id === rootId, r.body.comments?.[0]?.id);

  await author.fetch(`/api/posts/${original.id}/comments`, { method: "POST", json: { body: "a reply", parentId: rootId } });
  r = await watcher.fetch(`/api/posts/${original.id}/comments?sort=top`);
  const withReply = r.body.comments.find((c) => c.id === rootId);
  check("a root comment reports its reply count", withReply?.counts?.replies === 1, withReply?.counts);
  check("replies are not mixed into the top-level page", r.body.comments.every((c) => c.parentId === null), true);

  r = await watcher.fetch(`/api/comments/${rootId}/replies`);
  check("replies load on demand", r.body.replies?.length === 1 && r.body.replies[0].body === "a reply", r.body.replies);

  await watcher.fetch(`/api/comments/${rootId}`, { method: "DELETE" });
  r = await watcher.fetch(`/api/comments/${rootId}/replies`);
  check("deleting a parent removes its replies", r.status === 404, { status: r.status });

  /* -------------------------------------------------------------- mentions */
  heading("Mention autocomplete");

  r = await fan.fetch(`/api/explore/mentions?q=${people.author.username.slice(0, 8)}`);
  check("autocomplete finds the account", r.body.users?.some((u) => u.username === people.author.username), r.body.users);
  check("...and marks people you follow as connected", r.body.users?.find((u) => u.username === people.author.username)?.connected === true, r.body.users);

  r = await anon.fetch("/api/explore/mentions?q=soc_");
  check("autocomplete requires a session", r.body.users?.length === 0, r.body.users?.length);

  await watcher.fetch(`/api/users/${ids.author}/block`, { method: "POST" });
  r = await watcher.fetch(`/api/explore/mentions?q=${people.author.username.slice(0, 8)}`);
  check("blocked accounts never appear in autocomplete", !r.body.users?.some((u) => u.username === people.author.username), r.body.users);
  await watcher.fetch(`/api/users/${ids.author}/block`, { method: "DELETE" });

  r = await fan.fetch("/api/explore/mentions?q=");
  check("an empty query returns nothing", r.body.users?.length === 0);

  /* --------------------------------------------------------- link previews */
  heading("Link previews for sharing");

  const publicHtml = (await anon.fetch(`/p/${original.id}`)).body;
  const hasOg = typeof publicHtml === "string" && publicHtml.includes('property="og:title"');
  check("a shared post link carries Open Graph tags", hasOg, typeof publicHtml === "string" ? publicHtml.slice(0, 60) : null);
  if (hasOg) {
    check("...naming the author", publicHtml.includes(`@${people.author.username}`), true);
    check("...with the post image", publicHtml.includes("og:image"), true);
    check("...and the caption as the description", publicHtml.includes("the original photograph"), true);
  }

  const privateHtml = (await anon.fetch(`/p/${secret.id}`)).body;
  check("a private post's caption never reaches the preview", !privateHtml.includes("behind the wall"), true);

  const escaped = (
    await author.fetch("/api/posts", {
      method: "POST",
      body: form({ images: { file: png() }, caption: '"><script>alert(1)</script> quoted "caption"' }),
    })
  ).body.post;
  const escapedHtml = (await anon.fetch(`/p/${escaped.id}`)).body;
  check("a hostile caption is escaped in the meta tags", !escapedHtml.includes("<script>alert(1)</script>"), true);
  check("...and does not break out of the attribute", !/content="[^"]*"><script/.test(escapedHtml), true);

  const profileHtml = (await anon.fetch(`/${people.author.username}`)).body;
  check("profile links preview too", profileHtml.includes(`@${people.author.username}`), true);

  /* ------------------------------------------------------ story replies */
  heading("Story replies and reactions");

  const story = (
    await author.fetch("/api/stories", { method: "POST", body: form({ image: { file: png() }, caption: "out early" }) })
  ).body.story;
  check("story created", !!story?.id, story);
  check("a new story has no reaction from the viewer", story.myReaction === null, story?.myReaction);

  r = await fan.fetch(`/api/stories/${story.id}/react`, { method: "POST", json: { emoji: "🔥" } });
  check("a viewer can react to a story", r.status === 200 && r.body.reaction === "🔥", r.body);

  r = await fan.fetch(`/api/stories/${story.id}/react`, { method: "POST", json: { emoji: "😍" } });
  check("reacting again replaces the previous reaction", r.body.reaction === "😍", r.body);

  r = await author.fetch(`/api/stories/${story.id}/viewers`);
  const viewer = r.body.users?.find((u) => u.username === people.fan.username);
  check("the reaction shows in the author's viewer list", viewer?.reaction === "😍", viewer);
  check("reacting also counts as a view", !!viewer, r.body.users);

  r = await author.fetch("/api/notifications");
  check("the author is notified of the reaction", r.body.notifications.some((n) => n.type === "story_reaction"), r.body.notifications?.map((n) => n.type));
  const reactionNotifications = r.body.notifications.filter((n) => n.type === "story_reaction").length;
  check("changing a reaction does not stack notifications", reactionNotifications === 1, { reactionNotifications });

  r = await fan.fetch(`/api/stories/${story.id}/react`, { method: "POST", json: { emoji: "🚀" } });
  check("an emoji outside the set is rejected", r.status === 400, { status: r.status });

  r = await author.fetch(`/api/stories/${story.id}/react`, { method: "POST", json: { emoji: "🔥" } });
  check("you cannot react to your own story", r.status === 400, { status: r.status });

  r = await fan.fetch(`/api/stories/${story.id}/react`, { method: "DELETE" });
  check("a reaction can be removed", r.body.reaction === null, r.body);
  r = await author.fetch("/api/notifications");
  check("...which withdraws the notification", !r.body.notifications.some((n) => n.type === "story_reaction"), true);

  // Replies land in the normal inbox, carrying the story as context.
  r = await fan.fetch(`/api/stories/${story.id}/reply`, { method: "POST", json: { body: "where is this?" } });
  check("a story reply is accepted", r.status === 201 && !!r.body.conversationId, r.body);
  const storyThread = r.body.conversationId;

  r = await fan.fetch(`/api/stories/${story.id}/reply`, { method: "POST", json: { body: "   " } });
  check("an empty reply is rejected", r.status === 400, { status: r.status });

  r = await author.fetch(`/api/conversations/${storyThread}/messages`);
  const replyMessage = r.body.messages?.find((m) => m.body === "where is this?");
  check("the reply arrives as a direct message", !!replyMessage, r.body.messages?.length);
  check("...flagged as a story reply", replyMessage?.isStoryReply === true, replyMessage);
  check("...carrying the story thumbnail", !!replyMessage?.story?.thumb, replyMessage?.story);
  check("...and marked as the author's own story", replyMessage?.story?.mine === true, replyMessage?.story);

  r = await author.fetch("/api/conversations/unread-count");
  check("the reply raises the recipient's unread badge", r.body.unread >= 1, r.body);

  r = await author.fetch(`/api/stories/${story.id}/viewers`);
  check("replying counts as viewing the story", r.body.users?.some((u) => u.username === people.fan.username), r.body.users);

  r = await author.fetch(`/api/stories/${story.id}/reply`, { method: "POST", json: { body: "talking to myself" } });
  check("you cannot reply to your own story", r.status === 400, { status: r.status });

  // Privacy: a story you cannot see cannot be replied to or reacted to.
  const hidden = (
    await hermit.fetch("/api/stories", { method: "POST", body: form({ image: { file: png() }, caption: "private story" }) })
  ).body.story;
  r = await watcher.fetch(`/api/stories/${hidden.id}/reply`, { method: "POST", json: { body: "hello" } });
  check("a stranger cannot reply to a private account's story", r.status === 403 || r.status === 404, { status: r.status });
  r = await watcher.fetch(`/api/stories/${hidden.id}/react`, { method: "POST", json: { emoji: "🔥" } });
  check("...nor react to it", r.status === 403 || r.status === 404, { status: r.status });

  await author.fetch(`/api/users/${ids.watcher}/block`, { method: "POST" });
  r = await watcher.fetch(`/api/stories/${story.id}/react`, { method: "POST", json: { emoji: "🔥" } });
  check("a blocked viewer cannot react", r.status === 403 || r.status === 404, { status: r.status });
  r = await watcher.fetch(`/api/stories/${story.id}/reply`, { method: "POST", json: { body: "hi" } });
  check("...nor reply", r.status === 403 || r.status === 404, { status: r.status });
  await author.fetch(`/api/users/${ids.watcher}/block`, { method: "DELETE" });

  // The reply outlives the story, which only lasts a day.
  await author.fetch(`/api/stories/${story.id}`, { method: "DELETE" });
  r = await author.fetch(`/api/conversations/${storyThread}/messages`);
  const orphaned = r.body.messages?.find((m) => m.body === "where is this?");
  check("the reply survives the story expiring", !!orphaned, r.body.messages?.length);
  check("...still marked as a story reply", orphaned?.isStoryReply === true, orphaned);
  check("...with the expired story reported as gone", orphaned?.story === null, orphaned?.story);

  r = await fan.fetch(`/api/stories/${story.id}/reply`, { method: "POST", json: { body: "too late" } });
  check("replying to an expired story is rejected", r.status === 404, { status: r.status });

  /* --------------------------------------------------------------- cleanup */
  heading("Cleanup");
  let removed = 0;
  for (const [key, account] of Object.entries(people)) {
    const session = { author, fan, watcher, hermit }[key];
    const res = await session.fetch("/api/me", { method: "DELETE", json: { password: account.password } });
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
  console.error("\nSocial suite crashed:", err);
  process.exit(1);
});

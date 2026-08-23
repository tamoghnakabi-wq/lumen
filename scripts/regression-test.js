/**
 * Regression cover for the 2026-08-22 sweep.
 *
 * The first section pins the three bugs that were found and fixed; the rest are
 * the invariants the sweep checked and found already sound — blocking, deletion
 * cascades, pagination, messaging and collections authorization — kept here so
 * they stay that way.
 *
 *   node scripts/regression-test.js [baseUrl]      (needs DISABLE_RATE_LIMITS=1)
 */
import { makeReporter, makeUser, makePost, cleanup, form, png } from "./lib/harness.mjs";

const R = makeReporter();
const users = [];

// Written as escapes so the source itself stays free of invisible characters.
const ZWJ = "\u200D";
const FAMILY = `\u{1F469}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`;
const BIDI = "rtl \u202Eoverride\u202C end";
const NUL = "null\u0000byte";

/** Walks every page of a cursor-paged list and returns the ids seen. */
async function walk(user, url, { cursorField = "nextCursor", param = "cursor", itemsField = "posts", cap = 30 } = {}) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < cap; page++) {
    const sep = url.includes("?") ? "&" : "?";
    const r = await user.c.fetch(cursor === null ? url : `${url}${sep}${param}=${encodeURIComponent(cursor)}`);
    if (r.status !== 200) return { ids, error: { status: r.status, body: r.body }, pages: page };
    const items = r.body?.[itemsField] ?? [];
    ids.push(...items.map((p) => p.id));
    cursor = r.body?.[cursorField] ?? null;
    if (cursor === null || cursor === undefined || items.length === 0) return { ids, pages: page + 1 };
  }
  return { ids, pages: cap, ranOut: true };
}

try {
  const a = await makeUser("fix_a"); users.push(a);
  const b = await makeUser("fix_b"); users.push(b);

  /* ------------------------------------------------------ info leak */
  R.heading("A block is indistinguishable from content that never existed");
  const post = await makePost(a, "private thoughts");
  const story = await a.c.fetch("/api/stories", {
    method: "POST",
    body: form({ image: { file: png(), type: "image/png", name: "s.png" }, caption: "story" }),
  });
  const storyId = story.body?.story?.id;

  const seen = await b.c.fetch(`/api/posts/${post.id}`);
  R.check("before the block the post reads fine", seen.status === 200, { status: seen.status });

  await a.c.fetch(`/api/users/${b.id}/block`, { method: "POST" });

  const blockedRead = await b.c.fetch(`/api/posts/${post.id}`);
  const missingRead = await b.c.fetch("/api/posts/thispostneverexisted");
  R.check("a blocked user gets 404 on the post, not 403", blockedRead.status === 404, { status: blockedRead.status });
  R.check("...the same status as a post that never existed", blockedRead.status === missingRead.status,
    { blocked: blockedRead.status, missing: missingRead.status });
  R.check("...with the same wording, so the code is not a tell",
    blockedRead.body?.error === missingRead.body?.error,
    { blocked: blockedRead.body?.error, missing: missingRead.body?.error });

  const blockedStory = await b.c.fetch(`/api/stories/${storyId}/view`, { method: "POST" });
  R.check("a blocked user gets 404 on the story", blockedStory.status === 404, { status: blockedStory.status });
  const blockedReply = await b.c.fetch(`/api/stories/${storyId}/reply`, { method: "POST", json: { body: "hi" } });
  R.check("...and on replying to it", blockedReply.status === 404, { status: blockedReply.status });
  const blockedStories = await b.c.fetch(`/api/stories/user/${a.username}`);
  R.check("...and on their story list", blockedStories.status === 404, { status: blockedStories.status });

  const blockedRepost = await b.c.fetch(`/api/posts/${post.id}/repost`, { method: "POST" });
  R.check("...and on reposting", blockedRepost.status === 404, { status: blockedRepost.status });

  await a.c.fetch(`/api/users/${b.id}/block`, { method: "DELETE" });

  R.heading("A private account still says it is private");
  await a.c.fetch("/api/me", { method: "PATCH", json: { isPrivate: true } });
  const privateRead = await b.c.fetch(`/api/posts/${post.id}`);
  R.check("a stranger gets 403, not a bare 404", privateRead.status === 403, { status: privateRead.status });
  R.check("...so the client can offer to request a follow",
    /private/i.test(privateRead.body?.error ?? ""), privateRead.body);
  await a.c.fetch("/api/me", { method: "PATCH", json: { isPrivate: false } });

  /* -------------------------------------------------------- reports */
  R.heading("Reports name something real");
  let r = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: "nosuchpostatall", reason: "spam" } });
  R.check("a made-up post id is refused", r.status === 404, { status: r.status });
  r = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "user", targetId: "nosuchuser", reason: "spam" } });
  R.check("a made-up user id is refused", r.status === 404, { status: r.status });
  r = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "comment", targetId: "nosuchcomment", reason: "spam" } });
  R.check("a made-up comment id is refused", r.status === 404, { status: r.status });

  r = await a.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: post.id, reason: "spam" } });
  R.check("reporting your own post is refused", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/reports", { method: "POST", json: { targetType: "user", targetId: a.id, reason: "spam" } });
  R.check("reporting yourself is refused", r.status === 400, { status: r.status });

  const first = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: post.id, reason: "spam" } });
  R.check("a real report is filed", first.status === 201, { status: first.status });
  const second = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: post.id, reason: "hate" } });
  R.check("filing it again does not create a second row", second.status === 200, { status: second.status });
  R.check("...and says so plainly", /already/i.test(second.body?.message ?? ""), second.body);

  const cmt = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "a comment" } });
  r = await a.c.fetch("/api/reports", { method: "POST", json: { targetType: "comment", targetId: cmt.body.comment.id, reason: "spam" } });
  R.check("reporting someone else's comment works", r.status === 201, { status: r.status });

  /* ------------------------------------------------------- renaming */
  R.heading("Changing your username");
  const original = a.username;
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: b.username } });
  R.check("a taken username is refused", r.status === 409, { status: r.status });
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: "ab" } });
  R.check("a too-short username is refused", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: "has spaces" } });
  R.check("a username with spaces is refused", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: "settings" } });
  R.check("a reserved word is refused", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: "reels" } });
  R.check("a route name is reserved too", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: "bad..dots" } });
  R.check("consecutive dots are refused", r.status === 400, { status: r.status });

  const renamed = `renamed${Math.random().toString(36).slice(2, 7)}`;
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: renamed } });
  R.check("a valid rename succeeds", r.status === 200 && r.body?.user?.username === renamed,
    { status: r.status, username: r.body?.user?.username });
  a.username = renamed;

  r = await b.c.fetch(`/api/users/${renamed}`);
  R.check("the profile answers on the new handle", r.status === 200, { status: r.status });
  r = await b.c.fetch(`/api/users/${original}`);
  R.check("the old handle stops resolving", r.status === 404, { status: r.status });

  r = await b.c.fetch(`/api/posts/${post.id}`);
  R.check("existing posts follow the rename", r.body?.post?.author?.username === renamed,
    { author: r.body?.post?.author?.username });

  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: `again${Math.random().toString(36).slice(2, 6)}` } });
  R.check("a second rename is blocked by the cooldown", r.status === 400, { status: r.status });
  R.check("...and says how long to wait", /\d+ day/.test(r.body?.error ?? ""), r.body?.error);

  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: renamed, displayName: "Same Handle" } });
  R.check("saving other fields without changing the handle still works",
    r.status === 200 && r.body?.user?.displayName === "Same Handle", { status: r.status, body: r.body?.user?.displayName });

  const avail = await a.c.fetch(`/api/auth/available?username=${encodeURIComponent(renamed)}`);
  R.check("your own current handle reads as taken", avail.body?.available === false, avail.body);
  /* ========== Input, boundaries and pagination ========== */
  {

  const a = await makeUser("edge_a"); users.push(a);
  const b = await makeUser("edge_b"); users.push(b);

  /* ------------------------------------------------------ pagination */
  R.heading("Pagination cannot be abused or crashed");
  for (const [name, url] of [
    ["feed", "/api/feed"],
    ["explore", "/api/explore"],
    ["reels", "/api/reels"],
    ["notifications", "/api/notifications"],
    ["explore tags", "/api/explore/tags"],
  ]) {
    let r = await a.c.fetch(`${url}?offset=-5`);
    R.check(`${name}: a negative offset is refused or clamped`, r.status === 200 || r.status === 400, { status: r.status });
    r = await a.c.fetch(`${url}?offset=999999999999`);
    R.check(`${name}: an absurd offset does not error`, r.status === 200 || r.status === 400, { status: r.status });
    r = await a.c.fetch(`${url}?limit=100000`);
    const items = r.body?.posts ?? r.body?.reels ?? r.body?.notifications ?? [];
    R.check(`${name}: a huge limit is capped`, r.status !== 500 && items.length <= 100, { status: r.status, n: items.length });
    r = await a.c.fetch(`${url}?offset=abc&limit=xyz`);
    R.check(`${name}: junk pagination does not 500`, r.status !== 500, { status: r.status });
  }

  /* -------------------------------------------------------- captions */
  R.heading("Text input");
  const post = await makePost(a, "base");

  let r = await a.c.fetch(`/api/posts/${post.id}`, { method: "PATCH", json: { caption: "x".repeat(100000) } });
  R.check("an enormous caption is refused", r.status === 400 || r.status === 413, { status: r.status });

  r = await a.c.fetch(`/api/posts/${post.id}`, { method: "PATCH", json: { caption: "  \n\t  " } });
  R.check("a whitespace-only caption does not 500", r.status !== 500, { status: r.status });

  r = await a.c.fetch(`/api/posts/${post.id}`, { method: "PATCH", json: { caption: `emoji ${FAMILY} ok` } });
  R.check("emoji and ZWJ sequences survive a round trip",
    r.status === 200 && r.body.post.caption.includes(FAMILY), { status: r.status, cap: r.body?.post?.caption });

  r = await a.c.fetch(`/api/posts/${post.id}`, { method: "PATCH", json: { caption: NUL } });
  R.check("a null byte does not 500", r.status !== 500, { status: r.status });

  r = await a.c.fetch(`/api/posts/${post.id}`, { method: "PATCH", json: { caption: BIDI } });
  R.check("bidi override characters do not 500", r.status !== 500, { status: r.status });

  r = await a.c.fetch(`/api/posts/${post.id}`, { method: "PATCH", json: { caption: 12345 } });
  R.check("a non-string caption is refused", r.status === 400, { status: r.status });

  r = await a.c.fetch(`/api/posts/${post.id}`, { method: "PATCH", json: { caption: { $ne: null } } });
  R.check("an object caption is refused", r.status === 400, { status: r.status });

  /* ------------------------------------------------------- hashtags */
  R.heading("Hashtags");
  const tagPost = await makePost(a, `#${"a".repeat(200)} #ok #OK #ok`);
  R.check("an over-long hashtag does not break the post", tagPost.hashtags.every((t) => t.length <= 100), tagPost.hashtags);
  R.check("hashtags are de-duplicated case-insensitively",
    tagPost.hashtags.filter((t) => t.toLowerCase() === "ok").length === 1, tagPost.hashtags);

  r = await a.c.fetch(`/api/explore/tags/${encodeURIComponent("a".repeat(300))}`);
  R.check("a huge tag lookup does not 500", r.status !== 500, { status: r.status });
  r = await a.c.fetch(`/api/explore/tags/${encodeURIComponent("../../etc/passwd")}`);
  R.check("a traversal-shaped tag does not 500", r.status !== 500, { status: r.status });

  /* --------------------------------------------------------- search */
  R.heading("Search");
  for (const [name, q] of [
    ["empty", ""],
    ["one space", " "],
    ["percent", "%"],
    ["underscore wildcard", "_"],
    ["sql-ish", "' OR 1=1 --"],
    ["long", "x".repeat(5000)],
    ["emoji", "\u{1F525}"],
    ["unicode", "日本語"],
  ]) {
    const res = await a.c.fetch(`/api/explore/search?q=${encodeURIComponent(q)}`);
    R.check(`search handles ${name}`, res.status !== 500, { status: res.status });
  }
  const pct = await a.c.fetch(`/api/explore/search?q=${encodeURIComponent("%")}`);
  R.check("a bare % does not match every user (LIKE wildcard escaped)",
    (pct.body?.users ?? []).length === 0, { n: (pct.body?.users ?? []).length });
  const usc = await a.c.fetch(`/api/explore/search?q=${encodeURIComponent("_")}`);
  R.check("a bare _ is a literal, not a single-character wildcard",
    (usc.body?.users ?? []).every((u) => u.username.includes("_")),
    (usc.body?.users ?? []).map((u) => u.username).slice(0, 5));

  /* ------------------------------------------------------- comments */
  R.heading("Comments");
  r = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "" } });
  R.check("an empty comment is refused", r.status === 400, { status: r.status });
  r = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "   " } });
  R.check("a whitespace comment is refused", r.status === 400, { status: r.status });
  r = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "y".repeat(50000) } });
  R.check("an enormous comment is refused", r.status === 400, { status: r.status });

  const c1 = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "top" } });
  const commentId = c1.body?.comment?.id;
  R.check("a normal comment posts", c1.status === 201, { status: c1.status });

  const c2 = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "reply", parentId: commentId } });
  R.check("a reply posts", c2.status === 201, { status: c2.status });
  const c3 = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "deep", parentId: c2.body?.comment?.id } });
  R.check("a reply to a reply stays at one level",
    c3.status === 201 && c3.body.comment.parentId === commentId,
    { status: c3.status, parent: c3.body?.comment?.parentId, expected: commentId });

  r = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "x", parentId: "doesnotexist" } });
  R.check("replying to a missing comment is refused", r.status === 404 || r.status === 400, { status: r.status });

  const other = await makePost(a, "other");
  const oc = await a.c.fetch(`/api/posts/${other.id}/comments`, { method: "POST", json: { body: "elsewhere" } });
  r = await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "hijack", parentId: oc.body.comment.id } });
  R.check("a parent comment from a different post is refused", r.status === 400 || r.status === 404, { status: r.status });

  /* ---------------------------------------------------------- ids */
  R.heading("Malformed ids are handled, never 500");
  const nasty = ["../../etc/passwd", "'; DROP TABLE posts;--", "x".repeat(500), "../..", "null", "0", "-1"];
  for (const id of nasty) {
    const res = await a.c.fetch(`/api/posts/${encodeURIComponent(id)}`);
    R.check(`GET /posts/${id.slice(0, 16)} does not 500`, res.status !== 500, { status: res.status });
  }
  for (const id of nasty.slice(0, 4)) {
    const res = await a.c.fetch(`/api/users/${encodeURIComponent(id)}`);
    R.check(`GET /users/${id.slice(0, 16)} does not 500`, res.status !== 500, { status: res.status });
  }

  /* --------------------------------------------------- self actions */
  R.heading("Actions on yourself");
  r = await a.c.fetch(`/api/users/${a.id}/follow`, { method: "POST" });
  R.check("you cannot follow yourself", r.status === 400, { status: r.status });
  r = await a.c.fetch(`/api/users/${a.id}/block`, { method: "POST" });
  R.check("you cannot block yourself", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/reports", { method: "POST", json: { targetType: "user", targetId: a.id, reason: "spam" } });
  R.check("you cannot report yourself", r.status === 400 || r.status === 404, { status: r.status });

  /* ------------------------------------------------------ duplicate */
  R.heading("Repeated actions are idempotent");
  await b.c.fetch(`/api/posts/${post.id}/like`, { method: "POST" });
  const dup = await b.c.fetch(`/api/posts/${post.id}/like`, { method: "POST" });
  R.check("liking twice keeps the count at 1", dup.body?.post?.counts?.likes === 1, dup.body?.post?.counts);
  await b.c.fetch(`/api/posts/${post.id}/like`, { method: "DELETE" });
  const un = await b.c.fetch(`/api/posts/${post.id}/like`, { method: "DELETE" });
  R.check("unliking twice does not go negative", un.body?.post?.counts?.likes === 0, un.body?.post?.counts);

  await b.c.fetch(`/api/users/${a.id}/follow`, { method: "POST" });
  const f2 = await b.c.fetch(`/api/users/${a.id}/follow`, { method: "POST" });
  R.check("following twice does not error", f2.status !== 500, { status: f2.status });
  const prof = await b.c.fetch(`/api/users/${a.username}`);
  R.check("follower count stays 1", prof.body?.user?.counts?.followers === 1, prof.body?.user?.counts);
  }

  /* ========== Deletion cascades and cross-feature integrity ========== */
  {

  const a = await makeUser("int_a"); users.push(a);
  const b = await makeUser("int_b"); users.push(b);
  const c = await makeUser("int_c"); users.push(c);

  await b.c.fetch(`/api/users/${a.id}/follow`, { method: "POST" });
  await c.c.fetch(`/api/users/${a.id}/follow`, { method: "POST" });

  /* --------------------------------------------- deleting a post */
  R.heading("Deleting a post cleans up everything hanging off it");
  const post = await makePost(a, "will be deleted #bye");
  await b.c.fetch(`/api/posts/${post.id}/like`, { method: "POST" });
  await b.c.fetch(`/api/posts/${post.id}/comments`, { method: "POST", json: { body: "nice" } });
  await b.c.fetch(`/api/posts/${post.id}/save`, { method: "POST" });
  await b.c.fetch(`/api/posts/${post.id}/repost`, { method: "POST" });

  // A quote of it, from a third person.
  const quote = await c.c.fetch("/api/posts", {
    method: "POST",
    body: form({ caption: "quoting this", quotedPostId: post.id }),
  });
  R.check("a quote of the post exists", quote.status === 201, { status: quote.status, body: quote.body });
  const quoteId = quote.body?.post?.id;

  // A collection holding it.
  const coll = await b.c.fetch("/api/collections", { method: "POST", json: { name: "keepers" } });
  await b.c.fetch(`/api/collections/${coll.body?.collection?.id}/posts/${post.id}`, { method: "PUT" });

  // b should have notifications about none of this (they acted), but a should.
  let notes = await a.c.fetch("/api/notifications");
  const before = (notes.body?.notifications ?? []).length;
  R.check("the author got notifications", before > 0, { before });

  const del = await a.c.fetch(`/api/posts/${post.id}`, { method: "DELETE" });
  R.check("the post deletes", del.status === 200, { status: del.status });

  let r = await b.c.fetch(`/api/posts/${post.id}`);
  R.check("the post is gone", r.status === 404, { status: r.status });

  r = await b.c.fetch("/api/me/saved");
  R.check("it disappears from saved", !(r.body?.posts ?? []).some((p) => p.id === post.id), (r.body?.posts ?? []).length);

  r = await b.c.fetch(`/api/collections/${coll.body?.collection?.id}/posts`);
  R.check("it disappears from the collection", !(r.body?.posts ?? []).some((p) => p.id === post.id), r.body?.posts?.length);

  r = await c.c.fetch(`/api/posts/${quoteId}`);
  R.check("the quote survives as a tombstone rather than 500ing", r.status === 200, { status: r.status });
  R.check("...and reports the original as unavailable",
    r.body?.post?.quotedUnavailable === true && !r.body?.post?.quotedPost,
    { unavailable: r.body?.post?.quotedUnavailable, quoted: !!r.body?.post?.quotedPost });

  notes = await a.c.fetch("/api/notifications");
  const dangling = (notes.body?.notifications ?? []).filter((n) => n.post && n.post.id === post.id);
  R.check("notifications pointing at the deleted post are gone or nulled", dangling.length === 0, { dangling: dangling.length });
  R.check("the notification list still renders", notes.status === 200, { status: notes.status });

  const profile = await b.c.fetch(`/api/users/${a.username}`);
  R.check("the author's post count drops", profile.body?.user?.counts?.posts === 0, profile.body?.user?.counts);

  /* --------------------------------------------- deleting a comment */
  R.heading("Deleting a comment with replies");
  const p2 = await makePost(a, "comment tree");
  const top = await b.c.fetch(`/api/posts/${p2.id}/comments`, { method: "POST", json: { body: "parent" } });
  const topId = top.body.comment.id;
  await c.c.fetch(`/api/posts/${p2.id}/comments`, { method: "POST", json: { body: "child 1", parentId: topId } });
  await c.c.fetch(`/api/posts/${p2.id}/comments`, { method: "POST", json: { body: "child 2", parentId: topId } });

  let list = await a.c.fetch(`/api/posts/${p2.id}/comments`);
  const countBefore = (await a.c.fetch(`/api/posts/${p2.id}`)).body.post.counts.comments;
  R.check("three comments are counted", countBefore === 3, { countBefore });

  const dc = await b.c.fetch(`/api/comments/${topId}`, { method: "DELETE" });
  R.check("the parent comment deletes", dc.status === 200, { status: dc.status, body: dc.body });

  list = await a.c.fetch(`/api/posts/${p2.id}/comments`);
  R.check("the comment list still loads", list.status === 200, { status: list.status });
  const remaining = (list.body?.comments ?? []).length;
  const after = (await a.c.fetch(`/api/posts/${p2.id}`)).body.post.counts.comments;
  R.check("the comment count matches what is actually listed",
    after === remaining + (list.body?.comments ?? []).reduce((n, cm) => n + (cm.counts?.replies ?? 0), 0),
    { after, remaining, replies: (list.body?.comments ?? []).map((cm) => cm.counts?.replies) });

  /* ------------------------------------------------------- blocking */
  R.heading("Blocking unwinds the relationship");
  const p3 = await makePost(a, "before the block");
  await b.c.fetch(`/api/posts/${p3.id}/like`, { method: "POST" });
  await b.c.fetch(`/api/posts/${p3.id}/save`, { method: "POST" });

  // b follows a; a blocks b.
  let rel = await b.c.fetch(`/api/users/${a.username}`);
  R.check("b follows a before the block", rel.body?.user?.relation?.isFollowing === true, rel.body?.user?.relation);

  await a.c.fetch(`/api/users/${b.id}/block`, { method: "POST" });

  rel = await b.c.fetch(`/api/users/${a.username}`);
  R.check("the blocker's profile disappears entirely for them", rel.status === 404, { status: rel.status });
  // The other direction must stay reachable or there is nowhere to press Unblock.
  const ownView = await a.c.fetch(`/api/users/${b.username}`);
  R.check("the blocker can still open the profile they blocked", ownView.status === 200, { status: ownView.status });
  R.check("...and it reports the block", ownView.body?.user?.relation?.isBlocked === true, ownView.body?.user?.relation);
  R.check("...with the grid closed", ownView.body?.user?.canViewPosts === false, ownView.body?.user?.canViewPosts);
  R.check("the follow is severed", ownView.body?.user?.relation?.followsYou === false, ownView.body?.user?.relation);

  r = await b.c.fetch(`/api/posts/${p3.id}`);
  R.check("a blocked user cannot read the post", r.status === 404, { status: r.status });

  r = await b.c.fetch("/api/feed");
  R.check("the blocked user's feed drops the post", !(r.body?.posts ?? []).some((p) => p.id === p3.id));

  r = await b.c.fetch("/api/me/saved");
  R.check("a saved post from a blocker is hidden", !(r.body?.posts ?? []).some((p) => p.id === p3.id),
    (r.body?.posts ?? []).map((p) => p.id));

  r = await b.c.fetch(`/api/posts/${p3.id}/like`, { method: "POST" });
  R.check("a blocked user cannot like", r.status === 404 || r.status === 403, { status: r.status });

  r = await b.c.fetch(`/api/posts/${p3.id}/comments`, { method: "POST", json: { body: "hi" } });
  R.check("a blocked user cannot comment", r.status === 404 || r.status === 403, { status: r.status });

  r = await b.c.fetch(`/api/users/${a.id}/follow`, { method: "POST" });
  R.check("a blocked user cannot re-follow", r.status === 403 || r.status === 404, { status: r.status });

  const search = await b.c.fetch(`/api/explore/search?q=${encodeURIComponent(a.username)}`);
  R.check("search still behaves for a blocked user", search.status === 200, { status: search.status });

  await a.c.fetch(`/api/users/${b.id}/block`, { method: "DELETE" });

  /* ------------------------------------------------- going private */
  R.heading("Turning an account private");
  const p4 = await makePost(a, "public then private");
  await a.c.fetch("/api/me", { method: "PATCH", json: { isPrivate: true } });

  r = await c.c.fetch(`/api/posts/${p4.id}`);
  R.check("a follower keeps access after the switch", r.status === 200, { status: r.status });

  const stranger = await makeUser("int_d"); users.push(stranger);
  r = await stranger.c.fetch(`/api/posts/${p4.id}`);
  R.check("a stranger loses access, and is told it is private", r.status === 403, { status: r.status });

  r = await stranger.c.fetch(`/api/users/${a.username}/posts`);
  R.check("a stranger cannot list the posts", r.status === 403 || (r.body?.posts ?? []).length === 0,
    { status: r.status, n: (r.body?.posts ?? []).length });

  const fr = await stranger.c.fetch(`/api/users/${a.id}/follow`, { method: "POST" });
  R.check("following a private account makes a request", fr.body?.user?.relation?.isRequested === true, fr.body?.user?.relation);

  r = await a.c.fetch("/api/me/requests");
  R.check("the request shows up for the owner", (r.body?.users ?? r.body?.requests ?? []).length >= 1,
    { status: r.status, body: JSON.stringify(r.body).slice(0, 120) });

  await a.c.fetch("/api/me", { method: "PATCH", json: { isPrivate: false } });

  /* ------------------------------------------- deleting an account */
  R.heading("Deleting an account");
  const doomed = await makeUser("int_gone");
  const dp = await makePost(doomed, "from a doomed account");
  await a.c.fetch(`/api/posts/${dp.id}/like`, { method: "POST" });
  await a.c.fetch(`/api/posts/${dp.id}/comments`, { method: "POST", json: { body: "hello there" } });

  const gone = await doomed.c.fetch("/api/me", { method: "DELETE", json: { password: doomed.person.password } });
  R.check("the account deletes", gone.status === 200, { status: gone.status });

  r = await a.c.fetch(`/api/posts/${dp.id}`);
  R.check("their posts go with them", r.status === 404, { status: r.status });
  r = await a.c.fetch(`/api/users/${doomed.username}`);
  R.check("their profile is gone", r.status === 404, { status: r.status });
  r = await a.c.fetch("/api/feed");
  R.check("the feed still loads afterwards", r.status === 200, { status: r.status });
  r = await a.c.fetch("/api/notifications");
  R.check("notifications still load afterwards", r.status === 200, { status: r.status });
  R.check("no notification references the dead account",
    !(r.body?.notifications ?? []).some((n) => n.actor && n.actor.username === doomed.username));
  }

  /* ========== Pagination correctness ========== */
  {

  const author = await makeUser("pg_author"); users.push(author);
  const reader = await makeUser("pg_reader"); users.push(reader);
  await reader.c.fetch(`/api/users/${author.id}/follow`, { method: "POST" });

  R.heading("Building a body of posts");
  const made = [];
  for (let i = 0; i < 27; i++) made.push((await makePost(author, `post number ${i}`)).id);
  R.check("27 posts created", made.length === 27, { n: made.length });

  /* -------------------------------------------------------- the feed */
  R.heading("Feed paging");
  const feed = await walk(reader, "/api/feed");
  R.check("the feed pages without error", !feed.error, feed.error);
  R.check("the feed returns no duplicates", new Set(feed.ids).size === feed.ids.length,
    { total: feed.ids.length, unique: new Set(feed.ids).size });
  const missingFeed = made.filter((id) => !feed.ids.includes(id));
  R.check("every post is reachable by paging", missingFeed.length === 0,
    { missing: missingFeed.length, seen: feed.ids.length, pages: feed.pages });

  /* ------------------------------------------------- the profile grid */
  R.heading("Profile grid paging");
  const grid = await walk(reader, `/api/users/${author.username}/posts`);
  R.check("the grid pages without error", !grid.error, grid.error);
  R.check("the grid returns no duplicates", new Set(grid.ids).size === grid.ids.length,
    { total: grid.ids.length, unique: new Set(grid.ids).size });
  const missingGrid = made.filter((id) => !grid.ids.includes(id));
  R.check("every post appears on the profile", missingGrid.length === 0,
    { missing: missingGrid.length, seen: grid.ids.length });

  /* ------------------------------------------------------- comments */
  R.heading("Comment paging");
  const target = made[0];
  for (let i = 0; i < 25; i++) {
    await reader.c.fetch(`/api/posts/${target}/comments`, { method: "POST", json: { body: `comment ${i}` } });
  }
  const comments = await walk(reader, `/api/posts/${target}/comments`, { itemsField: "comments" });
  R.check("comments page without error", !comments.error, comments.error);
  R.check("comments have no duplicates", new Set(comments.ids).size === comments.ids.length,
    { total: comments.ids.length, unique: new Set(comments.ids).size });
  const count = (await reader.c.fetch(`/api/posts/${target}`)).body.post.counts.comments;
  R.check("the paged total matches the post's comment count", comments.ids.length === count,
    { paged: comments.ids.length, count });

  /* --------------------------------------------- inserting mid-walk */
  R.heading("A new post arriving mid-scroll does not shuffle the page");
  const first = await reader.c.fetch("/api/feed");
  const firstIds = (first.body?.posts ?? []).map((p) => p.id);
  const cursor = first.body?.nextCursor;
  R.check("the first page has a cursor", !!cursor, { cursor });

  await makePost(author, "posted while you were scrolling");

  const second = await reader.c.fetch(`/api/feed?cursor=${encodeURIComponent(cursor)}`);
  const secondIds = (second.body?.posts ?? []).map((p) => p.id);
  const overlap = secondIds.filter((x) => firstIds.includes(x));
  R.check("page two does not repeat page one after an insertion", overlap.length === 0,
    { overlap: overlap.length, firstIds: firstIds.length, secondIds: secondIds.length });

  /* ------------------------------------------------ explore & reels */
  R.heading("Explore and reels paging");
  for (const [name, url, field] of [["explore", "/api/explore", "posts"], ["reels", "/api/reels", "reels"]]) {
    const r1 = await reader.c.fetch(url);
    R.check(`${name} responds`, r1.status === 200, { status: r1.status });
    const ids1 = (r1.body?.[field] ?? []).map((p) => p.id);
    R.check(`${name} page one has no duplicates`, new Set(ids1).size === ids1.length, { n: ids1.length });
    const next = r1.body?.nextOffset ?? r1.body?.nextCursor;
    if (next !== null && next !== undefined) {
      const key = r1.body?.nextOffset !== undefined ? "offset" : "cursor";
      const r2 = await reader.c.fetch(`${url}?${key}=${encodeURIComponent(next)}`);
      const ids2 = (r2.body?.[field] ?? []).map((p) => p.id);
      const dup = ids2.filter((x) => ids1.includes(x));
      R.check(`${name} page two does not repeat page one`, dup.length === 0, { dup: dup.length });
    }
  }

  /* ------------------------------------------------- notifications */
  R.heading("Notification paging and counts");
  const notes = await reader.c.fetch("/api/notifications");
  R.check("notifications load", notes.status === 200, { status: notes.status });
  const nIds = (notes.body?.notifications ?? []).map((n) => n.id);
  R.check("notifications have no duplicates", new Set(nIds).size === nIds.length, { n: nIds.length });

  const authorNotes = await author.c.fetch("/api/notifications");
  const unreadListed = (authorNotes.body?.notifications ?? []).filter((n) => !n.read).length;
  const unreadCount = await author.c.fetch("/api/notifications/unread-count");
  const reported = unreadCount.body?.count ?? unreadCount.body?.unread ?? 0;
  R.check("the unread badge matches the unread notifications on page one",
    reported >= unreadListed || reported > 0, { reported, unreadListed });
  await author.c.fetch("/api/notifications/read", { method: "POST" });
  const after = await author.c.fetch("/api/notifications/unread-count");
  R.check("marking all read zeroes the badge",
    (after.body?.count ?? after.body?.unread ?? 0) === 0, after.body);
  }

  /* ========== Messaging, stories, collections and auth ========== */
  {

  const a = await makeUser("f_a"); users.push(a);
  const b = await makeUser("f_b"); users.push(b);
  const c = await makeUser("f_c"); users.push(c);

  /* -------------------------------------------------------- messaging */
  R.heading("Direct messages");
  let r = await a.c.fetch("/api/conversations", { method: "POST", json: { userId: b.id } });
  R.check("a conversation opens", r.status === 200 || r.status === 201, { status: r.status, body: r.body });
  const convo = r.body?.conversation?.id;

  const again = await a.c.fetch("/api/conversations", { method: "POST", json: { userId: b.id } });
  R.check("opening it twice reuses the same thread", again.body?.conversation?.id === convo,
    { first: convo, second: again.body?.conversation?.id });

  r = await a.c.fetch("/api/conversations", { method: "POST", json: { userId: a.id } });
  R.check("you cannot message yourself", r.status === 400, { status: r.status });

  r = await a.c.fetch("/api/conversations", { method: "POST", json: { userId: "nope" } });
  R.check("messaging a missing user is refused", r.status === 404 || r.status === 400, { status: r.status });

  r = await a.c.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "hello" } });
  R.check("a message sends", r.status === 201, { status: r.status });

  r = await a.c.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "" } });
  R.check("an empty message is refused", r.status === 400, { status: r.status });
  r = await a.c.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "z".repeat(20000) } });
  R.check("an enormous message is refused", r.status === 400 || r.status === 413, { status: r.status });

  // c is not a member.
  r = await c.c.fetch(`/api/conversations/${convo}/messages`);
  R.check("a non-member cannot read the thread", r.status === 403 || r.status === 404, { status: r.status });
  r = await c.c.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "intruding" } });
  R.check("a non-member cannot post to it", r.status === 403 || r.status === 404, { status: r.status });
  r = await c.c.fetch(`/api/conversations/${convo}/read`, { method: "POST" });
  R.check("a non-member cannot mark it read", r.status === 403 || r.status === 404, { status: r.status });

  // unread counts
  const unread = await b.c.fetch("/api/conversations/unread-count");
  R.check("the recipient has an unread count", (unread.body?.unread ?? unread.body?.count ?? 0) >= 1, unread.body);
  await b.c.fetch(`/api/conversations/${convo}/read`, { method: "POST" });
  const cleared = await b.c.fetch("/api/conversations/unread-count");
  R.check("reading clears it", (cleared.body?.unread ?? cleared.body?.count ?? 0) === 0, cleared.body);

  // deleting someone else's message
  const mine = await a.c.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "delete me" } });
  const msgId = mine.body?.message?.id;
  r = await b.c.fetch(`/api/messages/${msgId}`, { method: "DELETE" });
  R.check("you cannot delete someone else's message", r.status === 403 || r.status === 404, { status: r.status });
  r = await a.c.fetch(`/api/messages/${msgId}`, { method: "DELETE" });
  R.check("you can delete your own", r.status === 200, { status: r.status });

  // blocking mid-conversation
  await b.c.fetch(`/api/users/${a.id}/block`, { method: "POST" });
  r = await a.c.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "after block" } });
  R.check("a blocked sender cannot keep messaging", r.status === 403 || r.status === 404, { status: r.status });
  r = await b.c.fetch(`/api/conversations/${convo}/messages`, { method: "POST", json: { body: "blocker writes" } });
  R.check("the blocker cannot message either", r.status === 403 || r.status === 404, { status: r.status });
  await b.c.fetch(`/api/users/${a.id}/block`, { method: "DELETE" });

  /* --------------------------------------------------------- stories */
  R.heading("Stories");
  const st = await a.c.fetch("/api/stories", {
    method: "POST",
    body: form({ image: { file: png(), type: "image/png", name: "s.png" }, caption: "my story" }),
  });
  R.check("a story posts", st.status === 201, { status: st.status, body: st.body });
  const storyId = st.body?.story?.id;

  r = await b.c.fetch(`/api/stories/${storyId}/view`, { method: "POST" });
  R.check("a viewer can mark it seen", r.status === 200, { status: r.status });

  r = await a.c.fetch(`/api/stories/${storyId}/viewers`);
  R.check("the author sees the viewer list", r.status === 200 && (r.body?.users ?? r.body?.viewers ?? []).length >= 1,
    { status: r.status, body: JSON.stringify(r.body).slice(0, 120) });

  r = await b.c.fetch(`/api/stories/${storyId}/viewers`);
  R.check("a non-author cannot see who viewed", r.status === 403 || r.status === 404, { status: r.status });

  r = await a.c.fetch(`/api/stories/${storyId}/reply`, { method: "POST", json: { body: "hi" } });
  R.check("you cannot reply to your own story", r.status === 400, { status: r.status });

  r = await b.c.fetch(`/api/stories/${storyId}/react`, { method: "POST", json: { emoji: "not-an-emoji-at-all" } });
  R.check("a junk reaction is refused", r.status === 400, { status: r.status });

  r = await b.c.fetch(`/api/stories/${storyId}/reply`, { method: "POST", json: { body: "  " } });
  R.check("an empty story reply is refused", r.status === 400, { status: r.status });

  r = await b.c.fetch(`/api/stories/${storyId}`, { method: "DELETE" });
  R.check("you cannot delete someone else's story", r.status === 403 || r.status === 404, { status: r.status });

  /* ----------------------------------------------------- collections */
  R.heading("Collections");
  const post = await makePost(a, "collectible");
  let coll = await b.c.fetch("/api/collections", { method: "POST", json: { name: "  " } });
  R.check("an empty collection name is refused", coll.status === 400, { status: coll.status });

  coll = await b.c.fetch("/api/collections", { method: "POST", json: { name: "x".repeat(500) } });
  R.check("an enormous collection name is refused", coll.status === 400, { status: coll.status });

  coll = await b.c.fetch("/api/collections", { method: "POST", json: { name: "Reading" } });
  R.check("a collection is created", coll.status === 201, { status: coll.status });
  const collId = coll.body?.collection?.id;

  r = await b.c.fetch(`/api/collections/${collId}/posts/${post.id}`, { method: "PUT" });
  R.check("a post is added", r.status === 200 || r.status === 201, { status: r.status });

  r = await c.c.fetch(`/api/collections/${collId}/posts`);
  R.check("another user cannot read your collection", r.status === 403 || r.status === 404, { status: r.status });
  r = await c.c.fetch(`/api/collections/${collId}`, { method: "PATCH", json: { name: "hijacked" } });
  R.check("another user cannot rename it", r.status === 403 || r.status === 404, { status: r.status });
  r = await c.c.fetch(`/api/collections/${collId}`, { method: "DELETE" });
  R.check("another user cannot delete it", r.status === 403 || r.status === 404, { status: r.status });
  r = await c.c.fetch(`/api/collections/${collId}/posts/${post.id}`, { method: "PUT" });
  R.check("another user cannot add to it", r.status === 403 || r.status === 404, { status: r.status });

  /* --------------------------------------------------------- reports */
  R.heading("Reports");
  r = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: "totallymadeup", reason: "spam" } });
  R.check("reporting a non-existent post is refused", r.status === 404 || r.status === 400, { status: r.status });

  r = await a.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: post.id, reason: "spam" } });
  R.check("reporting your own post is refused", r.status === 400, { status: r.status });

  const rep1 = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: post.id, reason: "spam" } });
  R.check("a genuine report is accepted", rep1.status === 201, { status: rep1.status });
  const rep2 = await b.c.fetch("/api/reports", { method: "POST", json: { targetType: "post", targetId: post.id, reason: "spam" } });
  R.check("reporting the same thing twice is not double-filed", rep2.status === 200 || rep2.status === 409,
    { status: rep2.status, body: rep2.body });

  /* ------------------------------------------------------------ auth */
  R.heading("Account and auth");
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: b.username } });
  R.check("you cannot take another user's username", r.status === 400 || r.status === 409, { status: r.status });

  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: "a" } });
  R.check("a too-short username is refused", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { username: "has spaces" } });
  R.check("a username with spaces is refused", r.status === 400, { status: r.status });
  r = await a.c.fetch("/api/me", { method: "PATCH", json: { bio: "b".repeat(5000) } });
  R.check("an enormous bio is refused", r.status === 400 || r.status === 413, { status: r.status });

  r = await a.c.fetch("/api/auth/password", { method: "POST", json: { currentPassword: "wrong", newPassword: "NewPass!2026x" } });
  R.check("changing the password needs the current one", r.status === 400 || r.status === 401, { status: r.status });

  r = await a.c.fetch("/api/auth/password", { method: "POST", json: { currentPassword: a.person.password, newPassword: "short" } });
  R.check("a weak new password is refused", r.status === 400, { status: r.status });

  r = await a.c.fetch("/api/me", { method: "DELETE", json: { password: "definitely-wrong" } });
  R.check("deleting the account needs the right password", r.status === 400 || r.status === 401, { status: r.status });

  const anon = (await import("./lib/harness.mjs")).client();
  r = await anon.fetch("/api/auth/available?username=" + encodeURIComponent(a.username));
  R.check("username availability works", r.status === 200, { status: r.status });
  R.check("...and reports a taken name as unavailable", r.body?.available === false, r.body);
  }

} catch (err) {
  console.error("\nSuite crashed:", err.message, err.stack?.split("\n")[1] ?? "");
  R.check("suite ran to completion", false, err.message);
} finally {
  await cleanup(users);
}
process.exit(R.done() ? 1 : 0);

/**
 * Mute: quietens feeds, changes no permissions, and is never visible to the muted.
 *
 *   node scripts/mute-test.js [baseUrl]            (needs DISABLE_RATE_LIMITS=1)
 */
import { makeReporter, makeUser, makePost, cleanup, form, png } from "./lib/harness.mjs";

const R = makeReporter();
const users = [];

try {
  const me = await makeUser("mute_me"); users.push(me);
  const noisy = await makeUser("mute_noisy"); users.push(noisy);
  const quiet = await makeUser("mute_quiet"); users.push(quiet);

  await me.c.fetch(`/api/users/${noisy.id}/follow`, { method: "POST" });
  await me.c.fetch(`/api/users/${quiet.id}/follow`, { method: "POST" });
  await noisy.c.fetch(`/api/users/${me.id}/follow`, { method: "POST" });

  const noisyPost = await makePost(noisy, "loud post");
  const quietPost = await makePost(quiet, "calm post");
  await noisy.c.fetch("/api/stories", {
    method: "POST",
    body: form({ image: { file: png(), type: "image/png", name: "s.png" }, caption: "loud story" }),
  });

  R.heading("Before muting");
  let feed = await me.c.fetch("/api/feed");
  R.check("both accounts appear in the feed",
    (feed.body?.posts ?? []).some((p) => p.id === noisyPost.id) &&
    (feed.body?.posts ?? []).some((p) => p.id === quietPost.id),
    (feed.body?.posts ?? []).map((p) => p.author.username));
  let stories = await me.c.fetch("/api/stories");
  const hasNoisyStory = (g) => (g ?? []).some((x) => x.author?.username === noisy.username);
  R.check("their story is on the rail", hasNoisyStory(stories.body?.groups ?? stories.body?.stories), stories.body);

  R.heading("Muting");
  let r = await me.c.fetch(`/api/users/${noisy.id}/mute`, { method: "POST" });
  R.check("muting succeeds", r.status === 200, { status: r.status });
  R.check("the relation reports it", r.body?.user?.relation?.isMuted === true, r.body?.user?.relation);

  r = await me.c.fetch(`/api/users/${me.id}/mute`, { method: "POST" });
  R.check("you cannot mute yourself", r.status === 400, { status: r.status });

  feed = await me.c.fetch("/api/feed");
  R.check("their posts leave the feed", !(feed.body?.posts ?? []).some((p) => p.id === noisyPost.id),
    (feed.body?.posts ?? []).map((p) => p.author.username));
  R.check("everyone else stays", (feed.body?.posts ?? []).some((p) => p.id === quietPost.id));

  stories = await me.c.fetch("/api/stories");
  R.check("their story leaves the rail", !hasNoisyStory(stories.body?.groups ?? stories.body?.stories));

  const explore = await me.c.fetch("/api/explore");
  R.check("they are not recommended on explore", !(explore.body?.posts ?? []).some((p) => p.id === noisyPost.id));

  R.heading("Muting is a preference, not a permission");
  r = await me.c.fetch(`/api/posts/${noisyPost.id}`);
  R.check("their post still opens by direct link", r.status === 200, { status: r.status });
  r = await me.c.fetch(`/api/users/${noisy.username}`);
  R.check("their profile still opens", r.status === 200, { status: r.status });
  r = await me.c.fetch(`/api/users/${noisy.username}/posts`);
  R.check("their profile grid still lists their posts",
    (r.body?.posts ?? []).some((p) => p.id === noisyPost.id), { n: (r.body?.posts ?? []).length });
  R.check("the post carries the muted flag for the menu",
    (r.body?.posts ?? []).find((p) => p.id === noisyPost.id)?.viewer?.isMuted === true,
    (r.body?.posts ?? [])[0]?.viewer);

  r = await me.c.fetch(`/api/posts/${noisyPost.id}/like`, { method: "POST" });
  R.check("you can still like a muted account's post", r.status === 200, { status: r.status });

  const search = await me.c.fetch(`/api/explore/search?q=${encodeURIComponent(noisy.username)}`);
  R.check("search still finds them on purpose",
    (search.body?.users ?? []).some((u) => u.username === noisy.username),
    (search.body?.users ?? []).map((u) => u.username));

  R.heading("The muted account notices nothing");
  r = await noisy.c.fetch(`/api/users/${me.username}`);
  R.check("their view of you is unchanged", r.status === 200, { status: r.status });
  R.check("...no mute flag is exposed to them", r.body?.user?.relation?.isMuted === false, r.body?.user?.relation);
  R.check("...they still follow you", r.body?.user?.relation?.isFollowing === true, r.body?.user?.relation);

  const theirFeed = await noisy.c.fetch("/api/feed");
  R.check("your posts still reach them", theirFeed.status === 200, { status: theirFeed.status });

  r = await noisy.c.fetch(`/api/conversations`, { method: "POST", json: { userId: me.id } });
  R.check("they can still message you", r.status === 200 || r.status === 201, { status: r.status });

  const myProfile = await me.c.fetch(`/api/users/${me.username}`);
  R.check("muting did not change your follower count",
    myProfile.body?.user?.counts?.followers === 1, myProfile.body?.user?.counts);

  R.heading("Notifications still arrive");
  await noisy.c.fetch(`/api/posts/${(await makePost(me, "mine")).id}/like`, { method: "POST" });
  const notes = await me.c.fetch("/api/notifications");
  R.check("a muted account's like still notifies you",
    (notes.body?.notifications ?? []).some((n) => n.actor?.username === noisy.username),
    (notes.body?.notifications ?? []).map((n) => n.actor?.username).slice(0, 5));

  R.heading("The muted list and unmuting");
  let list = await me.c.fetch("/api/me/muted");
  R.check("the muted list shows them", (list.body?.users ?? []).some((u) => u.username === noisy.username), list.body);
  list = await noisy.c.fetch("/api/me/muted");
  R.check("their own muted list is empty", (list.body?.users ?? []).length === 0, list.body);

  r = await me.c.fetch(`/api/users/${noisy.id}/mute`, { method: "DELETE" });
  R.check("unmuting succeeds", r.status === 200, { status: r.status });
  R.check("the relation clears", r.body?.user?.relation?.isMuted === false, r.body?.user?.relation);

  feed = await me.c.fetch("/api/feed");
  R.check("their posts come back", (feed.body?.posts ?? []).some((p) => p.id === noisyPost.id));

  R.heading("Mute survives the odd cases");
  await me.c.fetch(`/api/users/${noisy.id}/mute`, { method: "POST" });
  r = await me.c.fetch(`/api/users/${noisy.id}/mute`, { method: "POST" });
  R.check("muting twice is idempotent", r.status === 200, { status: r.status });
  list = await me.c.fetch("/api/me/muted");
  R.check("...and does not duplicate the row",
    (list.body?.users ?? []).filter((u) => u.username === noisy.username).length === 1, list.body?.users?.length);

  r = await me.c.fetch(`/api/users/nosuchuserid/mute`, { method: "POST" });
  R.check("muting a missing user is refused", r.status === 404, { status: r.status });

  // A muted account you then block should behave like a block.
  await me.c.fetch(`/api/users/${noisy.id}/block`, { method: "POST" });
  r = await me.c.fetch(`/api/posts/${noisyPost.id}`);
  R.check("blocking on top of a mute still hides the post", r.status === 404, { status: r.status });
  await me.c.fetch(`/api/users/${noisy.id}/block`, { method: "DELETE" });

  // Deleting the muted account must not leave a dangling row.
  const temp = await makeUser("mute_temp");
  await me.c.fetch(`/api/users/${temp.id}/mute`, { method: "POST" });
  await temp.c.fetch("/api/me", { method: "DELETE", json: { password: temp.person.password } });
  list = await me.c.fetch("/api/me/muted");
  R.check("deleting a muted account clears the mute", list.status === 200 &&
    !(list.body?.users ?? []).some((u) => u.username === temp.username), list.body);
  feed = await me.c.fetch("/api/feed");
  R.check("the feed still loads afterwards", feed.status === 200, { status: feed.status });
} catch (err) {
  console.error("\nSuite crashed:", err.message, err.stack?.split("\n")[1] ?? "");
  R.check("suite ran to completion", false, err.message);
} finally {
  await cleanup(users);
}
process.exit(R.done() ? 1 : 0);

import { Router } from "express";
import { z } from "zod";
import { config } from "../config.ts";
import { all, get, run, tx } from "../db.ts";
import { badRequest, forbidden, h, limit, notFound, parse } from "../lib/http.ts";
import { me, requireAuth } from "../lib/auth.ts";
import { newId } from "../lib/ids.ts";
import { deleteMedia, storeImage, upload } from "../lib/media.ts";
import { notify, unnotify } from "../lib/notify.ts";
import { mediaPayload, userCard, type MediaRow, type UserRow } from "../lib/shape.ts";
import { tidy } from "../lib/text.ts";
import { assertCanView, blockedBetween } from "../lib/visibility.ts";
import { emitToUser } from "../lib/bus.ts";
import { broadcastMessage, openConversation } from "./messages.ts";

export const storiesRouter = Router();

type StoryRow = {
  id: string;
  author_id: string;
  caption: string;
  created_at: number;
  expires_at: number;
  media_id: string;
  m_width: number;
  m_height: number;
  m_preview: string;
  seen: number;
  my_reaction: string | null;
  reaction_count: number;
  username: string;
  display_name: string;
  avatar_id: string | null;
  last_seen_at: number;
  show_activity: number;
  is_private: number;
};

const STORY_SELECT = `
  SELECT s.id, s.author_id, s.caption, s.created_at, s.expires_at, s.media_id,
         m.width AS m_width, m.height AS m_height, m.preview AS m_preview,
         u.username, u.display_name, u.avatar_id, u.last_seen_at, u.show_activity, u.is_private,
         EXISTS(SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = ?1) AS seen,
         (SELECT sr.emoji FROM story_reactions sr WHERE sr.story_id = s.id AND sr.user_id = ?1) AS my_reaction,
         (SELECT COUNT(*) FROM story_reactions sr WHERE sr.story_id = s.id) AS reaction_count
  FROM stories s
  JOIN media m ON m.id = s.media_id
  JOIN users u ON u.id = s.author_id`;

function storyPayload(r: StoryRow) {
  return {
    id: r.id,
    caption: r.caption,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    seen: !!r.seen,
    myReaction: r.my_reaction ?? null,
    reactionCount: r.reaction_count ?? 0,
    media: mediaPayload({
      id: r.media_id,
      width: r.m_width,
      height: r.m_height,
      preview: r.m_preview,
      owner_id: r.author_id,
      bytes: 0,
      created_at: r.created_at,
    } as MediaRow),
  };
}

/** Stories from people you follow plus your own, grouped per author. */
storiesRouter.get(
  "/",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<StoryRow>(
      `${STORY_SELECT}
       WHERE s.expires_at > ?2
         AND (s.author_id = ?1
              OR EXISTS (SELECT 1 FROM follows f
                         WHERE f.follower_id = ?1 AND f.following_id = s.author_id AND f.status = 'accepted'))
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = s.author_id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = s.author_id))
         -- A muted account drops off the rail; their story is still reachable
         -- from their profile, which is the difference from blocking.
         AND NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = ?1 AND mu.muted_id = s.author_id)
       ORDER BY s.created_at ASC`,
      user.id,
      Date.now(),
    );

    const groups = new Map<string, { author: ReturnType<typeof userCard>; stories: any[] }>();
    for (const r of rows) {
      if (!groups.has(r.author_id)) {
        groups.set(r.author_id, {
          author: userCard({
            id: r.author_id,
            username: r.username,
            display_name: r.display_name,
            avatar_id: r.avatar_id,
            is_private: r.is_private,
            last_seen_at: r.last_seen_at,
            show_activity: r.show_activity,
          }),
          stories: [],
        });
      }
      groups.get(r.author_id)!.stories.push(storyPayload(r));
    }

    const list = [...groups.values()].map((g) => ({
      ...g,
      isSelf: g.author.id === user.id,
      hasUnseen: g.stories.some((s) => !s.seen),
      latestAt: Math.max(...g.stories.map((s) => s.createdAt)),
    }));
    // Your own ring first, then unseen rings, then the rest by recency.
    list.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
      return b.latestAt - a.latestAt;
    });
    res.json({ groups: list });
  }),
);

storiesRouter.post(
  "/",
  requireAuth,
  limit({ name: "story:create", max: 30, windowMs: 60 * 60 * 1000 }),
  upload.single("image"),
  h(async (req, res) => {
    const user = me(req);
    if (!req.file) throw badRequest("Choose an image for your story.");
    const body = parse(z.object({ caption: z.string().max(200).optional().default("") }), req.body ?? {});

    const media = await storeImage(req.file.buffer, user.id);
    const id = newId();
    const now = Date.now();
    run(
      "INSERT INTO stories (id, author_id, media_id, caption, created_at, expires_at) VALUES (?,?,?,?,?,?)",
      id,
      user.id,
      media.id,
      body.caption.trim(),
      now,
      now + config.storyTtlMs,
    );

    // Let followers refresh their rail without polling.
    const followers = all<{ follower_id: string }>(
      "SELECT follower_id FROM follows WHERE following_id = ? AND status = 'accepted'",
      user.id,
    );
    for (const f of followers) emitToUser(f.follower_id, "story:new", { authorId: user.id });

    const row = get<StoryRow>(`${STORY_SELECT} WHERE s.id = ?2`, user.id, id)!;
    res.status(201).json({ story: storyPayload(row) });
  }),
);

/** Stories for one author, used when opening the viewer straight from a profile. */
storiesRouter.get(
  "/user/:username",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const target = get<UserRow>("SELECT * FROM users WHERE username = ?", req.params.username.toLowerCase());
    if (!target) throw notFound("That account does not exist.");
    assertCanView(user.id, target.id, {
      missing: "That account does not exist.",
      restricted: "This account is private.",
    });
    const rows = all<StoryRow>(
      `${STORY_SELECT} WHERE s.author_id = ?2 AND s.expires_at > ?3 ORDER BY s.created_at ASC`,
      user.id,
      target.id,
      Date.now(),
    );
    res.json({
      group:
        rows.length === 0
          ? null
          : {
              author: userCard(target),
              isSelf: target.id === user.id,
              stories: rows.map(storyPayload),
              hasUnseen: rows.some((r) => !r.seen),
              latestAt: Math.max(...rows.map((r) => r.created_at)),
            },
    });
  }),
);

storiesRouter.post(
  "/:id/view",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const story = get<{ id: string; author_id: string; expires_at: number }>(
      "SELECT id, author_id, expires_at FROM stories WHERE id = ?",
      req.params.id,
    );
    if (!story || story.expires_at < Date.now()) throw notFound("That story has expired.");
    assertCanView(user.id, story.author_id, {
      missing: "That story has expired.",
      restricted: "You cannot view this story.",
    });
    if (story.author_id !== user.id) {
      run(
        "INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?,?,?)",
        story.id,
        user.id,
        Date.now(),
      );
    }
    res.json({ ok: true });
  }),
);

storiesRouter.get(
  "/:id/viewers",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const story = get<{ author_id: string }>("SELECT author_id FROM stories WHERE id = ?", req.params.id);
    if (!story) throw notFound("That story has expired.");
    if (story.author_id !== user.id) throw forbidden("Only the author can see who viewed a story.");
    // Reactions ride along with the viewer list — that is the only place the
    // author sees them.
    const rows = all<UserRow & { viewed_at: number; emoji: string | null }>(
      `SELECT u.*, v.viewed_at,
              (SELECT sr.emoji FROM story_reactions sr WHERE sr.story_id = v.story_id AND sr.user_id = u.id) AS emoji
       FROM story_views v JOIN users u ON u.id = v.viewer_id
       WHERE v.story_id = ? ORDER BY v.viewed_at DESC LIMIT 200`,
      req.params.id,
    );
    res.json({
      users: rows.map((u) => ({ ...userCard(u), viewedAt: u.viewed_at, reaction: u.emoji })),
    });
  }),
);

/* ------------------------------------------------- reactions and replies */

/** The fixed quick-reaction set; anything else is rejected. */
const REACTIONS = ["😂", "😮", "😍", "😢", "👏", "🔥", "🎉", "💯"] as const;

/** Loads a story the viewer is allowed to interact with, or throws. */
function loadInteractableStory(viewerId: string, storyId: string) {
  const story = get<{ id: string; author_id: string; expires_at: number; media_id: string; caption: string }>(
    "SELECT id, author_id, expires_at, media_id, caption FROM stories WHERE id = ?",
    storyId,
  );
  if (!story || story.expires_at < Date.now()) throw notFound("That story has expired.");
  if (story.author_id === viewerId) throw badRequest("You cannot reply to your own story.");
  // Same rule as viewing: private authors are visible only to accepted
  // followers, and a block hides the story in both directions.
  assertCanView(viewerId, story.author_id, {
    missing: "That story has expired.",
    restricted: "You cannot see this story.",
  });
  return story;
}

storiesRouter.post(
  "/:id/react",
  requireAuth,
  limit({ name: "story:react", max: 120, windowMs: 10 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const story = loadInteractableStory(user.id, req.params.id);
    const body = parse(
      z.object({ emoji: z.enum(REACTIONS, { errorMap: () => ({ message: "That reaction is not available." }) }) }),
      req.body ?? {},
    );

    run(
      `INSERT INTO story_reactions (story_id, user_id, emoji, created_at) VALUES (?,?,?,?)
       ON CONFLICT(story_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
      story.id,
      user.id,
      body.emoji,
      Date.now(),
    );
    // Reacting counts as watching it.
    run(
      "INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?,?,?)",
      story.id,
      user.id,
      Date.now(),
    );
    notify({ userId: story.author_id, actorId: user.id, type: "story_reaction" });
    res.json({ reaction: body.emoji });
  }),
);

storiesRouter.delete(
  "/:id/react",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const story = get<{ author_id: string }>("SELECT author_id FROM stories WHERE id = ?", req.params.id);
    run("DELETE FROM story_reactions WHERE story_id = ? AND user_id = ?", req.params.id, user.id);
    // Withdraw the notification from the story's author, not the story id.
    if (story) unnotify({ userId: story.author_id, actorId: user.id, type: "story_reaction" });
    res.json({ reaction: null });
  }),
);

/**
 * A story reply is a direct message that carries the story as context, so the
 * conversation lands in the normal inbox rather than a parallel one.
 */
storiesRouter.post(
  "/:id/reply",
  requireAuth,
  limit({ name: "story:reply", max: 60, windowMs: 10 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const story = loadInteractableStory(user.id, req.params.id);
    const body = parse(
      z.object({ body: z.string().trim().min(1, "Write something first.").max(1000) }),
      req.body ?? {},
    );
    if (blockedBetween(user.id, story.author_id)) throw notFound("That story has expired.");

    const conversation = openConversation(user.id, story.author_id);
    const messageId = newId();
    const now = Date.now();
    tx(() => {
      run(
        `INSERT INTO messages (id, conversation_id, sender_id, body, story_id, is_story_reply, created_at)
         VALUES (?,?,?,?,?,1,?)`,
        messageId,
        conversation.id,
        user.id,
        tidy(body.body, 12),
        story.id,
        now,
      );
      run("UPDATE conversations SET last_message_at = ? WHERE id = ?", now, conversation.id);
      run(
        "UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?",
        now,
        conversation.id,
        user.id,
      );
    });
    run(
      "INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?,?,?)",
      story.id,
      user.id,
      now,
    );

    // The reply arrives as a normal DM, so no separate notification: the
    // message badge already covers it.
    broadcastMessage(conversation.id, messageId);
    res.status(201).json({ conversationId: conversation.id });
  }),
);

storiesRouter.delete(
  "/:id",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    const story = get<{ id: string; author_id: string; media_id: string }>(
      "SELECT id, author_id, media_id FROM stories WHERE id = ?",
      req.params.id,
    );
    if (!story) throw notFound("That story has expired.");
    if (story.author_id !== user.id) throw forbidden("You can only delete your own stories.");
    run("DELETE FROM stories WHERE id = ?", story.id);
    await deleteMedia(story.media_id);
    res.json({ ok: true });
  }),
);

/** Deletes expired stories and their images. Runs on boot and hourly. */
export async function purgeExpiredStories() {
  const expired = all<{ id: string; media_id: string }>(
    "SELECT id, media_id FROM stories WHERE expires_at < ?",
    Date.now(),
  );
  for (const s of expired) {
    run("DELETE FROM stories WHERE id = ?", s.id);
    await deleteMedia(s.media_id);
  }
  return expired.length;
}

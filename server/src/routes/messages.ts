import { Router } from "express";
import { z } from "zod";
import { all, get, pluck, run, tx } from "../db.ts";
import { badRequest, forbidden, h, limit, notFound, parse } from "../lib/http.ts";
import { me, requireAuth } from "../lib/auth.ts";
import { newId } from "../lib/ids.ts";
import { getMedia, storeImage, upload } from "../lib/media.ts";
import { POST_SELECT, hydratePosts, mediaPayload, userCard, type PostRow, type UserRow } from "../lib/shape.ts";
import { blockedBetween, loadViewablePost } from "../lib/visibility.ts";
import { emitToUser } from "../lib/bus.ts";
import { tidy } from "../lib/text.ts";

export const conversationsRouter = Router();
export const messagesRouter = Router();

function memberIds(conversationId: string): string[] {
  return all<{ user_id: string }>(
    "SELECT user_id FROM conversation_members WHERE conversation_id = ?",
    conversationId,
  ).map((r) => r.user_id);
}

function assertMember(conversationId: string, userId: string) {
  const isMember = get(
    "SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    conversationId,
    userId,
  );
  if (!isMember) throw notFound("That conversation does not exist.");
}

function otherMember(conversationId: string, userId: string): UserRow | undefined {
  return get<UserRow>(
    `SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ? AND cm.user_id != ? LIMIT 1`,
    conversationId,
    userId,
  );
}

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  media_id: string | null;
  shared_post_id: string | null;
  story_id: string | null;
  is_story_reply: number;
  call_id: string | null;
  created_at: number;
  deleted_at: number | null;
};

export function messagePayload(r: MessageRow, viewerId: string) {
  const media = r.media_id && !r.deleted_at ? mediaPayload(getMedia(r.media_id)) : null;
  let sharedPost = null;
  if (r.shared_post_id && !r.deleted_at) {
    const row = get<PostRow>(`${POST_SELECT} WHERE p.id = ?2`, viewerId, r.shared_post_id);
    sharedPost = row ? hydratePosts([row], viewerId)[0] : null;
  }

  // Story replies show the story they answered. Stories last a day, so this is
  // null for anything older and the bubble falls back to a plain note.
  let story = null;
  if (r.is_story_reply && r.story_id && !r.deleted_at) {
    const row = get<{ id: string; author_id: string; caption: string; expires_at: number; media_id: string }>(
      "SELECT id, author_id, caption, expires_at, media_id FROM stories WHERE id = ?",
      r.story_id,
    );
    if (row && row.expires_at > Date.now()) {
      story = {
        id: row.id,
        authorId: row.author_id,
        caption: row.caption,
        thumb: `/media/${row.media_id}/thumb.webp`,
        mine: row.author_id === viewerId,
      };
    }
  }

  // A finished call renders as an event in the thread rather than a bubble.
  let call = null;
  if (r.call_id && !r.deleted_at) {
    const row = get<{ status: string; kind: string; caller_id: string; answered_at: number | null; ended_at: number | null }>(
      "SELECT status, kind, caller_id, answered_at, ended_at FROM calls WHERE id = ?",
      r.call_id,
    );
    if (row) {
      call = {
        id: r.call_id,
        status: row.status,
        kind: row.kind === "video" ? "video" : "audio",
        outgoing: row.caller_id === viewerId,
        durationMs: row.answered_at && row.ended_at ? row.ended_at - row.answered_at : 0,
      };
    }
  }

  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    body: r.deleted_at ? "" : r.body,
    createdAt: r.created_at,
    deleted: !!r.deleted_at,
    media,
    sharedPost,
    story,
    isStoryReply: !!r.is_story_reply && !r.deleted_at,
    call,
    mine: r.sender_id === viewerId,
  };
}

function conversationPayload(conversationId: string, viewerId: string) {
  const other = otherMember(conversationId, viewerId);
  const conv = get<{ id: string; last_message_at: number }>(
    "SELECT id, last_message_at FROM conversations WHERE id = ?",
    conversationId,
  )!;
  const lastRead = pluck<number>(
    "SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    conversationId,
    viewerId,
  ) ?? 0;
  const last = get<MessageRow>(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
    conversationId,
  );
  const unread =
    pluck<number>(
      `SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND sender_id != ? AND created_at > ? AND deleted_at IS NULL`,
      conversationId,
      viewerId,
      lastRead,
    ) ?? 0;
  // Read receipts are reciprocal: whoever switches them off stops sending
  // "Seen" and stops seeing it. Withheld at the API, not just hidden in the UI,
  // so turning it off actually stops the timestamp leaving the server.
  const viewerSharesReceipts = pluck<number>("SELECT read_receipts FROM users WHERE id = ?", viewerId) ?? 1;
  const theirLastRead =
    other && viewerSharesReceipts !== 0 && other.read_receipts !== 0
      ? pluck<number>(
          "SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
          conversationId,
          other.id,
        ) ?? 0
      : 0;

  return {
    id: conv.id,
    lastMessageAt: conv.last_message_at,
    unread,
    theirLastReadAt: theirLastRead,
    partner: other ? userCard(other) : null,
    blocked: other ? blockedBetween(viewerId, other.id) : false,
    lastMessage: last
      ? {
          id: last.id,
          body: last.deleted_at ? "Message deleted" : last.body,
          hasMedia: !!last.media_id && !last.deleted_at,
          hasPost: !!last.shared_post_id && !last.deleted_at,
          hasCall: !!last.call_id && !last.deleted_at,
          createdAt: last.created_at,
          mine: last.sender_id === viewerId,
        }
      : null,
  };
}

/**
 * The whole inbox in one query. Building it per conversation meant roughly five
 * synchronous statements each, which on a single-threaded server turns a busy
 * inbox into visible latency for everyone.
 */
conversationsRouter.get(
  "/",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<any>(
      `SELECT c.id, c.last_message_at, cm.last_read_at,
              other.user_id AS partner_id, other.last_read_at AS their_last_read,
              u.username, u.display_name, u.avatar_id, u.is_private, u.last_seen_at,
              u.show_activity, u.read_receipts AS their_receipts,
              lm.id AS last_id, lm.body AS last_body, lm.media_id AS last_media,
              lm.shared_post_id AS last_post, lm.created_at AS last_at,
              lm.sender_id AS last_sender, lm.deleted_at AS last_deleted, lm.call_id AS last_call,
              (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = c.id AND m.sender_id != ?1
                  AND m.created_at > cm.last_read_at AND m.deleted_at IS NULL) AS unread,
              EXISTS(SELECT 1 FROM blocks b
                WHERE (b.blocker_id = ?1 AND b.blocked_id = other.user_id)
                   OR (b.blocker_id = other.user_id AND b.blocked_id = ?1)) AS blocked
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id != cm.user_id
       JOIN users u ON u.id = other.user_id
       LEFT JOIN messages lm ON lm.id = (
         SELECT id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1)
       WHERE cm.user_id = ?1
       ORDER BY c.last_message_at DESC LIMIT 100`,
      user.id,
    );

    const conversations = rows
      .map((r) => ({
        id: r.id as string,
        lastMessageAt: r.last_message_at as number,
        unread: r.unread as number,
        // Withheld unless both sides share receipts, matching the thread view.
        theirLastReadAt: user.read_receipts !== 0 && r.their_receipts !== 0 ? (r.their_last_read as number) : 0,
        partner: userCard({
          id: r.partner_id,
          username: r.username,
          display_name: r.display_name,
          avatar_id: r.avatar_id,
          is_private: r.is_private,
          last_seen_at: r.last_seen_at,
          show_activity: r.show_activity,
        }),
        blocked: !!r.blocked,
        lastMessage: r.last_id
          ? {
              id: r.last_id as string,
              body: r.last_deleted ? "Message deleted" : (r.last_body as string),
              hasMedia: !!r.last_media && !r.last_deleted,
              hasPost: !!r.last_post && !r.last_deleted,
              hasCall: !!r.last_call && !r.last_deleted,
              createdAt: r.last_at as number,
              mine: r.last_sender === user.id,
            }
          : null,
      }))
      // Drop empty threads with people who have since blocked you.
      .filter((c) => !(c.blocked && !c.lastMessage));
    res.json({ conversations });
  }),
);

conversationsRouter.get(
  "/unread-count",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const count =
      pluck<number>(
        `SELECT COUNT(DISTINCT m.conversation_id) FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?1
         WHERE m.sender_id != ?1 AND m.created_at > cm.last_read_at AND m.deleted_at IS NULL`,
        user.id,
      ) ?? 0;
    res.json({ unread: count });
  }),
);

/**
 * The one-to-one thread between two people, created if it does not exist yet.
 * Shared with story replies, which drop into the same inbox.
 */
export function openConversation(userId: string, otherId: string): { id: string; created: boolean } {
  const existing = pluck<string>(
    `SELECT cm1.conversation_id FROM conversation_members cm1
     JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id AND cm2.user_id = ?2
     WHERE cm1.user_id = ?1
       AND (SELECT COUNT(*) FROM conversation_members cm3 WHERE cm3.conversation_id = cm1.conversation_id) = 2
     LIMIT 1`,
    userId,
    otherId,
  );
  if (existing) return { id: existing, created: false };

  const id = newId();
  const now = Date.now();
  tx(() => {
    run("INSERT INTO conversations (id, created_at, last_message_at) VALUES (?,?,?)", id, now, now);
    run("INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?,?,?)", id, userId, now);
    run("INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?,?,?)", id, otherId, 0);
  });
  return { id, created: true };
}

/** Delivers a freshly written message to both members over the socket. */
export function broadcastMessage(conversationId: string, messageId: string) {
  const row = get<MessageRow>("SELECT * FROM messages WHERE id = ?", messageId);
  if (!row) return;
  for (const memberId of memberIds(conversationId)) {
    emitToUser(memberId, "message:new", {
      message: messagePayload(row, memberId),
      conversation: conversationPayload(conversationId, memberId),
    });
  }
}

/** Opens (or creates) the one-to-one thread with another user. */
conversationsRouter.post(
  "/",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const body = parse(z.object({ userId: z.string().min(1) }), req.body);
    if (body.userId === user.id) throw badRequest("You cannot message yourself.");
    const other = get<UserRow>("SELECT * FROM users WHERE id = ?", body.userId);
    if (!other) throw notFound("That account does not exist.");
    if (blockedBetween(user.id, other.id)) throw forbidden("You cannot message this account.");

    const { id, created } = openConversation(user.id, other.id);
    res.status(created ? 201 : 200).json({ conversation: conversationPayload(id, user.id) });
  }),
);

conversationsRouter.get(
  "/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    assertMember(req.params.id, user.id);
    res.json({ conversation: conversationPayload(req.params.id, user.id) });
  }),
);

conversationsRouter.get(
  "/:id/messages",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    assertMember(req.params.id, user.id);
    const cursor = String(req.query.cursor ?? "");
    const limit = Math.min(Number(req.query.limit ?? 40) || 40, 80);
    const rows = all<MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND (? = '' OR id < ?)
       ORDER BY id DESC LIMIT ?`,
      req.params.id,
      cursor,
      cursor,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      messages: page.reverse().map((m) => messagePayload(m, user.id)),
      nextCursor: hasMore ? page[0]?.id ?? null : null,
    });
  }),
);

conversationsRouter.post(
  "/:id/messages",
  requireAuth,
  limit({ name: "message:send", max: 120, windowMs: 10 * 60 * 1000 }),
  upload.single("image"),
  h(async (req, res) => {
    const user = me(req);
    assertMember(req.params.id, user.id);
    const other = otherMember(req.params.id, user.id);
    if (other && blockedBetween(user.id, other.id)) throw forbidden("You cannot message this account.");

    const body = parse(
      z.object({
        body: z.string().max(2000, "Messages are limited to 2000 characters.").optional().default(""),
        sharedPostId: z.string().max(40).optional().nullable(),
      }),
      req.body ?? {},
    );
    const text = tidy(body.body, 20);

    let mediaId: string | null = null;
    if (req.file) mediaId = (await storeImage(req.file.buffer, user.id)).id;

    let sharedPostId: string | null = null;
    if (body.sharedPostId) {
      sharedPostId = loadViewablePost(user.id, body.sharedPostId).id;
    }

    if (!text && !mediaId && !sharedPostId) throw badRequest("Write a message first.");

    const id = newId();
    const now = Date.now();
    tx(() => {
      run(
        `INSERT INTO messages (id, conversation_id, sender_id, body, media_id, shared_post_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        id,
        req.params.id,
        user.id,
        text,
        mediaId,
        sharedPostId,
        now,
      );
      run("UPDATE conversations SET last_message_at = ? WHERE id = ?", now, req.params.id);
      run(
        "UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?",
        now,
        req.params.id,
        user.id,
      );
    });

    const row = get<MessageRow>("SELECT * FROM messages WHERE id = ?", id)!;
    for (const memberId of memberIds(req.params.id)) {
      emitToUser(memberId, "message:new", {
        message: messagePayload(row, memberId),
        conversation: conversationPayload(req.params.id, memberId),
      });
    }
    res.status(201).json({ message: messagePayload(row, user.id) });
  }),
);

conversationsRouter.post(
  "/:id/read",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    assertMember(req.params.id, user.id);
    const now = Date.now();
    run(
      "UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?",
      now,
      req.params.id,
      user.id,
    );
    const other = otherMember(req.params.id, user.id);
    if (other) emitToUser(other.id, "conversation:read", { conversationId: req.params.id, at: now });
    res.json({ ok: true });
  }),
);

messagesRouter.delete(
  "/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const msg = get<MessageRow>("SELECT * FROM messages WHERE id = ?", req.params.id);
    if (!msg) throw notFound("That message no longer exists.");
    if (msg.sender_id !== user.id) throw forbidden("You can only delete your own messages.");
    run("UPDATE messages SET deleted_at = ?, body = '', media_id = NULL, shared_post_id = NULL WHERE id = ?", Date.now(), msg.id);
    for (const memberId of memberIds(msg.conversation_id)) {
      emitToUser(memberId, "message:deleted", { conversationId: msg.conversation_id, messageId: msg.id });
    }
    res.json({ ok: true });
  }),
);

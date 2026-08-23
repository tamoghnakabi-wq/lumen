import { exists, get } from "../db.ts";
import { canViewContentOf } from "./visibility.ts";

type MediaContext = {
  kind: "avatar" | "post" | "story" | "message" | "orphan";
  ownerId: string | null;
  authorId: string | null;
  conversationId: string | null;
};

/**
 * What is this image attached to? One query, because it runs on every image
 * request. A media id belongs to exactly one upload, so at most one of these
 * matches in practice.
 */
export function mediaContext(mediaId: string): MediaContext | null {
  const row = get<{
    owner_id: string | null;
    avatar_user: string | null;
    post_author: string | null;
    story_author: string | null;
    conversation_id: string | null;
  }>(
    `SELECT
       (SELECT owner_id FROM media WHERE id = ?1) AS owner_id,
       (SELECT u.id FROM users u WHERE u.avatar_id = ?1 LIMIT 1) AS avatar_user,
       (SELECT p.author_id FROM post_media pm JOIN posts p ON p.id = pm.post_id
         WHERE pm.media_id = ?1 LIMIT 1) AS post_author,
       (SELECT s.author_id FROM stories s WHERE s.media_id = ?1 LIMIT 1) AS story_author,
       (SELECT m.conversation_id FROM messages m
         WHERE m.media_id = ?1 AND m.deleted_at IS NULL LIMIT 1) AS conversation_id`,
    mediaId,
  );
  if (!row) return null;
  if (row.avatar_user) {
    return { kind: "avatar", ownerId: row.owner_id, authorId: row.avatar_user, conversationId: null };
  }
  if (row.post_author) {
    return { kind: "post", ownerId: row.owner_id, authorId: row.post_author, conversationId: null };
  }
  if (row.story_author) {
    return { kind: "story", ownerId: row.owner_id, authorId: row.story_author, conversationId: null };
  }
  if (row.conversation_id) {
    return { kind: "message", ownerId: row.owner_id, authorId: null, conversationId: row.conversation_id };
  }
  return { kind: "orphan", ownerId: row.owner_id, authorId: null, conversationId: null };
}

export type MediaDecision =
  | { allow: true; cache: "immutable" | "public" | "private" }
  | { allow: false; reason: "not_found" | "forbidden" };

/**
 * Decides whether `viewerId` may fetch an image.
 *
 * Unguessable ids are a useful second line, but they are not access control:
 * URLs leak through history, referrers and forwarded messages, and a follower
 * who has been blocked keeps any URL they already collected. Private posts,
 * stories and everything sent in a DM are therefore checked on every request.
 */
export function decideMediaAccess(mediaId: string, viewerId: string | null): MediaDecision {
  const context = mediaContext(mediaId);
  if (!context) return { allow: false, reason: "not_found" };

  switch (context.kind) {
    case "avatar":
      // Profile pictures stay visible so mentions, search results and message
      // lists render for people who cannot see the account's posts. They are
      // public whatever happens to the account, so they can be cached hard.
      return { allow: true, cache: "immutable" };

    case "post":
    case "story": {
      const authorId = context.authorId!;
      const owner = get<{ is_private: number }>("SELECT is_private FROM users WHERE id = ?", authorId);
      if (!owner) return { allow: false, reason: "not_found" };
      if (!canViewContentOf(viewerId, authorId)) return { allow: false, reason: "forbidden" };
      // Deliberately not immutable. An account can be switched to private after
      // posting, and a year-long immutable copy would keep being served from
      // caches long after that; a short window bounds the exposure.
      return { allow: true, cache: owner.is_private ? "private" : "public" };
    }

    case "message": {
      if (!viewerId) return { allow: false, reason: "forbidden" };
      const member = exists(
        "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
        context.conversationId,
        viewerId,
      );
      return member ? { allow: true, cache: "private" } : { allow: false, reason: "forbidden" };
    }

    case "orphan":
      // Uploaded but not yet attached (or its post was deleted): owner only.
      if (viewerId && context.ownerId === viewerId) return { allow: true, cache: "private" };
      return { allow: false, reason: "not_found" };
  }
}

import { exists, get } from "../db.ts";
import { forbidden, notFound } from "./http.ts";

/** True when either user has blocked the other. */
export function blockedBetween(a: string, b: string): boolean {
  if (a === b) return false;
  return exists(
    `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    a,
    b,
    b,
    a,
  );
}

/**
 * True when `ownerId` has blocked `viewerId` — the direction that must look like
 * the account does not exist. The reverse (you blocked them) is not a secret from
 * you: you still need to reach their profile to undo it.
 */
export function blockedByOwner(viewerId: string | null, ownerId: string): boolean {
  if (!viewerId || viewerId === ownerId) return false;
  return exists("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?", ownerId, viewerId);
}

export function assertNotBlocked(viewerId: string, otherId: string) {
  if (blockedBetween(viewerId, otherId)) throw notFound("This account is not available.");
}

export function isFollowing(followerId: string, followingId: string): boolean {
  return exists(
    "SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ? AND status = 'accepted'",
    followerId,
    followingId,
  );
}

/**
 * Can `viewerId` see content owned by `ownerId`?
 * Blocks hide content in both directions; private accounts are visible only to accepted followers.
 */
export function canViewContentOf(viewerId: string | null, ownerId: string): boolean {
  if (viewerId === ownerId) return true;
  const owner = get<{ is_private: number }>("SELECT is_private FROM users WHERE id = ?", ownerId);
  if (!owner) return false;
  if (!viewerId) return !owner.is_private;
  if (blockedBetween(viewerId, ownerId)) return false;
  if (!owner.is_private) return true;
  return isFollowing(viewerId, ownerId);
}

/**
 * SQL predicate restricting `p`/`u` (posts joined to users) to what viewer ?1 may see.
 * Bind the viewer id as ?1; pass '' for anonymous viewers.
 */
export const VISIBLE_POSTS_SQL = `
  AND NOT EXISTS (SELECT 1 FROM blocks b
                  WHERE (b.blocker_id = p.author_id AND b.blocked_id = ?1)
                     OR (b.blocker_id = ?1 AND b.blocked_id = p.author_id))
  AND (u.is_private = 0 OR p.author_id = ?1
       OR EXISTS (SELECT 1 FROM follows f
                  WHERE f.follower_id = ?1 AND f.following_id = p.author_id AND f.status = 'accepted'))`;

/**
 * Hides a muted author's posts from a feed. Deliberately NOT part of
 * VISIBLE_POSTS_SQL: muting changes what is put in front of you, never what you
 * are allowed to reach. Their profile, their posts by direct link and every
 * notification they cause all still work — that is what separates it from a
 * block, and it is why this predicate is opt-in per query.
 * Bind the viewer id as ?1 and alias the posts table as `p`.
 */
export const UNMUTED_POSTS_SQL = `
  AND NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = ?1 AND mu.muted_id = p.author_id)`;

/** True when the viewer has muted this account. */
export function hasMuted(viewerId: string | null, targetId: string): boolean {
  if (!viewerId) return false;
  return !!get("SELECT 1 AS x FROM mutes WHERE muter_id = ? AND muted_id = ?", viewerId, targetId);
}

/** Same rule for a users query aliased as `u`. */
export const VISIBLE_USERS_SQL = `
  AND NOT EXISTS (SELECT 1 FROM blocks b
                  WHERE (b.blocker_id = u.id AND b.blocked_id = ?1)
                     OR (b.blocker_id = ?1 AND b.blocked_id = u.id))`;


/**
 * Enforces read access, distinguishing the two reasons it can fail.
 *
 * A block must be indistinguishable from "there is nothing here": if it answered
 * 403 the blocked account could probe ids and learn what exists and when the
 * blocker posts. A private account is different — its profile is deliberately
 * visible so you can ask to follow — so saying "this is private" gives nothing
 * away. `missing` should be word-for-word the message used when the thing really
 * is gone, or the status code alone becomes the tell.
 */
export function assertCanView(
  viewerId: string | null,
  ownerId: string,
  messages: { missing: string; restricted: string },
) {
  if (viewerId && blockedBetween(viewerId, ownerId)) throw notFound(messages.missing);
  if (!canViewContentOf(viewerId, ownerId)) throw forbidden(messages.restricted);
}

/** Loads a post and enforces read access, or throws 404/403. */
export function loadViewablePost(viewerId: string | null, postId: string) {
  const post = get<{ id: string; author_id: string }>("SELECT id, author_id FROM posts WHERE id = ?", postId);
  if (!post) throw notFound("This post is no longer available.");
  assertCanView(viewerId, post.author_id, {
    missing: "This post is no longer available.",
    restricted: "This post is private.",
  });
  return post;
}

/**
 * Reposting and quoting republish someone else's work to an audience they did
 * not choose, so they carry a stricter rule than reading: a private account's
 * posts cannot be repeated at all. Being able to see a post is not the same as
 * being allowed to hand it to your own followers.
 */
export function loadRepostablePost(viewerId: string, postId: string) {
  const post = get<{ id: string; author_id: string; is_private: number }>(
    `SELECT p.id, p.author_id, u.is_private FROM posts p
     JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
    postId,
  );
  if (!post) throw notFound("This post is no longer available.");
  assertCanView(viewerId, post.author_id, {
    missing: "This post is no longer available.",
    restricted: "This post is private.",
  });
  if (post.is_private) {
    throw forbidden("Posts from private accounts cannot be reposted.");
  }
  return post;
}

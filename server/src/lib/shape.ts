import { all, get, placeholders } from "../db.ts";
import { viewerSharesActivity } from "./viewerContext.ts";

export type UserRow = {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  display_name: string;
  bio: string;
  website: string;
  avatar_id: string | null;
  is_private: number;
  created_at: number;
  last_seen_at: number;
  username_changed_at: number;
  show_activity: number;
  read_receipts: number;
};

export type MediaRow = {
  id: string;
  owner_id: string | null;
  kind: "image" | "video";
  status: "ready" | "processing" | "failed";
  width: number;
  height: number;
  bytes: number;
  duration_ms: number;
  has_audio: number;
  preview: string;
  created_at: number;
};

const ONLINE_WINDOW_MS = 90_000;

export function mediaPayload(row: MediaRow | undefined | null) {
  if (!row) return null;
  const isVideo = row.kind === "video";
  return {
    id: row.id,
    kind: row.kind ?? "image",
    // Images are always ready; a video only becomes playable once encoded.
    status: row.status ?? "ready",
    width: row.width,
    height: row.height,
    preview: row.preview || null,
    // The poster frame lives at the same three URLs an image would, so grids,
    // carousels and link previews need no special case for video.
    url: `/media/${row.id}/feed.webp`,
    thumb: `/media/${row.id}/thumb.webp`,
    full: `/media/${row.id}/full.webp`,
    video: isVideo ? `/media/${row.id}/video.mp4` : null,
    durationMs: isVideo ? (row.duration_ms ?? 0) : 0,
    hasAudio: isVideo ? !!row.has_audio : false,
  };
}

export function avatarUrl(avatarId: string | null | undefined) {
  return avatarId ? `/media/${avatarId}/thumb.webp` : null;
}

/**
 * Whether this account should be shown as online.
 *
 * Two conditions, both deliberate. Someone who turned activity status off is
 * never shown as online — to anyone, themselves included, because a dot that
 * contradicts your own setting is just confusing. And they do not get to see
 * anyone else's either, so the switch cannot be used to watch unwatched.
 */
function onlineFor(row: Partial<UserRow>): boolean {
  // Unknown means the query did not fetch the setting. Treat that as "do not
  // show": a missed SELECT then costs a green dot, not someone's privacy.
  if (row.show_activity === undefined || row.show_activity === 0) return false;
  if (!viewerSharesActivity()) return false;
  return (row.last_seen_at ?? 0) > Date.now() - ONLINE_WINDOW_MS;
}

/** Compact user shape used inside posts, comments, notifications and lists. */
export function userCard(row: Partial<UserRow> & { id: string; username: string }) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatar: avatarUrl(row.avatar_id ?? null),
    isPrivate: !!row.is_private,
    isOnline: onlineFor(row),
  };
}

export type ViewerRelation = {
  isSelf: boolean;
  isFollowing: boolean;
  isRequested: boolean;
  followsYou: boolean;
  isBlocked: boolean;
  blockedYou: boolean;
  /** Only ever true for the person who muted; the muted account never sees it. */
  isMuted: boolean;
};

export function relationTo(viewerId: string | null, targetId: string): ViewerRelation {
  if (!viewerId) {
    return {
      isSelf: false,
      isFollowing: false,
      isRequested: false,
      followsYou: false,
      isBlocked: false,
      blockedYou: false,
      isMuted: false,
    };
  }
  if (viewerId === targetId) {
    return {
      isSelf: true,
      isFollowing: false,
      isRequested: false,
      followsYou: false,
      isBlocked: false,
      blockedYou: false,
      isMuted: false,
    };
  }
  const outgoing = get<{ status: string }>(
    "SELECT status FROM follows WHERE follower_id = ? AND following_id = ?",
    viewerId,
    targetId,
  );
  const incoming = get<{ status: string }>(
    "SELECT status FROM follows WHERE follower_id = ? AND following_id = ?",
    targetId,
    viewerId,
  );
  const blocked = get("SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?", viewerId, targetId);
  const blockedBy = get("SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?", targetId, viewerId);
  return {
    isSelf: false,
    isFollowing: outgoing?.status === "accepted",
    isRequested: outgoing?.status === "pending",
    followsYou: incoming?.status === "accepted",
    isBlocked: !!blocked,
    blockedYou: !!blockedBy,
    isMuted: !!get("SELECT 1 AS x FROM mutes WHERE muter_id = ? AND muted_id = ?", viewerId, targetId),
  };
}

export function userCounts(userId: string) {
  const row = get<{ posts: number; followers: number; following: number }>(
    `SELECT
       (SELECT COUNT(*) FROM posts WHERE author_id = ?1) AS posts,
       (SELECT COUNT(*) FROM follows WHERE following_id = ?1 AND status = 'accepted') AS followers,
       (SELECT COUNT(*) FROM follows WHERE follower_id = ?1 AND status = 'accepted') AS following`,
    userId,
  )!;
  return row;
}

/** Full profile payload. `canViewPosts` tells the client whether to render the grid or the locked state. */
export function userProfile(row: UserRow, viewerId: string | null) {
  const relation = relationTo(viewerId, row.id);
  const canViewPosts =
    relation.isSelf || (!row.is_private && !relation.blockedYou && !relation.isBlocked) || relation.isFollowing;
  return {
    ...userCard(row),
    bio: row.bio,
    website: row.website,
    createdAt: row.created_at,
    counts: userCounts(row.id),
    relation,
    canViewPosts,
    // Settings are only ever reported back to their owner.
    ...(relation.isSelf
      ? {
          email: row.email,
          showActivity: row.show_activity !== 0,
          readReceipts: row.read_receipts !== 0,
        }
      : {}),
  };
}

export type PostRow = {
  id: string;
  author_id: string;
  caption: string;
  location: string;
  quoted_post_id: string | null;
  is_quote: number;
  created_at: number;
  edited_at: number | null;
  like_count: number;
  comment_count: number;
  save_count: number;
  repost_count: number;
  quote_count: number;
  liked: number;
  saved: number;
  reposted: number;
  author_follow: string | null;
  author_muted: number;
  username: string;
  display_name: string;
  avatar_id: string | null;
  is_private: number;
  last_seen_at: number;
  show_activity: number;
};

/**
 * Shared column list for posts. Counts and viewer flags are computed in SQL so a
 * feed page is a single query plus one media lookup.
 * Bind the viewer id as ?1 (use '' for anonymous) — remaining params start at ?2.
 */
export const POST_COLUMNS = `
  p.id, p.author_id, p.caption, p.location, p.created_at, p.edited_at, p.quoted_post_id, p.is_quote,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)    AS like_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
  (SELECT COUNT(*) FROM saves s WHERE s.post_id = p.id)    AS save_count,
  (SELECT COUNT(*) FROM reposts rp WHERE rp.post_id = p.id) AS repost_count,
  (SELECT COUNT(*) FROM posts q WHERE q.quoted_post_id = p.id) AS quote_count,
  EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?1) AS liked,
  EXISTS(SELECT 1 FROM saves s WHERE s.post_id = p.id AND s.user_id = ?1) AS saved,
  EXISTS(SELECT 1 FROM reposts rp WHERE rp.post_id = p.id AND rp.user_id = ?1) AS reposted,
  -- Reels show a Follow button on an author the viewer may not know, so the
  -- relationship travels with the post rather than costing a request per reel.
  (SELECT f.status FROM follows f WHERE f.follower_id = ?1 AND f.following_id = p.author_id) AS author_follow,
  -- A muted author's posts still show on their profile and by direct link, so the
  -- overflow menu needs to know whether to offer Mute or Unmute.
  EXISTS(SELECT 1 FROM mutes mu WHERE mu.muter_id = ?1 AND mu.muted_id = p.author_id) AS author_muted,
  u.username, u.display_name, u.avatar_id, u.is_private, u.last_seen_at, u.show_activity`;

export const POST_SELECT = `SELECT ${POST_COLUMNS} FROM posts p JOIN users u ON u.id = p.author_id`;

/**
 * Turns post rows into API payloads.
 *
 * `viewerId` is needed because a quote repost embeds another post, and that
 * post's visibility has to be judged for whoever is reading right now — the
 * quoted author may have gone private or blocked this viewer since the quote
 * was written. `withQuotes` stops the embedding at one level: a quote of a
 * quote renders the inner one as a plain card, not a recursive chain.
 */
export function hydratePosts(rows: PostRow[], viewerId: string | null = null, withQuotes = true): any[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const mediaRows = all<MediaRow & { post_id: string; position: number }>(
    `SELECT m.*, pm.post_id, pm.position FROM post_media pm
     JOIN media m ON m.id = pm.media_id
     WHERE pm.post_id IN (${placeholders(ids.length)})
     ORDER BY pm.post_id, pm.position`,
    ...ids,
  );
  const tagRows = all<{ post_id: string; tag: string }>(
    `SELECT post_id, tag FROM post_hashtags WHERE post_id IN (${placeholders(ids.length)})`,
    ...ids,
  );
  const byPost = new Map<string, any[]>();
  for (const m of mediaRows) {
    if (!byPost.has(m.post_id)) byPost.set(m.post_id, []);
    byPost.get(m.post_id)!.push(mediaPayload(m));
  }
  const tagsByPost = new Map<string, string[]>();
  for (const t of tagRows) {
    if (!tagsByPost.has(t.post_id)) tagsByPost.set(t.post_id, []);
    tagsByPost.get(t.post_id)!.push(t.tag);
  }
  // Resolve embedded quotes in one extra query for the whole page, applying the
  // viewer's own visibility rules to each quoted post.
  const quotedIds = withQuotes
    ? [...new Set(rows.map((r) => r.quoted_post_id).filter((id): id is string => !!id))]
    : [];
  const quotedById = new Map<string, any>();
  if (quotedIds.length > 0) {
    const quotedRows = all<PostRow>(
      `${POST_SELECT}
       WHERE p.id IN (${placeholders(quotedIds.length)})
         AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = p.author_id AND b.blocked_id = ?1)
                            OR (b.blocker_id = ?1 AND b.blocked_id = p.author_id))
         AND (u.is_private = 0 OR p.author_id = ?1
              OR EXISTS (SELECT 1 FROM follows f
                         WHERE f.follower_id = ?1 AND f.following_id = p.author_id
                           AND f.status = 'accepted'))`,
      viewerId ?? "",
      ...quotedIds,
    );
    for (const payload of hydratePosts(quotedRows, viewerId, false)) {
      quotedById.set(payload.id, payload);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    caption: r.caption,
    location: r.location,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    author: userCard({
      id: r.author_id,
      username: r.username,
      display_name: r.display_name,
      avatar_id: r.avatar_id,
      is_private: r.is_private,
      last_seen_at: r.last_seen_at,
      show_activity: r.show_activity,
    }),
    media: byPost.get(r.id) ?? [],
    hashtags: tagsByPost.get(r.id) ?? [],
    counts: {
      likes: r.like_count,
      comments: r.comment_count,
      saves: r.save_count,
      reposts: r.repost_count,
      quotes: r.quote_count,
    },
    viewer: {
      liked: !!r.liked,
      saved: !!r.saved,
      reposted: !!r.reposted,
      isAuthor: !!viewerId && viewerId === r.author_id,
      followsAuthor: r.author_follow === "accepted",
      requestedAuthor: r.author_follow === "pending",
      isMuted: !!r.author_muted,
    },
    // A quote whose original is gone, private or blocked renders as a tombstone
    // rather than silently looking like an ordinary post.
    quotedPost: r.quoted_post_id ? (quotedById.get(r.quoted_post_id) ?? null) : null,
    quotedUnavailable: !!r.is_quote && withQuotes && !(r.quoted_post_id && quotedById.has(r.quoted_post_id)),
  }));
}

export type CommentRow = {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  body: string;
  created_at: number;
  username: string;
  display_name: string;
  avatar_id: string | null;
  last_seen_at: number;
  show_activity: number;
  like_count: number;
  reply_count: number;
  liked: number;
};

export const COMMENT_SELECT = `
  SELECT c.id, c.post_id, c.author_id, c.parent_id, c.body, c.created_at,
         u.username, u.display_name, u.avatar_id, u.last_seen_at, u.show_activity,
         (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS like_count,
         (SELECT COUNT(*) FROM comments rc WHERE rc.parent_id = c.id) AS reply_count,
         EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = ?1) AS liked
  FROM comments c JOIN users u ON u.id = c.author_id`;

export function commentPayload(r: CommentRow) {
  return {
    id: r.id,
    postId: r.post_id,
    parentId: r.parent_id,
    body: r.body,
    createdAt: r.created_at,
    author: userCard({
      id: r.author_id,
      username: r.username,
      display_name: r.display_name,
      avatar_id: r.avatar_id,
      last_seen_at: r.last_seen_at,
      show_activity: r.show_activity,
    }),
    counts: { likes: r.like_count, replies: r.reply_count ?? 0 },
    viewer: { liked: !!r.liked },
  };
}

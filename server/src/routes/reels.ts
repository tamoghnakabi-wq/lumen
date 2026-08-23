import { Router } from "express";
import { all } from "../db.ts";
import { h } from "../lib/http.ts";
import { POST_COLUMNS, hydratePosts, type PostRow } from "../lib/shape.ts";
import { UNMUTED_POSTS_SQL, VISIBLE_POSTS_SQL } from "../lib/visibility.ts";

export const reelsRouter = Router();

/**
 * The Reels feed: video posts only, ranked for browsing rather than recency.
 *
 * A Reel is not a separate kind of content — it is a post whose media is a
 * video — so this reuses the same visibility predicate, counts and payload as
 * every other feed. Only playable videos appear: one still encoding, or one
 * whose encode failed, would be a black rectangle you cannot skip past.
 *
 * People you follow are mixed in ahead of strangers, then engagement damped by
 * age, so the feed is neither purely chronological nor purely popular.
 */
reelsRouter.get(
  "/",
  h((req, res) => {
    const viewerId = req.user?.id ?? "";
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const limit = Math.min(Number(req.query.limit ?? 10) || 10, 20);
    // A single reel can be opened directly (from a grid); it leads the feed.
    const seed = String(req.query.seed ?? "").slice(0, 40);

    const rows = all<PostRow>(
      `SELECT ${POST_COLUMNS},
              ( (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)
                + 2.0 * (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)
                + 3.0 * (SELECT COUNT(*) FROM reposts rp WHERE rp.post_id = p.id) + 1.0 )
              / (1.0 + (?2 - p.created_at) / 86400000.0)
              * (CASE WHEN EXISTS (SELECT 1 FROM follows f
                                   WHERE f.follower_id = ?1 AND f.following_id = p.author_id
                                     AND f.status = 'accepted') THEN 2.5 ELSE 1.0 END) AS score
       FROM posts p
       JOIN users u ON u.id = p.author_id
       WHERE EXISTS (SELECT 1 FROM post_media pm
                     JOIN media m ON m.id = pm.media_id
                     WHERE pm.post_id = p.id AND m.kind = 'video' AND m.status = 'ready')
         ${VISIBLE_POSTS_SQL}
         ${UNMUTED_POSTS_SQL}
       ORDER BY (p.id = ?5) DESC, score DESC, p.id DESC
       LIMIT ?3 OFFSET ?4`,
      viewerId,
      Date.now(),
      limit + 1,
      offset,
      seed,
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({ reels: hydratePosts(page, viewerId), nextOffset: hasMore ? offset + limit : null });
  }),
);

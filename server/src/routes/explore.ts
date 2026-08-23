import { Router } from "express";
import { all } from "../db.ts";
import { h, limit } from "../lib/http.ts";
import { POST_COLUMNS, POST_SELECT, hydratePosts, userCard, type PostRow, type UserRow } from "../lib/shape.ts";
import { UNMUTED_POSTS_SQL, VISIBLE_POSTS_SQL, VISIBLE_USERS_SQL, isFollowing } from "../lib/visibility.ts";

export const exploreRouter = Router();

/** Escapes user input for a LIKE pattern so % and _ are literal. */
function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Ranked grid of public posts. Score is engagement damped by age so the grid
 * keeps moving instead of pinning the same all-time favourites.
 */
exploreRouter.get(
  "/",
  h((req, res) => {
    const viewerId = req.user?.id ?? "";
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const limit = Math.min(Number(req.query.limit ?? 24) || 24, 48);
    const rows = all<PostRow & { score: number }>(
      `SELECT ${POST_COLUMNS},
        ( (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)
          + 2.0 * (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) + 0.5 )
        / (1.0 + (?2 - p.created_at) / 43200000.0) AS score
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.author_id != ?1 AND p.created_at > ?5 ${VISIBLE_POSTS_SQL} ${UNMUTED_POSTS_SQL}
       ORDER BY score DESC, p.id DESC
       LIMIT ?3 OFFSET ?4`,
      viewerId,
      Date.now(),
      limit + 1,
      offset,
      // Ranking scans every candidate row, so bound it by recency rather than
      // letting the cost grow with the lifetime size of the table.
      Date.now() - 120 * 24 * 60 * 60 * 1000,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({ posts: hydratePosts(page, viewerId), nextOffset: hasMore ? offset + limit : null });
  }),
);

/** Trending hashtags over the last week, with a fallback to all-time. */
exploreRouter.get(
  "/tags",
  h((_req, res) => {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = all<{ tag: string; c: number }>(
      `SELECT ph.tag, COUNT(*) AS c FROM post_hashtags ph JOIN posts p ON p.id = ph.post_id
       JOIN users u ON u.id = p.author_id
       WHERE u.is_private = 0 AND p.created_at > ?
       GROUP BY ph.tag ORDER BY c DESC, ph.tag LIMIT 12`,
      since,
    );
    const tags =
      recent.length > 0
        ? recent
        : all<{ tag: string; c: number }>(
            `SELECT ph.tag, COUNT(*) AS c FROM post_hashtags ph JOIN posts p ON p.id = ph.post_id
             JOIN users u ON u.id = p.author_id
             WHERE u.is_private = 0
             GROUP BY ph.tag ORDER BY c DESC, ph.tag LIMIT 12`,
          );
    res.json({ tags: tags.map((t) => ({ tag: t.tag, posts: t.c })) });
  }),
);

/** Unified search across people, hashtags and captions. */
exploreRouter.get(
  "/search",
  limit({ name: "search", max: 120, windowMs: 60 * 1000 }),
  h((req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 60);
    const viewerId = req.user?.id ?? "";
    if (q.length === 0) return res.json({ users: [], tags: [], posts: [] });

    const bare = q.replace(/^[#@]/, "").toLowerCase();
    const pattern = likeTerm(bare);

    const users =
      q.startsWith("#")
        ? []
        : all<UserRow>(
            `SELECT u.* FROM users u
             WHERE (u.username LIKE ?2 ESCAPE '\\' OR LOWER(u.display_name) LIKE ?2 ESCAPE '\\')
               AND u.id != ?1 ${VISIBLE_USERS_SQL}
             ORDER BY (u.username = ?3) DESC,
                      (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id AND f.status='accepted') DESC
             LIMIT 12`,
            viewerId,
            pattern,
            bare,
          ).map((u) => ({
            ...userCard(u),
            bio: u.bio,
            isFollowing: viewerId ? isFollowing(viewerId, u.id) : false,
          }));

    const tags = q.startsWith("@")
      ? []
      : all<{ tag: string; c: number }>(
          `SELECT ph.tag, COUNT(*) AS c FROM post_hashtags ph
           JOIN posts p ON p.id = ph.post_id JOIN users u ON u.id = p.author_id
           WHERE ph.tag LIKE ?2 ESCAPE '\\' AND u.is_private = 0
           GROUP BY ph.tag ORDER BY (ph.tag = ?3) DESC, c DESC LIMIT 8`,
          viewerId,
          pattern,
          bare,
        ).map((t) => ({ tag: t.tag, posts: t.c }));

    const posts =
      q.startsWith("@") || q.startsWith("#")
        ? []
        : hydratePosts(
            all<PostRow>(
              `${POST_SELECT}
               WHERE LOWER(p.caption) LIKE ?2 ESCAPE '\\' ${VISIBLE_POSTS_SQL}
               ORDER BY p.id DESC LIMIT 18`,
              viewerId,
              pattern,
            ),
            viewerId,
          );

    res.json({ users, tags, posts });
  }),
);

/**
 * Typeahead for @mentions. Deliberately narrow: people you follow or who follow
 * you rank first, blocked accounts never appear, and it returns only what the
 * composer needs to render a row.
 */
exploreRouter.get(
  "/mentions",
  limit({ name: "mentions", max: 240, windowMs: 60 * 1000 }),
  h((req, res) => {
    const viewerId = req.user?.id ?? "";
    const q = String(req.query.q ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 24);
    if (!viewerId || q.length === 0) return res.json({ users: [] });

    const rows = all<UserRow & { connected: number }>(
      `SELECT u.*,
              (EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.following_id = u.id AND f.status='accepted')
               + EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.following_id = ?1 AND f.status='accepted')) AS connected
       FROM users u
       WHERE (u.username LIKE ?2 ESCAPE '\\' OR LOWER(u.display_name) LIKE ?2 ESCAPE '\\')
         ${VISIBLE_USERS_SQL}
       ORDER BY connected DESC, (u.username = ?3) DESC, LENGTH(u.username) ASC
       LIMIT 6`,
      viewerId,
      likeTerm(q),
      q,
    );
    res.json({ users: rows.map((u) => ({ ...userCard(u), connected: u.connected > 0 })) });
  }),
);

exploreRouter.get(
  "/tags/:tag",
  h((req, res) => {
    const viewerId = req.user?.id ?? "";
    const tag = req.params.tag.toLowerCase().replace(/^#/, "").slice(0, 50);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const limit = 24;
    const rows = all<PostRow>(
      `${POST_SELECT}
       WHERE EXISTS (SELECT 1 FROM post_hashtags ph WHERE ph.post_id = p.id AND ph.tag = ?2)
         ${VISIBLE_POSTS_SQL}
         ${UNMUTED_POSTS_SQL}
       ORDER BY p.id DESC LIMIT ?3 OFFSET ?4`,
      viewerId,
      tag,
      limit + 1,
      offset,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      tag,
      posts: hydratePosts(page, viewerId),
      nextOffset: hasMore ? offset + limit : null,
    });
  }),
);

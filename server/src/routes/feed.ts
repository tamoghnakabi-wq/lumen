import { Router } from "express";
import { all, pluck } from "../db.ts";
import { h } from "../lib/http.ts";
import { me, requireAuth } from "../lib/auth.ts";
import { POST_SELECT, hydratePosts, type PostRow } from "../lib/shape.ts";
import { UNMUTED_POSTS_SQL, VISIBLE_POSTS_SQL } from "../lib/visibility.ts";
import { feedPage } from "./posts.ts";

export const feedRouter = Router();

feedRouter.get(
  "/",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const cursor = String(req.query.cursor ?? "") || null;
    const limit = Math.min(Number(req.query.limit ?? 8) || 8, 20);
    const page = feedPage(user.id, cursor, limit);

    // A brand new account follows nobody; show public posts instead of an empty page.
    const followingCount =
      pluck<number>("SELECT COUNT(*) FROM follows WHERE follower_id = ? AND status = 'accepted'", user.id) ?? 0;
    if (page.posts.length === 0 && followingCount === 0 && !cursor) {
      const rows = all<PostRow>(
        `${POST_SELECT} WHERE 1=1 ${VISIBLE_POSTS_SQL} ${UNMUTED_POSTS_SQL} AND p.author_id != ?1
         ORDER BY p.id DESC LIMIT ?2`,
        user.id,
        limit,
      );
      return res.json({ posts: hydratePosts(rows, user.id), nextCursor: null, source: "discover" });
    }

    res.json({ ...page, source: "following" });
  }),
);

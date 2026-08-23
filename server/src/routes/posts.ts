import { Router } from "express";
import { z } from "zod";
import { config } from "../config.ts";
import { all, exists, get, run, tx } from "../db.ts";
import { badRequest, forbidden, h, limit, notFound, parse, tooLarge } from "../lib/http.ts";
import { me, requireAuth } from "../lib/auth.ts";
import { newId } from "../lib/ids.ts";
import { deleteMedia, discardUpload, isVideoUpload, storeImage, storeVideo, uploadPostMedia } from "../lib/media.ts";
import { notify, notifyMentions, unnotify } from "../lib/notify.ts";
import {
  COMMENT_SELECT,
  POST_COLUMNS,
  POST_SELECT,
  commentPayload,
  hydratePosts,
  userCard,
  type CommentRow,
  type MediaRow,
  type PostRow,
} from "../lib/shape.ts";
import { extractHashtags, extractMentions, tidy } from "../lib/text.ts";
import { canViewContentOf, loadRepostablePost, loadViewablePost } from "../lib/visibility.ts";

export const postsRouter = Router();

const captionSchema = z.string().max(2200, "Captions are limited to 2200 characters.").optional().default("");
const locationSchema = z.string().trim().max(80).optional().default("");

function loadPostPayload(postId: string, viewerId: string) {
  const row = get<PostRow>(`${POST_SELECT} WHERE p.id = ?2`, viewerId, postId);
  if (!row) throw notFound("This post is no longer available.");
  return hydratePosts([row], viewerId)[0];
}

function syncHashtags(postId: string, caption: string) {
  run("DELETE FROM post_hashtags WHERE post_id = ?", postId);
  for (const tag of extractHashtags(caption)) {
    run("INSERT OR IGNORE INTO post_hashtags (post_id, tag) VALUES (?,?)", postId, tag);
  }
}

postsRouter.post(
  "/",
  requireAuth,
  limit({ name: "post:create", max: 30, windowMs: 60 * 60 * 1000 }),
  uploadPostMedia.array("images", config.maxPostImages),
  h(async (req, res) => {
    const user = me(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const videos = files.filter((f) => isVideoUpload(f.mimetype));
    const images = files.filter((f) => !isVideoUpload(f.mimetype));

    const body = parse(
      z.object({
        caption: captionSchema,
        location: locationSchema,
        quotedPostId: z.string().max(40).optional().nullable(),
      }),
      req.body ?? {},
    );
    const caption = tidy(body.caption);

    // A quote repost borrows the original's images, so it is the one kind of
    // post that may carry none of its own.
    let quotedPostId: string | null = null;
    if (body.quotedPostId) {
      // Quoting a quote points at that quote, keeping the commentary you meant
      // to respond to; rendering stops after one level so chains stay readable.
      const quoted = loadRepostablePost(user.id, body.quotedPostId);
      if (files.length === 0 && !caption) throw badRequest("Add a comment or an image to your quote.");
      quotedPostId = quoted.id;
    } else if (files.length === 0) {
      throw badRequest("Add at least one photo or video to your post.");
    }

    // A post is either a set of photos or a single video. Mixing the two in one
    // carousel makes the viewer ambiguous — is it a Reel or a gallery? — and a
    // Reel is defined by being one video.
    if (videos.length > 1) {
      await Promise.all(files.map(discardUpload));
      throw badRequest("You can post one video at a time.");
    }
    if (videos.length === 1 && images.length > 0) {
      await Promise.all(files.map(discardUpload));
      throw badRequest("A post can hold photos or a video, not both.");
    }
    // Multer's own ceiling has to be the larger video limit, so photos are
    // measured here instead — still 413, the same answer multer used to give.
    const oversized = images.find((f) => f.size > config.maxUploadBytes);
    if (oversized) {
      await Promise.all(files.map(discardUpload));
      throw tooLarge(`“${oversized.originalname}” is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB photo limit.`);
    }

    const stored: MediaRow[] = [];
    try {
      for (const file of images) {
        stored.push(await storeImage(file.path, user.id));
        await discardUpload(file);
      }
      // storeVideo hands the temp file to the transcode queue, which deletes it.
      for (const file of videos) stored.push(await storeVideo(file.path, user.id));
    } catch (err) {
      await Promise.all(stored.map((m) => deleteMedia(m.id)));
      await Promise.all(files.map(discardUpload));
      throw err;
    }

    const postId = newId();
    const now = Date.now();
    tx(() => {
      run(
        "INSERT INTO posts (id, author_id, caption, location, quoted_post_id, is_quote, created_at) VALUES (?,?,?,?,?,?,?)",
        postId,
        user.id,
        caption,
        body.location,
        quotedPostId,
        quotedPostId ? 1 : 0,
        now,
      );
      stored.forEach((m, i) => {
        run("INSERT INTO post_media (post_id, media_id, position) VALUES (?,?,?)", postId, m.id, i);
      });
      for (const tag of extractHashtags(caption)) {
        run("INSERT OR IGNORE INTO post_hashtags (post_id, tag) VALUES (?,?)", postId, tag);
      }
    });

    notifyMentions(caption, user.id, { postId }, extractMentions(caption));
    if (quotedPostId) {
      const quotedAuthor = get<{ author_id: string }>("SELECT author_id FROM posts WHERE id = ?", quotedPostId);
      if (quotedAuthor) {
        notify({ userId: quotedAuthor.author_id, actorId: user.id, type: "quote", postId });
      }
    }
    res.status(201).json({ post: loadPostPayload(postId, user.id) });
  }),
);

/* -------------------------------------------------------------- reposts */

postsRouter.post(
  "/:id/repost",
  requireAuth,
  limit({ name: "repost", max: 120, windowMs: 60 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const post = loadRepostablePost(user.id, req.params.id);
    if (post.author_id === user.id) throw badRequest("You cannot repost your own post.");
    run("INSERT OR IGNORE INTO reposts (user_id, post_id, created_at) VALUES (?,?,?)", user.id, post.id, Date.now());
    notify({ userId: post.author_id, actorId: user.id, type: "repost", postId: post.id });
    res.json({ post: loadPostPayload(post.id, user.id) });
  }),
);

postsRouter.delete(
  "/:id/repost",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const post = get<{ id: string; author_id: string }>(
      "SELECT id, author_id FROM posts WHERE id = ?",
      req.params.id,
    );
    if (!post) throw notFound("This post is no longer available.");
    run("DELETE FROM reposts WHERE user_id = ? AND post_id = ?", user.id, post.id);
    unnotify({ userId: post.author_id, actorId: user.id, type: "repost", postId: post.id });
    res.json({ post: loadPostPayload(post.id, user.id) });
  }),
);

/** Who reposted this, for the count popover. */
postsRouter.get(
  "/:id/reposts",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    loadViewablePost(user.id, req.params.id);
    const rows = all(
      `SELECT u.* FROM reposts r JOIN users u ON u.id = r.user_id
       WHERE r.post_id = ?1
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?2)
                                                   OR (b.blocker_id = ?2 AND b.blocked_id = u.id))
       ORDER BY r.created_at DESC LIMIT 100`,
      req.params.id,
      user.id,
    );
    res.json({ users: rows.map((r) => userCard(r as any)) });
  }),
);

postsRouter.get(
  "/:id",
  h((req, res) => {
    const viewerId = req.user?.id ?? "";
    loadViewablePost(req.user?.id ?? null, req.params.id);
    res.json({ post: loadPostPayload(req.params.id, viewerId) });
  }),
);

postsRouter.patch(
  "/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const post = get<{ author_id: string }>("SELECT author_id FROM posts WHERE id = ?", req.params.id);
    if (!post) throw notFound("This post is no longer available.");
    if (post.author_id !== user.id) throw forbidden("You can only edit your own posts.");

    const body = parse(z.object({ caption: captionSchema, location: locationSchema }), req.body);
    const caption = tidy(body.caption);
    tx(() => {
      run(
        "UPDATE posts SET caption = ?, location = ?, edited_at = ? WHERE id = ?",
        caption,
        body.location,
        Date.now(),
        req.params.id,
      );
      syncHashtags(req.params.id, caption);
    });
    notifyMentions(caption, user.id, { postId: req.params.id }, extractMentions(caption));
    res.json({ post: loadPostPayload(req.params.id, user.id) });
  }),
);

postsRouter.delete(
  "/:id",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    const post = get<{ author_id: string }>("SELECT author_id FROM posts WHERE id = ?", req.params.id);
    if (!post) throw notFound("This post is no longer available.");
    if (post.author_id !== user.id) throw forbidden("You can only delete your own posts.");

    const mediaIds = all<{ media_id: string }>("SELECT media_id FROM post_media WHERE post_id = ?", req.params.id).map(
      (r) => r.media_id,
    );
    run("DELETE FROM posts WHERE id = ?", req.params.id);
    await Promise.all(mediaIds.map((id) => deleteMedia(id)));
    res.json({ ok: true });
  }),
);

/* ---------------------------------------------------------------- likes */

postsRouter.post(
  "/:id/like",
  requireAuth,
  limit({ name: "like", max: 300, windowMs: 10 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const post = loadViewablePost(user.id, req.params.id);
    run("INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?,?,?)", user.id, post.id, Date.now());
    notify({ userId: post.author_id, actorId: user.id, type: "like", postId: post.id });
    res.json({ post: loadPostPayload(post.id, user.id) });
  }),
);

postsRouter.delete(
  "/:id/like",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const post = loadViewablePost(user.id, req.params.id);
    run("DELETE FROM likes WHERE user_id = ? AND post_id = ?", user.id, post.id);
    unnotify({ userId: post.author_id, actorId: user.id, type: "like", postId: post.id });
    res.json({ post: loadPostPayload(post.id, user.id) });
  }),
);

postsRouter.get(
  "/:id/likes",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    loadViewablePost(user.id, req.params.id);
    const rows = all(
      `SELECT u.* FROM likes l JOIN users u ON u.id = l.user_id
       WHERE l.post_id = ?
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?)
                                                   OR (b.blocker_id = ? AND b.blocked_id = u.id))
       ORDER BY l.created_at DESC LIMIT 100`,
      req.params.id,
      user.id,
      user.id,
    );
    res.json({ users: rows.map((r) => userCard(r as any)) });
  }),
);

/* ---------------------------------------------------------------- saves */

postsRouter.post(
  "/:id/save",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const post = loadViewablePost(user.id, req.params.id);
    run("INSERT OR IGNORE INTO saves (user_id, post_id, created_at) VALUES (?,?,?)", user.id, post.id, Date.now());
    res.json({ post: loadPostPayload(post.id, user.id) });
  }),
);

postsRouter.delete(
  "/:id/save",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    tx(() => {
      run("DELETE FROM saves WHERE user_id = ? AND post_id = ?", user.id, req.params.id);
      // `saves` is the source of truth for bookmarking, so un-saving also files
      // the post out of any collections it was in.
      run(
        `DELETE FROM collection_items
          WHERE post_id = ?1
            AND collection_id IN (SELECT id FROM collections WHERE user_id = ?2)`,
        req.params.id,
        user.id,
      );
    });
    res.json({ post: loadPostPayload(req.params.id, user.id) });
  }),
);

/* ------------------------------------------------------------- comments */

/**
 * Top-level comments only, paged. Replies hang off their parent and are fetched
 * on demand — loading every reply for a busy post up front was both a big
 * response and an unreadable wall of text.
 *
 * sort=top ranks by likes then oldest-first (the conversation reads in order);
 * sort=new puts the most recent first.
 */
postsRouter.get(
  "/:id/comments",
  h((req, res) => {
    const viewerId = req.user?.id ?? "";
    loadViewablePost(req.user?.id ?? null, req.params.id);
    const sort = req.query.sort === "new" ? "new" : "top";
    const cursor = Math.max(Number(req.query.cursor ?? 0) || 0, 0);
    const pageSize = 20;

    const order = sort === "new" ? "c.created_at DESC, c.id DESC" : "like_count DESC, c.created_at ASC, c.id ASC";
    const rows = all<CommentRow>(
      `${COMMENT_SELECT}
       WHERE c.post_id = ?2 AND c.parent_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = c.author_id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = c.author_id))
       ORDER BY ${order}
       LIMIT ?3 OFFSET ?4`,
      viewerId,
      req.params.id,
      pageSize + 1,
      cursor,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    res.json({
      comments: page.map(commentPayload),
      nextCursor: hasMore ? cursor + pageSize : null,
      sort,
    });
  }),
);


postsRouter.post(
  "/:id/comments",
  requireAuth,
  limit({ name: "comment:create", max: 60, windowMs: 10 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const post = loadViewablePost(user.id, req.params.id);
    const body = parse(
      z.object({
        body: z.string().trim().min(1, "Write something first.").max(1000, "Comments are limited to 1000 characters."),
        parentId: z.string().max(40).optional().nullable(),
      }),
      req.body,
    );

    let parentId: string | null = null;
    if (body.parentId) {
      const parent = get<{ id: string; parent_id: string | null }>(
        "SELECT id, parent_id FROM comments WHERE id = ? AND post_id = ?",
        body.parentId,
        post.id,
      );
      if (!parent) throw notFound("That comment no longer exists.");
      // Keep threads one level deep: replying to a reply attaches to its parent.
      parentId = parent.parent_id ?? parent.id;
    }

    const id = newId();
    run(
      "INSERT INTO comments (id, post_id, author_id, parent_id, body, created_at) VALUES (?,?,?,?,?,?)",
      id,
      post.id,
      user.id,
      parentId,
      tidy(body.body, 12),
      Date.now(),
    );

    notify({ userId: post.author_id, actorId: user.id, type: "comment", postId: post.id, commentId: id });
    if (parentId) {
      const parentAuthor = get<{ author_id: string }>("SELECT author_id FROM comments WHERE id = ?", parentId);
      if (parentAuthor && parentAuthor.author_id !== post.author_id) {
        notify({
          userId: parentAuthor.author_id,
          actorId: user.id,
          type: "comment",
          postId: post.id,
          commentId: id,
        });
      }
    }
    notifyMentions(body.body, user.id, { postId: post.id, commentId: id }, extractMentions(body.body));

    const row = get<CommentRow>(`${COMMENT_SELECT} WHERE c.id = ?2`, user.id, id)!;
    res.status(201).json({ comment: commentPayload(row) });
  }),
);

export const commentsRouter = Router();

/** Replies to one comment, oldest first, fetched only when a thread is opened. */
commentsRouter.get(
  "/:id/replies",
  h((req, res) => {
    const viewerId = req.user?.id ?? "";
    const parent = get<{ id: string; post_id: string }>(
      "SELECT id, post_id FROM comments WHERE id = ?",
      req.params.id,
    );
    if (!parent) throw notFound("That comment no longer exists.");
    loadViewablePost(req.user?.id ?? null, parent.post_id);

    const cursor = Math.max(Number(req.query.cursor ?? 0) || 0, 0);
    const pageSize = 20;
    const rows = all<CommentRow>(
      `${COMMENT_SELECT}
       WHERE c.parent_id = ?2
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = c.author_id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = c.author_id))
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?3 OFFSET ?4`,
      viewerId,
      parent.id,
      pageSize + 1,
      cursor,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    res.json({ replies: page.map(commentPayload), nextCursor: hasMore ? cursor + pageSize : null });
  }),
);

commentsRouter.delete(
  "/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const comment = get<{ id: string; author_id: string; post_id: string }>(
      "SELECT id, author_id, post_id FROM comments WHERE id = ?",
      req.params.id,
    );
    if (!comment) throw notFound("That comment no longer exists.");
    const postAuthor = get<{ author_id: string }>("SELECT author_id FROM posts WHERE id = ?", comment.post_id);
    // A comment can be removed by its author or by the owner of the post.
    if (comment.author_id !== user.id && postAuthor?.author_id !== user.id) {
      throw forbidden("You cannot delete this comment.");
    }
    run("DELETE FROM comments WHERE id = ?", comment.id);
    res.json({ ok: true });
  }),
);

commentsRouter.post(
  "/:id/like",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const comment = get<{ id: string; author_id: string; post_id: string }>(
      "SELECT id, author_id, post_id FROM comments WHERE id = ?",
      req.params.id,
    );
    if (!comment) throw notFound("That comment no longer exists.");
    loadViewablePost(user.id, comment.post_id);
    run(
      "INSERT OR IGNORE INTO comment_likes (user_id, comment_id, created_at) VALUES (?,?,?)",
      user.id,
      comment.id,
      Date.now(),
    );
    notify({
      userId: comment.author_id,
      actorId: user.id,
      type: "comment_like",
      postId: comment.post_id,
      commentId: comment.id,
    });
    const row = get<CommentRow>(`${COMMENT_SELECT} WHERE c.id = ?2`, user.id, comment.id)!;
    res.json({ comment: commentPayload(row) });
  }),
);

commentsRouter.delete(
  "/:id/like",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    if (!exists("SELECT 1 FROM comments WHERE id = ?", req.params.id)) throw notFound("That comment no longer exists.");
    run("DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?", user.id, req.params.id);
    const row = get<CommentRow>(`${COMMENT_SELECT} WHERE c.id = ?2`, user.id, req.params.id)!;
    res.json({ comment: commentPayload(row) });
  }),
);

/**
 * The feed is an event stream, not a post list: a post can arrive because its
 * author is followed, or because someone followed reposted it. Both kinds are
 * unioned, de-duplicated to the most recent event per post, and ordered by when
 * that event happened — so a repost lifts an older post back into view once,
 * attributed to whoever repeated it.
 *
 * The cursor is "<eventTime>:<postId>" because the sort key is no longer the
 * post id.
 */
export function feedPage(viewerId: string, cursor: string | null, limit: number) {
  const [cursorAtRaw, cursorId] = (cursor ?? "").split(":");
  const cursorAt = Number(cursorAtRaw) || 0;

  const rows = all<PostRow & { sort_at: number; reposter_id: string | null; reposter_username: string | null; reposter_name: string | null; reposter_avatar: string | null }>(
    `WITH events AS (
       SELECT p.id AS post_id, p.created_at AS sort_at, NULL AS reposter_id
       FROM posts p
       WHERE p.author_id = ?1
          OR EXISTS (SELECT 1 FROM follows f
                     WHERE f.follower_id = ?1 AND f.following_id = p.author_id AND f.status = 'accepted')
       UNION ALL
       SELECT r.post_id, r.created_at AS sort_at, r.user_id AS reposter_id
       FROM reposts r
       WHERE (r.user_id = ?1
              OR EXISTS (SELECT 1 FROM follows f
                         WHERE f.follower_id = ?1 AND f.following_id = r.user_id AND f.status = 'accepted'))
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = r.user_id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = r.user_id))
     ),
     ranked AS (
       SELECT post_id, sort_at, reposter_id,
              ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY sort_at DESC) AS rn
       FROM events
     )
     SELECT ${POST_COLUMNS}, e.sort_at, e.reposter_id,
            ru.username AS reposter_username, ru.display_name AS reposter_name, ru.avatar_id AS reposter_avatar
     FROM ranked e
     JOIN posts p ON p.id = e.post_id
     JOIN users u ON u.id = p.author_id
     LEFT JOIN users ru ON ru.id = e.reposter_id
     WHERE e.rn = 1
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = p.author_id AND b.blocked_id = ?1)
                                                 OR (b.blocker_id = ?1 AND b.blocked_id = p.author_id))
       AND (u.is_private = 0 OR p.author_id = ?1
            OR EXISTS (SELECT 1 FROM follows f
                       WHERE f.follower_id = ?1 AND f.following_id = p.author_id AND f.status = 'accepted'))
       -- Muted authors, and reposts made by someone muted, drop out of the feed.
       AND NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = ?1 AND mu.muted_id = p.author_id)
       AND (e.reposter_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = ?1 AND mu.muted_id = e.reposter_id))
       AND (?2 = 0 OR e.sort_at < ?2 OR (e.sort_at = ?2 AND p.id < ?3))
     ORDER BY e.sort_at DESC, p.id DESC
     LIMIT ?4`,
    viewerId,
    cursorAt,
    cursorId ?? "",
    limit + 1,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const posts = hydratePosts(page, viewerId).map((post, i) => {
    const row = page[i];
    return row.reposter_id
      ? {
          ...post,
          repostedBy: {
            id: row.reposter_id,
            username: row.reposter_username,
            displayName: row.reposter_name || row.reposter_username,
            avatar: row.reposter_avatar ? `/media/${row.reposter_avatar}/thumb.webp` : null,
            isSelf: row.reposter_id === viewerId,
          },
        }
      : post;
  });

  const last = page[page.length - 1];
  return {
    posts,
    nextCursor: hasMore && last ? `${last.sort_at}:${last.id}` : null,
  };
}

export { canViewContentOf };

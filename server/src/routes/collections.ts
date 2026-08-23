import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx } from "../db.ts";
import { badRequest, conflict, h, limit, notFound, parse } from "../lib/http.ts";
import { me, requireAuth } from "../lib/auth.ts";
import { newId } from "../lib/ids.ts";
import { POST_COLUMNS, hydratePosts, type PostRow } from "../lib/shape.ts";

export const collectionsRouter = Router();

const nameSchema = z
  .string()
  .trim()
  .min(1, "Give the collection a name.")
  .max(40, "Collection names are limited to 40 characters.");

/**
 * Collections are named groups of saved posts. `saves` stays the single source
 * of truth for "is this bookmarked", so adding to a collection also saves, and
 * un-saving removes it from every collection.
 */
function assertOwned(collectionId: string, userId: string) {
  const collection = get<{ id: string; user_id: string; name: string }>(
    "SELECT * FROM collections WHERE id = ?",
    collectionId,
  );
  if (!collection || collection.user_id !== userId) throw notFound("That collection does not exist.");
  return collection;
}

collectionsRouter.get(
  "/",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<{ id: string; name: string; created_at: number; items: number; cover: string | null }>(
      `SELECT c.id, c.name, c.created_at,
              (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS items,
              (SELECT m.id FROM collection_items ci
                 JOIN post_media pm ON pm.post_id = ci.post_id AND pm.position = 0
                 JOIN media m ON m.id = pm.media_id
                WHERE ci.collection_id = c.id
                ORDER BY ci.added_at DESC LIMIT 1) AS cover
       FROM collections c
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC`,
      user.id,
    );
    res.json({
      collections: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        count: r.items,
        cover: r.cover ? `/media/${r.cover}/thumb.webp` : null,
      })),
    });
  }),
);

collectionsRouter.post(
  "/",
  requireAuth,
  limit({ name: "collection:create", max: 30, windowMs: 60 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const body = parse(z.object({ name: nameSchema }), req.body ?? {});
    const clash = get("SELECT 1 AS x FROM collections WHERE user_id = ? AND LOWER(name) = LOWER(?)", user.id, body.name);
    if (clash) throw conflict("You already have a collection with that name.");

    const id = newId();
    run("INSERT INTO collections (id, user_id, name, created_at) VALUES (?,?,?,?)", id, user.id, body.name, Date.now());
    res.status(201).json({ collection: { id, name: body.name, createdAt: Date.now(), count: 0, cover: null } });
  }),
);

collectionsRouter.patch(
  "/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const collection = assertOwned(req.params.id, user.id);
    const body = parse(z.object({ name: nameSchema }), req.body ?? {});
    run("UPDATE collections SET name = ? WHERE id = ?", body.name, collection.id);
    res.json({ ok: true });
  }),
);

collectionsRouter.delete(
  "/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const collection = assertOwned(req.params.id, user.id);
    // Only the grouping goes away; the posts stay saved.
    run("DELETE FROM collections WHERE id = ?", collection.id);
    res.json({ ok: true });
  }),
);

collectionsRouter.get(
  "/:id/posts",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const collection = assertOwned(req.params.id, user.id);
    const cursor = Number(req.query.cursor ?? 0) || 0;
    const pageSize = 24;
    const rows = all<PostRow & { added_at: number }>(
      `SELECT ${POST_COLUMNS}, ci.added_at
       FROM collection_items ci
       JOIN posts p ON p.id = ci.post_id
       JOIN users u ON u.id = p.author_id
       WHERE ci.collection_id = ?2 AND (?3 = 0 OR ci.added_at < ?3)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = p.author_id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = p.author_id))
       ORDER BY ci.added_at DESC LIMIT ?4`,
      user.id,
      collection.id,
      cursor,
      pageSize + 1,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    res.json({
      collection: { id: collection.id, name: collection.name },
      posts: hydratePosts(page, user.id),
      nextCursor: hasMore ? String(page[page.length - 1]!.added_at) : null,
    });
  }),
);

collectionsRouter.put(
  "/:id/posts/:postId",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const collection = assertOwned(req.params.id, user.id);
    const post = get<{ id: string }>("SELECT id FROM posts WHERE id = ?", req.params.postId);
    if (!post) throw notFound("This post is no longer available.");

    const now = Date.now();
    tx(() => {
      // Filing a post implies bookmarking it.
      run("INSERT OR IGNORE INTO saves (user_id, post_id, created_at) VALUES (?,?,?)", user.id, post.id, now);
      run(
        "INSERT OR IGNORE INTO collection_items (collection_id, post_id, added_at) VALUES (?,?,?)",
        collection.id,
        post.id,
        now,
      );
    });
    res.json({ ok: true });
  }),
);

collectionsRouter.delete(
  "/:id/posts/:postId",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const collection = assertOwned(req.params.id, user.id);
    run("DELETE FROM collection_items WHERE collection_id = ? AND post_id = ?", collection.id, req.params.postId);
    res.json({ ok: true });
  }),
);

/** Which of the caller's collections contain this post — drives the picker's checkmarks. */
collectionsRouter.get(
  "/-/for-post/:postId",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    if (!req.params.postId) throw badRequest("Missing post.");
    const rows = all<{ id: string; name: string; has: number }>(
      `SELECT c.id, c.name,
              EXISTS(SELECT 1 FROM collection_items ci WHERE ci.collection_id = c.id AND ci.post_id = ?2) AS has
       FROM collections c WHERE c.user_id = ?1 ORDER BY c.created_at DESC`,
      user.id,
      req.params.postId,
    );
    res.json({ collections: rows.map((r) => ({ id: r.id, name: r.name, contains: !!r.has })) });
  }),
);

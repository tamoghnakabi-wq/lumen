import { Router } from "express";
import { z } from "zod";
import { all, exists, get, run, tx } from "../db.ts";
import { badRequest, conflict, forbidden, h, limit, notFound, parse, rateLimit } from "../lib/http.ts";
import { clearSessionCookie, me, requireAuth, verifyPassword } from "../lib/auth.ts";
import { log } from "../lib/log.ts";
import { deleteMedia, storeImage, upload } from "../lib/media.ts";
import { notify, unnotify } from "../lib/notify.ts";
import {
  POST_COLUMNS,
  POST_SELECT,
  hydratePosts,
  userCard,
  userProfile,
  type PostRow,
  type UserRow,
} from "../lib/shape.ts";
import { tidy } from "../lib/text.ts";
import { USERNAME_COOLDOWN_MS, usernameSchema } from "../lib/username.ts";
import { blockedBetween, blockedByOwner, canViewContentOf } from "../lib/visibility.ts";
import { dropCallBetween, emitToUser } from "../lib/bus.ts";

export const usersRouter = Router();
export const meRouter = Router();

function userByUsername(username: string): UserRow {
  const user = get<UserRow>("SELECT * FROM users WHERE username = ?", username.toLowerCase());
  if (!user) throw notFound("That account does not exist.");
  return user;
}

function userById(id: string): UserRow {
  const user = get<UserRow>("SELECT * FROM users WHERE id = ?", id);
  if (!user) throw notFound("That account does not exist.");
  return user;
}

/* ------------------------------------------------------------- profiles */

usersRouter.get(
  "/:username",
  h((req, res) => {
    const target = userByUsername(req.params.username);
    const viewerId = req.user?.id ?? null;
    // Someone who blocked you should look like they do not exist. Someone *you*
    // blocked must stay reachable, or there is nowhere to press Unblock — their
    // posts are still hidden, because canViewContentOf refuses either direction.
    if (blockedByOwner(viewerId, target.id)) throw notFound("That account does not exist.");
    res.json({ user: userProfile(target, viewerId) });
  }),
);

usersRouter.get(
  "/:username/posts",
  h((req, res) => {
    const target = userByUsername(req.params.username);
    const viewerId = req.user?.id ?? null;
    if (viewerId && blockedBetween(viewerId, target.id)) throw notFound("That account does not exist.");
    if (!canViewContentOf(viewerId, target.id)) throw forbidden("This account is private.");

    const cursor = String(req.query.cursor ?? "");
    const limit = Math.min(Number(req.query.limit ?? 24) || 24, 48);
    const rows = all<PostRow>(
      `${POST_SELECT}
       WHERE p.author_id = ?2 AND (?3 = '' OR p.id < ?3)
       ORDER BY p.id DESC LIMIT ?4`,
      viewerId ?? "",
      target.id,
      cursor,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      posts: hydratePosts(page, viewerId),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    });
  }),
);

/**
 * Posts this account has reposted. Kept off the main profile grid, which stays
 * a grid of their own photographs, and given its own tab instead.
 */
usersRouter.get(
  "/:username/reposts",
  h((req, res) => {
    const target = userByUsername(req.params.username);
    const viewerId = req.user?.id ?? null;
    if (viewerId && blockedBetween(viewerId, target.id)) throw notFound("That account does not exist.");
    if (!canViewContentOf(viewerId, target.id)) throw forbidden("This account is private.");

    const cursor = Number(req.query.cursor ?? 0) || 0;
    const pageSize = 24;
    const rows = all<PostRow & { reposted_at: number }>(
      `SELECT ${POST_COLUMNS}, r.created_at AS reposted_at
       FROM reposts r
       JOIN posts p ON p.id = r.post_id
       JOIN users u ON u.id = p.author_id
       WHERE r.user_id = ?2 AND (?3 = 0 OR r.created_at < ?3)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = p.author_id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = p.author_id))
         AND (u.is_private = 0 OR p.author_id = ?1
              OR EXISTS (SELECT 1 FROM follows f
                         WHERE f.follower_id = ?1 AND f.following_id = p.author_id AND f.status = 'accepted'))
       ORDER BY r.created_at DESC LIMIT ?4`,
      viewerId ?? "",
      target.id,
      cursor,
      pageSize + 1,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    res.json({
      posts: hydratePosts(page, viewerId),
      nextCursor: hasMore ? String(page[page.length - 1]!.reposted_at) : null,
    });
  }),
);

function listRelations(req: any, kind: "followers" | "following") {
  const target = userByUsername(req.params.username);
  const viewerId = req.user?.id ?? null;
  if (viewerId && blockedBetween(viewerId, target.id)) throw notFound("That account does not exist.");
  if (!canViewContentOf(viewerId, target.id)) throw forbidden("This account is private.");

  // The viewer's own follow state is resolved in SQL; doing it per row turned a
  // 200-person list into 200 extra queries.
  const join =
    kind === "followers"
      ? "JOIN users u ON u.id = f.follower_id WHERE f.following_id = ?1"
      : "JOIN users u ON u.id = f.following_id WHERE f.follower_id = ?1";
  const rows = all<UserRow & { viewer_follows: number }>(
    `SELECT u.*,
            EXISTS(SELECT 1 FROM follows vf
              WHERE vf.follower_id = ?2 AND vf.following_id = u.id AND vf.status = 'accepted') AS viewer_follows
     FROM follows f
     ${join} AND f.status = 'accepted'
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?2)
                                                 OR (b.blocker_id = ?2 AND b.blocked_id = u.id))
     ORDER BY f.created_at DESC LIMIT 200`,
    target.id,
    viewerId ?? "",
  );
  return rows.map((u) => ({
    ...userCard(u),
    bio: u.bio,
    relation: viewerId ? { isFollowing: !!u.viewer_follows, isSelf: viewerId === u.id } : null,
  }));
}

usersRouter.get("/:username/followers", h((req, res) => res.json({ users: listRelations(req, "followers") })));
usersRouter.get("/:username/following", h((req, res) => res.json({ users: listRelations(req, "following") })));

/* --------------------------------------------------------------- follow */

usersRouter.post(
  "/:id/follow",
  requireAuth,
  limit({ name: "follow", max: 200, windowMs: 60 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const target = userById(req.params.id);
    if (target.id === user.id) throw badRequest("You cannot follow yourself.");
    if (blockedBetween(user.id, target.id)) throw notFound("That account does not exist.");

    const existing = get<{ status: string }>(
      "SELECT status FROM follows WHERE follower_id = ? AND following_id = ?",
      user.id,
      target.id,
    );
    if (!existing) {
      const status = target.is_private ? "pending" : "accepted";
      run(
        "INSERT INTO follows (follower_id, following_id, status, created_at) VALUES (?,?,?,?)",
        user.id,
        target.id,
        status,
        Date.now(),
      );
      notify({
        userId: target.id,
        actorId: user.id,
        type: status === "pending" ? "follow_request" : "follow",
      });
    }
    res.json({ user: userProfile(userById(target.id), user.id) });
  }),
);

usersRouter.delete(
  "/:id/follow",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const target = userById(req.params.id);
    run("DELETE FROM follows WHERE follower_id = ? AND following_id = ?", user.id, target.id);
    unnotify({ userId: target.id, actorId: user.id, type: "follow" });
    unnotify({ userId: target.id, actorId: user.id, type: "follow_request" });
    res.json({ user: userProfile(userById(target.id), user.id) });
  }),
);

/** Remove somebody who follows you. */
usersRouter.delete(
  "/:id/follower",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const target = userById(req.params.id);
    run("DELETE FROM follows WHERE follower_id = ? AND following_id = ?", target.id, user.id);
    res.json({ ok: true });
  }),
);

/* ---------------------------------------------------------------- block */

usersRouter.post(
  "/:id/block",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const target = userById(req.params.id);
    if (target.id === user.id) throw badRequest("You cannot block yourself.");
    // A block closes every channel at once, including one that is open right
    // now: leaving a live call running would be the loudest possible exception.
    dropCallBetween(user.id, target.id, "blocked");
    tx(() => {
      run("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)", user.id, target.id, Date.now());
      // Blocking severs the relationship in both directions.
      run(
        "DELETE FROM follows WHERE (follower_id = ?1 AND following_id = ?2) OR (follower_id = ?2 AND following_id = ?1)",
        user.id,
        target.id,
      );
      run(
        "DELETE FROM notifications WHERE (user_id = ?1 AND actor_id = ?2) OR (user_id = ?2 AND actor_id = ?1)",
        user.id,
        target.id,
      );
    });
    emitToUser(target.id, "relationship:changed", { userId: user.id });
    res.json({ ok: true });
  }),
);

usersRouter.delete(
  "/:id/block",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    run("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", user.id, req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * Mute: stop seeing someone without unfollowing or blocking them. They are never
 * notified, keep following you, and lose no access — the only thing that changes
 * is what reaches your feed, your reels and your story rail.
 */
usersRouter.post(
  "/:id/mute",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const target = userById(req.params.id);
    if (target.id === user.id) throw badRequest("You cannot mute yourself.");
    run("INSERT OR IGNORE INTO mutes (muter_id, muted_id, created_at) VALUES (?,?,?)", user.id, target.id, Date.now());
    res.json({ user: userProfile(userById(target.id), user.id) });
  }),
);

usersRouter.delete(
  "/:id/mute",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    run("DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?", user.id, req.params.id);
    res.json({ user: userProfile(userById(req.params.id), user.id) });
  }),
);

/** People you might want to follow: not you, not blocked, not already followed. */
usersRouter.get(
  "/-/suggestions",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<UserRow & { mutuals: number }>(
      `SELECT u.*,
              (SELECT COUNT(*) FROM follows f1
                JOIN follows f2 ON f2.following_id = f1.follower_id
                WHERE f1.following_id = u.id AND f1.status = 'accepted'
                  AND f2.follower_id = ?1 AND f2.status = 'accepted') AS mutuals
       FROM users u
       WHERE u.id != ?1
         AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.following_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = u.id))
       ORDER BY mutuals DESC, (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) DESC, u.created_at DESC
       LIMIT 8`,
      user.id,
    );
    res.json({
      users: rows.map((u) => ({ ...userCard(u), bio: u.bio, mutuals: u.mutuals })),
    });
  }),
);

/* ------------------------------------------------------------ me / self */

meRouter.patch(
  "/",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const body = parse(
      z.object({
        username: usernameSchema.optional(),
        displayName: z.string().trim().max(40, "Name must be 40 characters or fewer.").optional(),
        bio: z.string().max(300, "Bio must be 300 characters or fewer.").optional(),
        website: z
          .string()
          .trim()
          .max(120)
          .optional()
          .refine((v) => !v || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v), "Enter a valid link."),
        isPrivate: z.boolean().optional(),
        showActivity: z.boolean().optional(),
        readReceipts: z.boolean().optional(),
      }),
      req.body,
    );

    // Renaming is checked before the transaction so the caller gets the real
    // reason ("taken", "too soon") instead of a bare unique-constraint failure.
    const renaming = body.username !== undefined && body.username !== user.username;
    if (renaming) {
      const taken = get<{ id: string }>("SELECT id FROM users WHERE username = ? AND id != ?", body.username!, user.id);
      if (taken) throw conflict("That username is already taken.");
      const last = user.username_changed_at ?? 0;
      const waitMs = last + USERNAME_COOLDOWN_MS - Date.now();
      if (last > 0 && waitMs > 0) {
        const days = Math.ceil(waitMs / (24 * 60 * 60 * 1000));
        throw badRequest(`You can change your username again in ${days} day${days === 1 ? "" : "s"}.`);
      }
    }

    const wasPrivate = !!user.is_private;
    tx(() => {
      if (renaming) {
        run("UPDATE users SET username = ?, username_changed_at = ? WHERE id = ?", body.username!, Date.now(), user.id);
      }
      if (body.displayName !== undefined) run("UPDATE users SET display_name = ? WHERE id = ?", body.displayName, user.id);
      if (body.bio !== undefined) run("UPDATE users SET bio = ? WHERE id = ?", tidy(body.bio, 8), user.id);
      if (body.website !== undefined) run("UPDATE users SET website = ? WHERE id = ?", body.website, user.id);
      if (body.showActivity !== undefined) {
        run("UPDATE users SET show_activity = ? WHERE id = ?", body.showActivity ? 1 : 0, user.id);
      }
      if (body.readReceipts !== undefined) {
        run("UPDATE users SET read_receipts = ? WHERE id = ?", body.readReceipts ? 1 : 0, user.id);
      }
      if (body.isPrivate !== undefined) {
        run("UPDATE users SET is_private = ? WHERE id = ?", body.isPrivate ? 1 : 0, user.id);
        // Going public accepts everyone who was waiting.
        if (wasPrivate && !body.isPrivate) {
          const pending = all<{ follower_id: string }>(
            "SELECT follower_id FROM follows WHERE following_id = ? AND status = 'pending'",
            user.id,
          );
          run("UPDATE follows SET status = 'accepted' WHERE following_id = ? AND status = 'pending'", user.id);
          for (const p of pending) {
            run(
              "DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'follow_request'",
              user.id,
              p.follower_id,
            );
          }
        }
      }
    });
    res.json({ user: userProfile(userById(user.id), user.id) });
  }),
);

meRouter.post(
  "/avatar",
  requireAuth,
  limit({ name: "avatar", max: 20, windowMs: 60 * 60 * 1000 }),
  upload.single("image"),
  h(async (req, res) => {
    const user = me(req);
    if (!req.file) throw badRequest("Choose an image to upload.");
    const media = await storeImage(req.file.buffer, user.id);
    const previous = user.avatar_id;
    run("UPDATE users SET avatar_id = ? WHERE id = ?", media.id, user.id);
    if (previous) await deleteMedia(previous);
    res.json({ user: userProfile(userById(user.id), user.id) });
  }),
);

meRouter.delete(
  "/avatar",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    if (user.avatar_id) {
      run("UPDATE users SET avatar_id = NULL WHERE id = ?", user.id);
      await deleteMedia(user.avatar_id);
    }
    res.json({ user: userProfile(userById(user.id), user.id) });
  }),
);

meRouter.get(
  "/saved",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const cursor = Number(req.query.cursor ?? 0) || 0;
    const limit = 24;
    // Saved posts are paged by save time, not post time.
    const rows = all<PostRow & { saved_at: number }>(
      `SELECT ${POST_COLUMNS}, sv.created_at AS saved_at
       FROM saves sv
       JOIN posts p ON p.id = sv.post_id
       JOIN users u ON u.id = p.author_id
       WHERE sv.user_id = ?1 AND (?2 = 0 OR sv.created_at < ?2)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = p.author_id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = p.author_id))
       ORDER BY sv.created_at DESC LIMIT ?3`,
      user.id,
      cursor,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      posts: hydratePosts(page, user.id),
      nextCursor: hasMore ? String(page[page.length - 1]!.saved_at) : null,
    });
  }),
);

meRouter.get(
  "/blocked",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<UserRow>(
      `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
      user.id,
    );
    res.json({ users: rows.map((u) => ({ ...userCard(u), bio: u.bio })) });
  }),
);

meRouter.get(
  "/muted",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<UserRow>(
      `SELECT u.* FROM mutes mu JOIN users u ON u.id = mu.muted_id WHERE mu.muter_id = ? ORDER BY mu.created_at DESC`,
      user.id,
    );
    res.json({ users: rows.map((u) => ({ ...userCard(u), bio: u.bio })) });
  }),
);

meRouter.get(
  "/requests",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<UserRow & { requested_at: number }>(
      `SELECT u.*, f.created_at AS requested_at FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`,
      user.id,
    );
    res.json({ users: rows.map((u) => ({ ...userCard(u), bio: u.bio, requestedAt: u.requested_at })) });
  }),
);

meRouter.post(
  "/requests/:id/accept",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const changed = run(
      "UPDATE follows SET status = 'accepted' WHERE follower_id = ? AND following_id = ? AND status = 'pending'",
      req.params.id,
      user.id,
    );
    if (Number(changed.changes) === 0) throw notFound("That request is no longer pending.");
    run("DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'follow_request'", user.id, req.params.id);
    notify({ userId: req.params.id, actorId: user.id, type: "follow_accepted" });
    res.json({ ok: true });
  }),
);

meRouter.post(
  "/requests/:id/decline",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    run(
      "DELETE FROM follows WHERE follower_id = ? AND following_id = ? AND status = 'pending'",
      req.params.id,
      user.id,
    );
    run("DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'follow_request'", user.id, req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * Deleting an account is irreversible, so it re-checks the password: a session
 * left open on a shared machine should not be enough to destroy someone's data.
 */
meRouter.delete(
  "/",
  requireAuth,
  h(async (req, res) => {
    const user = me(req);
    rateLimit(`account-delete:${user.id}`, 5, 60 * 60 * 1000);
    const body = parse(z.object({ password: z.string().min(1, "Enter your password to confirm.") }), req.body ?? {});
    if (!(await verifyPassword(body.password, user.password_hash))) {
      throw badRequest("That password is not correct.");
    }

    const mediaIds = all<{ id: string }>("SELECT id FROM media WHERE owner_id = ?", user.id).map((m) => m.id);
    // Conversations the user was in are left without a member; drop the empty ones.
    const conversations = all<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversation_members WHERE user_id = ?",
      user.id,
    ).map((r) => r.conversation_id);

    run("DELETE FROM users WHERE id = ?", user.id);
    for (const id of conversations) {
      const remaining = get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM conversation_members WHERE conversation_id = ?",
        id,
      );
      if ((remaining?.c ?? 0) === 0) run("DELETE FROM conversations WHERE id = ?", id);
    }
    // media rows survive the user (owner_id is nulled), so remove them explicitly
    for (const id of mediaIds) await deleteMedia(id);

    log.info("account deleted", { user: user.username });
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }),
);

export { exists };

import { all, get, run } from "../db.ts";
import { newId } from "./ids.ts";
import { userCard } from "./shape.ts";
import { blockedBetween } from "./visibility.ts";
import { emitToUser } from "./bus.ts";

export type NotificationType =
  | "like"
  | "comment"
  | "comment_like"
  | "follow"
  | "follow_request"
  | "follow_accepted"
  | "mention"
  | "repost"
  | "quote"
  | "story_reaction";

/** Repeat events (a re-like) should refresh the existing row rather than pile up. */
const COLLAPSING: NotificationType[] = [
  "like",
  "comment_like",
  "follow",
  "follow_request",
  "follow_accepted",
  "repost",
  "story_reaction",
];

/**
 * Bind the recipient as ?1. `post_visible` decides whether the preview
 * thumbnail may be shown: a mention can point at a post on a private account
 * the recipient does not follow, and the thumbnail would otherwise leak it.
 */
export const NOTIFICATION_SELECT = `
  SELECT n.id, n.type, n.created_at, n.read_at, n.post_id, n.comment_id,
         a.id AS actor_id, a.username, a.display_name, a.avatar_id, a.last_seen_at,
         c.body AS comment_body,
         (SELECT m.id FROM post_media pm JOIN media m ON m.id = pm.media_id
           WHERE pm.post_id = n.post_id ORDER BY pm.position LIMIT 1) AS post_media_id,
         (SELECT CASE
             WHEN p.author_id = ?1 THEN 1
             WHEN au.is_private = 0 THEN 1
             WHEN EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1
                            AND f.following_id = p.author_id AND f.status = 'accepted') THEN 1
             ELSE 0 END
           FROM posts p JOIN users au ON au.id = p.author_id WHERE p.id = n.post_id) AS post_visible
  FROM notifications n
  JOIN users a ON a.id = n.actor_id
  LEFT JOIN comments c ON c.id = n.comment_id`;

export function notificationPayload(r: any) {
  return {
    id: r.id,
    type: r.type as NotificationType,
    createdAt: r.created_at,
    read: r.read_at != null,
    actor: userCard({
      id: r.actor_id,
      username: r.username,
      display_name: r.display_name,
      avatar_id: r.avatar_id,
      last_seen_at: r.last_seen_at,
      show_activity: r.show_activity,
    }),
    postId: r.post_id ?? null,
    commentId: r.comment_id ?? null,
    commentBody: r.comment_body ?? null,
    postThumb: r.post_media_id && r.post_visible ? `/media/${r.post_media_id}/thumb.webp` : null,
  };
}

export function unreadNotificationCount(userId: string): number {
  const row = get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL",
    userId,
  );
  return row?.c ?? 0;
}

type NotifyInput = {
  userId: string;
  actorId: string;
  type: NotificationType;
  postId?: string | null;
  commentId?: string | null;
};

export function notify({ userId, actorId, type, postId = null, commentId = null }: NotifyInput) {
  if (userId === actorId) return;
  if (blockedBetween(userId, actorId)) return;

  if (COLLAPSING.includes(type)) {
    run(
      `DELETE FROM notifications
        WHERE user_id = ? AND actor_id = ? AND type = ?
          AND IFNULL(post_id,'') = IFNULL(?,'') AND IFNULL(comment_id,'') = IFNULL(?,'')`,
      userId,
      actorId,
      type,
      postId,
      commentId,
    );
  }

  const id = newId();
  run(
    `INSERT INTO notifications (id, user_id, actor_id, type, post_id, comment_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    userId,
    actorId,
    type,
    postId,
    commentId,
    Date.now(),
  );

  const row = get(`${NOTIFICATION_SELECT} WHERE n.id = ?2`, userId, id);
  if (row) {
    emitToUser(userId, "notification:new", {
      notification: notificationPayload(row),
      unread: unreadNotificationCount(userId),
    });
  }
}

/** Drops a collapsing notification when the underlying action is undone. */
export function unnotify(input: NotifyInput) {
  const { userId, actorId, type, postId = null, commentId = null } = input;
  run(
    `DELETE FROM notifications
      WHERE user_id = ? AND actor_id = ? AND type = ?
        AND IFNULL(post_id,'') = IFNULL(?,'') AND IFNULL(comment_id,'') = IFNULL(?,'')`,
    userId,
    actorId,
    type,
    postId,
    commentId,
  );
  emitToUser(userId, "notification:count", { unread: unreadNotificationCount(userId) });
}

/** Fan out mention notifications for @usernames found in text. */
export function notifyMentions(
  text: string,
  actorId: string,
  ctx: { postId?: string | null; commentId?: string | null },
  usernames: string[],
) {
  if (usernames.length === 0) return;
  const rows = all<{ id: string; username: string }>(
    `SELECT id, username FROM users WHERE username IN (${usernames.map(() => "?").join(",")})`,
    ...usernames,
  );
  for (const u of rows) {
    notify({
      userId: u.id,
      actorId,
      type: "mention",
      postId: ctx.postId ?? null,
      commentId: ctx.commentId ?? null,
    });
  }
}

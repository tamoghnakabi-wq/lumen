import { Router } from "express";
import { z } from "zod";
import { all, get, run } from "../db.ts";
import { badRequest, h, limit, notFound, parse } from "../lib/http.ts";
import { me, requireAuth } from "../lib/auth.ts";
import { NOTIFICATION_SELECT, notificationPayload, unreadNotificationCount } from "../lib/notify.ts";
import { newId } from "../lib/ids.ts";
import { emitToUser } from "../lib/bus.ts";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const cursor = String(req.query.cursor ?? "").slice(0, 40);
    const pageSize = 30;
    const rows = all(
      `${NOTIFICATION_SELECT}
       WHERE n.user_id = ?1 AND (?2 = '' OR n.id < ?2)
       ORDER BY n.id DESC LIMIT ?3`,
      user.id,
      cursor,
      pageSize + 1,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    res.json({
      notifications: page.map(notificationPayload),
      nextCursor: hasMore ? (page[page.length - 1] as any).id : null,
      unread: unreadNotificationCount(user.id),
    });
  }),
);

notificationsRouter.get(
  "/unread-count",
  requireAuth,
  h((req, res) => res.json({ unread: unreadNotificationCount(me(req).id) })),
);

notificationsRouter.post(
  "/read",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", Date.now(), user.id);
    emitToUser(user.id, "notification:count", { unread: 0 });
    res.json({ ok: true });
  }),
);


/**
 * Who owns the thing being reported, or null when it does not exist. Reports are
 * the one write that names an arbitrary id, so the id has to be resolved before
 * anything is stored.
 */
function reportTargetOwner(type: "post" | "user" | "comment", id: string): string | null {
  if (type === "user") return get<{ id: string }>("SELECT id FROM users WHERE id = ?", id)?.id ?? null;
  if (type === "post") return get<{ author_id: string }>("SELECT author_id FROM posts WHERE id = ?", id)?.author_id ?? null;
  return get<{ author_id: string }>("SELECT author_id FROM comments WHERE id = ?", id)?.author_id ?? null;
}

export const reportsRouter = Router();

reportsRouter.post(
  "/",
  requireAuth,
  limit({ name: "report", max: 20, windowMs: 60 * 60 * 1000 }),
  h((req, res) => {
    const user = me(req);
    const body = parse(
      z.object({
        targetType: z.enum(["post", "user", "comment"]),
        targetId: z.string().min(1).max(40),
        reason: z.enum(["spam", "nudity", "hate", "violence", "harassment", "misinformation", "other"]),
        note: z.string().max(500).optional().default(""),
      }),
      req.body,
    );
    // Without these three checks the table is a free-form write endpoint: any
    // id at all, your own posts, and the same report filed over and over.
    const owner = reportTargetOwner(body.targetType, body.targetId);
    if (!owner) throw notFound("That content is no longer available.");
    if (owner === user.id) throw badRequest("You cannot report your own content.");

    const already = get<{ id: string }>(
      `SELECT id FROM reports
       WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'`,
      user.id,
      body.targetType,
      body.targetId,
    );
    // Reporting twice is far more often a double tap than a second opinion, so
    // it answers the same way rather than filing a duplicate for a moderator.
    if (already) {
      return res.json({ ok: true, message: "You have already reported this. Our team will review it." });
    }

    run(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      newId(),
      user.id,
      body.targetType,
      body.targetId,
      body.reason,
      body.note.trim(),
      Date.now(),
    );
    res.status(201).json({ ok: true, message: "Thanks — our team will review this." });
  }),
);

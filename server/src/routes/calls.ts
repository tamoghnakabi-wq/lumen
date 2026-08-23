import { Router } from "express";
import { config } from "../config.ts";
import { all, get } from "../db.ts";
import { h, notFound } from "../lib/http.ts";
import { me, requireAuth } from "../lib/auth.ts";
import { userCard, type UserRow } from "../lib/shape.ts";

export const callsRouter = Router();

/**
 * ICE servers for the browser's RTCPeerConnection.
 *
 * Served from an authenticated endpoint rather than baked into the bundle so
 * TURN credentials — if an operator configures a relay — are never shipped to
 * anonymous visitors.
 */
callsRouter.get(
  "/ice",
  requireAuth,
  h((_req, res) => {
    const iceServers: RTCConfigLike[] = [{ urls: config.webrtc.stunUrls }];
    if (config.webrtc.turnUrl) {
      iceServers.push({
        urls: config.webrtc.turnUrl,
        username: config.webrtc.turnUsername,
        credential: config.webrtc.turnCredential,
      });
    }
    // Without a relay, a pair of peers both behind symmetric NAT cannot
    // connect. The client uses this flag to explain that rather than hang.
    res.json({ iceServers, hasRelay: !!config.webrtc.turnUrl });
  }),
);

type RTCConfigLike = { urls: string | string[]; username?: string; credential?: string };

/** Call history for one conversation. */
callsRouter.get(
  "/conversation/:id",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const member = get(
      "SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
      req.params.id,
      user.id,
    );
    if (!member) throw notFound("That conversation does not exist.");

    const rows = all<{
      id: string;
      caller_id: string;
      status: string;
      kind: string;
      started_at: number;
      answered_at: number | null;
      ended_at: number | null;
    }>(
      `SELECT id, caller_id, status, kind, started_at, answered_at, ended_at
       FROM calls WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 50`,
      req.params.id,
    );
    res.json({
      calls: rows.map((r) => ({
        id: r.id,
        status: r.status,
        kind: r.kind === "video" ? "video" : "audio",
        outgoing: r.caller_id === user.id,
        startedAt: r.started_at,
        durationMs: r.answered_at && r.ended_at ? r.ended_at - r.answered_at : 0,
      })),
    });
  }),
);

/** Everyone this account can reach by call: existing threads, most recent first. */
callsRouter.get(
  "/recent",
  requireAuth,
  h((req, res) => {
    const user = me(req);
    const rows = all<UserRow & { conversation_id: string; last_at: number }>(
      `SELECT u.*, c.id AS conversation_id, c.last_message_at AS last_at
       FROM conversation_members mine
       JOIN conversations c ON c.id = mine.conversation_id
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id != mine.user_id
       JOIN users u ON u.id = other.user_id
       WHERE mine.user_id = ?1
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?1)
                                                   OR (b.blocker_id = ?1 AND b.blocked_id = u.id))
       ORDER BY c.last_message_at DESC LIMIT 30`,
      user.id,
    );
    res.json({
      contacts: rows.map((r) => ({ ...userCard(r), conversationId: r.conversation_id })),
    });
  }),
);
